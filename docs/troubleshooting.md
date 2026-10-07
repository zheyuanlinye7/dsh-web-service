# Troubleshooting

Run `dsh-web-service diagnose` first: it reads the service log and the machine
state and prints findings with a suggested fix. This page explains what those
findings mean and what to do when the tool says everything is fine but it is
not.

## The service will not stay running

### `EADDRINUSE`

```
Error: listen EADDRINUSE: address already in use 0.0.0.0:3080
dsh: startup failed: 2 required plugins did not activate
Failed plugins (1):
  webserver (required)
```

Something else owns the port. Nine times out of ten it is the interactive
`dsh web` you started in a console to keep working while the service was broken.
The service process starts, cannot bind, exits; the wrapper restarts it two
seconds later; the log grows by ~200 lines a minute.

`status` prints the current owner:

```
port      3080  held by node.exe:5848
```

Stop that process, or install on a different `--port`. Note that the port can be
held by a program that is not dsh at all - `status` shows the process name so the
distinction is visible.

### It starts, then disappears with no error

Check the log path `status` reports. If the file does not exist, the wrapper was
never told where to write, or the service account cannot create it. A service
running as a non-system account needs write access to the log directory.

## A dsh upgrade broke a previously working service

```
dsh: skipping profile bundle "dshmarket": Error: Plugin dshmarket@1.18.1
is incompatible with dsh 0.2.0-rc.2: peerDependencies { ... }
dsh: it stays installed but profile startup denies it until you grant an exemption
```

This is dsh being careful, not broken. The plugin declares peer dependencies the
new runtime does not satisfy, so dsh **skips the bundle**: the package stays on
disk, but nothing is mounted, and the feature it provided disappears from the UI
without an error dialog.

Three ways out, in order of preference:

1. Update the plugin: `dsh plugin --profile web add <name>@latest`
2. Remove it from the profile bundle list if you no longer need it
3. Grant the exact-version exemption if you accept the risk:
   `dsh plugin --profile web allow-version <name>@<version> --dsh-version <runtime> --accept-risk`

`diagnose` names the plugin, its version and the runtime version, so you do not
have to read the whole message.

## The plugin tree fails to load and dsh exits

```
Error: dsh: plugin tree failed to load: failed to apply loader entry include
(cordis:include): failed to import loader entry dsh-lan-guard (dsh-lan-guard):
z.boolean(...).default(...).volatile is not a function
```

One plugin throws during its import and takes the entire tree with it. Because
the process exits, the wrapper restarts it, and the whole thing repeats: this is
the failure mode that produces hundreds of identical stack traces in the log.

The package name is in the message. Update it, disable its row in the profile
patch, or remove it. If the package is not even declared in the profile
`package.json` - a leftover from an earlier experiment - a `pnpm install` in the
profile directory prunes it.

## The service runs, but the UI is unreachable

Distinguish the layers before changing anything:

```sh
sc query dsh-web                                   # does the SCM think it runs
dsh-web-service status                             # port owner + HTTP probe
curl -v http://127.0.0.1:3080/                     # from the host itself
curl -v http://<lan-ip>:3080/                      # from the host, by LAN address
```

Then from another machine on the network:

```powershell
Test-NetConnection <host-ip> -Port 3080   # TCP layer
curl.exe -v http://<host-ip>:3080/        # HTTP layer
```

- **TCP fails from another machine but works locally** - the problem is the
  network, not DSH: a different subnet, a switch or AP with client isolation, a
  second router handing out the same address range, or the Windows firewall
  profile that applies to the active network category. Check `arp -a` on the host
  for the client address: a same-subnet client that never appears in the ARP
  table was never on the same layer 2 segment.
- **TCP works, HTTP returns 401** - dsh's browser session gate. Open the URL
  printed in the log (`dsh web: http://…/?token=…`) once; it exchanges the token
  for a signed cookie that survives restarts.
- **TCP works, HTTP returns 403** - the Host/Origin trust fence. Access by the
  address the server advertises on, not by a name that is not in its trusted
  host list.
- **TCP works, HTTP works, the page never finishes loading** - a large first load
  (the client bundle is several megabytes) on a slow link, or a browser
  auto-upgrading the URL to `https://`. `https` against a plain-http port fails
  immediately; if your browser is set to HTTPS-first, allow the exception.

## The service is fine but `diagnose` mentions old errors

That is intentional and it is labelled. A rotating log keeps every past failure;
when the service is running and its endpoint answers, log-derived errors are
demoted to `INFO` and prefixed with "Earlier failure kept in the log". A
`service-healthy` finding is added at the same time. If you see a finding
without that prefix, it is current.

## `install` says no service wrapper was found

Install nssm or WinSW, or point at it:

```sh
dsh-web-service install --nssm "C:\tools\nssm-2.24\win64\nssm.exe"
```

Detection looks at PATH first, then a set of shallow locations, then walks your
home directory, `Program Files`, `Program Files (x86)` and `ProgramData` up to
four levels deep, preferring 64-bit builds. Layouts like
`%USERPROFILE%\frp\nssm-2.24\win64\nssm.exe` are found by the walk.

## Installing fails with access denied

Registering a service needs administrator rights. `plan`, `status`, `diagnose`
and `logs` do not - use them to prepare, then run `install` from an elevated
terminal. The MCP tools inherit whatever rights the dsh process has, so an agent
running unelevated cannot install a service either; it can still diagnose one.

## After changing the dsh installation

If dsh moves (a different npm prefix, a different Node), repoint the service by
re-running install with `--force`:

```sh
dsh-web-service install --force
```

This deletes and recreates the service with the paths that are current now.
