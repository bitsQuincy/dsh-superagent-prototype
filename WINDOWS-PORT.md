# WINDOWS-PORT — Windows 原生适配差量

本文件是 `redmine-fork` 相对官方 main 的 **Windows 适配差量清单**，也是上游同步时的核对表。
所有改动都以 `process.platform === 'win32'` 门控，POSIX 分支保持原有行为；没有引入任何第三方 Windows 仓库的代码。

函数级对照参考（只读，不 vendor）：

- [Check-mj/dsh-superagent-windows — WINDOWS-DELTA.md](https://github.com/Check-mj/dsh-superagent-windows/blob/main/WINDOWS-DELTA.md)
- [buyou-claw/dsh-superagent-win — UPSTREAM.md](https://github.com/buyou-claw/dsh-superagent-win/blob/main/UPSTREAM.md)

检索全部改动：

```sh
grep -rn "\[windows-port\]" src tests
```

## 一、差量清单

| 文件 | 函数/位置 | 改动 | 为什么 |
|---|---|---|---|
| `src/deployment.ts` | `absolute()` | `stateDir` schema 由 `^\//` 改为同时接受 `C:\`、`C:/`、`\\server\share`；POSIX 仍只认 `/` | 原 schema 直接拒绝 Windows 盘符路径，插件不激活 |
| `src/deployment.ts` | `executable()` | win32 按 `.com/.exe/.bat/.cmd` 依次查找；PATH 条目去引号；`X_OK` 改 `F_OK`；绝对路径先试原名 | 配置里写 `gh` 时找不到 `gh.exe`；Windows 没有执行位 |
| `src/deployment.ts` | `Probe` / `workerProbe()` | 去掉 `['env','PATH=…',…]`，改为通过 subprocess 的显式 `env` 传 PATH | Windows 没有 `env` 可执行文件 |
| `src/deployment.ts` | `resolveFeishuBot()` 的 `run()` | 同上，`LARKSUITE_CLI_*` 通过 env 参数传 | 同上 |
| `src/policy.ts` | `ExecutorConfigSchema.directory` | `startsWith('/')` 改为 `isAbsolute()` | 面板保存 `D:/work` 会 400 |
| `src/infra/environment.ts` | `credentialHelper()` | win32 返回 `!"C:/…/gh.exe" auth git-credential`（正斜杠 + 双引号） | Git for Windows 用 `sh.exe` 执行 `!` helper，反斜杠单引号不稳 |
| `src/infra/environment.ts` | `sameDirectory()` | win32 下大小写不敏感、分隔符统一 | `D:\…` 与 `d:\…` 比较失败会导致 shim 目录剥不掉 |
| `src/infra/environment.ts` | `agentGhConfig()` / `agentVariables()` | win32 新增 `<stateDir>/gh-config` 并注入 `GH_CONFIG_DIR` | `.cmd` 包装器不能被 Node 直接 spawn；用配置目录选 gh 账号 |
| `src/infra/environment.ts` | `written()` | 按 `/\r?\n/` 切前两行，识别 `@REM`/`REM` 标记 | `.cmd` 的 `#` 注释会被 cmd 当命令执行；CRLF 下原逻辑认不出自己写的文件 |
| `src/infra/environment.ts` | `writeEnvironment()` | win32 写 `<name>.cmd`（CRLF、`@echo off`、`@REM` 标记、绝对路径、`%*`、`exit /b`）；被禁命令写失败垫片；清理旧的同名无扩展名垫片 | 无扩展名文件在 PATHEXT 查找里不可执行 |
| `src/infra/environment.ts` | `runAsWorker()` | win32 下 `.cmd`/`.bat` 改走 `cmd.exe /d /c <prog> <args...>`，程序与参数分开传 | Node 24 拒绝直接 spawn batch（CVE-2024-27980 hardening） |
| `src/infra/environment.ts` | `verifyEnvironment()` | win32 比较前统一分隔符、大小写、CR | git 回显 `file:C:/…`，与 `path.join` 产物不一致 |
| `src/infra/environment.ts` | `verifyDirectory()` | 配置行按 `/\r?\n/` 切分 | Windows 输出带 CR |
| `src/infra/commands.ts` | `Commands.run()` | win32 下 `.cmd`/`.bat` 改走 `cmd.exe /d /c` | 宿主侧 `gh`/`lark-cli` 也可能是 batch |
| `src/executor/dsh.ts` | `prepareArgv()`（新增导出） | win32 用 `cmd.exe /d /s /c`，POSIX 仍 `sh -c` | Windows 没有 `sh`；反斜杠会被 POSIX shell 吃掉 |
| `src/app/sessions.ts` | `noWait()` | 同时覆盖 `pwsh` | 主 Session 在 Windows 上只有 `pwsh` |
| `src/app/sessions.ts` | 主 Session 工具白名单 | 不再硬编码 `'bash'`，按实际工具注册表过滤 | `tools.restrict()` 拒绝未注册的工具名，首启 Session setup 失败 |
| `pnpm-workspace.yaml` | — | `nodeLinker: hoisted`（fork 既有改动） | 规避本机 Windows pnpm junction 导致 tsdown 找不到依赖 |
| `.gitattributes` | 新增 | POSIX 文本强制 LF，`.cmd/.bat/.ps1` 强制 CRLF | Windows checkout 不会把 `#!/bin/sh`/Python 脚本改成 CRLF |
| `tests/windows-port.spec.ts` | 新增 | Windows 契约测试（路径、PATHEXT、垫片、batch spawn、prepare、credential helper） | 上游同步后先跑这组，防止 win32 分支被合掉 |
| `tests/runtime.spec.ts`, `tests/fixtures/host.ts` | 测试夹具 | prepare 断言的 argv/answer key 改用 `prepareArgv()`；shim 断言接受 `.cmd` 名称；探针断言改为检查 subprocess env 而不是 `env` 命令 | 让 91 项 runtime 测试在 Windows 通过，POSIX 断言等价 |
| `tests/bundle-patch.spec.ts` | 测试夹具 | 期望的 patch 行加上 `dsh-superagent-redmine` | redmine-fork 新增了该行，原测试漏更新 |

## 二、两个有意的设计选择

### 1. Windows 垫片按绝对路径调用，不重建 PATH

Check-mj 的 `writeEnvironment()` 在 batch 里重建 PATH 以保持“垫片目录从 PATH 消失”的上游语义。
本 fork 没有照搬：`cmd.exe` 对 PATH 里的 `&`、`|`、`%`、`^` 等元字符处理很脆，实测包含 `C:\a&b` 的 PATH 会让 `for` 拆分提前截断。
因此 Windows 垫片直接调用配置的 CLI 绝对路径：

```bat
@echo off
@REM # Written by dsh-superagent on every start; edits are lost.
"C:\Program Files\GitHub CLI\gh.exe" %*
exit /b %ERRORLEVEL%
```

代价：如果 `github.cli` 配的是一个“按名字再调 `gh`”的包装器，会再次进入垫片。
**Windows 部署请把 `github.cli` 指向真实 `gh.exe`，或指向内部用绝对路径调用真实 `gh` 的包装器。**
Redmine 主线默认关闭 GitHub Source，不受此影响。

### 2. PATHEXT 只认 Node 能 spawn 的四类

Windows 的 `PATHEXT` 默认还包含 `.JS`、`.VBS`、`.PS1` 等，这些不能由 `spawn` 直接执行。
`executable()` 只尝试 `.com/.exe/.bat/.cmd`，避免把脚本误判成可执行文件。

## 三、验证

Windows 上：

```sh
pnpm install
pnpm typecheck
pnpm build
pnpm vitest run tests/windows-port.spec.ts
```

Linux/CI 上仍以完整 POSIX 测试为准（Windows 契约测试自动跳过）：

```sh
pnpm check
```

本次移植的验证结果（2026-11-13，Node 24.18.0 / pnpm 11.7.0 / DSH 0.2.1-alpha.2）：

```text
pnpm typecheck                         EXIT 0
pnpm build                             EXIT 0（lib/redmine-watch.js 产出）
pnpm vitest run tests/windows-port.spec.ts   12 passed
pnpm vitest run tests/runtime.spec.ts        91 passed
pnpm vitest run tests/migration.spec.ts      19 passed
pnpm vitest run tests/bundle-patch.spec.ts   2 passed
```

Windows 上完整 `pnpm test` 目前仍有失败，都是 POSIX 专有测试（`service-script` 的 tmux/Python、`environment` 的 `#!/bin/sh` 垫片、`sources` 的 fake CLI、`store` 的权限位）和 Windows 下的 5s 超时；不是本次生产代码改动的回归。因此：

- **Windows 门禁**：`tests/windows-port.spec.ts` + `tests/runtime.spec.ts`
- **Linux/CI 门禁**：`pnpm check`（完整 POSIX 测试）

## 四、Windows 部署注意

- `stateDir`、`executor.directory` 用盘符或 UNC 绝对路径，例如 `D:/dsh/state`、`D:/dsh/work`。
- `executor.prepare` 在 Windows 上是 **cmd.exe 语法**。建议在 `redmine-superagent` 仓库提供 `.cmd` 包装器，面板里填带引号的路径：
  `"D:\redmine-superagent\scripts\prepare-stage2-gitlab.cmd"`。
- `mailq/gateway.mjs` 本身跨平台；常驻改任务计划（`--once` 每分钟）或 NSSM（`--interval 30`），并显式设置工作目录/绝对路径。
- `taskq`/`mailq` 进 Worker PATH 时用 `.cmd` 垫片，或 prompts 里直接写 `node D:/.../taskq.mjs`。
- 令牌文件用 NTFS ACL（`icacls`）而不是 `chmod`；Worker 用专用 Windows 账号运行。
- GitLab 凭据：本 fork 的 `worker-gitconfig` 只配了 `github.com` 的 credential helper。阶段二走 GitLab HTTPS 时，需要为 GitLab host 补一条 helper（`glab auth git-credential`）或改用 SSH key。这是跨平台遗留项，不是 Windows 特有。

## 五、没有移植的部分

- `scripts/dsh-superagent`（Python + `fcntl` + tmux 的 POSIX 服务脚本）：Windows 不用它，服务交给 NSSM / 任务计划。
- Check-mj 的 Electron 桌面应用、Watchdog、按命令下发 env 的 `worker-shell-pwsh` 方案：不属于本次最小移植。
- buyou-claw 的 `isolateEnvironment` 语义改造：本 fork 仍沿用上游的 `applyEnvironment()`（改宿主进程环境），前提是 DSH 跑在专用 profile/账号里。
- POSIX 测试没有整体做 Windows 化改写（只适配了 `runtime` 的 prepare/垫片断言）；`service-script`、`environment`、`sources`、`store` 等 POSIX 专有测试在 Windows 上仍会失败。完整测试仍在 Linux/CI 跑，Windows 门禁见上。

## 六、上游同步检查清单

1. `git fetch upstream && git merge upstream/main`
2. 按本文件表格逐项核对 `[windows-port]` 标记是否还在；上游若重构了同一函数，**以官方新结构为准**，把 win32 分支移植进新结构
3. `pnpm install && pnpm typecheck && pnpm build`
4. `pnpm vitest run tests/windows-port.spec.ts`
5. Linux/CI：`pnpm check`
6. 若 `writeEnvironment()` / `workerProbe()` / `prepareArgv()` 被官方改写，重新生成 `<stateDir>/worker-bin`（删旧垫片或重跑 setup），避免标记格式变化触发 `foreignFile`
7. 合并成功后 `git tag -f upstream-base upstream/main`（如沿用基线 tag 的工作流）
