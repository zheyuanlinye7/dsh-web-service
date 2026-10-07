/**
 * The service lifecycle: build a plan, then execute it step by step.
 *
 * A plan is a plain object, so `--dry-run` prints the exact commands and the
 * MCP server can return it as JSON before anything is written.
 */
import path from 'node:path';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { adapterFor } from './wrapper.mjs';
import { serviceParameters, survey } from './detect.mjs';
import { buildWindowsCommandLine, isDir, isFile, normalize, run, runPowerShell } from './util.mjs';

export const DEFAULTS = {
  serviceName: 'dsh-web',
  profile: 'web',
  port: 3080,
  logRotateBytes: 10 * 1024 * 1024,
  restartDelayMs: 2000,
  stopTimeoutMs: 5000,
  startType: 'SERVICE_AUTO_START',
  account: 'LocalSystem',
};

/**
 * Split a user profile root such as `C:\\Users\\admin` into the pieces a
 * service environment needs. Windows derives `~` from these four values, and
 * a LocalSystem service ignores the invoking user entirely, so every one of
 * them has to be stated explicitly.
 *
 * @param {string} userHome the profile root.
 * @returns {Record<string,string>} environment entries.
 */
export function profileEnvironment(userHome) {
  const home = normalize(userHome);
  const drive = path.parse(home).root.replace(/\\$/, '');
  const rest = home.slice(drive.length);
  const env = {
    USERPROFILE: home,
    HOMEDRIVE: drive,
    HOMEPATH: rest,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: path.join(home, 'AppData', 'Local', 'Temp'),
    TMP: path.join(home, 'AppData', 'Local', 'Temp'),
  };
  return env;
}

/**
 * Derive the user profile root from the harness home.
 *
 * @param {string} dshHome absolute harness home (`...\\.dsh`).
 * @returns {string} the profile root.
 */
export function userHomeFor(dshHome) {
  return path.dirname(normalize(dshHome));
}

/**
 * Build the full install/repair plan without touching the machine.
 *
 * @param {object} [options] CLI or tool options.
 * @returns {object} { ok, plan, warnings, errors, survey }
 */
