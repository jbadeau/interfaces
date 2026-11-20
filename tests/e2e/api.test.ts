/**
 * End-to-end tests against the running API (mise run e2e).
 *
 * Web UI, CLI and MCP are generic clients of this API: they render whatever the
 * spec and the API return. So testing the API's behaviour (validation, rules,
 * auth, paging, long-running operations, errors) tests what every channel does.
 * Each response is also checked against the schema the spec declares for its
 * status code: the contract itself is under test, not just the happy path.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { operations, spec } from '@demo/contract';
import { pollOperation } from '@demo/contract/async';

const API = process.env.API_URL ?? 'http://127.0.0.1:8787';
const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
const tokenUrl = (spec as any).components.securitySchemes.oauth2.flows.clientCredentials.tokenUrl;

// --------------------------------------------------------------- helpers ---

/** Find the spec operation for a concrete request, and the schema for its status. */
function responseSchema(method: string, url: string, status: number) {
  const path = new URL(url, API).pathname;
  for (const o of operations()) {
    const re = new RegExp('^' + o.path.replace(/\{\w+\}/g, '[^/]+') + '$');
    if (o.method === method.toLowerCase() && re.test(path)) {
      const r: any = o.op.responses[String(status)] ?? o.op.responses.default;
      const content = r?.content ?? {};
      return { op: o.op, schema: (content['application/json'] ?? content['application/problem+json'])?.schema };
    }
  }
  throw new Error(`No operation in the spec for ${method} ${path}`);
}

/** Call the API and assert the response matches the spec (status declared, body valid). */
async function call(method: string, url: string, { token, body }: { token?: string; body?: unknown } = {}) {
  const res = await fetch(API + url, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : undefined;
  const { schema } = responseSchema(method, url, res.status);
  if (schema) {
    const ok = ajv.validate(schema, data);
    assert.ok(ok, `${method} ${url} -> ${res.status} does not match the spec: ${ajv.errorsText()}`);
  }
  if (res.status >= 400) assert.match(res.headers.get('content-type') ?? '', /application\/problem\+json/);
  return { status: res.status, data, headers: res.headers };
}

async function clientToken(clientId = 'todos-cli') {
  const res = await fetch(tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: 'dev-secret' }) });
  return (await res.json()).access_token as string;
}

/** Sign in like the web UI does: authorization code + PKCE, as a demo user. */
async function userToken(user: 'ada' | 'grace') {
  const flow = (spec as any).components.securitySchemes.oauth2.flows.authorizationCode;
  const verifier = randomBytes(32).toString('base64url');
  const redirect = 'http://localhost:5173/';
  const res = await fetch(flow.authorizationUrl, {
    method: 'POST', redirect: 'manual',
    body: new URLSearchParams({ user, client_id: 'e2e', redirect_uri: redirect, state: 's', code_challenge: createHash('sha256').update(verifier).digest('base64url') }),
  });
  const code = new URL(res.headers.get('location')!).searchParams.get('code')!;
  const tok = await fetch(flow.tokenUrl, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, code_verifier: verifier }) });
  return (await tok.json()).access_token as string;
}

const inDays = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString().slice(0, 10);

// ----------------------------------------------------------------- tests ---

const token = await clientToken();

test('auth: no token is 401, a viewer is 403 on writes, a developer may write', async () => {
  assert.equal((await call('GET', '/todos')).status, 401);
  assert.equal((await call('GET', '/todos', { token: 'not.a.token' })).status, 401);
  const grace = await userToken('grace');
  assert.equal((await call('GET', '/todos', { token: grace })).status, 200);
  const denied = await call('POST', '/todos', { token: grace, body: { title: 'x' } });
  assert.equal(denied.status, 403);
  assert.match(denied.data.detail, /todos:write/);
  const ada = await userToken('ada');
  const ok = await call('POST', '/todos', { token: ada, body: { title: 'e2e: by Ada' } });
  assert.equal(ok.status, 201);
  await call('DELETE', `/todos/${ok.data.id}`, { token: ada });
});

test('structural validation: 400 with JSON pointers', async () => {
  const r = await call('POST', '/todos', { token, body: { title: '', priority: 'urgent' } });
  assert.equal(r.status, 400);
  const pointers = r.data.errors.map((e: any) => e.pointer);
  assert.ok(pointers.includes('/title') && pointers.includes('/priority'), JSON.stringify(pointers));
});

test('business rules (CEL): 422 names the rule and the field', async () => {
  const r = await call('POST', '/todos', { token, body: { title: 'e2e', priority: 'high' } });
  assert.equal(r.status, 422);
  assert.equal(r.data.errors[0].pointer, '/dueDate');
  assert.match(r.data.errors[0].rule, /has\(self.dueDate\)/);
  const past = await call('POST', '/todos', { token, body: { title: 'e2e', dueDate: '2000-01-01' } });
  assert.equal(past.status, 422);
});

