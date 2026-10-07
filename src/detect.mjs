/**
 * Environment detection: where Node is, where the dsh installation lives,
 * where $DSH_HOME is, which service wrapper is available, and what is already
 * running or listening. Every answer is a plain value so callers can render a
 * plan without touching the machine.
 */
import path from 'node:path';
import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { isDir, isFile, normalize, run, runPowerShell, which } from './util.mjs';

/** Names a service wrapper ships under. */
const WRAPPER_FILES = ['nssm.exe', 'winsw.exe', 'winsw-x64.exe', 'winsw-net4.exe', 'winsw-net461.exe'];

/**
 * Resolve the Node executable the service should run.
 *
 * @param {{node?: string}} [options] explicit override.
 * @returns {string} absolute path to node.exe.
 */
export function resolveNode(options = {}) {
  if (options.node) return normalize(options.node);
  return process.execPath;
}

/**
 * Resolve `@deepseek-ai/dsh/lib/bin.js`, the entry point `dsh` itself uses.
 *
 * Resolution order: explicit override, the global npm root, the per-user npm
 * prefix that `npm i -g` uses on Windows, then the location of the `dsh` shim
 * on PATH. The result is validated before it is returned.
 *
 * @param {{dshBin?: string}} [options] explicit override.
 * @returns {{path: string|null, source: string, checked: string[]}}
 */
export function resolveDshBin(options = {}) {
  const checked = [];
  const accept = (candidate, source) => {
    if (!candidate) return null;
    const resolved = normalize(candidate);
    checked.push(resolved);
    return isFile(resolved) ? { path: resolved, source, checked } : null;
  };

  const explicit = accept(options.dshBin, 'option:dshBin');
  if (explicit) return explicit;
  if (options.dshBin) return { path: null, source: 'option:dshBin (missing)', checked };

  const npmRoot = run('npm.cmd', ['root', '-g'], { timeoutMs: 60000 });
  if (npmRoot.ok) {
    const fromNpmRoot = accept(
      path.join(npmRoot.stdout.trim(), '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      'npm root -g',
    );
    if (fromNpmRoot) return fromNpmRoot;
  }

  for (const prefix of [
    process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : null,
    path.join(homedir(), 'AppData', 'Roaming', 'npm'),
  ]) {
    if (!prefix) continue;
    const fromPrefix = accept(
      path.join(prefix, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      'npm prefix',
    );
    if (fromPrefix) return fromPrefix;
  }

  const shim = which('dsh');
  if (shim) {
    const fromShim = accept(
      path.join(path.dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
      'dsh shim on PATH',
    );
    if (fromShim) return fromShim;
  }

  return { path: null, source: 'not found', checked };
}

/**
 * Resolve the harness home. A Windows service runs as LocalSystem, where
 * `~` is the system profile, so this value must be passed explicitly into the
 * service environment rather than left to expansion.
 *
 * @param {{dshHome?: string}} [options] explicit override.
 * @returns {{path: string, source: string}}
 */
export function resolveDshHome(options = {}) {
  if (options.dshHome) return { path: normalize(options.dshHome), source: 'option:dshHome' };
  if (process.env.DSH_HOME) return { path: normalize(process.env.DSH_HOME), source: 'env:DSH_HOME' };
  return { path: path.join(homedir(), '.dsh'), source: 'default (~/.dsh)' };
}

/**
 * Resolve one profile directory under the harness home.
 *
 * @param {string} dshHome absolute harness home.
 * @param {string} profile profile name, e.g. `web`.
 * @returns {{path: string, exists: boolean}}
 */
export function resolveProfileDir(dshHome, profile) {
  const dir = path.join(dshHome, 'profiles', profile);
  return { path: dir, exists: isDir(dir) };
}

/**
 * Breadth-first, depth-bounded directory walk that looks for a wrapper binary.
 *
 * This is done in Node rather than PowerShell on purpose: `Get-ChildItem
 * -LiteralPath` silently ignores `-Include`, and the quoting needed to build
 * that command safely through several layers is exactly the kind of thing that
 * works until it quietly does not. A walk is also far faster.
 *
 * @param {string[]} roots directories to search.
 * @param {number} [maxDepth] how many levels below each root to visit.
 * @returns {string[]} absolute paths of wrapper candidates.
 */
export function walkForWrappers(roots, maxDepth = 4) {
  const found = [];
  const queue = roots.filter((root) => root && isDir(root)).map((root) => ({ dir: root, depth: 0 }));
  const seen = new Set();
  while (queue.length > 0 && found.length < 8) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth + 1 <= maxDepth) queue.push({ dir: full, depth: depth + 1 });
        continue;
      }
      const lower = entry.name.toLowerCase();
      if (lower === 'nssm.exe' || (lower.startsWith('winsw') && lower.endsWith('.exe'))) found.push(full);
    }
  }
  return found;
}

