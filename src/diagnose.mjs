/**
 * Diagnostics.
 *
 * Every rule here comes from a failure that actually happened on a real
 * machine. The parser is deliberately text-based: dsh writes plain lines to
 * stdout/stderr, the wrapper copies them into one rotating log, and that log
 * is the only surviving evidence once the SCM has restarted the process a few
 * hundred times.
 */
import path from 'node:path';
import { isDir, isFile, normalize } from './util.mjs';
import { serviceQuery, status, tailLog, userHomeFor } from './service.mjs';

/**
 * Turn a log tail into structured findings.
 *
 * @param {string} text the log tail.
 * @returns {Array<object>} findings.
 */
export function parseLogSignatures(text) {
  const findings = [];
  const source = String(text ?? '');

  const portConflict = /listen\s+(EADDRINUSE)[^\n]*/i.exec(source);
  if (portConflict) {
    const address = /address already in use\s+(\S+)/i.exec(portConflict[0]);
    findings.push({
      severity: 'error',
      code: 'port-in-use',
      title: 'The service cannot bind its port',
      detail: address ? 'Address already in use: ' + address[1] : portConflict[0].trim(),
      fix: 'Stop whatever is listening on that port (an interactive "dsh web" is the usual owner), then start the service again. Use the status action to see the current owner.',
    });
  }

  const skipped = [...source.matchAll(/skipping profile bundle "([^"]+)": Error: Plugin ([^\s]+) is incompatible with dsh ([^:]+):\s*peerDependencies (\{[^}]*\})/g)];
  for (const match of skipped) {
    findings.push({
      severity: 'error',
      code: 'plugin-incompatible',
      title: 'A profile plugin is incompatible with this dsh runtime',
      detail: match[2] + ' cannot load on dsh ' + match[3].trim() + ' (needs ' + match[4] + '). The bundle is skipped, so its features disappear from the UI.',
      fix: 'Update the plugin ("dsh plugin --profile <profile> add <name>@latest"), or grant the exact-version exemption, or remove it from the profile bundles.',
      plugin: match[2],
      dshVersion: match[3].trim(),
    });
  }

  const treeFailure = /plugin tree failed to load: ([^\n]+)/i.exec(source);
  if (treeFailure) {
    findings.push({
      severity: 'error',
      code: 'plugin-tree-failed',
      title: 'The profile plugin tree failed to load, so dsh exits',
      detail: treeFailure[1].trim().slice(0, 500),
      fix: 'One plugin threw during import. Find it in the message above, then update, disable or remove it in the profile patch before restarting.',
    });
  }

  const startupFailed = /startup failed:\s*(\d+)\s+required plugins did not activate/i.exec(source);
  if (startupFailed) {
    const block = source.slice(startupFailed.index, startupFailed.index + 2000);
    const names = [...new Set([...block.matchAll(/^\s{2}([\w@/.\-]+)\s+\(required\)/gm)].map((m) => m[1]))];
    findings.push({
      severity: 'error',
      code: 'required-plugin-failed',
      title: startupFailed[1] + ' required plugin(s) did not activate',
      detail: names.length ? names.join(', ') : block.split(/\r?\n/).slice(0, 12).join(' | ').slice(0, 400),
      fix: 'The most common cause is a port already in use or a plugin that cannot import. Read the "Failed plugins" block in the log for the exact error.',
      plugins: names,
    });
  }

  const missingProfile = /ENOENT[^\n]*profiles[^\n]*/i.exec(source);
  if (missingProfile) {
    findings.push({
      severity: 'error',
      code: 'profile-missing',
      title: 'The service cannot find its profile directory',
      detail: missingProfile[0].trim().slice(0, 300),
      fix: 'DSH_HOME is wrong for the service account. Re-run install with the correct --dsh-home (it must be the harness home that owns the profile).',
    });
  }

  const permission = /(EACCES|EPERM)[^\n]*/i.exec(source);
  if (permission) {
    findings.push({
      severity: 'warn',
      code: 'permission-denied',
      title: 'A file operation was denied',
      detail: permission[0].trim().slice(0, 300),
      fix: 'The service account cannot reach that path. Running as LocalSystem normally avoids this; when you install with --account, grant that account access to DSH_HOME and the log directory.',
    });
  }

  return findings;
}

/**
 * Diagnose one installed service end to end.
 *
 * @param {object} [options] the same options {@link status} accepts, plus `logLines`.
 * @returns {Promise<object>} findings plus the raw status.
 */
