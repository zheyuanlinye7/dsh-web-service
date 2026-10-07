# Third-party notices

This project **bundles and redistributes no third-party binary**. It shells out
to a service wrapper that is already installed on the machine, chosen by the
user. The wrappers it knows how to drive are listed here for attribution.

## nssm — the Non-Sucking Service Manager

- Upstream: <https://nssm.cc/>
- License: public domain. The upstream distribution states that nssm is public
  domain software and may be used freely, including commercially.
- This project invokes `nssm.exe` as an external program. It does not link
  against it, embed it, or ship a copy of it.

## WinSW

- Upstream: <https://github.com/winsw/winsw>
- License: MIT.
- This project writes a WinSW XML service definition next to the executable the
  user supplies and invokes it as an external program. It does not ship a copy
  of WinSW.

## Node.js

- Upstream: <https://nodejs.org/>
- License: MIT (plus third-party licenses for bundled components).
- The service runs the `node.exe` already present on the machine, normally the
  one that runs dsh itself.

## DeepSeek Harness (dsh)

- The service starts `@deepseek-ai/dsh/lib/bin.js` from the user's own global
  installation. No dsh source file is modified, copied or redistributed.
- The optional MCP bridge uses the in-box `@deepseek-ai/dsh-mcp-client` package,
  referenced as a peer of the host rather than vendored here.
