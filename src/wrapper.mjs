/**
 * Service-wrapper backends.
 *
 * A wrapper is the small native program that lets an ordinary console
 * application be supervised by the Windows Service Control Manager: Node
 * cannot call StartServiceCtrlDispatcher, and a service that never reports to
 * the SCM is killed by it after 30 seconds. nssm and WinSW are the two
 * established wrappers; both are handled here behind one adapter shape.
 *
 * Every mutation is produced as a list of STEPS rather than executed inline,
 * so `--dry-run` can print exactly what would happen and tests can assert on
 * it without touching the machine.
 */
import path from 'node:path';
import { buildWindowsCommandLine, isFile, normalize } from './util.mjs';

/**
 * Build the nssm adapter.
 *
 * @param {string} exe absolute path to nssm.exe.
 * @returns {object} the adapter.
 */
export function nssmAdapter(exe) {
  const runStep = (args, note) => ({ type: 'run', command: exe, args, note });
  return {
    kind: 'nssm',
    exe,

    installSteps(plan) {
      const name = plan.serviceName;
      const steps = [];
      // `nssm install <name>` with no application creates the service in the
      // stopped state with every parameter left at its default; the settings
      // below then describe the app. This is the only form that does not
      // depend on nssm\'s own command-line parsing of a quoted program path.
      steps.push(runStep(['install', name], 'create the service entry'));
      steps.push(runStep(['set', name, 'Application', plan.node], 'point at node.exe'));
      steps.push(runStep(['set', name, 'AppParameters', buildWindowsCommandLine(plan.appArgs)], 'the dsh web argument vector'));
      steps.push(runStep(['set', name, 'AppDirectory', plan.workingDirectory], 'working directory'));
      for (const [key, value] of Object.entries(plan.environment)) {
        steps.push(runStep(['set', name, 'AppEnvironmentExtra', key + '=' + value], 'environment ' + key));
      }
      steps.push(runStep(['set', name, 'DisplayName', plan.displayName], 'display name'));
      steps.push(runStep(['set', name, 'Description', plan.description], 'description'));
      steps.push(runStep(['set', name, 'Start', plan.startType], 'start type ' + plan.startType));
      if (plan.account) steps.push(runStep(['set', name, 'ObjectName', plan.account], 'run as ' + plan.account));
      steps.push(runStep(['set', name, 'AppStdout', plan.logPath], 'stdout log'));
      steps.push(runStep(['set', name, 'AppStderr', plan.logPath], 'stderr log'));
      steps.push(runStep(['set', name, 'AppRotateFiles', '1'], 'rotate the log'));
      steps.push(runStep(['set', name, 'AppRotateOnline', '1'], 'rotate while running'));
      steps.push(runStep(['set', name, 'AppRotateBytes', String(plan.logRotateBytes)], 'log rotation size'));
      steps.push(runStep(['set', name, 'AppRestartDelay', String(plan.restartDelayMs)], 'restart delay'));
      steps.push(runStep(['set', name, 'AppStopMethodConsole', String(plan.stopTimeoutMs)], 'graceful stop window'));
      steps.push(runStep(['set', name, 'AppExit', 'Default', 'Restart'], 'restart whenever the app exits'));
      steps.push(runStep(['set', name, 'AppThrottle', '1500'], 'restart throttle'));
      return steps;
    },

    removeSteps(name) {
      return [
        { type: 'run', command: exe, args: ['stop', name], note: 'stop before removal', optional: true },
        { type: 'run', command: exe, args: ['remove', name, 'confirm'], note: 'delete the service entry' },
      ];
    },

    startSteps(name) { return [{ type: 'run', command: exe, args: ['start', name], note: 'start' }]; },
    stopSteps(name) { return [{ type: 'run', command: exe, args: ['stop', name], note: 'stop' }]; },
    restartSteps(name) { return [{ type: 'run', command: exe, args: ['restart', name], note: 'restart' }]; },
    statusSteps(name) { return [{ type: 'run', command: exe, args: ['status', name], note: 'wrapper status' }]; },
    dumpSteps(name) { return [{ type: 'run', command: exe, args: ['dump', name], note: 'dump the stored parameters' }]; },
    readStep(name, key) { return { type: 'run', command: exe, args: ['get', name, key], note: 'get ' + key }; },
  };
}

