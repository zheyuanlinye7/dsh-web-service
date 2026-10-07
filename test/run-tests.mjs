/**
 * Dependency-free test runner.
 *
 * The log fixtures are verbatim excerpts from a real machine, which is why
 * this project exists: every rule in src/diagnose.mjs is a failure that was
 * actually observed, not a guess.
 */
import assert from 'node:assert/strict';
import { buildWindowsCommandLine, quoteWindowsArg, expandEnv } from '../src/util.mjs';
import { profileEnvironment, userHomeFor, buildPlan, serviceQuery } from '../src/service.mjs';
import { renderWinswXml, nssmAdapter, winswAdapter } from '../src/wrapper.mjs';
import { parseLogSignatures } from '../src/diagnose.mjs';

let passed = 0;
let failed = 0;
const failures = [];

function test(name, body) {
  try {
    body();
    passed += 1;
    process.stdout.write('  ok   ' + name + '\n');
  } catch (error) {
    failed += 1;
    failures.push({ name, error });
    process.stdout.write('  FAIL ' + name + '\n        ' + String(error?.message ?? error).split('\n').join('\n        ') + '\n');
  }
}

process.stdout.write('quoteWindowsArg\n');
test('leaves a bare token alone', () => {
  assert.equal(quoteWindowsArg('web'), 'web');
});
test('quotes a path with spaces', () => {
  assert.equal(quoteWindowsArg('C:\\Program Files\\nodejs\\node.exe'), '"C:\\Program Files\\nodejs\\node.exe"');
});
test('doubles backslashes before a closing quote', () => {
  assert.equal(quoteWindowsArg('C:\\a b\\'), '"C:\\a b\\\\"');
});
test('escapes an embedded quote', () => {
  assert.equal(quoteWindowsArg('say "hi"'), '"say \\"hi\\""');
});
test('keeps an empty argument', () => {
  assert.equal(quoteWindowsArg(''), '""');
});
test('builds a service command line', () => {
  const line = buildWindowsCommandLine(['C:\\npm\\@deepseek-ai\\dsh\\lib\\bin.js', 'web', '--no-open']);
  assert.equal(line, 'C:\\npm\\@deepseek-ai\\dsh\\lib\\bin.js web --no-open');
});

process.stdout.write('expandEnv\n');
test('expands a known variable and leaves unknown ones', () => {
  process.env.DSH_TEST_VAR = 'xyz';
  assert.equal(expandEnv('%DSH_TEST_VAR%/a'), 'xyz/a');
  assert.equal(expandEnv('%NOT_SET_ANYWHERE%'), '%NOT_SET_ANYWHERE%');
  delete process.env.DSH_TEST_VAR;
});

process.stdout.write('profileEnvironment\n');
test('splits the profile root the way Windows does', () => {
  const env = profileEnvironment('C:\\Users\\admin');
  assert.equal(env.USERPROFILE, 'C:\\Users\\admin');
  assert.equal(env.HOMEDRIVE, 'C:');
  assert.equal(env.HOMEPATH, '\\Users\\admin');
  assert.equal(env.APPDATA, 'C:\\Users\\admin\\AppData\\Roaming');
});
test('derives the profile root from the harness home', () => {
  assert.equal(userHomeFor('C:\\Users\\admin\\.dsh'), 'C:\\Users\\admin');
});