export function buildPlan(options = {}) {
  const serviceName = options.serviceName ?? DEFAULTS.serviceName;
  const profile = options.profile ?? DEFAULTS.profile;
  const port = Number(options.port ?? DEFAULTS.port);
  const snapshot = survey({ ...options, profile, port });
  const warnings = [];
  const errors = [];

  if (!snapshot.dshBin.path) {
    errors.push({
      code: 'dsh-bin-missing',
      message: 'Could not locate @deepseek-ai/dsh/lib/bin.js. Pass --dsh-bin, or install dsh globally.',
      checked: snapshot.dshBin.checked,
    });
  }
  if (!snapshot.profileDir.exists) {
    warnings.push({
      code: 'profile-missing',
      message: 'The profile directory does not exist yet: ' + snapshot.profileDir.path +
        '. Start the harness once with this DSH_HOME before installing the service.',
    });
  }
  const adapter = adapterFor(snapshot.wrapper);
  if (!options.wrapper && !adapter) {
    errors.push({
      code: 'wrapper-missing',
      message: 'No service wrapper found. Install nssm (public domain) or WinSW (MIT), or pass --nssm/--winsw.',
      searchedCount: snapshot.wrapper.searched.length,
    });
  }

  // The failure this whole project exists to prevent: a service that cannot
  // bind because an interactive `dsh web` already owns the port. The SCM sees
  // a healthy-looking process that exits immediately, nssm restarts it every
  // two seconds, and the log fills with EADDRINUSE.
  const foreignListeners = snapshot.listeners.filter((entry) => {
    const owner = snapshot.dshProcesses.find((proc) => proc.pid === entry.pid);
    return !owner;
  });
  const dshListeners = snapshot.listeners.filter((entry) =>
    snapshot.dshProcesses.some((proc) => proc.pid === entry.pid));
  if (foreignListeners.length > 0) {
    warnings.push({
      code: 'port-taken-by-other',
      message: 'Port ' + port + ' is already held by ' +
        foreignListeners.map((l) => (l.processName ?? 'pid ' + l.pid) + ' (pid ' + l.pid + ')').join(', ') +
        '. The service will fail with EADDRINUSE until that program is stopped or another port is chosen.',
    });
  }
  if (dshListeners.length > 0) {
    warnings.push({
      code: 'interactive-instance-running',
      message: 'An interactive dsh web is already listening on port ' + port + ' (pid ' +
        dshListeners.map((l) => l.pid).join(', ') +
        '). Stop it before (or right after) installing, otherwise the service restart-loops on EADDRINUSE.',
    });
  }

  const userHome = options.userHome ? normalize(options.userHome) : userHomeFor(snapshot.dshHome.path);
  const logPath = options.logPath ? normalize(options.logPath) : path.join(userHome, serviceName + '.log');
  const workingDirectory = options.workingDirectory ? normalize(options.workingDirectory) : userHome;

  const webFlags = [];
  if (options.openBrowser !== true) webFlags.push('--no-open');
  if (options.host) webFlags.push('--host', String(options.host));
  if (options.port) webFlags.push('--port', String(port));
  for (const extra of options.extraArgs ?? []) webFlags.push(String(extra));

  const appArgs = snapshot.dshBin.path ? [snapshot.dshBin.path, profile, ...webFlags] : [];

  const environment = {
    DSH_HOME: snapshot.dshHome.path,
    ...profileEnvironment(userHome),
    ...(options.extraEnvironment ?? {}),
  };

  const plan = {
    serviceName,
    profile,
    port,
    host: options.host ?? null,
    node: snapshot.node,
    dshBin: snapshot.dshBin.path,
    dshHome: snapshot.dshHome.path,
    userHome,
    profileDir: snapshot.profileDir.path,
    workingDirectory,
    logPath,
    logRotateBytes: Number(options.logRotateBytes ?? DEFAULTS.logRotateBytes),
    restartDelayMs: Number(options.restartDelayMs ?? DEFAULTS.restartDelayMs),
    stopTimeoutMs: Number(options.stopTimeoutMs ?? DEFAULTS.stopTimeoutMs),
    startType: options.startType ?? DEFAULTS.startType,
    account: options.account ?? DEFAULTS.account,
    displayName: options.displayName ?? ('DeepSeek Harness Web (' + profile + ')'),
    description: options.description ?? ('Runs "dsh ' + profile + '" as a Windows service on port ' + port + '.'),
    appArgs,
    environment,
    commandLine: appArgs.length ? '\"' + snapshot.node + '\" ' + buildWindowsCommandLine(appArgs) : null,
    wrapper: adapter ? { kind: adapter.kind, exe: adapter.exe } : null,
  };

  const steps = adapter ? adapter.installSteps(plan) : [];

  return {
    ok: errors.length === 0,
    plan,
    steps,
    warnings,
    errors,
    survey: {
      wrapperSearched: snapshot.wrapper.searched.slice(0, 12),
      listeners: snapshot.listeners,
      dshProcesses: snapshot.dshProcesses,
    },
  };
}

/**
 * Execute one plan step.
 *
 * @param {object} step a step from an adapter.
 * @returns {{step: object, ok: boolean, detail: string}}
 */
function executeStep(step) {
  if (step.type === 'write') {
    mkdirSync(path.dirname(step.path), { recursive: true });
    writeFileSync(step.path, step.content, 'utf8');
    return { step, ok: true, detail: 'wrote ' + step.path };
  }
  const result = run(step.command, step.args, { timeoutMs: 120000 });
  const detail = (result.stdout + result.stderr).trim();
  if (!result.ok && step.optional) return { step, ok: true, detail: detail || 'ignored (optional)' };
  return { step, ok: result.ok, detail };
}

/**
 * Run a list of steps in order, stopping at the first hard failure.
 *
 * @param {object[]} steps the steps.
 * @param {{dryRun?: boolean}} [options]
 * @returns {{ok: boolean, results: object[]}}
 */
export function executeSteps(steps, options = {}) {
  const results = [];
  for (const step of steps) {
    if (options.dryRun) {
      results.push({ step, ok: true, detail: 'dry run' });
      continue;
    }
    const result = executeStep(step);
    results.push(result);
    if (!result.ok) return { ok: false, results };
  }
  return { ok: true, results };
}

