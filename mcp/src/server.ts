#!/usr/bin/env -S node --no-warnings
/**
 * Spec-driven MCP server. Nothing in here knows about todos.
 *
 * - Every operation marked `x-mcp: true` becomes a tool (name = operationId).
 * - Tool input schema = path/query params + `body` (the JSON Schema from the spec).
 * - Tool annotations are derived from HTTP semantics (GET = read-only, DELETE = destructive).
 * - Results carry structuredContent (raw JSON, for the agent) and text rendered
 *   with the shared design atoms (same tokens/symbols as the web UI and CLI).
 * - Validation (structural + semantic) is done by the service; its RFC 9457
 *   problems are returned as tool errors so the agent can self-correct.
 * - If the client supports elicitation, a rejected body is first turned into a
 *   form for the user instead (see elicit.ts), built from the same JSON Schema.
 * - Long-running operations (202 + Operation) are polled to completion, with MCP
 *   progress notifications; the agent gets the result or the RFC 9457 problem.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { operations, spec, type Operation } from '@demo/contract';
import { layoutFor, successSchema } from '@demo/design';
import { render } from '@demo/design/text';
import { formFor, problemMessage } from './elicit.ts';
import { isOperation, pollOperation } from '@demo/contract/async';

const API_URL = process.env.API_URL ?? 'http://127.0.0.1:8787';

/**
 * Auth: the API decides who may do what (OAuth2 scopes in the spec). This server
 * is just a client: it gets a token with client credentials from the spec's token
 * URL (demo: the mock IdP). With the MCP authorization spec, a host would instead
 * sign the user in and pass their token through.
 */
const ccFlow = (spec as any).components?.securitySchemes?.oauth2?.flows?.clientCredentials;
let cached: { token: string; until: number } | undefined;
async function authHeader(): Promise<Record<string, string>> {
  if (!ccFlow) return {};
  if (!cached || cached.until < Date.now()) {
    const res = await fetch(ccFlow.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: process.env.MCP_CLIENT_ID ?? 'todos-mcp', client_secret: process.env.MCP_CLIENT_SECRET ?? 'dev-secret' }),
    });
    if (!res.ok) return {};
    const t = await res.json();
    cached = { token: t.access_token, until: Date.now() + (t.expires_in - 60) * 1000 };
  }
  return { authorization: `Bearer ${cached.token}` };
}
const api = async (url: string, init: RequestInit = {}) =>
  fetch(API_URL + url, { ...init, headers: { ...(init.headers as any), ...(await authHeader()) } });

interface Tool { name: string; method: string; path: string; op: Operation; inputSchema: Record<string, any> }

const tools: Tool[] = [...operations()]
  .filter(({ op }) => op['x-mcp'] === true)
  .map(({ path, method, op }) => {
    const params = op.parameters ?? [];
    const body = op.requestBody?.content['application/json']?.schema;
    return {
      name: op.operationId, method, path, op,
      inputSchema: {
        type: 'object',
        properties: {
          ...Object.fromEntries(params.map((p) => [p.name, { ...p.schema, description: p.description }])),
          ...(body ? { body } : {}),
        },
        required: [...params.filter((p) => p.required).map((p) => p.name), ...(op.requestBody?.required ? ['body'] : [])],
      },
    };
  });

const server = new Server(
  { name: 'todos-mcp', version: spec.info.version },
  { capabilities: { tools: {} }, instructions: spec.info.description },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({
    name: t.name,
    title: t.op.summary,
    description: [
      t.op.summary, t.op.description,
      // With elicitation, the server owns the form: the agent shouldn't interview the user itself.
      t.op.requestBody && server.getClientCapabilities()?.elicitation &&
        'Call it with what the user gave you, even if a field or business rule is not satisfied: the server then asks the user to complete it in a form generated from the API spec. Do not ask the user for missing fields yourself',
    ].filter(Boolean).join('. '),
    inputSchema: t.inputSchema,
    annotations: {
      title: t.op.summary,
      readOnlyHint: t.method === 'get',
      destructiveHint: t.method === 'delete',
      idempotentHint: ['get', 'put', 'delete'].includes(t.method),
      openWorldHint: false,
    },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
  const tool = tools.find((t) => t.name === req.params.name);
  if (!tool) return { isError: true, content: [{ type: 'text', text: `Unknown tool ${req.params.name}` }] };

  const args = (req.params.arguments ?? {}) as Record<string, any>;
  const params = tool.op.parameters ?? [];
  const path = tool.path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(args[k]));
  const query = new URLSearchParams(
    params.filter((p) => p.in === 'query' && args[p.name] !== undefined).map((p) => [p.name, String(args[p.name])]),
  );

  const send = async () => {
    const res = await api(`${path}${query.size ? `?${query}` : ''}`, {
      method: tool.method.toUpperCase(),
      headers: args.body ? { 'content-type': 'application/json' } : {},
      body: args.body ? JSON.stringify(args.body) : undefined,
    });
    const text = await res.text();
    return { res, data: text ? JSON.parse(text) : undefined };
  };

  let { res, data }: { res: Response; data: any } = await send();

  // Rejected body (400 structural / 422 semantic)? Ask the user with a form built
  // from the spec, pre-filled with the agent's attempt, then retry.
  const bodySchema = tool.op.requestBody?.content['application/json']?.schema;
  const canElicit = !!bodySchema && !!server.getClientCapabilities()?.elicitation;
  const viaForm: string[] = []; // fields the user supplied in a form, so the agent can say where they came from
  for (let round = 0; canElicit && [400, 422].includes(res.status) && round < 3; round++) {
    const form = formFor(bodySchema, args.body);
    const answer = await server.elicitInput({
      message: problemMessage(tool.op.summary ?? tool.name, data),
      requestedSchema: form.requestedSchema as any,
    });
    if (answer.action !== 'accept' || !answer.content) {
      return { isError: true, content: [{ type: 'text', text: `The user ${answer.action === 'decline' ? 'declined' : 'cancelled'} the form; nothing was changed.` }] };
    }
    const before = JSON.stringify(args.body ?? {});
    args.body = form.toBody(answer.content);
    for (const [k, v] of Object.entries(args.body ?? {})) if (!before.includes(`"${k}":${JSON.stringify(v)}`) && !viaForm.includes(k)) viaForm.push(k);
    ({ res, data } = await send());
  }

  // Long-running (202 + Operation): poll it here, reporting MCP progress
  // notifications, so the agent gets the outcome, not a ticket. If it takes
  // too long, the agent gets the operation back and can poll getOperation.
  if (res.status === 202 && isOperation(data)) {
    const token = req.params._meta?.progressToken;
    data = await pollOperation(data, async (href) => (await api(href)).json(), {
      timeoutMs: 60_000,
      onUpdate: (op) => {
        if (token !== undefined) {
          void extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: op.progress, total: 100, message: `${op.title}: ${op.status}` } });
        }
      },
    });
  }

  const rendered = render(layoutFor(successSchema(tool.op), data, `${tool.op.summary}: done.`));
  const failed = !res.ok || (isOperation(data) && data.status === 'failed');
  return {
    isError: failed,
    content: [
      ...(viaForm.length ? [{ type: 'text' as const, text: `The API rejected the first attempt, so the user completed a form (MCP elicitation) and supplied: ${viaForm.join(', ')}.` }] : []),
      { type: 'text', text: rendered },
    ],
    ...(data && typeof data === 'object' && !Array.isArray(data) ? { structuredContent: data } : {}),
  };
});

await server.connect(new StdioServerTransport());
