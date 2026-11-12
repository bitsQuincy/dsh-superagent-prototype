/**
 * Redmine source kind —— [redmine-fork] 新增（官方只有 github/feishu）。
 *
 * 只读取一个 Redmine 项目（按 project_id + 可选 tracker_id 过滤），把每个 journal（备注/属性变更）
 * 变成一条 Trigger，一个 issue 一条 Thread。语义对齐 docs/010-tapd-source.md 的 TAPD kind：
 *
 *   · journal 是 Redmine 的天然事件流：Trigger id = `redmine:<journalId>`，幂等去重由 Engine 完成
 *     （重复轮询产出相同 id，Engine 视为 duplicate 丢弃），因此本 Source 不维护游标
 *   · agent 自己（agentLogin）的 journal 不产出 Trigger（防自激）
 *   · 显式请求（addressed: 'mention'）三选一：issue 被指派给 agent / 状态流转到 readyStatus /
 *     备注文本 @agentLogin —— 白名单内成员的显式请求在任何 accept 模式下都会接
 *   · 其余备注作为 Thread 的普通消息进入准入表（有活单时经订阅直达 Worker，不走 Eval）
 *   · 本 kind 无 Channel：对需求方的沟通走邮件（mailq CLI），对 Redmine 的回写/状态流转走 taskq CLI，
 *     由 Worker 的 prompts（stage1/stage2）明确指示 —— 这是有意设计，不是缺失
 *
 * 与 taskq CLI 的契约一致：taskq pull 输出的 item 形状 = 本文件 triggerOf 的输出形状。
 * Worker 侧令牌必须走文件（DSH 剥离含 KEY/TOKEN/SECRET 的子进程环境变量）；
 * 本 Source 运行在宿主进程，可读环境变量 DSH_SUPERAGENT_REDMINE_API_KEY。
 */
import type { Context } from '@deepseek-ai/cordis'
import { readFileSync } from 'node:fs'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import type { FieldSpec, Localized, SourceKind } from './kind.ts'
import { health, sourceContext, type Health, type SourceContext } from './host.ts'
import { pause } from './poll.ts'

export const SOURCE = 'redmine'
/** 单条 Trigger 保留的最大备注长度；更长的内容 Worker 用 taskq thread 重读。 */
const NOTE_MAX_CHARS = 4000

const RedmineConfigSchema = z.object({
  baseUrl: z.string().trim().regex(/^https?:\/\/[^\s]+$/).default(''),
  /** API Key 文件路径（绝对或相对 stateDir）；env DSH_SUPERAGENT_REDMINE_API_KEY 优先。 */
  apiKeyFile: z.string().trim().default(''),
  projectId: z.number().int().positive().default(0),
  trackerId: z.number().int().positive().default(0),
  agentLogin: z.string().trim().min(1).default('agent-bot'),
  /** 流转到该状态 = 白名单成员的显式开工指令。 */
  readyStatus: z.string().trim().min(1).default('可开工'),
  pollSeconds: z.number().int().min(60).max(3600).default(120),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
  limit: z.number().int().min(1).max(200).default(100),
}).strict()
export type RedmineConfig = z.infer<typeof RedmineConfigSchema>

/** 宿主进程的凭据解析：env 优先，其次 apiKeyFile。缺失时点名，不做静默空读。 */
export function credentials(config: Pick<RedmineConfig, 'apiKeyFile'>, env: Record<string, string | undefined> = process.env): string {
  const token = env.DSH_SUPERAGENT_REDMINE_API_KEY || env.REDMINE_API_KEY
  if (token) return token
  if (!config.apiKeyFile) throw new Error('Redmine 凭据缺失：设 DSH_SUPERAGENT_REDMINE_API_KEY，或在 Source 配置里填 apiKeyFile')
  return readFileSync(config.apiKeyFile, 'utf8').trim()
}

/** Redmine REST 最小客户端（只覆盖本 kind 的读路径）。 */
export async function api<T>(base: string, token: string, path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
    headers: { 'X-Redmine-API-Key': token, Accept: 'application/json' }, signal,
  })
  if (!response.ok) throw new Error(`Redmine HTTP ${response.status} ${path.split('?')[0]}`)
  return response.json() as Promise<T>
}

