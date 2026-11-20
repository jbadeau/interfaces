/**
 * Sign-in for the web UI, derived from the spec's OAuth2 security scheme
 * (authorization code + PKCE). Nothing todo-specific: the authorize/token URLs
 * and scopes come from openapi.yaml. In the demo they point at the mock IdP.
 */
import { spec, type Operation } from '@demo/contract';

const CLIENT_ID = 'todos-web';
const KEY = 'demo.token';
const scheme = Object.values((spec as any).components.securitySchemes ?? {}).find((s: any) => s.type === 'oauth2') as any;
const flow = scheme?.flows?.authorizationCode;

export interface Session { token: string; name: string; scopes: string[] }

const b64url = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (token: string) => JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));

export function session(): Session | undefined {
  try {
    const token = sessionStorage.getItem(KEY);
    if (!token) return undefined;
    const c = decode(token);
    if (c.exp * 1000 < Date.now()) return signOut();
    return { token, name: c.name ?? c.sub, scopes: String(c.scope).split(' ') };
  } catch { return undefined; }
}

export function signOut(): undefined {
  try { sessionStorage.removeItem(KEY); } catch { /* ignore */ }
  return undefined;
}

/** Redirect to the IdP's sign-in page (authorization code + PKCE). */
export async function signIn() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(8)));
  sessionStorage.setItem('demo.pkce', JSON.stringify({ verifier, state }));
  const url = new URL(flow.authorizationUrl);
  url.search = new URLSearchParams({
    response_type: 'code', client_id: CLIENT_ID, redirect_uri: location.origin + '/', state,
    scope: Object.keys(flow.scopes).join(' '),
    code_challenge: b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
    code_challenge_method: 'S256',
  }).toString();
  location.assign(url);
}

/** On return from the IdP: exchange ?code for a token. */
export async function completeSignIn(): Promise<Session | undefined> {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code) return session();
  history.replaceState(null, '', location.pathname);
  const pkce = JSON.parse(sessionStorage.getItem('demo.pkce') ?? '{}');
  if (pkce.state !== q.get('state')) return undefined;
  // Token endpoint via the dev proxy (same origin).
  const res = await fetch('/api' + new URL(flow.tokenUrl).pathname, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: location.origin + '/', code_verifier: pkce.verifier }),
  });
  if (!res.ok) return undefined;
  sessionStorage.setItem(KEY, (await res.json()).access_token);
  return session();
}

/** Scopes an operation needs that the session lacks (from the spec's `security`). */
export function missingScopes(op: Operation, s: Session | undefined): string[] {
  const reqs = op.security ?? [];
  if (!reqs.length || reqs.some((r) => !Object.keys(r).length)) return [];
  const needed = [...new Set(reqs.flatMap((r) => Object.values(r).flat()))];
  return needed.filter((sc) => !s?.scopes.includes(sc));
}