process.stdout.write('wrapper steps\n');
test('nssm install sets every parameter the service needs', () => {
  const adapter = nssmAdapter('C:\\nssm\\nssm.exe');
  const steps = adapter.installSteps({
    serviceName: 'dsh-web', profile: 'web', port: 3080,
    node: 'C:\\Program Files\\nodejs\\node.exe',
    appArgs: ['C:\\npm\\bin.js', 'web', '--no-open'],
    workingDirectory: 'C:\\Users\\admin',
    environment: { DSH_HOME: 'C:\\Users\\admin\\.dsh' },
    displayName: 'DeepSeek Harness Web (web)', description: 'x',
    startType: 'SERVICE_AUTO_START', account: 'LocalSystem',
    logPath: 'C:\\Users\\admin\\dsh-web.log', logRotateBytes: 10485760,
    restartDelayMs: 2000, stopTimeoutMs: 5000,
  });
  const keys = steps.map((step) => (step.args ?? [])[2]).filter(Boolean);
  for (const required of ['Application', 'AppParameters', 'AppDirectory', 'AppEnvironmentExtra', 'Start', 'AppStdout', 'AppRestartDelay']) {
    assert.ok(keys.includes(required), 'missing ' + required);
  }
  const params = steps.find((step) => (step.args ?? [])[2] === 'AppParameters');
  assert.equal(params.args[3], 'C:\\npm\\bin.js web --no-open');
});
test('WinSW renders a definition with log rotation and env', () => {
  const xml = renderWinswXml({
    serviceName: 'dsh-web', displayName: 'DSH', description: 'd & d',
    node: 'C:\\node.exe', appArgs: ['C:\\bin.js', 'web'], workingDirectory: 'C:\\Users\\a b',
    startType: 'SERVICE_AUTO_START', account: null, stopTimeoutMs: 5000, restartDelayMs: 2000,
    logRotateBytes: 10485760, environment: { DSH_HOME: 'C:\\Users\\a b\\.dsh' },
  });
  assert.ok(xml.includes('<id>dsh-web</id>'));
  assert.ok(xml.includes('roll-by-size'));
  assert.ok(xml.includes('d &amp; d'));
  assert.ok(xml.includes('<env name="DSH_HOME" value="C:\\Users\\a b\\.dsh"/>'));
});
test('WinSW adapter writes the definition before installing', () => {
  const adapter = winswAdapter('C:\\tools\\WinSW.exe');
  const steps = adapter.installSteps({ serviceName: 'dsh-web', appArgs: [], environment: {}, logRotateBytes: 1, restartDelayMs: 1, stopTimeoutMs: 1, workingDirectory: 'C:\\', node: 'C:\\n.exe', displayName: 'd', description: 'd', startType: 'SERVICE_AUTO_START' });
  assert.equal(steps[0].type, 'write');
  assert.ok(steps[0].path.endsWith('dsh-web.xml'));
});

process.stdout.write('diagnose — real log fixtures\n');
test('detects the EADDRINUSE restart loop', () => {
  const findings = parseLogSignatures([
    'dsh: startup failed: 2 required plugins did not activate',
    '',
    'Failed plugins (1):',
    '  webserver (required)',
    '    Package: @deepseek-ai/dsh-host-webserver',
    '    Error: listen EADDRINUSE: address already in use 0.0.0.0:3080',
  ].join('\n'));
  assert.ok(findings.some((f) => f.code === 'port-in-use'), 'port-in-use missing');
  assert.ok(findings.some((f) => f.code === 'required-plugin-failed'), 'required-plugin-failed missing');
});
test('detects an incompatible profile plugin', () => {
  const findings = parseLogSignatures('dsh: skipping profile bundle "dshmarket": Error: Plugin dshmarket@1.18.1 is incompatible with dsh 0.2.0-rc.2: peerDependencies {"@deepseek-ai/dsh-settings":"^0.1.0-rc.7 || ^0.1.1-rc.2"}. Running it may cause crashes or data loss.');
  const hit = findings.find((f) => f.code === 'plugin-incompatible');
  assert.ok(hit, 'plugin-incompatible missing');
  assert.equal(hit.plugin, 'dshmarket@1.18.1');
  assert.equal(hit.dshVersion, '0.2.0-rc.2');
});
test('detects a plugin tree that cannot import', () => {
  const findings = parseLogSignatures('Error: dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry dsh-lan-guard');
  assert.ok(findings.some((f) => f.code === 'plugin-tree-failed'));
});
test('clean output produces no findings', () => {
  assert.deepEqual(parseLogSignatures('dsh web: http://127.0.0.1:3080/?token=abc'), []);
});

process.stdout.write('buildPlan (read-only, real machine)\n');
test('produces a plan object without touching the service', () => {
  const built = buildPlan({ serviceName: 'dsh-web-service-selftest', port: 3099 });
  assert.ok(built.plan, 'no plan');
  assert.equal(built.plan.serviceName, 'dsh-web-service-selftest');
  assert.ok(Array.isArray(built.steps));
  assert.ok(Array.isArray(built.warnings));
  assert.ok(built.plan.environment.DSH_HOME, 'DSH_HOME missing from the service environment');
  assert.ok(built.plan.environment.USERPROFILE, 'USERPROFILE missing from the service environment');
  const query = serviceQuery('dsh-web-service-selftest');
  assert.equal(query.installed, false, 'the self-test service name must not exist');
});

process.stdout.write('\n' + passed + ' passed, ' + failed + ' failed\n');
if (failed > 0) {
  for (const failure of failures) process.stdout.write('\n' + failure.name + '\n' + String(failure.error?.stack ?? failure.error) + '\n');
  process.exit(1);
}
