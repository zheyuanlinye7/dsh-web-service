<div align="center">

# dsh-web-service

**把 `dsh web` 变成 Windows 服务：开机自启、无黑窗、注销也在跑。**

一个 DeepSeek Harness 插件（MCP 工具 + 命令行），底层用 nssm 或 WinSW 托管的服务包装器。

[![GitHub](https://img.shields.io/badge/github-zheyuanlinye7%2Fdsh-web-service-181717.svg)](https://github.com/zheyuanlinye7/dsh-web-service)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-windows-0078D4.svg)](#兼容性)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)

简体中文 | [English](README.en.md)

</div>

---

## 为什么需要它

`dsh web` 是一个前台进程：关掉那个命令行窗口，Web UI 就没了；注销、重启之后它也不会自己回来。想做一台"随时能连的 DSH 主机"，就必须把它交给 Windows 服务控制管理器（SCM）。

但 Node 程序**不能直接当 Windows 服务**——SCM 要求程序调用 `StartServiceCtrlDispatcher` 并周期性上报心跳，一个普通的 `node.exe` 做不到，30 秒后就会被 SCM 判定为无响应而杀掉。所以必须有一个原生包装器（nssm、WinSW）夹在中间。

手工配置这个包装器有一堆坑：LocalSystem 账户下 `~` 指向的是系统配置目录而不是你的用户目录，于是 `DSH_HOME`、`USERPROFILE`、`APPDATA` 全都得显式写进服务环境变量；`--no-open` 不能忘；日志轮转、重启策略、优雅停止窗口都要设。**这个插件把这些一次性做对。**

## 它做什么

- **安装/修复服务**：探测 node、`@deepseek-ai/dsh/lib/bin.js`、`$DSH_HOME`、profile 目录、服务包装器，生成完整参数并注册服务，然后启动并探测端口。
- **诊断**：解析服务日志，把"为什么起不来"翻译成人话——端口被占、profile 插件与新版本 dsh 不兼容、插件树加载失败、profile 目录不存在、权限被拒。每条结论都给出可执行的修复建议。
- **控制**：start / stop / restart，并等待 SCM 真正报告新状态，而不是把 `sc start` 的退出码当成结果。
- **零副作用预演**：`plan` 会打印出将要执行的每一条命令和将要写入的每一个文件，一个字节都不落盘。
- **两种包装器**：nssm（公有领域）和 WinSW（MIT），自动探测，不需要手工指定路径。

## 它不做什么

- **不打包也不下载任何二进制**。它只用机器上已有的 nssm 或 WinSW。下载可执行文件这件事应该由你决定，而不是由插件替你决定。
- **不改动 dsh 本体**。不 patch DSH 源码，不碰它的监听绑定。
- **不需要管理员权限来看**。`status`、`plan`、`diagnose` 全是只读的；只有 `install` / `uninstall` / `start` / `stop` 需要提权。

## 安装

```sh
# 从 GitHub 安装
dsh plugin --profile web add "github:zheyuanlinye7/dsh-web-service"
```

装完 **重启一次 dsh**。插件包的 `cordis.patch.yml` 会把 MCP 工具挂上去，但**默认是关的**：

```yaml
- id: mcp-dsh-web-service
  name: '@deepseek-ai/dsh-mcp-client'
  disabled: true      # 装个包不该顺带获得管理员能力
```

想用 agent 管理服务，就在 Plugins 页面把这一行打开（或把 `disabled` 改成 `false`）再重启。

### 前置条件

- Windows（`win32`），Node.js 22+
- 一个服务包装器：[nssm](https://nssm.cc/download) 或 [WinSW](https://github.com/winsw/winsw/releases)
  - 放在 PATH 上，或者任意常见位置（`%USERPROFILE%` 下 4 层以内、`Program Files`、`ProgramData`），插件会自动找到；也可以用 `--nssm` / `--winsw` 显式指定。

## 快速开始

### 命令行

```sh
# 先看现状：服务在不在、谁占着端口、HTTP 通不通、日志在哪
npx dsh-web-service status

# 看它打算做什么（只读，不改任何东西）
npx dsh-web-service plan

# 以管理员身份执行
npx dsh-web-service install

# 起不来的时候问它为什么
npx dsh-web-service diagnose
```

### 让 agent 来做

打开 MCP 工具行之后，直接跟 agent 说：

> 把 dsh web 装成 Windows 服务，端口 3080，开机自启。

模型会看到这些工具：

| 工具 | 作用 |
| --- | --- |
| `mcp__winsvc__service_status` | 服务状态、端口占用者、HTTP 探测、日志路径 |
| `mcp__winsvc__service_plan` | 预演安装，不改动任何东西 |
| `mcp__winsvc__service_install` | 创建/重写服务并启动 |
| `mcp__winsvc__service_uninstall` | 停止并删除服务 |
| `mcp__winsvc__service_control` | start / stop / restart |
| `mcp__winsvc__service_diagnose` | 读日志解释失败原因 |
| `mcp__winsvc__service_logs` | 打印日志尾部 |

## 配置项

CLI 与 MCP 工具共用同一组选项（CLI 用 `--dry-run`，MCP 用 `dryRun: true`）：

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `--name` / `name` | `dsh-web` | 服务名 |
| `--profile` / `profile` | `web` | 要托管的 dsh profile |
| `--port` / `port` | `3080` | 监听端口 |
| `--host` / `host` | 不传 | 绑定地址；不传就用 profile 里组合出来的值。想让局域网直连就传 `0.0.0.0` |
| `--dsh-home` / `dshHome` | `$DSH_HOME` → `~/.dsh` | harness 主目录 |
| `--dsh-bin` / `dshBin` | 自动探测 | `@deepseek-ai/dsh/lib/bin.js` |
| `--node` / `node` | 当前 node | 服务要跑的 `node.exe` |
| `--nssm` / `nssm` | 自动探测 | nssm.exe 路径 |
| `--winsw` / `winsw` | 自动探测 | WinSW 可执行文件路径 |
| `--account` / `account` | `LocalSystem` | 服务账户 |
| `--log` / `log` | `<用户目录>\<服务名>.log` | 服务日志（stdout 与 stderr 合并，10 MB 轮转） |
| `--force` / `force` | `false` | 服务已存在时先删除再重建 |
| `--json` | `false` | 机器可读输出（CLI） |

## 工作原理

安装一个服务，本质上就是把这五件事写对：

1. **谁来跑**：`node.exe <...>\dsh\lib\bin.js web --no-open --port 3080`
2. **在什么环境下跑**：因为服务以 LocalSystem 身份运行，`~` 是系统配置目录。所以 `DSH_HOME`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`TEMP` 都必须显式写进服务环境，否则 dsh 会去 `C:\Windows\System32\config\systemprofile\.dsh` 找 profile——然后告诉你 profile 不存在。
3. **工作目录**：必须是一个真实存在的目录，否则某些相对路径解析会失败。
4. **日志**：stdout 与 stderr 指向同一个文件，开轮转（10 MB，保留一份），否则跑一个月就是几个 GB。
5. **退出之后**：`AppRestartDelay 2000` + `AppExit Default Restart` 让它崩了自动回来；`AppStopMethodConsole 5000` 给它 5 秒优雅退出。

更多实现细节见 [docs/architecture.md](docs/architecture.md)。

## 故障排查

这些不是假想的场景，是这套工具在真机上被写出来的原因。完整版见 [docs/troubleshooting.md](docs/troubleshooting.md)。

### 服务在重启循环里刷 `EADDRINUSE`

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3080
```

已经有一个 `dsh web` 占着端口——通常是你之前手动起的那个。服务进程启动、绑定失败、退出，nssm 两秒后重启它，周而复始。先停掉手动实例，或者换一个 `--port`。

### 更新 dsh 之后服务就废了

```
dsh: skipping profile bundle "dshmarket": Error: Plugin dshmarket@1.18.1
is incompatible with dsh 0.2.0-rc.2: peerDependencies { ... }
```

某个 profile 插件的 peer 依赖对不上新版运行时。dsh 的策略是**跳过这个 bundle**：包还在磁盘上，但启动时不会挂载，于是它的界面直接消失。升级那个插件，或者给它授权精确版本豁免。

### 插件树整个加载不了

```
Error: dsh: plugin tree failed to load: failed to apply loader entry
include (cordis:include): failed to import loader entry dsh-lan-guard
```

一个插件的 import 阶段就抛异常，整棵树跟着挂掉，dsh 直接退出——服务于是重启循环。找出日志里那个包名，升级、禁用或移除它。

### `diagnose` 把历史错误也报出来了

日志是轮转追加的，历史上崩过的记录永远在里面。所以当服务**正在运行且 HTTP 有响应**时，日志里的 `ERROR` 会被降级成 `INFO` 并标注"日志里保留的早期失败"，只有真正当前的故障才报 ERROR。

## 安全说明

安装服务需要管理员权限，请在有权限的终端里执行（`install` 之外的动作都不需要）。

`--host 0.0.0.0` 会把 Web UI 暴露到整个局域网。dsh 自身对 Web UI 有基于 token 的浏览器会话鉴权，但如果你另外打过绕过鉴权的补丁，那么**任何能访问该端口的设备都能完全控制这台机器上的 agent**——包括它的文件访问和命令执行能力。想清楚再开。

## 兼容性

| 项 | 值 |
| --- | --- |
| 平台 | Windows（`win32`） |
| Node.js | >= 22 |
| dsh | `>=0.2.0-rc.1 <0.3.0`（声明于 `dsh.engines`） |
| 包装器 | nssm（公有领域）、WinSW（MIT） |

## 开发

```sh
node test/run-tests.mjs     # 17 个单元测试，不碰机器状态
node test/mcp-list.mjs      # 真实 stdio 管道的 MCP 握手 + tools/list
node mcp/server.mjs --self-test
```

测试里的日志样本是从真机上逐字摘下来的——`src/diagnose.mjs` 的每一条规则都对应一次真实故障，不是猜的。

## 许可

MIT。本项目不包含也不分发任何第三方二进制；nssm 与 WinSW 的授权说明见 [THIRD_PARTY.md](THIRD_PARTY.md)。
