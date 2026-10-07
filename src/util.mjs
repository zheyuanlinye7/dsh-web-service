/**
 * Dependency-free process, path and formatting helpers shared by the library,
 * the CLI and the MCP server. Windows-first, but every function degrades
 * gracefully so the module can be imported on any platform for tests.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';

export const IS_WINDOWS = process.platform === 'win32';

/**
 * Whether this process runs on Windows.
 *
 * @returns {boolean} true on win32.
 */
export function isWindows() {
  return IS_WINDOWS;
}

/**
 * Run a program and capture its output. Never throws for a non-zero exit:
 * service tooling leans on exit codes and stderr text for diagnosis, so the
 * caller decides what a failure means.
 *
 * @param {string} command executable name or absolute path.
 * @param {string[]} [args] argument vector (never a shell string).
 * @param {{cwd?: string, timeoutMs?: number, env?: Record<string,string>}} [options]
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null}}
 */
export function run(command, args = [], options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    timeout: options.timeoutMs ?? 120000,
    windowsHide: true,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    ok: result.status === 0,
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

/**
 * Run one PowerShell snippet. Used only for read-only WMI/TCP queries, which
 * have no reliable dependency-free cmd.exe equivalent.
 *
 * @param {string} script the command text.
 * @param {{timeoutMs?: number}} [options]
 * @returns {{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null}}
 */
export function runPowerShell(script, options = {}) {
  return run(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    options,
  );
}

/**
 * Resolve an executable through PATH.
 *
 * @param {string} name bare name such as `nssm` or `sc.exe`.
 * @returns {string|null} the first match, or null.
 */
export function which(name) {
  const found = run('where.exe', [name]);
  if (!found.ok) return null;
  const first = found.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)[0];
  return first ?? null;
}

/**
 * Quote one argument for a Windows command line, following the MSVCRT rules
 * that CommandLineToArgvW and the C runtime implement. nssm stores its
 * `AppParameters` as a single string, so this is the only correct way to hand
 * it an argument vector.
 *
 * @param {string} arg one raw argument.
 * @returns {string} the quoted form.
 */
export function quoteWindowsArg(arg) {
  const value = String(arg);
  if (value === '') return '""';
  if (!/[\s"]/.test(value)) return value;
  let out = '"';
  let backslashes = 0;
  for (const ch of value) {
    if (ch === '\\') { backslashes += 1; continue; }
    if (ch === '"') { out += '\\'.repeat(backslashes * 2 + 1) + '"'; backslashes = 0; continue; }
    out += '\\'.repeat(backslashes) + ch;
    backslashes = 0;
  }
  out += '\\'.repeat(backslashes * 2) + '"';
  return out;
}

/**
 * Join an argument vector into one Windows command line.
 *
 * @param {string[]} args the argument vector.
 * @returns {string} the command line.
 */
export function buildWindowsCommandLine(args) {
  return args.map(quoteWindowsArg).join(' ');
}

/**
 * Expand `%VAR%` references against the ambient environment.
 *
 * @param {string} value raw text.
 * @returns {string} expanded text.
 */
export function expandEnv(value) {
  return String(value).replace(/%([^%]+)%/g, (whole, name) => {
    const found = process.env[name] ?? process.env[name.toUpperCase()];
    return found === undefined ? whole : found;
  });
}

/**
 * Whether a path names an existing file.
 *
 * @param {string|null|undefined} candidate path to test.
 * @returns {boolean}
 */
export function isFile(candidate) {
  if (!candidate) return false;
  try { return statSync(candidate).isFile(); } catch { return false; }
}

/**
 * Whether a path names an existing directory.
 *
 * @param {string|null|undefined} candidate path to test.
 * @returns {boolean}
 */
export function isDir(candidate) {
  if (!candidate) return false;
  try { return statSync(candidate).isDirectory(); } catch { return false; }
}

/** Normalize a path to absolute forward-slash-free Windows form. */
export function normalize(p) {
  return path.resolve(expandEnv(p));
}

/** Shorten a long path for one-line diagnostics. */
export function shortPath(p, keep = 46) {
  const value = String(p ?? '');
  if (value.length <= keep) return value;
  return value.slice(0, 12) + '...' + value.slice(-(keep - 15));
}

/** Write one JSON document to stdout (the CLI's machine-readable mode). */
export function printJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

/** Whether a file exists at all. */
export function exists(p) {
  return Boolean(p) && existsSync(p);
}
