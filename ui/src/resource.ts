/**
 * Derives a "resource model" for the UI from the OpenAPI document.
 * Nothing todo-specific: point it at any collection path.
 */
import { operations, spec, type Operation, type JsonSchema } from '@demo/contract';
import { session } from './auth';

export interface ResourceModel {
  title: string;
  list: Operation;
  create?: Operation;
  createSchema?: JsonSchema;
  itemSchema: JsonSchema;
  itemPath: string;
  remove?: Operation;
  /** POST {itemPath}/{action} operations, rendered as row buttons. */
  actions: { name: string; path: string; op: Operation }[];
  /** POST {collectionPath}/{action} operations (e.g. long-running ones), rendered in the toolbar. */
  collectionActions: { name: string; path: string; op: Operation }[];
}

export function resourceModel(collectionPath: string): ResourceModel {
  const ops = [...operations()];
  const list = ops.find((o) => o.path === collectionPath && o.method === 'get')!.op;
  const create = ops.find((o) => o.path === collectionPath && o.method === 'post')?.op;
  const itemPath = ops.find((o) => o.path.startsWith(collectionPath + '/{') && o.path.split('/').length === collectionPath.split('/').length + 1)!.path;
  const remove = ops.find((o) => o.path === itemPath && o.method === 'delete')?.op;
  const actions = ops
    .filter((o) => o.method === 'post' && o.path.startsWith(itemPath + '/'))
    .map((o) => ({ name: o.path.slice(itemPath.length + 1), path: o.path, op: o.op }));

  const collectionActions = ops
    .filter((o) => o.method === 'post' && o.path.startsWith(collectionPath + '/') && !o.path.includes('{'))
    .map((o) => ({ name: o.path.slice(collectionPath.length + 1), path: o.path, op: o.op }));

  const pageSchema = (list.responses['200'] as any).content['application/json'].schema;
  return {
    title: spec.info.title,
    list,
    create,
    createSchema: create?.requestBody?.content['application/json'].schema,
    itemSchema: pageSchema.properties.items.items,
    itemPath,
    remove,
    actions,
    collectionActions,
  };
}

export const fillPath = (path: string, params: Record<string, string>) =>
  path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k]));

export interface ProblemResponse {
  status: number;
  title: string;
  detail?: string;
  errors?: { pointer?: string; detail: string; rule?: string }[];
}

/** Minimal fetch: the API is proxied under /api by Vite. Throws RFC 9457 problems. */
export async function call(method: string, path: string, body?: unknown, query?: Record<string, string>) {
  const qs = query && Object.keys(query).length ? '?' + new URLSearchParams(query) : '';
  const res = await fetch(`/api${path}${qs}`, {
    method: method.toUpperCase(),
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      // Every request carries the signed-in user's token; the API decides.
      ...(session() ? { authorization: `Bearer ${session()!.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? undefined : await res.json();
  if (!res.ok) throw data as ProblemResponse;
  return data;
}
