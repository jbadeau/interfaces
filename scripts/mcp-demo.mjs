#!/usr/bin/env node
// Shows what an AI agent sees: drives the MCP server over stdio and prints
// the tools and a few tool calls. Usage: node scripts/mcp-demo.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../mcp/src/server.ts', import.meta.url));
const p = spawn('node', ['--no-warnings', server], { stdio: ['pipe', 'pipe', 'ignore'] });
let buf = '';
const waiters = new Map();
p.stdout.on('data', (d) => {
  buf += d;
  for (let i; (i = buf.indexOf('\n')) >= 0; ) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (line.trim()) { const m = JSON.parse(line); waiters.get(m.id)?.(m); }
  }
});
let n = 0;
const rpc = (method, params) => new Promise((r) => { const id = ++n; waiters.set(id, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const dim = (s) => `\x1b[2m${s}\x1b[22m`, bold = (s) => `\x1b[1m${s}\x1b[22m`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const delay = Number(process.env.DEMO_DELAY ?? 0);

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-demo', version: '1' } });
p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const { tools } = (await rpc('tools/list', {})).result;
console.log(bold('MCP tools (from openapi.yaml):'));
for (const t of tools) {
  const hints = [t.annotations.readOnlyHint && 'read-only', t.annotations.destructiveHint && 'destructive'].filter(Boolean).join(', ');
  console.log(`  ${t.name.padEnd(15)} ${dim(t.title)}${hints ? dim(`  [${hints}]`) : ''}`);
}

const call = async (name, args) => {
  await pause(delay);
  console.log(`\n${bold('→ ' + name)} ${dim(JSON.stringify(args))}`);
  const r = (await rpc('tools/call', { name, arguments: args })).result;
  console.log(r.content[0].text);
  return r;
};

const due = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
await call('createTodo', { body: { title: 'Agent: draft release notes', priority: 'high' } });
await call('createTodo', { body: { title: 'Agent: draft release notes', priority: 'high', dueDate: due, tags: ['agent'] } });
await call('listTodos', { priority: 'high' });
p.kill();
