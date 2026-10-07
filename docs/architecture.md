# Architecture

## The problem shape

Node cannot be a Windows service directly. The SCM requires the process to call
`StartServiceCtrlDispatcher` and answer `SERVICE_CONTROL_INTERROGATE`; a plain
`node.exe` does neither, so the SCM reports error 1053 and kills the process
after about 30 seconds. A native wrapper therefore has to sit between the SCM
and Node, and the whole product is really about configuring that wrapper
correctly.

Two wrappers are supported. They are different enough that the abstraction is
explicit rather than pretended away.

| | nssm | WinSW |
| --- | --- | --- |
| Configuration | `nssm set <name> <key> <value>`, one call per key | one XML document next to the executable |
| Environment | `AppEnvironmentExtra KEY=VALUE ...` | `<env name="K" value="V"/>` |
| Log rotation | `AppRotateFiles` / `AppRotateOnline` / `AppRotateBytes` | `<log mode="roll-by-size">` |
| Removal | `nssm remove <name> confirm` | `winsw uninstall <xml>` |

## Layers

```
bin/dsh-web-service.mjs     CLI: argument parsing, human and JSON output
mcp/server.mjs              MCP stdio server: same actions as tools
        |                   (both import only src/)
        v
src/service.mjs             plan -> steps -> execution; SCM queries; HTTP probe
src/diagnose.mjs            log signature parsing and machine-state findings
src/wrapper.mjs             nssm and WinSW adapters, both producing steps
src/detect.mjs              node, dsh bin, DSH_HOME, profile, wrapper, processes
src/util.mjs                process execution, Windows quoting, path helpers
```

Nothing below `src/service.mjs` performs an action. Every mutation is emitted as
a *step*:

```js
{ type: 'run',   command: '…\\nssm.exe', args: ['set', 'dsh-web', 'Application', '…'], note: 'point at node.exe' }
{ type: 'write', path: '…\\dsh-web.xml', content: '<service>…</service>', note: 'write the WinSW definition' }
```

That one decision is what makes `plan` honest: the rehearsal prints the same
steps the installer would execute, and `--dry-run` is a loop that prints instead
of spawning.

## Why the environment block is written by hand

This is the single most common reason a hand-rolled DSH service starts and then
immediately exits with "the profile does not exist".

A Windows service runs under the account named by `ObjectName`; by default that
is `LocalSystem`. `LocalSystem`'s profile is
`C:\Windows\System32\config\systemprofile`, so:

- `homedir()` resolves to the system profile, and
- `~/.dsh` resolves to `C:\Windows\System32\config\systemprofile\.dsh`.

Your profiles are somewhere else entirely. The fix is not to copy them; it is to
tell the service where home is:

```
DSH_HOME      = C:\Users\<you>\.dsh
USERPROFILE   = C:\Users\<you>
HOMEDRIVE     = C:
HOMEPATH      = \Users\<you>
APPDATA       = C:\Users\<you>\AppData\Roaming
LOCALAPPDATA  = C:\Users\<you>\AppData\Local
TEMP/TMP      = C:\Users\<you>\AppData\Local\Temp
```

`src/service.mjs` derives all of these from the harness home with
`userHomeFor()` and `profileEnvironment()`, which is why `--dsh-home` is the one
option that has to be right.

## The quoting rule

nssm stores its `AppParameters` as a **single string**, not an argument vector.
Handing it `"C:\Program Files\nodejs\node.exe" a b` means the C runtime will
re-split that string with `CommandLineToArgvW` rules, and a naive join produces
the wrong vector the moment a path contains a space or a quote.
`quoteWindowsArg()` implements the MSVCRT algorithm - doubling backslashes that
precede a quote, escaping embedded quotes - and `buildWindowsCommandLine()`
composes the vector with it. WinSW has the same requirement inside its
`<arguments>` element.

## Diagnostics are text rules on purpose

By the time a service has been restart-looping for ten minutes, the only
surviving evidence is what the wrapper copied into one rotating log. dsh does not
structured-log its startup failures, so `src/diagnose.mjs` matches the exact
phrases dsh prints:

| Signature | Meaning |
| --- | --- |
| `listen EADDRINUSE … address already in use HOST:PORT` | port conflict; the process starts and dies immediately |
| `skipping profile bundle "X": … Plugin X@V is incompatible with dsh D` | a plugin's peers do not satisfy the runtime; the bundle is not mounted |
| `plugin tree failed to load: … failed to import loader entry X` | one plugin throws at import; dsh exits |
| `startup failed: N required plugins did not activate` | the follow-up block names them |
| `ENOENT … profiles …` | `DSH_HOME` is wrong for the service account |
| `EACCES` / `EPERM` | the service account cannot reach a path |

### Historical versus current

A rotating log never forgets. If the service is running **and** its HTTP
endpoint answers, every log-derived error is demoted to an informational note
labelled as an earlier failure, and a `service-healthy` finding is added. Only
live problems are reported as errors. Without that rule the tool would accuse a
perfectly healthy service of the crash it had last week.

### Reading what is already installed

`status` does not assume the defaults it would have written. It reads
`HKLM\SYSTEM\CurrentControlSet\Services\<name>\Parameters` and reports the
`AppParameters` and `AppStdout` the service was actually configured with. That is
how `diagnose` finds the right log file for a service somebody else set up -
including one whose log is not named after the service. (PowerShell decorates
registry objects with `PSPath`, `PSDrive` and a provider reflection graph; those
keys are stripped before the value leaves the module.)

## MCP transport

The server speaks both framings and picks one by looking at the first bytes on
stdin: `Content-Length:` headers (LSP-style) or newline-delimited JSON. It keeps
no state between requests and starts in milliseconds, because the MCP client
spawns a throwaway probe process before the serving one.

Logging goes to stderr only. A stray `console.log` on stdout corrupts the
protocol and is the classic way a hand-written MCP server fails.

## Deliberate omissions

- **No binary download.** Shipping a fetch-and-execute path for a service
  wrapper would turn a convenience feature into a supply-chain decision made on
  the user's behalf. The plugin reports what it found and how to install a
  wrapper; it never fetches one.
- **No source patching.** Nothing is written into the dsh installation.
- **Read-only by default where possible.** `status`, `plan` and `diagnose` never
  mutate. Only the five action verbs do, and those are the ones that need
  elevation.