/** 扁平化 Redmine 实体，缺失字段留空不猜测。 */
export interface RedmineJournal {
  id: number
  user_id?: number
  user: { id: number; login: string; name: string }
  notes: string
  created_on: string
  details: { property: string; name: string; old_value?: unknown; new_value?: unknown }[]
}
export interface RedmineIssue {
  id: number
  subject: string
  description: string
  status: { id: number; name: string }
  assigned_to?: { id: number; login: string } | null
  project_id: number
  tracker_id: number
  updated_on: string
  journals?: RedmineJournal[]
  attachments?: { id: number; filename: string; filesize: number }[]
}

export function plainText(text: string): string {
  const value = String(text ?? '').replace(/[ \t\f\r]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim()
  return value.length > NOTE_MAX_CHARS ? `${value.slice(0, NOTE_MAX_CHARS)}…` : value
}

/** journal 的变更摘要（无备注时作为 Trigger 文本）。 */
export function changeSummary(journal: RedmineJournal, statusName: (id: unknown) => string, userName: (id: unknown) => string): string {
  return journal.details.map(d => {
    if (d.name === 'status_id') return `状态: ${statusName(d.old_value)} → ${statusName(d.new_value)}`
    if (d.name === 'assigned_to_id') return `指派: ${userName(d.old_value)} → ${userName(d.new_value)}`
    return `${d.name}: ${String(d.old_value ?? '∅')} → ${String(d.new_value ?? '∅')}`
  }).join('; ')
}

/**
 * journal → Trigger 的唯一映射（taskq pull 与本函数保持一致）。
 * assigned: 指派给 agent；ready: 状态流转到 readyStatus；mentioned: 备注 @agentLogin。
 */
export function triggerOf(issue: RedmineIssue, journal: RedmineJournal, config: RedmineConfig, base: string,
  names: { statusName(id: unknown): string; userName(id: unknown): string }): Trigger {
  const notes = plainText(journal.notes)
  const assigned = journal.details.some(d => d.name === 'assigned_to_id' && names.userName(d.new_value) === config.agentLogin)
  const ready = journal.details.some(d => d.name === 'status_id' && names.statusName(d.new_value) === config.readyStatus)
  const mentioned = journal.notes.includes(`@${config.agentLogin}`)
  const text = notes || changeSummary(journal, names.statusName, names.userName)
  return {
    id: `${SOURCE}:${journal.id}`,
    source: SOURCE,
    threads: [{ source: SOURCE, id: String(issue.id) }],
    actor: { source: SOURCE, id: journal.user.login ?? String(journal.user.id) },
    human: true,
    ...(assigned || ready || mentioned ? { addressed: 'mention' as const } : {}),
    at: journal.created_on,
    text: `[RD#${issue.id}] ${issue.subject}\n\n${text}`,
    url: `${base}/issues/${issue.id}`,
    meta: {
      issueId: issue.id, journalId: journal.id, subject: issue.subject,
      status: issue.status?.name ?? '', assignedTo: issue.assigned_to?.login ?? '',
      kind: notes ? 'note' : 'change', attachments: (issue.attachments ?? []).length,
      assigned, ready, mentioned, readyStatus: config.readyStatus,
    },
  }
}

/** 一轮轮询：列出项目内最近更新的 issue，逐条读 journals，产出未见过的新 Trigger。 */
export async function pollRound(ctx: SourceContext, config: RedmineConfig, signal: AbortSignal): Promise<number> {
  const base = config.baseUrl
  if (!base) throw new Error('Redmine baseUrl 未配置')
  const token = credentials(config)
  const [{ issue_statuses: statuses }, { users }] = await Promise.all([
    api<{ issue_statuses: { id: number; name: string }[] }>(base, token, '/issue_statuses.json', signal),
    api<{ users: { id: number; login: string; name: string }[] }>(base, token, '/users.json', signal),
  ])
  const statusName = (id: unknown) => statuses.find(s => s.id === Number(id))?.name ?? String(id ?? '∅')
  const userName = (id: unknown) => users.find(u => u.id === Number(id))?.login ?? String(id ?? '∅')
  const names = { statusName, userName }

  const query = new URLSearchParams({ sort: 'updated_on:desc', limit: String(config.limit) })
  if (config.projectId) query.set('project_id', String(config.projectId))
  if (config.trackerId) query.set('tracker_id', String(config.trackerId))
  const list = (await api<{ issues: RedmineIssue[] }>(base, token, `/issues.json?${query}`, signal)).issues

  let stored = 0
  for (const row of list) {
    const issue = (await api<{ issue: RedmineIssue }>(base, token, `/issues/${row.id}.json?include=journals,attachments`, signal)).issue
    for (const journal of issue.journals ?? []) {
      if (journal.user?.login === config.agentLogin) continue // 防自激：agent 的备注/变更不是请求
      if (await ctx.receive(triggerOf(issue, journal, config, base, names)) === 'stored') stored += 1
    }
  }
  return stored
}

/** 连续失败达到阈值才报 error；单次网络抖动静默重试。 */
export function pollFailure(failures: number, threshold: number, error: unknown): Health | undefined {
  return failures >= threshold ? health('error', 'pollFailures', { count: String(failures), error: String(error) }) : undefined
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  while (!signal.aborted) {
    const config = ctx.config<RedmineConfig>(SOURCE)
    try {
      if (!config) ctx.report('redmine', health('paused', 'sourceOff'))
      else if (!config.baseUrl || !config.projectId) ctx.report('redmine', { state: 'paused', detail: 'Redmine baseUrl / projectId 未配置（Settings → Source）' })
      else {
        const stored = await pollRound(ctx, config, signal)
        ctx.report('redmine', { state: 'ready', detail: `${stored} new trigger${stored === 1 ? '' : 's'}; polls every ${config.pollSeconds}s` })
        failures = 0
      }
    } catch (error) {
      failures += 1
      const failed = pollFailure(failures, config?.failuresBeforeError ?? 1, error)
      if (!signal.aborted && failed) ctx.report('redmine', failed)
    }
    await pause(Math.max(60, config?.pollSeconds ?? 120) * 1000, signal)
  }
}

const zhField = (key: string, label: string, hint: string, rest: Record<string, unknown> = {}): FieldSpec =>
  ({ key, type: 'text', label: { zh: label, en: label }, hint: { zh: hint, en: hint }, ...rest })

/** The kind: 只读轮询器，无 Channel —— 对人沟通走邮件，对 Redmine 回写走 taskq。 */
export const redmineKind: SourceKind<RedmineConfig> = {
  kind: SOURCE,
  title: { zh: 'Redmine', en: 'Redmine' },
  description: {
    zh: '只读轮询一个 Redmine 项目：备注/指派/状态变更变成 Trigger，一个 issue 一条 Thread。指派给 agent、状态流转到「可开工」或备注 @agent 是显式请求；agent 自己的变更被忽略。',
    en: 'Read-only poll of one Redmine project: journals become Triggers, one Thread per issue. Assignment to the agent, a transition to the ready status, or a mention is an explicit request; the agent\'s own journals are ignored.',
  },
  schema: RedmineConfigSchema,
  fields: [
    zhField('baseUrl', 'Redmine 地址', '例如 http://redmine.internal:3000（内网）'),
    zhField('apiKeyFile', 'API Key 文件', '宿主进程读取的令牌文件路径；也可用环境变量 DSH_SUPERAGENT_REDMINE_API_KEY', { advanced: true }),
    { key: 'projectId', type: 'number', min: 1, max: 100000, label: { zh: '项目 ID', en: 'Project ID' }, hint: { zh: '只读这个项目的 issue（Redmine 管理界面可见数字 ID）', en: 'Numeric project ID' } },
    { key: 'trackerId', type: 'number', min: 1, max: 1000, label: { zh: '跟踪类型 ID（可选）', en: 'Tracker ID (optional)' }, hint: { zh: '例如「功能需求」的 tracker_id；留空读全部', en: 'Restrict to one tracker; empty reads all' }, advanced: true },
    zhField('agentLogin', 'Agent 登录名', 'agent 专用 Redmine 账号的 login；它的 journal 不会触发'),
    zhField('readyStatus', '开工状态名', '流转到该状态 = 显式开工指令，例如「可开工」', { advanced: true }),
    { key: 'pollSeconds', type: 'number', min: 60, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' }, advanced: true, hint: { zh: '默认 120 秒', en: 'Two minutes by default' } },
    { key: 'failuresBeforeError', type: 'number', min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' }, advanced: true, hint: { zh: '单次网络中断不报告', en: 'A single interruption stays quiet' } },
    { key: 'limit', type: 'number', min: 1, max: 200, label: { zh: '每轮最多读取的 issue 数', en: 'Issues read per poll' }, advanced: true, hint: { zh: '按最近更新排序取前 N 条，逐条读 journals', en: 'Most recently updated N issues are read in full' } },
  ],
  health: ['redmine'],
  find: query => {
    const id = query.trim().match(/^\d{1,10}$/)?.[0]
    return id ? { threads: [`${SOURCE}:${id}`], terms: [id] } : { threads: [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().trim().min(1).max(100), name: z.string().trim().max(100).optional() }).strict())
        .refine(people => new Set(people.map(p => p.id)).size === people.length, 'Duplicate logins').default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的账号', en: 'Logins who may originate work' },
        columns: [{ key: 'id', type: 'text', label: { zh: 'Redmine 登录名', en: 'Redmine login' } },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true }] },
    ],
    explicit: { zh: '名单内账号的指派、@提及或状态流转到「可开工」是明确的请求，不需要再确认；名单外的人不接收。', en: 'An assignment, mention or ready-status transition by a listed login is an explicit request; anyone unlisted is not received.' },
  },
  threadContext: {
    messageId: trigger => trigger.id,
    async read(commands, trigger, part, cursor, config) {
      // 只实现 'thread' 一页：issue 的 journals 按时间正序；cursor 为已读的最大 journal id。
      const issueId = trigger.threads[0]?.id ?? String(trigger.meta.issueId ?? '')
      const token = credentials(config)
      const data = await api<{ issue: RedmineIssue }>(config.baseUrl, token, `/issues/${issueId}.json?include=journals`, AbortSignal.timeout(15000))
      const items = (data.issue.journals ?? [])
        .filter(j => Number(j.id) > Number(cursor ?? 0))
        .slice(0, 100)
        .map(j => ({
          id: `${SOURCE}:${j.id}`, from: j.user?.login ?? String(j.user_id), at: j.created_on,
          text: plainText(j.notes) || changeSummary(j, id => String(id), id => String(id)),
          url: `${config.baseUrl}/issues/${issueId}`,
        }))
      const next = items.length ? String(Number(items[items.length - 1]!.id.split(':')[1])) : undefined
      return { messages: items, next, body: { issueId, subject: data.issue.subject }, status: data.issue.status?.name }
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_REDMINE_ISSUE_ID', description: { zh: '触发工单的 Redmine issue ID；非 Redmine 来源的工单为空', en: 'Redmine issue ID of the ticket; empty otherwise' } },
      { key: 'DSH_SUPERAGENT_REDMINE_ISSUE_URL', description: { zh: '该 issue 的链接', en: 'Link to that issue' } },
      { key: 'DSH_SUPERAGENT_REDMINE_SUBJECT', description: { zh: 'issue 标题', en: 'Issue subject' } },
      { key: 'DSH_SUPERAGENT_REDMINE_STATUS', description: { zh: 'issue 当前状态名', en: 'Issue status name' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_REDMINE_ISSUE_ID: trigger?.source === SOURCE ? String(trigger.meta.issueId ?? '') : '',
      DSH_SUPERAGENT_REDMINE_ISSUE_URL: trigger?.source === SOURCE ? String(trigger.url ?? '') : '',
      DSH_SUPERAGENT_REDMINE_SUBJECT: trigger?.source === SOURCE ? String(trigger.meta.subject ?? '') : '',
      DSH_SUPERAGENT_REDMINE_STATUS: trigger?.source === SOURCE ? String(trigger.meta.status ?? '') : '',
    }),
  },
}

export const name = 'dsh-superagent-redmine'
export const inject = ['orchestrator']
/** 注册 kind 并启动轮询循环；部署在 profile patch 层里开/关这个入口（默认 disabled，见 cordis.patch.yml）。 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(redmineKind), 'redmine: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, redmineKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('redmine', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}
