import Fastify from 'fastify';
import { spec } from '@demo/contract';
import { registerSpec } from './spec-router.ts';
import { todos } from './todos.ts';
import { registerMockIdp } from './mock-idp.ts';

const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// Discoverability
//   Link header        every response points at the contract (RFC 8631), so clients
//                      such as Restish find the operations with no configuration
//   /openapi.json      the contract itself, served by the API that implements it
//   /.well-known/api-catalog
//                      RFC 9727 catalog: what a platform portal (Backstage, …) or an
//                      agent crawls to list the platform's APIs
app.addHook('onSend', async (_req, reply) => {
  reply.header('Link', '</openapi.json>; rel="service-desc", </.well-known/api-catalog>; rel="api-catalog"');
});
app.get('/openapi.json', async () => spec);
app.get('/.well-known/api-catalog', async (req, reply) => {
  const base = `${req.protocol}://${req.host}`;
  reply.type('application/linkset+json; profile="https://www.rfc-editor.org/info/rfc9727"');
  return {
    linkset: [{
      anchor: `${base}/`,
      'service-desc': [{ href: `${base}/openapi.json`, type: 'application/vnd.oai.openapi+json;version=3.1', title: spec.info.title }],
      'service-meta': [{ href: `${base}/openapi.json#/info`, title: `${spec.info.title} ${spec.info.version}` }],
    }],
  };
});

// JSON bodies; an empty body is "no body" (many clients send the header anyway).
// Whether a body is required is the spec's call, checked by the router.
app.removeContentTypeParser('application/json');
app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
  if (!String(body).trim()) return done(null, undefined);
  try { done(null, JSON.parse(String(body))); } catch { done(Object.assign(new Error('Malformed JSON body'), { statusCode: 400 }), undefined); }
});

// Form posts for the OAuth2 endpoints of the mock IdP.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) =>
  done(null, Object.fromEntries(new URLSearchParams(String(body)))));

registerMockIdp(app); // DEV ONLY: stands in for the platform's OAuth2/OIDC provider
registerSpec(app, spec, todos);

const port = Number(process.env.PORT ?? 8787);
await app.listen({ port, host: '127.0.0.1' });
