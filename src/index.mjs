/**
 * dsh-web-service — run `dsh web` as a Windows service.
 *
 * The public surface is deliberately small: everything the CLI and the MCP
 * server do goes through these exports.
 */
export { DEFAULTS, buildPlan, control, executeSteps, install, probeHttp, profileEnvironment, serviceQuery, status, tailLog, uninstall, userHomeFor, waitForState } from './service.mjs';
export { diagnose, detectDrift, parseLogSignatures } from './diagnose.mjs';
export { adapterFor, nssmAdapter, renderWinswXml, winswAdapter } from './wrapper.mjs';
export { findWrapper, listDshProcesses, portOwners, processInfo, resolveDshBin, resolveDshHome, resolveNode, resolveProfileDir, survey } from './detect.mjs';
export { buildWindowsCommandLine, isDir, isFile, quoteWindowsArg, run, runPowerShell, which } from './util.mjs';
