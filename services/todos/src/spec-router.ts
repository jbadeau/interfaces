/**
 * Spec-driven router. Nothing in here knows about todos.
 *
 * For every operation in the OpenAPI document it:
 *   0. authenticates, rate-limits and checks the operation's OAuth2 scopes (auth.ts),
 *   1. registers the route,
 *   2. validates path/query params and body against JSON Schema 2020-12 (structural),
 *   3. evaluates x-validations CEL rules on the body (semantic),
 *   4. evaluates x-preconditions CEL rules on the current resource (semantic),
 *   5. dispatches to the handler registered under the operationId,
 *   6. renders all errors as RFC 9457 problem+json.
 * Long-running operations answer 202 + Location; see operations.ts.
 */
import type { FastifyInstance, FastifyReply } from 'fastify';
import Ajv2020, { type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { operations, type OpenApiDocument, type OperationId, type Problem } from '@demo/contract';
import { collectRules, evaluate, type Violation } from '@demo/semantic';
import { authenticate, authorize, rateLimit } from './auth.ts';

export interface Ctx {
  params: Record<string, any>;
  query: Record<string, any>;
  body: any;
  /** Current resource, loaded when the operation declares x-preconditions. */
  current?: any;
}
export interface Result { status: number; body?: unknown; headers?: Record<string, string> }
export type Handler = (ctx: Ctx) => Result | Promise<Result>;

export interface Implementation {
  /** One handler per operationId. Missing handlers are a compile error. */
  handlers: Record<OperationId, Handler>;
  /** Loads the resource addressed by path params (used for preconditions). */
  load(params: Record<string, any>): unknown | undefined;
}

const ajvOptions = { strict: false, allErrors: true } as const;
const bodyAjv = addFormats(new Ajv2020({ ...ajvOptions, useDefaults: true })); // apply schema defaults (e.g. priority)
const paramAjv = addFormats(new Ajv2020({ ...ajvOptions, coerceTypes: true, useDefaults: true }));

export class ProblemError extends Error {
  constructor(public problem: Problem) { super(problem.title); }
}

export const problem = (status: number, title: string, extra: Partial<Problem> = {}): ProblemError =>
  new ProblemError({ type: 'about:blank', status, title, ...extra });

const sendProblem = (reply: FastifyReply, p: Problem) => {
  if (p.status === 401) reply.header('WWW-Authenticate', 'Bearer realm="todos"');
  return reply.code(p.status).type('application/problem+json').send(JSON.stringify(p));
};

const ajvToErrors = (errors: ErrorObject[] | null | undefined, prefix = ''): Violation[] =>
  (errors ?? []).map((e) => ({
    pointer:
      prefix + e.instancePath +
      (e.keyword === 'required' ? `/${e.params.missingProperty}` : '') +
      (e.keyword === 'unevaluatedProperties' ? `/${e.params.unevaluatedProperty}` : ''),
    detail: e.message ?? 'invalid',
    rule: undefined as unknown as string,
  })).map(({ rule, ...rest }) => rest as Violation);

export function registerSpec(app: FastifyInstance, doc: OpenApiDocument, impl: Implementation) {
  for (const { path, method, op } of operations(doc)) {
    const handler = impl.handlers[op.operationId as OperationId];
    if (!handler) throw new Error(`No handler for operationId "${op.operationId}"`);

    const paramSchema = (where: 'path' | 'query') => {
      const ps = op.parameters!.filter((p) => p.in === where);
      return paramAjv.compile({
        type: 'object',
        properties: Object.fromEntries(ps.map((p) => [p.name, p.schema])),
        required: ps.filter((p) => p.required).map((p) => p.name),
      });
    };
    const validatePath = paramSchema('path');
    const validateQuery = paramSchema('query');

    const bodySchema = op.requestBody?.content['application/json']?.schema;
    const validateBody: ValidateFunction | undefined = bodySchema && bodyAjv.compile(bodySchema);
    const bodyRules = collectRules(bodySchema);
    const preconditions = op['x-preconditions'] ?? [];

    app.route({
      method: method.toUpperCase() as any,
      url: path.replace(/\{(\w+)\}/g, ':$1'),
      handler: async (req, reply) => {
        try {
          // Cross-cutting, from the spec: who (401), may they (403), how often (429).
          const principal = authenticate(req);
          rateLimit(principal?.sub ?? req.ip, reply, principal?.quota);
          authorize(op.security, principal);

          const params = { ...(req.params as object) };
          const query = { ...(req.query as object) };
          const structural = [
            ...(validatePath(params) ? [] : ajvToErrors(validatePath.errors, '/path')),
            ...(validateQuery(query) ? [] : ajvToErrors(validateQuery.errors, '/query')),
          ];
          if (validateBody) {
            if (req.body === undefined) structural.push({ pointer: '', detail: 'request body is required', rule: '' });
            else if (!validateBody(req.body)) structural.push(...ajvToErrors(validateBody.errors));
          }
          if (structural.length)
            throw problem(400, 'Request does not match the schema', { errors: structural });

          // Semantic validation: business rules on the payload.
          const semantic = evaluate(bodyRules, req.body);
          if (semantic.length)
            throw problem(422, 'Request violates business rules', { errors: semantic });

          // Semantic validation: preconditions on current state.
          let current: unknown;
          if (preconditions.length) {
            current = impl.load(params);
            if (current === undefined) throw problem(404, 'Not found');
            const failed = evaluate(preconditions, current);
            if (failed.length)
              throw problem(409, 'Operation not allowed in current state', { detail: failed[0].detail, errors: failed });
          }

          const result = await handler({ params, query, body: req.body, current });
          reply.code(result.status);
          if (result.headers) reply.headers(result.headers);
          return result.body ?? reply.send();
        } catch (e) {
          if (e instanceof ProblemError) return sendProblem(reply, { ...e.problem, instance: req.url });
          req.log.error(e);
          return sendProblem(reply, { type: 'about:blank', status: 500, title: 'Internal error', instance: req.url });
        }
      },
    });
  }

  // Malformed JSON etc. as problem+json too.
  app.setErrorHandler((err: any, req, reply) =>
    sendProblem(reply, { type: 'about:blank', status: err.statusCode ?? 500, title: err.message, instance: req.url }));
  app.setNotFoundHandler((req, reply) =>
    sendProblem(reply, { type: 'about:blank', status: 404, title: 'Not found', instance: req.url }));
}
