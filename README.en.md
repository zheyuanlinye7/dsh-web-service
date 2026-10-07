<div align="center">

# dsh-web-service

**Run `dsh web` as a Windows service: starts at boot, no console window, survives sign-out.**

A DeepSeek Harness plugin (MCP tools + CLI) built on the nssm and WinSW service wrappers.

[![GitHub](https://img.shields.io/badge/github-zheyuanlinye7%2Fdsh-web-service-181717.svg)](https://github.com/zheyuanlinye7/dsh-web-service)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![platform](https://img.shields.io/badge/platform-windows-0078D4.svg)](#compatibility)
[![node](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](https://nodejs.org)

[简体中文](README.md) | English

</div>

---

## Why this exists

`dsh web` is a foreground process. Close the console and the UI is gone; sign out or reboot and it never comes back. To keep a DSH host you can reach at any time, the Service Control Manager has to own it.

But a Node program **cannot be a Windows service on its own**. The SCM requires the process to call `StartServiceCtrlDispatcher` and report heartbeats; a plain `node.exe` does neither, and the SCM kills it after 30 seconds. A native wrapper (nssm, WinSW) has to sit in between.

Wiring that wrapper by hand is where the traps are. A LocalSystem service sees `~` as the system profile, not yours, so `DSH_HOME`, `USERPROFILE`, `APPDATA` and friends all have to be written into the service environment explicitly. `--no-open` must not be forgotten. Log rotation, restart policy and the graceful-stop window each have a wrong default. **This plugin gets all of it right once, instead of you getting it right every time.**

## What it does

- **Install / repair** — detects Node, `@deepseek-ai/dsh/lib/bin.js`, `$DSH_HOME`, the profile directory and an available wrapper, writes the service, starts it, and probes the port.
- **Diagnose** — reads the service log and translates "why will it not start" into plain findings: port already in use, a profile plugin incompatible with this dsh, a plugin tree that fails to import, a missing profile directory, a denied file operation. Every finding carries a concrete fix.
- **Control** — start / stop / restart, waiting for the SCM to actually report the new state instead of trusting an exit code.
- **Rehearse** — `plan` prints every command it would run and every file it would write, without touching anything.
- **Two wrappers** — nssm (public domain) and WinSW (MIT), auto-detected.

## What it does not do

- **It bundles and downloads no binaries.** It uses the nssm or WinSW already on the machine. Fetching an executable is your decision, not a plugin's.
- **It never patches dsh.** No source edits, no changes to the listen binding.
- **It needs no administrator rights to look.** `status`, `plan` and `diagnose` are read-only; only `install`, `uninstall`, `start` and `stop` need elevation.

## Install

```sh
# from GitHub
dsh plugin --profile web add "github:zheyuanlinye7/dsh-web-service"
```

Restart dsh once. The bundle patch mounts the MCP tools **disabled on purpose** — adding a package should not hand a profile administrator capability by accident. Enable the `mcp-dsh-web-service` row in the Plugins page when you want the agent to manage the service.

### Requirements

- Windows (`win32`), Node.js 22+
- A service wrapper: [nssm](https://nssm.cc/download) or [WinSW](https://github.com/winsw/winsw/releases), on PATH or anywhere within four levels of your home directory, `Program Files` or `ProgramData`. `--nssm` / `--winsw` override detection.

## Quick start

### From the command line

```sh
npx dsh-web-service status      # registered? who owns the port? does HTTP answer?
npx dsh-web-service plan        # read-only rehearsal
npx dsh-web-service install     # run elevated
npx dsh-web-service diagnose    # why is it not running
```

### Through the agent

With the MCP row enabled, ask: *"Install dsh web as a Windows service on port 3080, starting at boot."* The model gets `mcp__winsvc__service_status`, `service_plan`, `service_install`, `service_uninstall`, `service_control`, `service_diagnose` and `service_logs`.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `--name` | `dsh-web` | Service name |
| `--profile` | `web` | dsh profile to host |
| `--port` | `3080` | Listen port |
| `--host` | unset | Bind address; unset uses the profile composition. `0.0.0.0` exposes it to the LAN |
| `--dsh-home` | `$DSH_HOME`, then `~/.dsh` | Harness home |
| `--dsh-bin` | auto | Path to `@deepseek-ai/dsh/lib/bin.js` |
| `--node` | current node | `node.exe` to run |
| `--nssm` / `--winsw` | auto | Wrapper executable |
| `--account` | `LocalSystem` | Service account |
| `--log` | `<home>\<name>.log` | Service log, 10 MB rotation |
| `--force` | `false` | Delete and recreate an existing service |
| `--json` | `false` | Machine-readable output (CLI) |

## How it works

Five things have to be right:

1. **What runs** — `node.exe <...>\dsh\lib\bin.js web --no-open --port 3080`
2. **The environment it runs in** — as LocalSystem, `~` is the system profile, so `DSH_HOME`, `USERPROFILE`, `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA` and `TEMP` are all written into the service environment. Without them dsh looks in `C:\Windows\System32\config\systemprofile\.dsh` and reports that the profile does not exist.
3. **Working directory** — a real directory, or relative path resolution breaks.
4. **Logging** — stdout and stderr to one file with 10 MB rotation, or a month of uptime becomes gigabytes.
5. **After exit** — `AppRestartDelay 2000` plus `AppExit Default Restart` bring it back after a crash; `AppStopMethodConsole 5000` gives it five seconds to leave cleanly.

More in [docs/architecture.md](docs/architecture.md).

## Troubleshooting

These are not hypothetical. They are the failures this tool was written in response to; the long form is [docs/troubleshooting.md](docs/troubleshooting.md).

### The service loops on `EADDRINUSE`

Something already owns the port, usually the `dsh web` you started by hand earlier. The service binds, fails, exits, and nssm restarts it two seconds later, forever. Stop the other instance or choose another `--port`.

### A dsh upgrade broke it

```
dsh: skipping profile bundle "dshmarket": Error: Plugin dshmarket@1.18.1
is incompatible with dsh 0.2.0-rc.2: peerDependencies { ... }
```

A profile plugin declares peers the new runtime does not satisfy. dsh responds by *skipping the bundle*: it stays installed but is never mounted, so its UI silently disappears. Update the plugin or grant it an exact-version exemption.

### The plugin tree will not load at all

```
Error: dsh: plugin tree failed to load: failed to apply loader entry
include (cordis:include): failed to import loader entry dsh-lan-guard
```

One plugin throws during import and takes the whole tree down; dsh exits and the service restart-loops. Update, disable or remove the package named in the log.

### `diagnose` reports old failures

A rotating log keeps every past crash forever. While the service is **running and answering HTTP**, log-derived errors are demoted to `INFO` and marked as earlier failures; only current problems are reported as errors.

## Security

Installing a service needs administrator rights; nothing else does. `--host 0.0.0.0` exposes the UI to the whole LAN — dsh still requires its browser session token, but if you have patched that gate away, every device that reaches the port controls the agent, including its file and command access.

## Compatibility

| | |
| --- | --- |
| Platform | Windows (`win32`) |
| Node.js | >= 22 |
| dsh | `>=0.2.0-rc.1 <0.3.0` (`dsh.engines`) |
| Wrappers | nssm (public domain), WinSW (MIT) |

## Development

```sh
node test/run-tests.mjs     # 17 unit tests, no machine state touched
node test/mcp-list.mjs      # real stdio handshake + tools/list
node mcp/server.mjs --self-test
```

The log fixtures are verbatim excerpts from a real machine: every rule in `src/diagnose.mjs` corresponds to a failure that actually happened.

## License

MIT. No third-party binary is bundled or redistributed; see [THIRD_PARTY.md](THIRD_PARTY.md).
