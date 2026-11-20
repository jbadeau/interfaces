/**
 * Semantic validation layer.
 *
 * Structural validation (types, formats, required, enums) is done by JSON Schema.
 * Semantic validation covers the business rules JSON Schema cannot express:
 * cross-field constraints and state-dependent preconditions.
 *
 * Rules live in the OpenAPI spec as CEL expressions (same model as Kubernetes
 * `x-kubernetes-validations`), so every interface enforces the same rules:
 *
 *   x-validations          (on a schema)    `self` = the request payload
 *   x-preconditions        (on an operation) `self` = the current resource state
 *
 * Variables available to every rule: `self`, `today` ("YYYY-MM-DD", UTC).
 *
 * The service is authoritative. The UI evaluates the same rules for instant
 * feedback. CLI and MCP receive the service's RFC 9457 problem responses.
 */
import { parse } from '@marcbachmann/cel-js';

export interface Rule {
  /** CEL expression that must evaluate to true. */
  rule: string;
  message: string;
  /** Field the error is attached to, e.g. ".name" (Kubernetes style). */
  fieldPath?: string;
  reason?: string;
}

export interface Violation {
  /** JSON Pointer to the offending field ("" = whole object). */
  pointer: string;
  detail: string;
  rule: string;
}

type Compiled = ReturnType<typeof parse>;
const cache = new Map<string, Compiled>();

function compile(rule: string): Compiled {
  let fn = cache.get(rule);
  if (!fn) cache.set(rule, (fn = parse(rule)));
  return fn;
}

/** Returns an error message if the rule is not valid CEL, else null. Used by the spec linter. */
export function checkRule(rule: string): string | null {
  try {
    compile(rule);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}

/** Collect x-validations from a (dereferenced) schema, including allOf members. */
export function collectRules(schema: Record<string, any> | undefined): Rule[] {
  if (!schema) return [];
  const own: Rule[] = schema['x-validations'] ?? [];
  const nested = (schema.allOf ?? []).flatMap((s: Record<string, any>) => collectRules(s));
  return [...own, ...nested];
}

const toPointer = (fieldPath?: string) =>
  fieldPath ? fieldPath.replace(/^\./, '/').replaceAll('.', '/') : '';

/**
 * Evaluate rules against `self`.
 *
 * A rule that cannot be evaluated (e.g. it reads a field that is absent) is
 * skipped rather than failed: missing fields are structural errors and are
 * reported by JSON Schema. This also lets the UI validate partially-filled forms.
 */
export function evaluate(rules: Rule[], self: unknown, now: Date = new Date()): Violation[] {
  const vars = { self, today: now.toISOString().slice(0, 10) };
  const violations: Violation[] = [];
  for (const r of rules) {
    let ok: unknown;
    try {
      ok = compile(r.rule)(vars);
    } catch {
      continue;
    }
    if (ok !== true) violations.push({ pointer: toPointer(r.fieldPath), detail: r.message, rule: r.rule });
  }
  return violations;
}