test('lifecycle + preconditions: create, complete, 409 on second complete, reopen, delete, 404', async () => {
  const c = await call('POST', '/todos', { token, body: { title: 'e2e: lifecycle', priority: 'high', dueDate: inDays(3), tags: ['e2e'] } });
  assert.equal(c.status, 201);
  assert.equal(c.data.status, 'open');
  const id = c.data.id;
  assert.equal((await call('POST', `/todos/${id}/complete`, { token })).data.status, 'done');
  const again = await call('POST', `/todos/${id}/complete`, { token });
  assert.equal(again.status, 409);
  assert.equal(again.data.detail, 'Only open todos can be completed.');
  assert.equal((await call('POST', `/todos/${id}/reopen`, { token })).data.status, 'open');
  assert.equal((await call('DELETE', `/todos/${id}`, { token })).status, 204);
  assert.equal((await call('GET', `/todos/${id}`, { token })).status, 404);
});

test('regression (found by the load test): empty JSON body on a body-less operation is fine', async () => {
  const c = await call('POST', '/todos', { token, body: { title: 'e2e: empty body' } });
  const res = await fetch(`${API}/todos/${c.data.id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } });
  assert.equal(res.status, 200);
  const bad = await fetch(`${API}/todos`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: '{oops' });
  assert.equal(bad.status, 400);
  assert.match(bad.headers.get('content-type') ?? '', /problem\+json/);
  await call('DELETE', `/todos/${c.data.id}`, { token });
});

test('paging: cursors walk every item exactly once', async () => {
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) ids.push((await call('POST', '/todos', { token, body: { title: `e2e: page ${i}` } })).data.id);
  const seen: string[] = [];
  let cursor: string | null = null;
  do {
    const r = await call('GET', `/todos?limit=2${cursor ? `&cursor=${cursor}` : ''}`, { token });
    assert.ok(r.data.items.length <= 2);
    seen.push(...r.data.items.map((t: any) => t.id));
    cursor = r.data.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, seen.length, 'no duplicates across pages');
  for (const id of ids) assert.ok(seen.includes(id));
  for (const id of ids) await call('DELETE', `/todos/${id}`, { token });
});

test('long-running operation: 202 + Location, poll to succeeded, result, listed with paging', async () => {
  const c = await call('POST', '/todos', { token, body: { title: 'e2e: to archive' } });
  await call('POST', `/todos/${c.data.id}/complete`, { token });
  const r = await call('POST', '/todos/archive', { token });
  assert.equal(r.status, 202);
  assert.equal(r.headers.get('location'), r.data.href);
  assert.ok(Number(r.headers.get('retry-after')) >= 0);
  const seen = new Set<string>();
  const done = await pollOperation(r.data, async (href) => (await call('GET', href, { token })).data, { onUpdate: (op) => seen.add(op.status), intervalMs: 300 });
  assert.equal(done.status, 'succeeded');
  assert.ok(seen.has('running'));
  assert.ok((done.result as any).archived >= 1);
  assert.equal((await call('GET', `/todos/${c.data.id}`, { token })).status, 404);
  const page = await call('GET', '/operations?limit=1', { token });
  assert.equal(page.data.items[0].id, done.id);
  assert.equal((await call('GET', '/operations/op-unknown', { token })).status, 404);
});

test('every operation is reachable as an MCP tool, exactly when x-mcp is true', async () => {
  const exposed = [...operations()].filter((o) => o.op['x-mcp']).map((o) => o.op.operationId).sort();
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const client = new Client({ name: 'e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: 'node', args: ['--no-warnings', 'mcp/src/server.ts'], env: { ...process.env, API_URL: API } as any }));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), exposed);
  const r: any = await client.callTool({ name: 'createTodo', arguments: { body: { title: 'e2e', priority: 'high' } } });
  assert.equal(r.isError, true, 'MCP surfaces the same 422');
  assert.match(r.content[0].text, /High-priority todos must have a due date/);
  await client.close();
});

test('rate limiting: 429 problem with Retry-After and RateLimit headers', async () => {
  const ci = await clientToken('todos-ci'); // own identity: the limit is per principal
  const first = await call('GET', '/todos?limit=1', { token: ci });
  const limit = Number(first.headers.get('ratelimit-limit'));
  assert.ok(limit > 0);
  let last = first;
  for (let i = 0; i < limit && last.status !== 429; i++) last = await call('GET', '/todos?limit=1', { token: ci });
  assert.equal(last.status, 429);
  assert.ok(Number(last.headers.get('retry-after')) > 0);
  assert.equal(last.headers.get('ratelimit-remaining'), '0');
});

test('discoverability: Link header and RFC 9727 api-catalog lead to the contract', async () => {
  const res = await fetch(`${API}/todos`);
  assert.match(res.headers.get('link') ?? '', /<\/openapi\.json>; rel="service-desc"/);
  const cat = await fetch(`${API}/.well-known/api-catalog`);
  assert.match(cat.headers.get('content-type') ?? '', /application\/linkset\+json/);
  const desc = (await cat.json()).linkset[0]['service-desc'][0].href;
  const found = await (await fetch(desc)).json();
  assert.equal(found.info.title, spec.info.title);
  assert.ok(Object.keys(found.paths).length > 0);
});
