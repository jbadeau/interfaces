/**
 * MOCK identity provider: DEV/DEMO ONLY. Stands in for the platform's real
 * OAuth2 / OIDC provider (Keycloak, Entra ID, Okta, Auth0, ...), so the demo can
 * show login + scopes end to end without external services.
 *
 *   GET  /oauth2/authorize  sign-in page (pick a demo user), authorization-code + PKCE
 *   POST /oauth2/token      authorization_code | client_credentials -> JWT (HS256)
 *
 * The API itself only verifies tokens and checks the scopes the spec declares
 * (see auth.ts); swapping this for a real IdP changes nothing else.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

const SECRET = process.env.MOCK_IDP_SECRET ?? 'dev-only-secret';
const TTL = 3600;

/** Demo users: a developer (read + write) and a viewer (read only). */
export const USERS: Record<string, { name: string; role: string; scopes: string[] }> = {
  ada: { name: 'Ada Lovelace', role: 'Developer', scopes: ['todos:read', 'todos:write', 'operations:read'] },
  grace: { name: 'Grace Hopper', role: 'Viewer', scopes: ['todos:read', 'operations:read'] },
};
/** Demo machine clients (CLI, MCP server, CI) using client credentials. */
const CLIENTS: Record<string, { secret: string; scopes: string[]; quota?: number }> = {
  'todos-cli': { secret: 'dev-secret', scopes: ['todos:read', 'todos:write', 'operations:read'] },
  'todos-mcp': { secret: 'dev-secret', scopes: ['todos:read', 'todos:write', 'operations:read'] },
  'todos-ci': { secret: 'dev-secret', scopes: ['todos:read', 'operations:read'] }, // e2e: hits the default limit
  'todos-load': { secret: 'dev-secret', scopes: ['todos:read', 'todos:write', 'operations:read'], quota: 1_000_000 }, // load tests
};

const b64 = (v: Buffer | string) => Buffer.from(v).toString('base64url');
const sign = (data: string) => createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken(claims: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64(JSON.stringify({ iss: 'mock-idp', iat: now, exp: now + TTL, ...claims }));
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/** `quota`: requests per rate-limit window for this client (per-client tiers), if set. */
export interface Principal { sub: string; name?: string; scope: string[]; client_id?: string; quota?: number }

/** Verify a JWT from this IdP. Returns null when it is invalid or expired. */
export function verifyToken(token: string): Principal | null {
  const [head, body, sig] = token.split('.');
  if (!head || !body || !sig) return null;
  const expected = Buffer.from(sign(`${head}.${body}`));
  if (expected.length !== Buffer.from(sig).length || !timingSafeEqual(expected, Buffer.from(sig))) return null;
  const c = JSON.parse(Buffer.from(body, 'base64url').toString());
  if (typeof c.exp !== 'number' || c.exp < Date.now() / 1000) return null;
  return { sub: c.sub, name: c.name, scope: String(c.scope ?? '').split(' ').filter(Boolean), client_id: c.client_id, quota: c.quota };
}

const codes = new Map<string, { user: string; scopes: string[]; challenge?: string; redirect: string; client: string }>();
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const page = (q: Record<string, string>) => `<!doctype html><html><head><meta charset="utf-8"><title>Platform SSO</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
 body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f4f6fb;font:15px/1.5 system-ui,-apple-system,sans-serif;color:#1d2433}
 .card{width:400px;background:#fff;border:1px solid #e3e7ef;border-radius:14px;padding:28px;box-shadow:0 10px 30px rgba(20,30,60,.08)}
 .brand{display:flex;align-items:center;gap:10px;font-weight:700;font-size:18px}.brand i{width:28px;height:28px;border-radius:8px;background:#4c6ef5;display:inline-block}
 .mock{font-size:12px;color:#c92a2a;background:#fff5f5;border-radius:6px;padding:2px 8px;margin-left:auto;font-weight:600}
 p{color:#5c667a;margin:8px 0 18px}
 button{display:flex;width:100%;align-items:center;gap:12px;text-align:left;border:1px solid #e3e7ef;background:#fff;border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer;font:inherit}
 button:hover{border-color:#4c6ef5;background:#f5f7ff}
 .av{width:36px;height:36px;border-radius:50%;display:grid;place-items:center;color:#fff;font-weight:700}
 small{display:block;color:#5c667a} code{font-size:12px;color:#4c6ef5}
</style></head><body><form class="card" method="post">
 <div class="brand"><i></i>Platform SSO<span class="mock">MOCK</span></div>
 <p><b>${esc(q.client_id ?? 'An app')}</b> wants to access the Todos API.</p>
 ${Object.entries(USERS).map(([id, u], i) => `<button name="user" value="${id}"><span class="av" style="background:${i ? '#7048e8' : '#2f9e44'}">${u.name[0]}</span><span>${esc(u.name)} <small>${u.role} · <code>${u.scopes.join(' ')}</code></small></span></button>`).join('')}
 ${['client_id', 'redirect_uri', 'state', 'scope', 'code_challenge'].map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? '')}">`).join('')}
</form></body></html>`;

export function registerMockIdp(app: FastifyInstance) {
  app.get('/oauth2/authorize', async (req, reply) => reply.type('text/html').send(page(req.query as any)));

  app.post('/oauth2/authorize', async (req, reply) => {
    const f = req.body as Record<string, string>;
    const user = USERS[f.user];
    if (!user || !f.redirect_uri) return reply.code(400).send('bad request');
    const requested = (f.scope || user.scopes.join(' ')).split(' ');
    const code = randomBytes(16).toString('hex');
    codes.set(code, { user: f.user, scopes: requested.filter((s) => user.scopes.includes(s)), challenge: f.code_challenge || undefined, redirect: f.redirect_uri, client: f.client_id });
    const url = new URL(f.redirect_uri);
    url.searchParams.set('code', code);
    if (f.state) url.searchParams.set('state', f.state);
    return reply.redirect(url.toString(), 303);
  });

  app.post('/oauth2/token', async (req, reply) => {
    const f = req.body as Record<string, string>;
    const fail = (error: string) => reply.code(400).send({ error });
    if (f.grant_type === 'authorization_code') {
      const c = codes.get(f.code);
      codes.delete(f.code);
      if (!c || c.redirect !== f.redirect_uri) return fail('invalid_grant');
      if (c.challenge && createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== c.challenge) return fail('invalid_grant');
      const u = USERS[c.user];
      return { access_token: issueToken({ sub: c.user, name: u.name, scope: c.scopes.join(' '), client_id: c.client }), token_type: 'Bearer', expires_in: TTL, scope: c.scopes.join(' ') };
    }
    if (f.grant_type === 'client_credentials') {
      const [id, secret] = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString().split(':')
        : [f.client_id, f.client_secret];
      const client = CLIENTS[id];
      if (!client || client.secret !== secret) return reply.code(401).send({ error: 'invalid_client' });
      const scopes = f.scope ? f.scope.split(' ').filter((s) => client.scopes.includes(s)) : client.scopes;
      return { access_token: issueToken({ sub: id, scope: scopes.join(' '), client_id: id, ...(client.quota ? { quota: client.quota } : {}) }), token_type: 'Bearer', expires_in: TTL, scope: scopes.join(' ') };
    }
    return fail('unsupported_grant_type');
  });
}
