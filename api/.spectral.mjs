// API standards as code. Run: npm run lint
import { oas } from '@stoplight/spectral-rulesets';
import { truthy, pattern, enumeration } from '@stoplight/spectral-functions';
import { parse } from '@marcbachmann/cel-js';

/** Semantic rules must be valid CEL, or every interface would break at runtime. */
const celCompiles = (rules, _opts, { path }) => {
  const results = [];
  for (const [i, r] of (Array.isArray(rules) ? rules : []).entries()) {
    try { parse(r.rule); } catch (e) { results.push({ message: `Invalid CEL "${r.rule}": ${e.message}`, path: [...path, i, 'rule'] }); }
    if (!r.message) results.push({ message: 'Rule needs a human-readable message', path: [...path, i] });
  }
  return results;
};

const TONES = ['neutral', 'info', 'success', 'warning', 'danger', 'accent'];
/** x-display tones must exist in the design tokens and cover every enum value. */
const displayTones = (schema, _opts, { path }) => {
  const d = schema['x-display'];
  if (!d?.tones) return [];
  const out = Object.entries(d.tones).filter(([, t]) => !TONES.includes(t)).map(([v, t]) => ({ message: `Unknown tone "${t}" for "${v}"`, path: [...path, 'x-display', 'tones', v] }));
  for (const v of schema.enum ?? []) if (!(v in d.tones)) out.push({ message: `No tone for enum value "${v}"`, path: [...path, 'x-display', 'tones'] });
  return out;
};

/** A 202 must be pollable: Location header + an Operation body (href, status). */
const asyncPollable = (res, _opts, { path }) => {
  const out = [];
  if (!res?.headers?.Location) out.push({ message: '202 response needs a Location header to poll', path: [...path, 'headers'] });
  const req = res?.content?.['application/json']?.schema?.required ?? [];
  for (const f of ['href', 'status']) if (!req.includes(f)) out.push({ message: `202 body must be an Operation with "${f}"`, path: [...path, 'content'] });
  return out;
};

export default {
  extends: [[oas, 'recommended']],
  rules: {
    'oas3-api-servers': 'off',
    'info-contact': 'off',

    'operation-id-camel-case': {
      description: 'operationId must be camelCase (it becomes the CLI command and MCP tool name).',
      given: '$.paths[*][get,put,post,delete,patch].operationId',
      severity: 'error',
      then: { function: pattern, functionOptions: { match: '^[a-z][a-zA-Z0-9]+$' } },
    },
    'paths-kebab-case': {
      description: 'Path segments must be lower kebab-case.',
      given: '$.paths',
      severity: 'error',
      then: { field: '@key', function: pattern, functionOptions: { match: '^(/([a-z0-9-]+|\\{[a-zA-Z]+\\}))+$' } },
    },
    'problem-default-response': {
      description: 'Every operation must declare a default RFC 9457 problem response.',
      given: '$.paths[*][get,put,post,delete,patch].responses',
      severity: 'error',
      then: { field: 'default', function: truthy },
    },
    'mcp-exposure-explicit': {
      description: 'Every operation must explicitly decide whether AI agents may call it (x-mcp).',
      given: '$.paths[*][get,put,post,delete,patch]',
      severity: 'error',
      then: { field: 'x-mcp', function: truthy },
    },
    'semantic-rules-valid-cel': {
      description: 'x-validations / x-preconditions must be valid CEL with a message.',
      given: ['$..x-validations', '$..x-preconditions'],
      severity: 'error',
      message: '{{error}}',
      then: { function: celCompiles },
    },
    'security-declared': {
      description: 'Every operation must declare who may call it (OAuth2 scopes).',
      given: '$.paths[*][get,put,post,delete,patch]',
      severity: 'error',
      then: { field: 'security', function: truthy },
    },
    'auth-and-rate-limit-responses': {
      description: 'Secured operations must document 401, 403 and 429 (as RFC 9457 problems).',
      given: '$.paths[*][get,put,post,delete,patch].responses',
      severity: 'error',
      then: [{ field: '401', function: truthy }, { field: '403', function: truthy }, { field: '429', function: truthy }],
    },
    'async-operations-pollable': {
      description: 'Long-running operations answer 202 with a Location header and an Operation to poll.',
      given: '$.paths[*][get,put,post,delete,patch].responses.202',
      severity: 'error',
      message: '{{error}}',
      then: { function: asyncPollable },
    },
    'display-tones-valid': {
      description: 'x-display tones must be design tokens and cover every enum value.',
      given: '$.components.schemas[*]',
      severity: 'error',
      message: '{{error}}',
      then: { function: displayTones },
    },
    'operation-summary': {
      description: 'Operations need a summary (CLI help, MCP tool title, UI headings).',
      given: '$.paths[*][get,put,post,delete,patch]',
      severity: 'error',
      then: { field: 'summary', function: truthy },
    },
  },
};
