/**
 * Cross-cutting concerns, applied by the router to every operation from the spec.
 * Nothing here knows about todos.
 *
 *   authenticate  Bearer token -> principal              (401 problem if missing/invalid)
 *   authorize     the operation's `security` scopes       (403 problem if not granted)
 *   rateLimit     per principal (or IP), fixed window     (429 problem + Retry-After);
 *                 a token's `quota` claim sets a per-client tier
 *
 * Every interface (web, CLI, MCP, CI) is just a client sending a token: one
 * place decides who may do what, and how often.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { problem } from './spec-router.ts';
import { verifyToken, type Principal } from './mock-idp.ts';

type SecurityRequirement = Record<string, string[]>;

export function authenticate(req: FastifyRequest): Principal | null {
  const h = req.headers.authorization;
  if (!h) return null;
  const principal = h.startsWith('Bearer ') ? verifyToken(h.slice(7)) : null;
  if (!principal) throw problem(401, 'Invalid or expired token', { detail: 'Sign in again to get a new token.' });
  return principal;
}

/** OpenAPI semantics: any one requirement object must be met; `{}` means anonymous. */
export function authorize(security: SecurityRequirement[] | undefined, who: Principal | null) {
  if (!security?.length) return;
  if (security.some((r) => Object.keys(r).length === 0)) return;
  if (!who) throw problem(401, 'Authentication required', { detail: 'Send an OAuth2 bearer token (Authorization: Bearer …).' });
  const ok = security.some((r) => Object.values(r).every((scopes) => scopes.every((s) => who.scope.includes(s))));
  if (!ok) {
    const needed = [...new Set(security.flatMap((r) => Object.values(r).flat()))];
    throw problem(403, 'Missing permission', {
      detail: `${who.name ?? who.sub} lacks scope ${needed.filter((s) => !who.scope.includes(s)).join(', ')}.`,
      errors: needed.filter((s) => !who.scope.includes(s)).map((s) => ({ detail: `Requires scope ${s}` })),
    });
  }
}

const LIMIT = Number(process.env.RATE_LIMIT ?? 120); // requests per window, per principal
const WINDOW = Number(process.env.RATE_WINDOW ?? 60); // seconds
const windows = new Map<string, { start: number; count: number }>();

/** Fixed-window limiter. Sets IETF RateLimit-* headers on every response. */
export function rateLimit(key: string, reply: FastifyReply, limit = LIMIT) {
  const now = Math.floor(Date.now() / 1000);
  let w = windows.get(key);
  if (!w || now - w.start >= WINDOW) windows.set(key, (w = { start: now, count: 0 }));
  w.count++;
  const reset = w.start + WINDOW - now;
  reply.headers({
    'RateLimit-Limit': String(limit),
    'RateLimit-Remaining': String(Math.max(0, limit - w.count)),
    'RateLimit-Reset': String(reset),
  });
  if (w.count > limit) {
    reply.header('Retry-After', String(reset));
    throw problem(429, 'Too many requests', { detail: `Limit is ${limit} requests per ${WINDOW}s. Retry in ${reset}s.` });
  }
}
