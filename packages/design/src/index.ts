/**
 * Medium-independent design model.
 *
 *   tokens  -> what a tone looks like (color, symbol)           [tokens.json]
 *   atoms   -> how a single value is shown (badge, tags, date, text)
 *   layouts -> how a response is shown (table, record, problem)
 *
 * The OpenAPI spec decides WHICH atom and tone a field uses (`x-display`);
 * renderers in ./react, ./terminal and ./text decide how that looks in their medium.
 */
import tokensJson from './tokens.json' with { type: 'json' };

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'accent';
export type Schema = Record<string, any>;

export const tokens = tokensJson;
export const toneColor = (t: Tone) => tokens.tone[t].color.$value;
export const toneSymbol = (t: Tone) => tokens.tone[t].symbol.$value;
export const EMPTY = tokens.atom.empty.$value;
export const TAG_PREFIX = tokens.atom.tag.prefix.$value;

// ----------------------------------------------------------------- atoms ---

export type Atom =
  | { atom: 'badge'; label: string; tone: Tone }
  | { atom: 'tags'; items: string[] }
  | { atom: 'date'; iso: string; label: string; tone: Tone }
  | { atom: 'text'; text: string; tone?: Tone }
  | { atom: 'empty' };

/** Merge allOf members so callers can read properties/titles. */
export function properties(schema: Schema | undefined): Record<string, Schema> {
  if (!schema) return {};
  return Object.assign({}, schema.properties, ...(schema.allOf ?? []).map(properties));
}

const today = () => new Date().toISOString().slice(0, 10);

/** Decide which atom displays `value`, from its schema. */
export function atomFor(schema: Schema = {}, value: unknown): Atom {
  if (value === null || value === undefined || value === '') return { atom: 'empty' };
  const display = schema['x-display'] ?? {};

  if (schema.enum || display.atom === 'badge') {
    return { atom: 'badge', label: String(value), tone: (display.tones?.[String(value)] as Tone) ?? 'neutral' };
  }
  if (schema.type === 'array' && Array.isArray(value)) return { atom: 'tags', items: value.map(String) };
  if (schema.format === 'date' || schema.format === 'date-time') {
    const iso = String(value);
    const day = iso.slice(0, 10);
    // Dates in the past are highlighted; a date-only field due today is a warning.
    const tone: Tone = schema.format === 'date' ? (day < today() ? 'danger' : day === today() ? 'warning' : 'neutral') : 'neutral';
    const label = schema.format === 'date' ? day : iso.slice(0, 16).replace('T', ' ');
    return { atom: 'date', iso, label, tone };
  }
  return { atom: 'text', text: typeof value === 'object' ? JSON.stringify(value) : String(value) };
}

/** Plain-text label of an atom (used for width calculations and sorting). */
export function atomText(a: Atom): string {
  switch (a.atom) {
    case 'badge': return `${toneSymbol(a.tone)} ${a.label}`;
    case 'tags': return a.items.map((t) => TAG_PREFIX + t).join(' ');
    case 'date': return a.label;
    case 'text': return a.text;
    case 'empty': return EMPTY;
  }
}

// --------------------------------------------------------------- layouts ---

export interface Column { key: string; title: string; schema: Schema }

export type Layout =
  | { layout: 'table'; columns: Column[]; rows: Record<string, any>[]; next?: string | null }
  | { layout: 'record'; fields: Column[]; value: Record<string, any> }
  | { layout: 'problem'; status: number; title: string; detail?: string; errors: { pointer?: string; detail: string; rule?: string }[] }
  | { layout: 'operation'; title: string; status: string; tone: Tone; progress: number }
  | { layout: 'empty'; message: string }
  | { layout: 'raw'; value: unknown };

const columnsOf = (schema: Schema): Column[] => {
  const props = properties(schema);
  const keys: string[] = schema['x-display']?.columns ?? Object.keys(props);
  return keys.map((key) => ({ key, title: props[key]?.title ?? key, schema: props[key] ?? {} }));
};

const recordFields = (schema: Schema, value: Record<string, any>): Column[] => {
  const props = properties(schema);
  const keys = [...new Set([...Object.keys(props), ...Object.keys(value)])].filter((k) => k in value);
  return keys.map((key) => ({ key, title: props[key]?.title ?? key, schema: props[key] ?? {} }));
};

export const isProblem = (v: any) => v && typeof v === 'object' && 'status' in v && 'title' in v && typeof v.status === 'number';

/** A long-running operation (the spec's Operation shape: href + status + progress). */
export const isOperationBody = (v: any) => v && typeof v === 'object' && typeof v.href === 'string' && typeof v.status === 'string' && typeof v.progress === 'number';

/** Choose a layout for a response body given the operation's success schema. */
export function layoutFor(schema: Schema | undefined, body: any, emptyMessage = 'Done.'): Layout {
  if (body === undefined || body === null || body === '') return { layout: 'empty', message: emptyMessage };
  if (isProblem(body)) return { layout: 'problem', status: body.status, title: body.title, detail: body.detail, errors: body.errors ?? [] };
  if (isOperationBody(body)) {
    // Finished: show the outcome (result, or the RFC 9457 problem). Running: show progress.
    if (body.status === 'failed' && body.error) return layoutFor(undefined, body.error);
    if (body.status === 'succeeded') {
      const value = { title: body.title, status: body.status, ...body.result };
      return { layout: 'record', fields: recordFields(schema ?? {}, value), value };
    }
    const tone = (properties(schema).status?.['x-display']?.tones?.[body.status] as Tone) ?? 'info';
    return { layout: 'operation', title: body.title, status: body.status, tone, progress: body.progress };
  }
  const props = properties(schema);
  if (props.items?.type === 'array' && Array.isArray(body.items)) {
    return { layout: 'table', columns: columnsOf(props.items.items), rows: body.items, next: body.nextCursor };
  }
  if (body && typeof body === 'object' && !Array.isArray(body)) return { layout: 'record', fields: recordFields(schema ?? {}, body), value: body };
  return { layout: 'raw', value: body };
}

/** Success response schema of an operation (first 2xx with JSON content). */
export function successSchema(op: { responses: Record<string, any> }): Schema | undefined {
  const code = Object.keys(op.responses).find((c) => c.startsWith('2'));
  return code ? op.responses[code]?.content?.['application/json']?.schema : undefined;
}