/**
 * Ask the SCM about one service.
 *
 * @param {string} serviceName the service name.
 * @returns {{installed: boolean, state: string|null, raw: string}}
 */
export function serviceQuery(serviceName) {
  const result = run('sc.exe', ['query', serviceName], { timeoutMs: 30000 });
  const raw = (result.stdout + result.stderr).trim();
  if (!result.ok) return { installed: false, state: null, raw };
  const match = /STATE\s*:\s*\d+\s+([A-Z_]+)/.exec(result.stdout);
  return { installed: true, state: match ? match[1] : 'UNKNOWN', raw };
}

/**
 * Wait for the SCM to report one of the wanted states.
 *
 * @param {string} serviceName the service name.
 * @param {string[]} wanted state names such as RUNNING.
 * @param {number} [timeoutMs]
 * @returns {{ok: boolean, state: string|null, waitedMs: number}}
 */
export async function waitForState(serviceName, wanted, timeoutMs = 30000) {
  const started = Date.now();
  let state = null;
  while (Date.now() - started < timeoutMs) {
    const query = serviceQuery(serviceName);
    state = query.state;
    if (state && wanted.includes(state)) return { ok: true, state, waitedMs: Date.now() - started };
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return { ok: false, state, waitedMs: Date.now() - started };
}

/**
 * Probe one HTTP endpoint.
 *
 * @param {string} url the URL.
 * @param {number} [timeoutMs]
 * @returns {Promise<{ok: boolean, status: number|null, ms: number, error: string|null}>}
 */
export async function probeHttp(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const started = Date.now();
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { ok: true, status: response.status, ms: Date.now() - started, error: null };
  } catch (error) {
    return { ok: false, status: null, ms: Date.now() - started, error: String(error?.message ?? error) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Install (or repair) the service.
 *
 * @param {object} [options] see {@link buildPlan}.
 * @returns {Promise<object>} the outcome.
 */
export async function install(options = {}) {
  const built = buildPlan(options);
  if (!built.ok) return { ok: false, stage: 'plan', ...built };

  const existing = serviceQuery(built.plan.serviceName);
  if (existing.installed && !options.force) {
    return {
      ok: false,
      stage: 'precheck',
      code: 'already-installed',
      message: 'Service ' + built.plan.serviceName + ' already exists (' + existing.state + '). Pass force:true to rewrite it, or run the repair action.',
      plan: built.plan,
      warnings: built.warnings,
    };
  }

  if (existing.installed && options.force) {
    const adapter = adapterFor({ kind: built.plan.wrapper.kind, path: built.plan.wrapper.exe });
    const removed = executeSteps(adapter.removeSteps(built.plan.serviceName), { dryRun: options.dryRun });
    if (!removed.ok) return { ok: false, stage: 'remove-existing', plan: built.plan, results: removed.results };
  }

  const executed = executeSteps(built.steps, { dryRun: options.dryRun });
  const outcome = {
    ok: executed.ok,
    stage: executed.ok ? 'installed' : 'configure',
    plan: built.plan,
    warnings: built.warnings,
    steps: executed.results.map((entry) => ({
      note: entry.step.note,
      command: entry.step.type === 'write' ? 'write ' + entry.step.path : entry.step.command + ' ' + entry.step.args.join(' '),
      ok: entry.ok,
      detail: entry.detail.slice(0, 400),
    })),
  };
  if (!executed.ok || options.dryRun) return outcome;

  const started = run('sc.exe', ['start', built.plan.serviceName], { timeoutMs: 60000 });
  const waited = await waitForState(built.plan.serviceName, ['RUNNING'], options.startTimeoutMs ?? 30000);
  const probe = await probeHttp('http://127.0.0.1:' + built.plan.port + '/', 8000);
  return {
    ...outcome,
    started: { ok: started.ok, detail: (started.stdout + started.stderr).trim().slice(0, 400) },
    state: waited,
    probe,
    ok: executed.ok && waited.ok,
  };
}

/**
 * Remove the service.
 *
 * @param {object} [options] `serviceName` plus wrapper hints.
 * @returns {object} the outcome.
 */
export function uninstall(options = {}) {
  const serviceName = options.serviceName ?? DEFAULTS.serviceName;
  const existing = serviceQuery(serviceName);
  if (!existing.installed) return { ok: true, stage: 'not-installed', serviceName };
  const snapshot = survey(options);
  const adapter = adapterFor(snapshot.wrapper);
  if (!adapter) {
    const forced = run('sc.exe', ['delete', serviceName], { timeoutMs: 60000 });
    return { ok: forced.ok, stage: 'sc-delete', detail: (forced.stdout + forced.stderr).trim(), serviceName };
  }
  const executed = executeSteps(adapter.removeSteps(serviceName), { dryRun: options.dryRun });
  return {
    ok: executed.ok,
    stage: 'removed',
    serviceName,
    steps: executed.results.map((entry) => ({ note: entry.step.note, ok: entry.ok, detail: entry.detail.slice(0, 300) })),
  };
}

/**
 * Start, stop or restart an installed service and wait for the SCM to agree.
 *
 * @param {'start'|'stop'|'restart'} action the action.
 * @param {object} [options]
 * @returns {Promise<object>} the outcome.
 */
export async function control(action, options = {}) {
  const serviceName = options.serviceName ?? DEFAULTS.serviceName;
  const existing = serviceQuery(serviceName);
  if (!existing.installed) return { ok: false, code: 'not-installed', serviceName };
  const result = run('sc.exe', [action, serviceName], { timeoutMs: 60000 });
  const wanted = action === 'stop' ? ['STOPPED'] : ['RUNNING'];
  const waited = await waitForState(serviceName, wanted, options.timeoutMs ?? 30000);
  const outcome = {
    ok: waited.ok,
    serviceName,
    action,
    detail: (result.stdout + result.stderr).trim().slice(0, 500),
    state: waited,
  };
  if (action !== 'stop' && waited.ok && options.port) {
    outcome.probe = await probeHttp('http://127.0.0.1:' + Number(options.port) + '/', 8000);
  }
  return outcome;
}

/**
 * Report the full picture for one service.
 *
 * @param {object} [options]
 * @returns {Promise<object>} status.
 */
export async function status(options = {}) {
  const serviceName = options.serviceName ?? DEFAULTS.serviceName;
  const port = Number(options.port ?? DEFAULTS.port);
  const query = serviceQuery(serviceName);
  const snapshot = survey({ ...options, port });
  const probe = query.state === 'RUNNING' ? await probeHttp('http://127.0.0.1:' + port + '/', 6000) : null;
  // An already-installed service carries its own log path in the wrapper's
  // stored parameters; preferring it over the derived default is what makes
  // `diagnose` read the file the service actually writes.
  const parameters = query.installed ? serviceParameters(serviceName) : null;
  const configuredLog = typeof parameters?.AppStdout === 'string' && parameters.AppStdout.trim() !== ''
    ? parameters.AppStdout.trim()
    : null;
  const configuredArgs = typeof parameters?.AppParameters === 'string' ? parameters.AppParameters : null;
  const logPath = options.logPath
    ? normalize(options.logPath)
    : configuredLog
      ? normalize(configuredLog)
      : path.join(userHomeFor(snapshot.dshHome.path), serviceName + '.log');
  return {
    serviceName,
    installed: query.installed,
    configured: configuredArgs ? { appParameters: configuredArgs, appStdout: configuredLog } : null,
    state: query.state,
    port,
    listeners: snapshot.listeners,
    dshProcesses: snapshot.dshProcesses,
    probe,
    logPath,
    logExists: existsSync(logPath),
    wrapper: snapshot.wrapper.kind,
    dshBin: snapshot.dshBin,
    dshHome: snapshot.dshHome,
  };
}

/**
 * Read the tail of the service log without loading a huge file.
 *
 * @param {string} logPath the log file.
 * @param {number} [lines] how many lines to keep.
 * @returns {string} the tail.
 */
export function tailLog(logPath, lines = 200) {
  if (!isFile(logPath)) return '';
  const size = 2 * 1024 * 1024;
  const raw = readFileSync(logPath);
  const slice = raw.length > size ? raw.subarray(raw.length - size) : raw;
  return slice.toString('utf8').split(/\r?\n/).slice(-lines).join('\n');
}