/**
 * Look for a service wrapper. `nssm` is the reference implementation and is
 * public domain; WinSW is the MIT-licensed alternative. Nothing is downloaded
 * here - this only reports what is already on the machine.
 *
 * @param {{nssmPath?: string, winswPath?: string, extraDirs?: string[]}} [options]
 * @returns {{nssm: string|null, winsw: string|null, kind: 'nssm'|'winsw'|null, path: string|null, searched: string[]}}
 */
export function findWrapper(options = {}) {
  const searched = [];
  const classify = (candidate) => {
    const lower = candidate.toLowerCase();
    return lower.includes('winsw')
      ? { nssm: null, winsw: candidate, kind: 'winsw', path: candidate, searched }
      : { nssm: candidate, winsw: null, kind: 'nssm', path: candidate, searched };
  };

  for (const explicit of [options.nssmPath, options.winswPath]) {
    if (!explicit) continue;
    const candidate = normalize(explicit);
    searched.push(candidate);
    if (isFile(candidate)) return classify(candidate);
  }

  const onPath = which('nssm') ?? which('winsw');
  if (onPath) {
    searched.push(onPath);
    return classify(onPath);
  }

  // Shallow probes cover the usual hand-installed layouts without touching the
  // disk beyond a single stat each.
  const shallowRoots = [
    'C:\\Program Files',
    'C:\\Program Files (x86)',
    'C:\\',
    process.env.ProgramData ?? 'C:\\ProgramData',
    process.env.ProgramFiles ?? null,
    homedir(),
    path.join(homedir(), 'frp'),
    path.join(homedir(), 'tools'),
    path.join(homedir(), 'bin'),
    ...(options.extraDirs ?? []),
  ].filter(Boolean);
  const shallow = [];
  for (const root of shallowRoots) {
    for (const name of ['nssm.exe', 'NSSM.exe', ...WRAPPER_FILES]) shallow.push(path.join(root, name));
    for (const sub of ['win64', 'win32', 'x64', 'amd64']) {
      for (const name of ['nssm.exe', 'NSSM.exe', ...WRAPPER_FILES]) shallow.push(path.join(root, sub, name));
    }
  }
  for (const probe of shallow) {
    if (searched.includes(probe)) continue;
    searched.push(probe);
    if (isFile(probe)) return classify(probe);
  }

  // Then one bounded walk. `%USERPROFILE%\\frp\\nssm-2.24\\win64\\nssm.exe` is a
  // real layout this has to find.
  const deepRoots = [homedir(), 'C:\\Program Files', 'C:\\Program Files (x86)', 'C:\\ProgramData'];
  // nssm ships win32 and win64 builds side by side; both run on x64, but the
  // 64-bit one should win so the walk order never decides it.
  const rank = (candidate) => (/win64|x64|amd64/i.test(candidate) ? 0 : 1);
  const hits = walkForWrappers(deepRoots, 4).sort((a, b) => rank(a) - rank(b));
  for (const hit of hits) {
    if (searched.includes(hit)) continue;
    searched.push(hit);
    return classify(hit);
  }

  return { nssm: null, winsw: null, kind: null, path: null, searched };
}

/**
 * Read the parameters a wrapper stored for one service. This is the only way to
 * learn what an ALREADY-INSTALLED service was configured with: the log path, the
 * argument vector and the environment all live here, not in any file this project
 * wrote.
 *
 * @param {string} serviceName the service name.
 * @returns {Record<string, string|string[]>|null} the parameters, or null.
 */
export function serviceParameters(serviceName) {
  const key = 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\' + serviceName + '\\Parameters';
  const query = runPowerShell(
    'try { Get-ItemProperty -LiteralPath \'' + key + '\' -ErrorAction Stop | ConvertTo-Json -Compress -Depth 2 } catch { \'\' }',
    { timeoutMs: 30000 },
  );
  if (!query.ok) return null;
  const text = query.stdout.trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return null;
    // PowerShell decorates every registry object with PSPath/PSDrive/...; those
    // carry the provider reflection graph and would swamp any consumer.
    const clean = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key.startsWith('PS')) continue;
      clean[key] = value;
    }
    return clean;
  } catch { return null; }
}

