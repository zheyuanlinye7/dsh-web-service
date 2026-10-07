/**
 * Exercise the MCP server over a real stdio pipe: initialize, then tools/list.
 * This is the same handshake @deepseek-ai/dsh-mcp-client performs.
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, '..', 'mcp', 'server.mjs');
const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'inherit'] });

let buffer = '';
const seen = [];
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let newline = buffer.indexOf('\n');
  while (newline !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) seen.push(JSON.parse(line));
    newline = buffer.indexOf('\n');
  }
});

const write = (message) => child.stdin.write(JSON.stringify(message) + '\n');
write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2026-07-28', clientInfo: { name: 'mcp-list', version: '1' } } });
write({ jsonrpc: '2.0', method: 'notifications/initialized' });
write({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

await new Promise((resolve) => setTimeout(resolve, 2500));
child.stdin.end();

const init = seen.find((message) => message.id === 1);
const list = seen.find((message) => message.id === 2);
if (!init || !list) {
  process.stderr.write('handshake failed; received: ' + JSON.stringify(seen) + '\n');
  process.exit(1);
}
process.stdout.write('server   ' + init.result.serverInfo.name + ' ' + init.result.serverInfo.version + '  protocol ' + init.result.protocolVersion + '\n');
for (const tool of list.result.tools) process.stdout.write('  tool   ' + tool.name + '\n');
process.exit(list.result.tools.length >= 6 ? 0 : 1);