export async function diagnose(options = {}) {
  const current = await status(options);
  const findings = [];

  if (!current.installed) {
    findings.push({
      severity: 'info',
      code: 'not-installed',
      title: 'No service with this name is registered',
      detail: current.serviceName + ' was not found by the Service Control Manager.',
      fix: 'Run the install action to create it.',
    });
  }

  // status() already resolved the log the service actually writes, so trust it
  // instead of re-deriving a default that an existing service may not match.
  const logPath = normalize(options.logPath ?? current.logPath);
  // A rotating log keeps every past failure forever, so a healthy service would
  // otherwise be reported as broken on the strength of last month's crash loop.
  // Failures from the log are therefore demoted to notes while the service is
  // up and its endpoint answers.
  const healthy = current.installed && current.state === 'RUNNING' && current.probe?.ok === true;
  const tail = tailLog(logPath, Number(options.logLines ?? 400));
  if (tail) {
    for (const finding of parseLogSignatures(tail)) {
      findings.push(
        healthy && finding.severity === 'error'
          ? { ...finding, severity: 'info', historical: true, title: 'Earlier failure kept in the log: ' + finding.title }
          : finding,
      );
    }
  }
  if (healthy) {
    findings.push({
      severity: 'info',
      code: 'service-healthy',
      title: 'The service is running and its HTTP endpoint answers',
      detail: current.serviceName + ' is ' + current.state + '; HTTP ' + current.probe.status + ' in ' + current.probe.ms + 'ms.',
      fix: null,
    });
  }

  if (!current.dshBin.path) {
    findings.push({
      severity: 'error',
      code: 'dsh-bin-missing',
      title: 'The dsh entry point could not be located',
      detail: 'Checked: ' + current.dshBin.checked.slice(0, 5).join(', '),
      fix: 'Pass --dsh-bin with the absolute path to @deepseek-ai/dsh/lib/bin.js, then re-run install to rewrite the service arguments.',
    });
  }
  if (!isDir(current.dshHome.path)) {
    findings.push({
      severity: 'error',
      code: 'dsh-home-missing',
      title: 'The harness home does not exist',
      detail: current.dshHome.path + ' (from ' + current.dshHome.source + ')',
      fix: 'Point --dsh-home at the directory that contains profiles\\<name>, or run dsh once for this account so it creates one.',
    });
  }

  if (current.installed && current.state === 'STOPPED') {
    const running = current.listeners.filter((entry) => {
      return !current.dshProcesses.some((proc) => proc.pid === entry.pid);
    });
    if (running.length > 0) {
      findings.push({
        severity: 'error',
        code: 'port-held-while-stopped',
        title: 'The service is stopped but its port is still held',
        detail: running.map((l) => (l.processName ?? 'pid ' + l.pid) + ' on ' + l.address + ':' + l.port).join(', '),
        fix: 'Stop that process (or pick another --port) before starting the service.',
      });
    }
  }

  if (current.installed && current.state === 'RUNNING' && current.probe && !current.probe.ok) {
    findings.push({
      severity: 'warn',
      code: 'running-but-unreachable',
      title: 'The service is running but its HTTP endpoint does not answer',
      detail: current.probe.error ?? 'no response',
      fix: 'The process may still be starting. Check the log tail; a slow profile (many plugins) can take ten seconds or more.',
    });
  }

  if (current.wrapper === null) {
    findings.push({
      severity: 'info',
      code: 'wrapper-not-detected',
      title: 'No service wrapper is available for repair operations',
      detail: 'Neither nssm nor WinSW was found on this machine.',
      fix: 'Install nssm or WinSW, or pass --nssm/--winsw with its absolute path.',
    });
  }

  const order = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => (order[a.severity] ?? 3) - (order[b.severity] ?? 3));

  return {
    serviceName: current.serviceName,
    installed: current.installed,
    state: current.state,
    probe: current.probe,
    logPath,
    logTailLines: tail ? tail.split('\n').length : 0,
    findings,
    ok: findings.every((finding) => finding.severity !== 'error'),
  };
}

/**
 * Compare the stored service arguments with the current machine state, which
 * is how a dsh upgrade that moved the installation is caught before it turns
 * into a crash loop.
 *
 * @param {string} serviceName the service name.
 * @param {object} wrapper the detected wrapper.
 * @returns {object} drift report.
 */
export function detectDrift(serviceName, wrapper) {
  const query = serviceQuery(serviceName);
  if (!query.installed) return { installed: false, drift: [] };
  const drift = [];
  const registry = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + serviceName + '\\Parameters';
  return { installed: true, registry, drift, raw: query.raw };
}
