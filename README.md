# One API contract, every interface

A working demo of **API-first platform interfaces**: one OpenAPI 3.1 document
(whose schemas are JSON Schema 2020-12) drives a service, a React UI, a CLI and
an MCP server — with shared **semantic validation** and a shared **design system**.

**Watch the demo:** [`demo/demo.mp4`](demo/demo.mp4) (10 min, narrated): why the
API comes first for an internal developer platform, a tour of the contract, then
the same API in the web UI, the CLI, the MCP server and an agent (Claude Code).

The domain is the classic Todos API.

```
                      api/openapi.yaml  (single source of truth)
   JSON Schema · CEL business rules · display tones · form hints · MCP exposure
                                   │
         Spectral lint (standards + CEL compiles) · oasdiff (breaking changes)
                                   │
     ┌─────────────┬───────────────┼────────────────┬──────────────────┐
     ▼             ▼               ▼                ▼                  ▼
  Service       React UI          CLI              MCP           TS types/client
  (Fastify,     (RJSF forms,     (Restish,       (spec-driven,   (openapi-typescript,
  Ajv 2020,     atom table)      `bin/todos`)    tools at          openapi-fetch)
  CEL)                                            runtime)
     └──── semantic rules: @demo/semantic ────┘      all rendered with @demo/design
```

## Quick start

