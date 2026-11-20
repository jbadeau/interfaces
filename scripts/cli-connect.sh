#!/usr/bin/env bash
# Registers the running API with Restish. Restish discovers the spec via the
# `Link: rel=service-desc` header and turns every operation into a command.
# Config is kept in the repo (cli/restish.json), not in your home directory.
# Auth: OAuth2 client credentials against the spec's token URL (demo: mock IdP).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export RSH_CONFIG="$ROOT/cli/restish.json"
BASE="${API_URL:-http://127.0.0.1:8787}"
BASE="$BASE" node -e '
const fs = require("fs"), f = process.env.RSH_CONFIG, base = process.env.BASE;
const c = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
c.apis = { ...(c.apis ?? {}), todos: {
  base_url: base, spec_url: base + "/openapi.json",
  profiles: { default: { credentials: { oauth2: {
    auth: { type: "oauth-client-credentials", params: { client_id: "todos-cli", client_secret: "dev-secret", token_url: base + "/oauth2/token", scopes: "operations:read todos:read todos:write" } },
    satisfies: ["operations:read", "todos:read", "todos:write"] } } } } } };
fs.writeFileSync(f, JSON.stringify(c, null, 2));'
chmod 600 "$RSH_CONFIG"
restish api sync todos </dev/null
echo "Connected. Try: todos --help  (bin/ is on PATH via mise)"
