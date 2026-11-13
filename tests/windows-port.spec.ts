/**
 * Windows port contracts: drive-qualified paths, PATHEXT lookup, batch worker shims, cmd.exe prepare commands, and
 * case-insensitive path comparison. Run on Windows; the POSIX suite remains the Linux/CI gate.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SubprocessOutputReader, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import { Config, executable, machineOf, workerProbe } from '../src/deployment.ts'
import { prepareArgv } from '../src/executor/dsh.ts'
import { Commands } from '../src/infra/commands.ts'
import { agentGhConfig, agentVariables, credentialHelper, runAsWorker, sameDirectory, workerBin, workerGitConfig, writeEnvironment } from '../src/infra/environment.ts'
import { ExecutorConfigSchema } from '../src/policy.ts'
import { testDeployment } from './fixtures/deployment.ts'

const exec = promisify(execFile)
let dir: string
const windows = process.platform === 'win32'

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'windows-port-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.runIf(windows)('Windows configuration paths', () => {
  it('accepts drive-qualified and UNC state directories, and still rejects relative and home paths', () => {
    const stateDir = join(dir, 'state')
    expect(machineOf(Config({ stateDir })).stateDir).toBe(stateDir)
    expect(() => Config({ stateDir: 'D:/dsh/state' })).not.toThrow()
    expect(() => Config({ stateDir: '\\\\server\\share\\dsh' })).not.toThrow()
    expect(() => Config({ stateDir: 'relative/dir' })).toThrow()
    expect(() => Config({ stateDir: '~/dir' })).toThrow()
  })

  it('accepts the same absolute forms for the executor ticket directory', () => {
    const directory = join(dir, 'work')
    expect(ExecutorConfigSchema.parse({ directory }).directory).toBe(directory)
    expect(ExecutorConfigSchema.parse({ directory: 'D:/dsh/work' }).directory).toBe('D:/dsh/work')
    expect(() => ExecutorConfigSchema.parse({ directory: 'relative/work' })).toThrow()
    expect(() => ExecutorConfigSchema.parse({ directory: '\\work' })).toThrow()
  })
})

describe.runIf(windows)('Windows CLI and path resolution', () => {
  it('finds a command through PATHEXT, preferring a native executable over a batch file', () => {
    const bin = join(dir, 'bin'); mkdirSync(bin)
    writeFileSync(join(bin, 'tool.cmd'), '@echo off\r\n')
    writeFileSync(join(bin, 'tool.exe'), '')
    expect(executable('tool', bin)).toBe(join(bin, 'tool.exe'))
    rmSync(join(bin, 'tool.exe'))
    expect(executable('tool', bin)).toBe(join(bin, 'tool.cmd'))
    expect(executable(join(bin, 'tool.cmd'), bin)).toBe(join(bin, 'tool.cmd'))
    // PATHEXT also lists scripts Windows cannot spawn directly; must not resolve them.
    rmSync(join(bin, 'tool.cmd'))
    writeFileSync(join(bin, 'tool.js'), '')
    expect(() => executable('tool', bin)).toThrow('tool is not an executable file on PATH')
    expect(() => executable('missing', bin)).toThrow('missing is not an executable file on PATH')
  })

  it('passes PATH through the subprocess env seam instead of invoking the POSIX env command', async () => {
    const seen: { argv: string[]; env?: Record<string, string> }[] = []
    const empty = { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }
    const subprocess = {
      spawn: (spec: { argv: string[]; env?: Record<string, string> }) => {
        seen.push(spec)
        return { done: Promise.resolve({ exitCode: 0, signal: null }), collected: { stdout: empty, stderr: empty } }
      },
    } as unknown as SubprocessRuntime
    await workerProbe(subprocess, dir, dir, new AbortController().signal)(['gh', 'api', 'user'])
    expect(seen[0]!.argv).toEqual(['gh', 'api', 'user'])
    expect(seen[0]!.env?.PATH).not.toContain(workerBin(dir))
    expect(seen[0]!.env?.GH_CONFIG_DIR).toBe(agentGhConfig(dir))
  })

  it('compares directories without regard to case, as the Windows filesystem does', () => {
    mkdirSync(join(dir, 'CaseDir'))
    expect(sameDirectory(join(dir, 'CaseDir'), join(dir, 'casedir'))).toBe(true)
  })

  it('runs a batch host CLI through cmd.exe', async () => {
    const cli = join(dir, 'host-cli.cmd')
    writeFileSync(cli, `@echo off\r\n"${process.execPath}" -e "console.log('host-ok')" %*\r\n`)
    const commands = new Commands(() => testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli } }), {}, new AbortController().signal)
    expect((await commands.run(cli, [])).trim()).toBe('host-ok')
  })

  it('runs a batch CLI through cmd.exe and reaches the configured executable', async () => {
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: process.execPath }, feishu: undefined })
    await writeEnvironment(deployment, [])
    const seen: string[][] = []
    const subprocess = {
      spawn: ({ argv, cwd, env }: { argv: string[]; cwd: string; env?: Record<string, string> }) => {
        seen.push([...argv])
        const child = spawn(argv[0]!, argv.slice(1), { cwd, env: { ...process.env, ...env } })
        const output = { stdout: '', stderr: '' }
        child.stdout.on('data', chunk => { output.stdout += String(chunk) })
        child.stderr.on('data', chunk => { output.stderr += String(chunk) })
        const reader = (name: 'stdout' | 'stderr') => ({ readFrom: () => ({ text: output[name], nextOffset: 0, lossy: false }) })
        const done = new Promise(resolve => child.on('close', (code, signal) => resolve({ exitCode: code, signal })))
        return { done, collected: { stdout: reader('stdout') as SubprocessOutputReader, stderr: reader('stderr') as SubprocessOutputReader } }
      },
    } as unknown as SubprocessRuntime
    const stdout = await runAsWorker(subprocess, [join(workerBin(dir), 'gh.cmd'), '-v'], dir, new AbortController().signal)
    expect(seen[0]![0]).toBe('cmd.exe')
    expect(stdout.trim()).toMatch(/^v\d+/)
  })
})

describe.runIf(windows)('Windows worker environment', () => {
  it('writes .cmd shims with the batch marker and retires an old extensionless shim it wrote', async () => {
    const deployment = testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli: process.execPath }, feishu: undefined })
    const bin = workerBin(dir); mkdirSync(bin, { recursive: true })
    // A shim written by the POSIX implementation before this port must be recognized and replaced, not rejected as foreign.
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\n# Written by dsh-superagent on every start; edits are lost.\n')
    await writeEnvironment(deployment, ['personal-gh'])
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd', 'personal-gh.cmd'])
    const gh = readFileSync(join(bin, 'gh.cmd'), 'utf8')
    expect(gh.startsWith('@echo off\r\n@REM # Written by dsh-superagent')).toBe(true)
    expect(gh).toContain(`"${process.execPath}" %*`)
    expect(gh).toContain('exit /b %ERRORLEVEL%')
    // A second start must accept its own files and leave the same set.
    await expect(writeEnvironment(deployment, ['personal-gh'])).resolves.toBeUndefined()
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd', 'personal-gh.cmd'])
    expect(agentGhConfig(dir)).toBe(join(dir, 'gh-config'))
    expect(agentVariables(dir).GH_CONFIG_DIR).toBe(join(dir, 'gh-config'))
    expect(readdirSync(agentGhConfig(dir))).toEqual([])
    expect(workerGitConfig(dir)).toBe(join(dir, 'worker-gitconfig'))
  })

  it('renders the Windows credential helper into the isolated git config as git reads it', async () => {
    const cli = 'C:\\Program Files\\GitHub CLI\\gh.exe'
    await writeEnvironment(testDeployment({ stateDir: dir, github: { ...testDeployment().github, cli }, feishu: undefined }), [])
    const { stdout } = await exec('git', ['config', '--file', workerGitConfig(dir), '--get-all', 'credential.https://github.com.helper'])
    expect(stdout.trim()).toBe(credentialHelper(cli))
  })

  it('makes a blocked command fail with exit code 1 and a stderr explanation', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    await expect(exec('cmd.exe', ['/d', '/c', join(workerBin(dir), 'personal-gh.cmd')]))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('personal-gh is blocked in this installation') })
  })

  it('quotes a git credential helper with forward slashes for Git for Windows', () => {
    expect(credentialHelper('C:\\Program Files\\GitHub CLI\\gh.exe')).toBe('!"C:/Program Files/GitHub CLI/gh.exe" auth git-credential')
  })
})

describe.runIf(windows)('Windows prepare command', () => {
  it('uses cmd.exe syntax instead of sh -c', () => {
    expect(prepareArgv('prepare.cmd')).toEqual(['cmd.exe', '/d', '/s', '/c', 'prepare.cmd'])
  })
})
