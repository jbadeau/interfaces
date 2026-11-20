/**
 * Spec-driven forms for agents (MCP elicitation). Nothing in here knows about todos.
 *
 * When a tool call with a request body is rejected by the service (400 structural,
 * 422 semantic), the server asks the *user* to fix it: it turns the body's JSON
 * Schema into an elicitation form, pre-fills what the agent already sent, and puts
 * the service's RFC 9457 errors in the message. The client (Claude Code, Inspector,
 * …) renders the form natively; the answer is merged back and the call retried.
 */
import type { JsonSchema } from '@demo/contract';

/** A form field and how to turn its answer back into the body's shape. */
interface Field { name: string; schema: JsonSchema; list: boolean }

/** Collect properties/required through `allOf` (the spec composes schemas that way). */
function flatten(schema: JsonSchema): { properties: Record<string, JsonSchema>; required: string[] } {
  const out = { properties: { ...(schema.properties ?? {}) }, required: [...(schema.required ?? [])] };
  for (const part of schema.allOf ?? []) {
    const f = flatten(part);
    Object.assign(out.properties, f.properties);
    out.required.push(...f.required);
  }
  return out;
}

/** JSON Schema property -> elicitation primitive (flat: string/number/boolean/enum). */
function toField(name: string, p: JsonSchema): Field | undefined {
  const base = { title: p.title ?? name, ...(p.description ? { description: p.description } : {}) };
  if (p.enum) return { name, list: false, schema: { type: 'string', ...base, enum: p.enum } };
  if (p.type === 'string') {
    const format = ['date', 'date-time', 'email', 'uri'].includes(p.format) ? { format: p.format } : {};
    return { name, list: false, schema: { type: 'string', ...base, ...format, ...pick(p, 'minLength', 'maxLength') } };
  }
  if (p.type === 'integer' || p.type === 'number') return { name, list: false, schema: { type: p.type, ...base, ...pick(p, 'minimum', 'maximum') } };
  if (p.type === 'boolean') return { name, list: false, schema: { type: 'boolean', ...base } };
  if (p.type === 'array' && p.items?.enum) return { name, list: false, schema: { type: 'array', ...base, items: { type: 'string', enum: p.items.enum } } };
  if (p.type === 'array' && p.items?.type === 'string') {
    return { name, list: true, schema: { type: 'string', ...base, description: `${p.description ?? base.title} (comma-separated)` } };
  }
  return undefined; // nested objects are not form-able: the agent has to supply them
}

const pick = (o: JsonSchema, ...keys: string[]) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Build the elicitation form for a body schema, pre-filled with what the agent sent. */
export function formFor(bodySchema: JsonSchema, current: Record<string, any> = {}) {
  const { properties, required } = flatten(bodySchema);
  const fields = Object.entries(properties)
    .filter(([, p]) => !p.readOnly)
    .map(([n, p]) => toField(n, p))
    .filter((f): f is Field => !!f);

  const requestedSchema = {
    type: 'object' as const,
    properties: Object.fromEntries(fields.map((f) => {
      const v = current[f.name] ?? properties[f.name].default;
      const value = f.list && Array.isArray(v) ? v.join(', ') : v;
      return [f.name, value === undefined ? f.schema : { ...f.schema, default: value }];
    })),
    required: required.filter((r) => fields.some((f) => f.name === r)),
  };

  /** Form answer -> request body (drops blanks, splits list fields). */
  const toBody = (answer: Record<string, any>) => {
    const body: Record<string, any> = { ...current };
    for (const f of fields) {
      const v = answer[f.name];
      if (v === undefined || v === '') { delete body[f.name]; continue; }
      body[f.name] = f.list ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : v;
    }
    return body;
  };

  return { requestedSchema, toBody };
}

/** The service's problem, as the form's message. */
export function problemMessage(summary: string, problem: any): string {
  const errors = (problem?.errors ?? []).map((e: any) => `• ${e.detail}`);
  const head = problem?.title ? `${summary}: ${problem.title.toLowerCase()}.` : `${summary}: please complete the form.`;
  return [head, ...errors].join('\n');
}
