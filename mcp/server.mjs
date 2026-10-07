#!/usr/bin/env node
/**
 * MCP stdio server for dsh-web-service.
 *
 * DSH bridges this process through @deepseek-ai/dsh-mcp-client, so the model
 * sees the tools below as mcp__<serverName>__<tool>. The server speaks both
 * stdio framings: newline-delimited JSON and LSP-style Content-Length
 * headers, detected from the first bytes the client writes.
 *
 * Nothing is cached between requests and no state is kept across processes:
 * the MCP client runs a short-lived probe process before the serving one, so
 * startup must be cheap and side-effect free.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPlan, control, install, probeHttp, status, tailLog, uninstall, userHomeFor } from '../src/service.mjs';
import { diagnose } from '../src/diagnose.mjs';

const SERVER_NAME = 'dsh-web-service';
const MCP_PROTOCOL_VERSION = '2026-07-28';

function serverVersion() {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch { return '0.0.0'; }
}

const COMMON_PROPERTIES = {
  name: { type: 'string', description: 'Service name. Default "dsh-web".' },
  profile: { type: 'string', description: 'dsh profile to serve. Default "web".' },
  port: { type: 'number', description: 'Listen port. Default 3080.' },
  host: { type: 'string', description: 'Bind address, for example 0.0.0.0. Omit to use the profile composition.' },
  dshHome: { type: 'string', description: 'Harness home. Defaults to $DSH_HOME, then ~/.dsh.' },
  dshBin: { type: 'string', description: 'Absolute path to @deepseek-ai/dsh/lib/bin.js.' },
  nssm: { type: 'string', description: 'Absolute path to nssm.exe.' },
  winsw: { type: 'string', description: 'Absolute path to a WinSW executable.' },
  account: { type: 'string', description: 'Service account. Default LocalSystem.' },
  log: { type: 'string', description: 'Service log file path.' },
};

const tools = [
  {
    name: 'service_status',
    description: 'Report whether dsh web is registered as a Windows service, its SCM state, which process owns its port, whether its HTTP endpoint answers, and where its log lives.',
    inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES }, additionalProperties: false },
  },
  {
    name: 'service_plan',
    description: 'Show exactly what service_install would write and run, without changing anything. Use this first when the user wants to review the change.',
    inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES, openBrowser: { type: 'boolean', description: 'Open a browser on start. Off by default, which is what a service wants.' } }, additionalProperties: false },
  },
  {
    name: 'service_install',
    description: 'Create (or with force, rewrite) the Windows service that runs `dsh web` at boot with no console window, then start it and probe the port. Requires an elevated agent: writing a service needs administrator rights.',
    inputSchema: {
      type: 'object',
      properties: {
        ...COMMON_PROPERTIES,
        force: { type: 'boolean', description: 'Delete and recreate an existing service of the same name.' },
        dryRun: { type: 'boolean', description: 'Produce the plan without executing it.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'service_uninstall',
    description: 'Stop and delete the Windows service. The dsh installation and the harness home are left untouched.',
    inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES }, additionalProperties: false },
  },
  {
    name: 'service_control',
    description: 'Start, stop or restart the installed service and wait for the Service Control Manager to report the new state.',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop', 'restart'], description: 'What to do.' }, ...COMMON_PROPERTIES },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'service_diagnose',
    description: 'Read the service log and the machine state and explain why the service is not working: port already in use, a profile plugin that cannot load on this dsh version, a failed plugin tree, a missing profile, permission denials. Returns findings with a concrete fix for each.',
    inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES, logLines: { type: 'number', description: 'How many log lines to parse. Default 400.' } }, additionalProperties: false },
  },
  {
    name: 'service_logs',
    description: 'Return the tail of the service log file.',
    inputSchema: { type: 'object', properties: { ...COMMON_PROPERTIES, lines: { type: 'number', description: 'How many lines. Default 120.' } }, additionalProperties: false },
  },
];

/** Map tool arguments onto library options. */
function toOptions(args = {}) {
  return {
    serviceName: args.name,
    profile: args.profile,
    port: args.port,
    host: args.host,
    dshHome: args.dshHome,
    dshBin: args.dshBin,
    nssmPath: args.nssm,
    winswPath: args.winsw,
    account: args.account,
    logPath: args.log,
    openBrowser: args.openBrowser === true,
    force: args.force === true,
    dryRun: args.dryRun === true,
  };
}