Requires [mise](https://mise.jdx.dev): it pins Node, Restish, oasdiff and k6, runs
all tasks, and puts `bin/` (the `todos` CLI) on your PATH.

```bash
mise install
mise run setup         # install, generate, lint, typecheck, test
mise run dev           # API on :8787 + UI on http://localhost:5173 (in parallel)
mise run cli:connect   # once, with the API running: register the CLI
mise tasks             # everything else
```

| Interface | Try it |
|---|---|
| **Web** | http://localhost:5173 → *Sign in with Platform SSO* (mock): **Ada** (developer) or **Grace** (viewer, read-only) |
| **CLI** | `todos list-todos --limit 2` (then `--cursor …`) · `todos create-todo 'title: Ship it, priority: high, dueDate: "2026-12-24"'` · `todos complete-todo <id>` · `todos archive-todos` (long-running, live progress) · `todos --help` |
| **MCP** | `mise run demo:mcp` shows what an agent sees. Registered for Claude Code in `.mcp.json` (server `todos`). Or: `npx @modelcontextprotocol/inspector node --no-warnings mcp/src/server.ts` |
| **HTTP** | spec at `localhost:8787/openapi.json` · every operation needs a token: `curl -d grant_type=client_credentials -d client_id=todos-cli -d client_secret=dev-secret localhost:8787/oauth2/token` |
| **Tests** | `mise run e2e` (end-to-end, spec-checked) · `mise run load` (k6) |

## The contract: `api/openapi.yaml`

| Part | Drives |
|---|---|
| `components.schemas` (JSON Schema 2020-12) | Structural validation in service and form; TS types; CLI flags; MCP tool input schemas |
| `x-validations` (CEL, on a schema) | **Semantic validation** of payloads — cross-field business rules |
| `x-preconditions` (CEL, on an operation) | **Semantic validation** of state — e.g. only open todos can be completed. Also enables/disables UI buttons |
| `x-display` | Atom (badge/tags/date/text) and semantic **tone** per value, and table columns — identical in UI, CLI and MCP |
| `x-ui-schema` | RJSF uiSchema for input forms |
| `x-mcp` | Whether AI agents may call the operation (must be explicit — lint enforces it) |
| `operationId` | CLI command (`list-todos`) and MCP tool (`listTodos`) names |
| `securitySchemes` + `security` | OAuth2 scopes per operation, **enforced by the API** for every client (401/403) |
| `202` + `Operation` | Long-running operations: clients poll `Location` until done (lint enforces the shape) |
| `limit` / `cursor` / `nextCursor` | Cursor paging, rendered as "more: --cursor …" (CLI) and "More results" (MCP) |
| `Problem` (RFC 9457) | The one error format: 400, 401, 403, 404, 409, 422, 429, 500 and failed operations |

### Semantic validation

JSON Schema answers *"is this well-formed?"*. Semantic rules answer *"is this
allowed?"*. They're declared once in the spec as [CEL](https://cel.dev)
expressions — the same model as Kubernetes `x-kubernetes-validations`:

```yaml
x-validations:
  - rule: "has(self.priority) && self.priority == 'high' ? has(self.dueDate) : true"
    message: High-priority todos must have a due date.
    fieldPath: .dueDate
  - rule: "!has(self.dueDate) || self.dueDate >= today"
    message: Due date cannot be in the past.
    fieldPath: .dueDate
```

| Layer | Status | Where |
|---|---|---|
| Structural (JSON Schema) | `400` | service (Ajv 2020) + form (RJSF, same dialect) |
| Semantic, payload (`x-validations`) | `422` | service (authoritative) + form (instant feedback) |
| Semantic, state (`x-preconditions`) | `409` | service + UI button state |

All errors are RFC 9457 `application/problem+json` with JSON-pointer `errors[]`,
so the form highlights the right field, the CLI prints them, and an agent can
self-correct. The spec linter rejects rules that aren't valid CEL.

### One design system, three media

`packages/design` holds the tokens (`tokens.json`: tone colors and symbols) and
the **atoms** (badge, tags, date, text, button, table). The spec maps values to
tones (`high → danger`); each medium renders the same atom:

| Atom | Web | CLI | MCP |
|---|---|---|---|
| badge `high` (danger) | red pill `▲ high` | red `▲ high` (truecolor) | `▲ high` |
| badge `done` (success) | green pill `✓ done` | green `✓ done` | `✓ done` |
| tags | accent `#api #review` | accent `#api #review` | `#api #review` |
| problem | field errors in form + toast | `✗ 422 …` + `› /dueDate …` | `✗ **422 …**` + pointer list, or a form (below) |

### Forms for agents (MCP elicitation)

When the client supports [elicitation](https://modelcontextprotocol.io/specification/draft/client/elicitation)
(Claude Code does), a tool call whose body the service rejects (`400`/`422`)
doesn't just fail: the MCP server turns the body's JSON Schema into a form,
pre-fills what the agent sent, shows the service's errors as the message, and
retries with the user's answer. `mcp/src/elicit.ts` is generic: enums become
selects, `format: date` a date field, string arrays a comma-separated field.

Try it: `claude`, then *"Add a high-priority todo: Prepare the launch demo"*.

## Cross-cutting concerns, solved once in the API

Every interface is just a client, so these live in one place
(`services/todos/src/auth.ts`, `operations.ts`, `spec-router.ts`), driven by the spec:

| Concern | How | Every client gets |
|---|---|---|
| **Errors** | RFC 9457 `application/problem+json` with JSON-pointer `errors[]` | Form field errors, `✗ 422 › /dueDate`, agent self-correction |
| **AuthN / AuthZ** | OAuth2 bearer tokens; scopes per operation from `security` | 401/403 problems; UI disables what you may not do; CLI/MCP send their own token |
| **Rate limiting** | Per principal, fixed window; IETF `RateLimit-*` headers; a token's `quota` claim sets a per-client tier | 429 problem + `Retry-After` |
| **Paging** | Opaque cursors | `--cursor` in the CLI, cursor hint for agents |
| **Long-running work** | `202 Accepted` + `Location` → `GET /operations/{id}` (pending → running → succeeded/failed) | One shared poller (`@demo/contract/async`): progress toast (web), live progress line (CLI), MCP progress notifications |
| **Discoverability** | The API serves its own contract (`/openapi.json`), links it from every response (`Link: rel="service-desc"`, RFC 8631) and publishes an RFC 9727 catalog at `/.well-known/api-catalog` (`services/todos/src/server.ts`) | Restish builds commands from the spec, MCP clients list tools (`tools/list`), portals and agents crawl the catalog; `summary`/`description`/`tags` become help text, labels and tool descriptions |

**Auth in the demo** uses a **mock IdP served by the API** (`services/todos/src/mock-idp.ts`,
dev only): a sign-in page with two users (authorization code + PKCE, for the web UI)
and client credentials (`todos-cli`, `todos-mcp`, `todos-ci`, `todos-load`). In
production, point the spec's `securitySchemes` at the platform's OAuth2/OIDC provider;
nothing else changes.

## Testing: the API drives every channel

- `mise run e2e`: end-to-end tests against the running API. Every response is
  validated against the schema the spec declares for its status, and the
  scenarios cover auth, 400/422/409/404, paging, long-running operations, rate
  limits and MCP tool parity. Because web, CLI and MCP are generic clients of
  the same API, this covers the behaviour they all share; their own tests can
  stay small (rendering).
- `mise run load`: k6, spec-driven. Budgets for read/write latency (p95/p99) and
  zero errors at ~1000 req/s, plus an abuse scenario that must get only 429
  problems, never 5xx. (It found a real bug: empty JSON bodies were rejected.)

## Layout

```
api/openapi.yaml            the contract
api/.spectral.mjs           API standards as lint rules (incl. CEL + tone checks)
packages/contract           generated: dereferenced spec, TS types, typed client
packages/semantic           CEL evaluator for x-validations / x-preconditions
packages/design             tokens + atoms, renderers: react / terminal / text
services/todos              spec-router.ts, auth.ts, operations.ts (generic) + todos.ts (the only business code)
                            mock-idp.ts: DEV-ONLY OAuth2 provider for the demo
ui                          generic resource page: RJSF + atoms, from the spec
cli                         Restish profile + terminal renderer (bin/todos)
mcp                         generic spec-driven MCP server (elicitation forms, polling)
tests/e2e                   end-to-end tests against the API, checked against the spec
tests/load                  k6 load test
```

## What's hand-written vs. derived

- **Hand-written, per API:** the spec, and one handler per `operationId`
  (`services/todos/src/todos.ts`). A missing handler is a compile error.
- **Generic, written once:** spec router, UI resource page, MCP server, CLI
  renderer, design atoms. Adding an operation or a field to the spec shows up in
  every interface without touching them.
- **Generated:** `packages/contract/generated/*` (`mise run generate`).

## Governance

- `mise run lint` — Spectral: OAS recommended + house rules (camelCase
  operationIds, kebab-case paths, problem responses, explicit `x-mcp`, valid CEL,
  valid tones covering every enum value, `security` on every operation,
  documented 401/403/429, pollable `202`s).
- `mise run breaking` — oasdiff against `origin/main`/`main`; fails on breaking changes.

## Production notes

- The service router is ~130 lines for transparency. Equivalent off-the-shelf
  options: Backstage `repo-tools` OpenAPI server generator, `fastify-openapi-glue`,
  `oapi-codegen` (Go).
- Compile `tokens.json` with Style Dictionary when there are more consumers.
- Replace the mock IdP with the platform's OAuth2/OIDC provider; the rate limiter
  with a shared store (Redis) or the API gateway when running more than one instance.
- Restish can be replaced by a generated CLI if a single static binary is needed;
  the renderer contract (`layoutFor` + atoms) stays the same.