/** Escape one XML text node. */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Render a WinSW service definition.
 *
 * WinSW reads one XML file named after the service, sitting beside the
 * executable (or passed with `/c`). Its log element is deliberately
 * different from nssm\'s: `mode="roll-by-size"` plus a size threshold.
 *
 * @param {object} plan the install plan.
 * @returns {string} the XML document.
 */
export function renderWinswXml(plan) {
  const lines = [];
  lines.push('<service>');
  lines.push('  <id>' + xmlEscape(plan.serviceName) + '</id>');
  lines.push('  <name>' + xmlEscape(plan.displayName) + '</name>');
  lines.push('  <description>' + xmlEscape(plan.description) + '</description>');
  lines.push('  <executable>' + xmlEscape(plan.node) + '</executable>');
  lines.push('  <arguments>' + xmlEscape(buildWindowsCommandLine(plan.appArgs)) + '</arguments>');
  lines.push('  <workingdirectory>' + xmlEscape(plan.workingDirectory) + '</workingdirectory>');
  lines.push('  <startmode>' + (plan.startType === 'SERVICE_AUTO_START' ? 'Automatic' : 'Manual') + '</startmode>');
  if (plan.account) lines.push('  <serviceaccount><username>' + xmlEscape(plan.account) + '</username></serviceaccount>');
  lines.push('  <stoptimeout>' + Math.max(1, Math.round(plan.stopTimeoutMs / 1000)) + ' sec</stoptimeout>');
  lines.push('  <onfailure action="restart" delay="' + Math.max(1, Math.round(plan.restartDelayMs / 1000)) + ' sec"/>');
  lines.push('  <log mode="roll-by-size">');
  lines.push('    <sizeThreshold>' + plan.logRotateBytes + '</sizeThreshold>');
  lines.push('    <keepFiles>4</keepFiles>');
  lines.push('  </log>');
  for (const [key, value] of Object.entries(plan.environment)) {
    lines.push('  <env name="' + xmlEscape(key) + '" value="' + xmlEscape(value) + '"/>');
  }
  lines.push('</service>');
  return lines.join('\r\n') + '\r\n';
}

/**
 * Build the WinSW adapter.
 *
 * @param {string} exe absolute path to the WinSW executable.
 * @returns {object} the adapter.
 */
export function winswAdapter(exe) {
  const runStep = (args, note, extra = {}) => ({ type: 'run', command: exe, args, note, ...extra });
  return {
    kind: 'winsw',
    exe,

    /** WinSW keeps one definition file per service next to the executable. */
    configPath(serviceName) {
      return path.join(path.dirname(exe), serviceName + '.xml');
    },

    installSteps(plan) {
      const name = plan.serviceName;
      return [
        { type: 'write', path: this.configPath(name), content: renderWinswXml(plan), note: 'write the WinSW definition' },
        runStep(['install', this.configPath(name)], 'register the service'),
      ];
    },

    removeSteps(name) {
      return [
        { type: 'run', command: exe, args: ['stop', this.configPath(name)], note: 'stop before removal', optional: true },
        { type: 'run', command: exe, args: ['uninstall', this.configPath(name)], note: 'unregister the service' },
      ];
    },

    startSteps(name) { return [runStep(['start', this.configPath(name)], 'start')]; },
    stopSteps(name) { return [runStep(['stop', this.configPath(name)], 'stop')]; },
    restartSteps(name) { return [runStep(['restart', this.configPath(name)], 'restart')]; },
    statusSteps(name) { return [runStep(['status', this.configPath(name)], 'wrapper status')]; },
  };
}

/**
 * Pick an adapter for a detected wrapper.
 *
 * @param {{kind: string|null, path: string|null}} wrapper the detection result.
 * @returns {object|null} the adapter, or null when nothing was found.
 */
export function adapterFor(wrapper) {
  if (!wrapper || !wrapper.path) return null;
  const exe = normalize(wrapper.path);
  if (!isFile(exe)) return null;
  if (wrapper.kind === 'winsw') return winswAdapter(exe);
  return nssmAdapter(exe);
}
