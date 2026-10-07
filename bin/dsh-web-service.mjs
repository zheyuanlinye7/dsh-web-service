#!/usr/bin/env node
/**
 * dsh-web-service — command line interface.
 *
 * Every action is available with `--json` so scripts and the MCP tools can
 * consume the same result the human sees.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, control, install, serviceQuery, status, tailLog, uninstall, userHomeFor, probeHttp } from '../src/service.mjs';
import { diagnose } from '../src/diagnose.mjs';
import { printJson, isWindows } from '../src/util.mjs';

const BOOLEAN_FLAGS = new Set(['json', 'dryRun', 'force', 'help', 'version', 'openBrowser', 'quiet']);

/** Parse `--flag`, `--flag value` and `--flag=value` into a flat object. */
function parseArgs(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { positionals.push(token); continue; }
    const [rawKey, inline] = token.slice(2).split('=');
    const key = rawKey.replace(/-([a-z0-9])/g, (_, ch) => ch.toUpperCase());
    if (inline !== undefined) { flags[key] = inline; continue; }
    if (BOOLEAN_FLAGS.has(key)) { flags[key] = true; continue; }
    const next = argv[index + 1];
    if (next !== undefined && !next.startsWith('--')) { flags[key] = next; index += 1; continue; }
    flags[key] = true;
  }
  return { positionals, flags };
}

const USAGE = [
  'dsh-web-service — run `dsh web` as a Windows service',
  '',
  'Usage: dsh-web-service <command> [options]',
  '',
  'Commands:',
  '  status                 service state, port owner, HTTP probe, log path',
  '  plan                   print exactly what install would do (no writes)',
  '  install                create or rewrite the service and start it',
  '  uninstall              stop and delete the service',
  '  start | stop | restart control an installed service',
  '  diagnose               explain why the service will not run',
  '  logs                   print the tail of the service log',
  '',
  'Options:',
  '  --name <name>          service name (default dsh-web)',
  '  --profile <name>       dsh profile to serve (default web)',
  '  --port <n>             listen port (default 3080)',
  '  --host <addr>          bind address, e.g. 0.0.0.0',
  '  --dsh-home <path>      harness home (default $DSH_HOME or ~/.dsh)',
  '  --dsh-bin <path>       @deepseek-ai/dsh/lib/bin.js',
  '  --node <path>          node.exe to run',
  '  --nssm <path>          nssm.exe to use',
  '  --winsw <path>         WinSW executable to use',
  '  --account <account>    service account (default LocalSystem)',
  '  --log <path>           service log file',
  '  --dry-run              print the steps without running them',
  '  --force                rewrite an existing service',
  '  --json                 machine-readable output',
  '  --quiet                only errors',
  '  --help                 this text',
].join('\n');

/** Read this package's own version without importing package.json into the graph. */
function packageVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return manifest.version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

function humanStatus(result, logTail) {
  const lines = [];
  lines.push('service   ' + result.serviceName + (result.installed ? '  [' + result.state + ']' : '  [not installed]'));
  if (result.dshBin?.path) lines.push('dsh       ' + result.dshBin.path + '  (' + result.dshBin.source + ')');
  lines.push('dsh home  ' + result.dshHome.path + '  (' + result.dshHome.source + ')');
  lines.push('port      ' + result.port + (result.listeners.length ? '  held by ' + result.listeners.map((l) => (l.processName ?? 'pid') + ':' + l.pid).join(', ') : '  free'));
  if (result.probe) lines.push('http      ' + (result.probe.ok ? 'HTTP ' + result.probe.status + ' in ' + result.probe.ms + 'ms' : 'no answer: ' + result.probe.error));
  lines.push('log       ' + result.logPath + (result.logExists ? '' : '  (not created yet)'));
  if (result.dshProcesses.length) {
    lines.push('dsh procs ' + result.dshProcesses.map((p) => 'pid ' + p.pid + (p.isWeb ? ' (web)' : '')).join(', '));
  }
  if (logTail) {
    lines.push('');
    lines.push('--- last lines of the service log ---');
    lines.push(logTail.split(/\r?\n/).slice(-12).join('\n'));
  }
  return lines.join('\n');
}

