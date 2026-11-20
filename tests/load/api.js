// Load test for the platform API (k6): mise run load   (API must be running)
//
// Spec-driven: endpoints and the token URL are read from /openapi.json, so the
// same budgets apply whichever interface (web, CLI, MCP, CI) generates the traffic.
//
//   browse  steady read traffic         -> p95 latency budget, no errors
//   writes  create/complete/delete       -> p95 latency budget, no errors
//   abuse   one client far over its quota -> only 429 problems (Retry-After), never 5xx
import http from 'k6/http';
import { check } from 'k6';

const API = __ENV.API_URL || 'http://127.0.0.1:8787';

export const options = {
  scenarios: {
    browse: { executor: 'constant-arrival-rate', rate: 300, timeUnit: '1s', duration: '20s', preAllocatedVUs: 50, exec: 'browse' },
    writes: { executor: 'constant-arrival-rate', rate: 30, timeUnit: '1s', duration: '20s', preAllocatedVUs: 20, exec: 'writes' },
    abuse: { executor: 'constant-arrival-rate', rate: 20, timeUnit: '1s', duration: '10s', preAllocatedVUs: 10, exec: 'abuse', startTime: '5s' },
  },
  thresholds: {
    'http_req_duration{scenario:browse}': ['p(95)<50', 'p(99)<150'],
    'http_req_duration{scenario:writes}': ['p(95)<75'],
    'http_req_failed{scenario:browse}': ['rate==0'],
    'http_req_failed{scenario:writes}': ['rate==0'],
    'checks{scenario:abuse}': ['rate==1'],
    'http_reqs{scenario:abuse,status:429}': ['count>0'],
  },
};

function token(clientId) {
  const spec = http.get(`${API}/openapi.json`).json();
  const url = spec.components.securitySchemes.oauth2.flows.clientCredentials.tokenUrl;
  const r = http.post(url, { grant_type: 'client_credentials', client_id: clientId, client_secret: 'dev-secret' });
  return r.json('access_token');
}

export function setup() {
  const load = token('todos-load'); // per-client quota tier for load generation
  const ci = token('todos-ci'); // default quota: used to hit the limit on purpose
  const ids = http.get(`${API}/todos?limit=100`, { headers: { authorization: `Bearer ${load}` } }).json('items').map((t) => t.id);
  return { load, ci, ids };
}

const auth = (t) => ({ headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' } });

export function browse(d) {
  const pick = d.ids[Math.floor(Math.random() * d.ids.length)];
  const r = [
    http.get(`${API}/todos?limit=20`, auth(d.load)),
    http.get(`${API}/todos/${pick}`, auth(d.load)),
    http.get(`${API}/operations?limit=5`, auth(d.load)),
  ];
  check(r, { 'reads ok': (rs) => rs.every((x) => x.status === 200) });
}

export function writes(d) {
  const due = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
  const c = http.post(`${API}/todos`, JSON.stringify({ title: 'load test', priority: 'high', dueDate: due }), auth(d.load));
  if (!check(c, { 'created': (x) => x.status === 201 })) return;
  const id = c.json('id');
  check(http.post(`${API}/todos/${id}/complete`, null, auth(d.load)), { 'completed': (x) => x.status === 200 });
  check(http.del(`${API}/todos/${id}`, null, auth(d.load)), { 'deleted': (x) => x.status === 204 });
}

export function abuse(d) {
  const r = http.get(`${API}/todos?limit=1`, Object.assign(auth(d.ci), { responseCallback: http.expectedStatuses(200, 429) }));
  check(r, {
    'only 200 or 429': (x) => x.status === 200 || x.status === 429,
    '429 is a problem with Retry-After': (x) => x.status !== 429 ||
      (x.headers['Content-Type'].includes('problem+json') && Number(x.headers['Retry-After']) > 0 && x.json('status') === 429),
  });
}