/**
 * List every process whose command line looks like a dsh launch.
 *
 * @returns {Array<{pid: number, parentPid: number, commandLine: string, startedAt: string|null, isWeb: boolean}>}
 */
export function listDshProcesses() {
  const query = runPowerShell(
    'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | ' +
    'Select-Object ProcessId,ParentProcessId,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 3',
    { timeoutMs: 60000 },
  );
  if (!query.ok) return [];
  const text = query.stdout.trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => typeof row.CommandLine === 'string' && row.CommandLine.includes('dsh'))
    .map((row) => ({
      pid: Number(row.ProcessId),
      parentPid: Number(row.ParentProcessId),
      commandLine: row.CommandLine,
      startedAt: typeof row.CreationDate === 'string' ? row.CreationDate : null,
      isWeb: /lib[\\/]bin\.js"?\s+web(\s|$)/.test(row.CommandLine),
    }));
}

/**
 * Report which process owns a listening TCP port, if any.
 *
 * @param {number} port the port to inspect.
 * @returns {Array<{address: string, port: number, pid: number, processName: string|null, parentName: string|null}>}
 */
export function portOwners(port) {
  const query = runPowerShell(
    '$rows = Get-NetTCPConnection -State Listen -LocalPort ' + Number(port) + ' -ErrorAction SilentlyContinue | ' +
    'Select-Object LocalAddress,LocalPort,OwningProcess; ' +
    'if ($rows) { $rows | ConvertTo-Json -Compress -Depth 3 } else { \'[]\' }',
    { timeoutMs: 60000 },
  );
  if (!query.ok) return [];
  const text = query.stdout.trim();
  if (!text) return [];
  let parsed;
  try { parsed = JSON.parse(text); } catch { return []; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.map((row) => {
    const pid = Number(row.OwningProcess);
    const info = processInfo(pid);
    return {
      address: String(row.LocalAddress),
      port: Number(row.LocalPort),
      pid,
      processName: info?.name ?? null,
      parentName: info?.parentName ?? null,
    };
  });
}

/**
 * Read one process and its parent name.
 *
 * @param {number} pid process id.
 * @returns {{name: string|null, parentName: string|null, commandLine: string|null, startedAt: string|null}|null}
 */
export function processInfo(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const query = runPowerShell(
    '$p = Get-CimInstance Win32_Process -Filter "ProcessId=' + String(pid) + '\" -ErrorAction SilentlyContinue; ' +
    'if ($p) { $par = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $p.ParentProcessId) -ErrorAction SilentlyContinue; ' +
    '[pscustomobject]@{ name=$p.Name; parentName=$par.Name; commandLine=$p.CommandLine; startedAt=$p.CreationDate } | ConvertTo-Json -Compress } else { \'\' }',
    { timeoutMs: 60000 },
  );
  if (!query.ok) return null;
  const text = query.stdout.trim();
  if (!text) return null;
  try {
    const row = JSON.parse(text);
    return {
      name: row.name ?? null,
      parentName: row.parentName ?? null,
      commandLine: row.commandLine ?? null,
      startedAt: typeof row.startedAt === 'string' ? row.startedAt : null,
    };
  } catch { return null; }
}

/**
 * Survey everything the installer needs to know before it writes anything.
 *
 * @param {{profile?: string, port?: number, dshHome?: string, dshBin?: string, node?: string, nssmPath?: string, winswPath?: string}} [options]
 * @returns {object} a plain snapshot, safe to serialize.
 */
export function survey(options = {}) {
  const profile = options.profile ?? 'web';
  const port = Number(options.port ?? 3080);
  const node = resolveNode(options);
  const dshBin = resolveDshBin(options);
  const dshHome = resolveDshHome(options);
  const profileDir = resolveProfileDir(dshHome.path, profile);
  const wrapper = findWrapper(options);
  const listeners = portOwners(port);
  const dshProcesses = listDshProcesses();
  return { platform: process.platform, profile, port, node, dshBin, dshHome, profileDir, wrapper, listeners, dshProcesses };
}