function humanFindings(result) {
  if (result.findings.length === 0) return 'No problems found for ' + result.serviceName + '.';
  const lines = [];
  for (const finding of result.findings) {
    lines.push('[' + finding.severity.toUpperCase() + '] ' + finding.title);
    lines.push('        ' + finding.detail);
    if (finding.fix) lines.push('        fix: ' + finding.fix);
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const command = positionals[0] ?? 'status';
  const options = {
    serviceName: flags.name,
    profile: flags.profile,
    port: flags.port ? Number(flags.port) : undefined,
    host: typeof flags.host === 'string' ? flags.host : undefined,
    dshHome: flags.dshHome,
    dshBin: flags.dshBin,
    node: flags.node,
    nssmPath: flags.nssm,
    winswPath: flags.winsw,
    account: flags.account,
    logPath: flags.log,
    openBrowser: flags.openBrowser === true,
    dryRun: flags.dryRun === true,
    force: flags.force === true,
  };

  if (flags.help || command === 'help') { process.stdout.write(USAGE + '\n'); return 0; }
  if (flags.version || command === 'version') { process.stdout.write(packageVersion() + '\n'); return 0; }
  if (!isWindows()) { process.stderr.write('dsh-web-service only manages Windows services (this host is ' + process.platform + ').\n'); return 2; }

  let result;
  let logTail = '';
  switch (command) {
    case 'status': {
      result = await status(options);
      const userHome = userHomeFor(result.dshHome.path);
      logTail = tailLog(options.logPath ?? path.join(userHome, result.serviceName + '.log'), 40);
      break;
    }
    case 'plan': {
      result = buildPlan(options);
      break;
    }
    case 'install': {
      result = await install(options);
      break;
    }
    case 'uninstall': {
      result = uninstall(options);
      break;
    }
    case 'start': case 'stop': case 'restart': {
      result = await control(command, { ...options, timeoutMs: 45000 });
      break;
    }
    case 'diagnose': {
      result = await diagnose(options);
      break;
    }
    case 'logs': {
      const current = await status(options);
      const userHome = userHomeFor(current.dshHome.path);
      const logPath = options.logPath ?? path.join(userHome, current.serviceName + '.log');
      logTail = tailLog(logPath, Number(flags.lines ?? 120));
      result = { serviceName: current.serviceName, logPath, lines: logTail ? logTail.split('\n').length : 0 };
      break;
    }
    default:
      process.stderr.write('Unknown command: ' + command + '\n\n' + USAGE + '\n');
      return 2;
  }

  if (flags.json) {
    printJson({ command, ...result, logTail: logTail || undefined });
  } else if (!flags.quiet) {
    if (command === 'status') process.stdout.write(humanStatus(result, logTail) + '\n');
    else if (command === 'diagnose') process.stdout.write(humanFindings(result) + '\n');
    else if (command === 'plan') process.stdout.write(humanPlan(result) + '\n');
    else process.stdout.write(humanOutcome(result) + '\n');
  }

  if (command === 'plan') return result.ok ? 0 : 1;
  return result.ok === false ? 1 : 0;
}

function humanPlan(result) {
  const lines = [];
  lines.push('service   ' + result.plan.serviceName + '  via ' + (result.plan.wrapper?.kind ?? '<no wrapper>'));
  lines.push('command   ' + (result.plan.commandLine ?? '<unresolved>'));
  lines.push('workdir   ' + result.plan.workingDirectory);
  lines.push('log       ' + result.plan.logPath);
  lines.push('env       ' + Object.entries(result.plan.environment).map(([k, v]) => k + '=' + v).join('\n          '));
  for (const warning of result.warnings) lines.push('[WARN]    ' + warning.message);
  for (const error of result.errors) lines.push('[ERROR]   ' + error.message);
  lines.push('');
  lines.push('steps (' + result.steps.length + '):');
  for (const step of result.steps) {
    const text = step.type === 'write' ? 'write ' + step.path : step.command + ' ' + step.args.join(' ');
    lines.push('  - ' + (step.note ?? '') + '\n      ' + text);
  }
  return lines.join('\n');
}

function humanOutcome(result) {
  const lines = [];
  lines.push((result.ok ? 'OK' : 'FAILED') + '  ' + (result.stage ?? '') + (result.message ? '  ' + result.message : ''));
  if (result.plan) lines.push('command   ' + (result.plan.commandLine ?? ''));
  for (const warning of result.warnings ?? []) lines.push('[WARN]    ' + warning.message);
  if (result.state) lines.push('state     ' + result.state.state + ' after ' + result.state.waitedMs + 'ms');
  if (result.probe) lines.push('http      ' + (result.probe.ok ? 'HTTP ' + result.probe.status + ' in ' + result.probe.ms + 'ms' : 'no answer: ' + result.probe.error));
  for (const step of result.steps ?? []) {
    if (!step.ok) lines.push('[STEP FAIL] ' + step.note + '\n      ' + step.detail);
  }
  return lines.join('\n');
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((error) => {
    process.stderr.write((error?.stack ?? String(error)) + '\n');
    process.exitCode = 1;
  });
