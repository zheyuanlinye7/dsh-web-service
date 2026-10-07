# Changelog

All notable changes to this project are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-10-07

First release.

### Added

- `install` / `uninstall` / `start` / `stop` / `restart` / `status` / `plan` /
  `diagnose` / `logs`, available both as a CLI and as MCP tools.
- Wrapper adapters for nssm and WinSW behind one step-based plan shape, so
  `plan` can print the exact commands and files an install would produce.
- Wrapper detection: PATH, a set of shallow probes, then a bounded breadth-first
  walk of the home directory, `Program Files`, `Program Files (x86)` and
  `ProgramData`, preferring 64-bit builds.
- A service environment builder that writes `DSH_HOME`, `USERPROFILE`,
  `HOMEDRIVE`, `HOMEPATH`, `APPDATA`, `LOCALAPPDATA`, `TEMP` and `TMP`, because
  a LocalSystem service does not inherit the invoking user's profile.
- A diagnostic engine with rules for: `EADDRINUSE` restart loops, profile
  plugins skipped for peer incompatibility, a plugin tree that fails to import,
  required plugins that never activate, a missing profile directory, and denied
  file operations.
- Log-derived findings are demoted to notes while the service is running and its
  endpoint answers, so a healthy service is not reported as broken on the
  strength of an old crash.
- `status` reads the log path, argument vector and environment an already
  installed service was configured with, straight from the service parameters,
  rather than assuming the defaults it would have written itself.
- MCP stdio server speaking both newline-delimited JSON and LSP-style
  `Content-Length` framing, detected from the first bytes the client writes.
- 17 unit tests, including log fixtures taken verbatim from a real machine, and
  an end-to-end MCP handshake test over a real stdio pipe.

### Notes

- Nothing is downloaded or bundled: the plugin uses the nssm or WinSW already
  present on the machine.
- The MCP entry is inserted disabled, so installing the package does not grant
  a profile administrator capability by itself.

[0.1.0]: https://github.com/zheyuanlinye7/dsh-web-service/releases/tag/v0.1.0
