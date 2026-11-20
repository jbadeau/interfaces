/**
 * Polling long-running operations: one implementation for every client
 * (web UI, CLI, MCP). An operation is recognised by its shape (the spec's
 * Operation schema: href + status + progress), not by name.
 */
export interface OperationLike {
  id: string;
  href: string;
  title: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  progress: number;
  result?: Record<string, unknown>;
  error?: { status: number; title: string; detail?: string; errors?: unknown[] };
}

export const isOperation = (v: any): v is OperationLike =>
  !!v && typeof v === 'object' && typeof v.href === 'string' && typeof v.status === 'string' && typeof v.progress === 'number';

export const isDone = (op: OperationLike) => op.status === 'succeeded' || op.status === 'failed';

/**
 * Poll `op.href` with `get` until the operation is done (or `timeoutMs` passes,
 * in which case the last state is returned and the caller can poll again later).
 */
export async function pollOperation(
  op: OperationLike,
  get: (href: string) => Promise<OperationLike>,
  { onUpdate, intervalMs = 700, timeoutMs = 120_000 }: { onUpdate?: (op: OperationLike) => void; intervalMs?: number; timeoutMs?: number } = {},
): Promise<OperationLike> {
  const until = Date.now() + timeoutMs;
  onUpdate?.(op);
  while (!isDone(op) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const next = await get(op.href);
    if (!isOperation(next)) throw next; // e.g. a 401/429 problem while polling
    op = next;
    onUpdate?.(op);
  }
  return op;
}
