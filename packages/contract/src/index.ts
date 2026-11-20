// Everything here is derived from api/openapi.yaml (see `npm run generate`).
import createClient from 'openapi-fetch';
import type { paths, components, operations as OperationsMap } from '../generated/schema.js';
import openapi from '../generated/openapi.json' with { type: 'json' };

/** The dereferenced OpenAPI document (no $refs) — consumed at runtime by service and UI. */
export const spec = openapi as unknown as OpenApiDocument;

export type Schemas = components['schemas'];
export type Todo = Schemas['Todo'];
export type TodoCreate = Schemas['TodoCreate'];
export type Problem = Schemas['Problem'];

/** Every operationId in the spec — lets implementations be checked for completeness. */
export type OperationId = keyof OperationsMap;

/** Fully typed client: paths, params, bodies and responses checked at compile time. */
export const createApiClient = (baseUrl: string) => createClient<paths>({ baseUrl });

export const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface Operation {
  operationId: string;
  summary?: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content: Record<string, { schema: JsonSchema }> };
  responses: Record<string, unknown>;
  'x-mcp'?: boolean;
  /** OAuth2 scopes required (OpenAPI security requirements; any one must be met). */
  security?: Record<string, string[]>[];
  'x-preconditions'?: { rule: string; message: string; reason?: string }[];
  [ext: `x-${string}`]: unknown;
}
export interface Parameter { name: string; in: 'path' | 'query' | 'header'; required?: boolean; schema: JsonSchema; description?: string }
export type JsonSchema = Record<string, any>;
export interface PathItem { parameters?: Parameter[]; [method: string]: Operation | Parameter[] | undefined }
export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths: Record<string, PathItem>;
  components: { schemas: Record<string, JsonSchema> };
}

/** Iterate all operations with their path-level parameters merged in. */
export function* operations(doc: OpenApiDocument = spec) {
  for (const [path, item] of Object.entries(doc.paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const parameters = [...(item.parameters ?? []), ...(op.parameters ?? [])];
      yield { path, method, op: { ...op, parameters } };
    }
  }
}