/** Run one tool by name. Exported shape kept small for tests. */
export async function callTool(name, args = {}) {
  const options = toOptions(args);
  switch (name) {
    case 'service_status':
      return status(options);
    case 'service_plan':
      return buildPlan(options);
    case 'service_install':
      return install(options);
    case 'service_uninstall':
      return uninstall(options);
    case 'service_control':
      return control(String(args.action), { ...options, timeoutMs: 60000 });
    case 'service_diagnose':
      return diagnose({ ...options, logLines: args.logLines });
    case 'service_logs': {
      const current = await status(options);
      const userHome = userHomeFor(current.dshHome.path);
      const logPath = options.logPath ?? path.join(userHome, current.serviceName + '.log');
      return { logPath, tail: tailLog(logPath, Number(args.lines ?? 120)) };
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

function textResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

async function handleRequest(message) {
  const { id, method, params } = message ?? {};
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return null;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: params?.protocolVersion || MCP_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: serverVersion() },
      },
    };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools } };
  if (method === 'tools/call') {
    try {
      const value = await callTool(params?.name, params?.arguments ?? {});
      return { jsonrpc: '2.0', id, result: textResult(value) };
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        result: { isError: true, content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }] },
      };
    }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } };
}

let framingMode = 'line';
function send(message) {
  if (!message) return;
  const payload = JSON.stringify(message);
  if (framingMode === 'headers') {
    process.stdout.write('Content-Length: ' + Buffer.byteLength(payload, 'utf8') + '\r\n\r\n' + payload);
    return;
  }
  process.stdout.write(payload + '\n');
}

let buffer = Buffer.alloc(0);
let pending = 0;
function maybeExit() {
  if (process.stdin.readableEnded && pending === 0) process.exit(0);
}

function dispatch(message) {
  pending += 1;
  Promise.resolve(handleRequest(message))
    .then(send)
    .catch((error) => {
      send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: -32603, message: String(error?.message ?? error) } });
    })
    .finally(() => { pending -= 1; maybeExit(); });
}

function ingest(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.length > 0) {
    const asText = buffer.toString('utf8');
    if (asText.startsWith('Content-Length:')) {
      framingMode = 'headers';
      const headerEnd = asText.indexOf('\r\n\r\n');
      if (headerEnd === -1) return;
      const match = /Content-Length:\s*(\d+)/i.exec(asText.slice(0, headerEnd));
      if (!match) throw new Error('Invalid MCP Content-Length header');
      const length = Number(match[1]);
      const bodyStart = headerEnd + 4;
      if (buffer.length < bodyStart + length) return;
      const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
      buffer = buffer.subarray(bodyStart + length);
      dispatch(JSON.parse(body));
      continue;
    }
    const newline = asText.indexOf('\n');
    if (newline === -1) return;
    const line = asText.slice(0, newline).trim();
    buffer = buffer.subarray(Buffer.byteLength(asText.slice(0, newline + 1), 'utf8'));
    if (line) dispatch(JSON.parse(line));
  }
}

function startStdioServer() {
  process.stdin.on('data', ingest);
  process.stdin.on('end', maybeExit);
  process.stdin.resume();
}

async function selfTest() {
  const probe = await probeHttp('http://127.0.0.1:3080/', 3000);
  return {
    ok: tools.length >= 6,
    server: { name: SERVER_NAME, version: serverVersion(), protocol: MCP_PROTOCOL_VERSION },
    tools: tools.map((tool) => tool.name),
    platform: process.platform,
    probe3080: probe,
  };
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (process.argv.includes('--self-test')) {
  selfTest()
    .then((result) => { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); process.exit(result.ok ? 0 : 1); })
    .catch((error) => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1); });
} else if (process.argv[2] === '--call') {
  const toolName = process.argv[3];
  const rawArgs = process.argv[4] ?? '{}';
  callTool(toolName, JSON.parse(rawArgs))
    .then((value) => { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); process.exit(0); })
    .catch((error) => { process.stderr.write(String(error?.stack ?? error) + '\n'); process.exit(1); });
} else if (invokedDirectly || process.argv.includes('--serve')) {
  startStdioServer();
}
