/**
 * Long-running operations, generic (nothing in here knows about todos).
 *
 * A handler calls `start(title, work)` and answers 202 with the Operation; the
 * work runs in the background and reports progress. Clients poll
 * GET /operations/{operationId} until status is `succeeded` (with `result`) or
 * `failed` (with `error`, the same RFC 9457 problem as any synchronous error).
 */
import { randomBytes } from 'node:crypto';
import type { Problem } from '@demo/contract';
import { problem, ProblemError, type Ctx, type Result } from './spec-router.ts';

export type OperationStatus = 'pending' | 'running' | 'succeeded' | 'failed';
export interface Operation {
  id: string; href: string; title: string; status: OperationStatus; progress: number;
  createdAt: string; updatedAt: string; result?: Record<string, unknown>; error?: Problem;
}
export type Work = (report: (progress: number) => void) => Promise<Record<string, unknown>>;

/** Seconds a client should wait between polls while an operation is not done. */
const RETRY_AFTER = 1;
const store = new Map<string, Operation>();
const now = () => new Date().toISOString();
const done = (op: Operation) => op.status === 'succeeded' || op.status === 'failed';

export function start(title: string, work: Work): Operation {
  const id = `op-${randomBytes(4).toString('hex')}`;
  const op: Operation = { id, href: `/operations/${id}`, title, status: 'pending', progress: 0, createdAt: now(), updatedAt: now() };
  store.set(id, op);
  const set = (patch: Partial<Operation>) => Object.assign(op, patch, { updatedAt: now() });
  queueMicrotask(async () => {
    set({ status: 'running' });
    try {
      const result = await work((p) => set({ progress: Math.max(0, Math.min(99, Math.round(p))) }));
      set({ status: 'succeeded', progress: 100, result });
    } catch (e) {
      const error: Problem = e instanceof ProblemError
        ? e.problem
        : { type: 'about:blank', status: 500, title: 'Operation failed', detail: (e as Error).message };
      set({ status: 'failed', error });
    }
  });
  return op;
}

/** The 202 answer for a started operation. */
export const accepted = (op: Operation): Result => ({
  status: 202, body: op, headers: { Location: op.href, 'Retry-After': String(RETRY_AFTER) },
});

const encodeCursor = (n: number) => Buffer.from(String(n)).toString('base64url');
const decodeCursor = (c?: string) => (c ? Number(Buffer.from(c, 'base64url').toString()) || 0 : 0);

/** Handlers for the generic /operations endpoints. */
export const operationHandlers = {
  listOperations: ({ query: { limit, cursor, status } }: Ctx): Result => {
    const all = [...store.values()].filter((o) => !status || o.status === status).reverse();
    const start = decodeCursor(cursor);
    const items = all.slice(start, start + limit);
    return { status: 200, body: { items, nextCursor: start + limit < all.length ? encodeCursor(start + limit) : null } };
  },
  getOperation: ({ params }: Ctx): Result => {
    const op = store.get(params.operationId);
    if (!op) throw problem(404, 'Operation not found', { detail: `No operation with id ${params.operationId}` });
    return { status: 200, body: op, headers: done(op) ? {} : { 'Retry-After': String(RETRY_AFTER) } };
  },
};
