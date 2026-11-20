#!/usr/bin/env bash
# Fails if api/openapi.yaml has breaking changes compared to a base revision.
# Usage: mise run breaking [<git-ref>]   (default: origin/main, then main)
set -euo pipefail
cd "$(dirname "$0")/.."
BASE_REF="${1:-}"
if [[ -z "$BASE_REF" ]]; then
  for r in origin/main main; do git rev-parse -q --verify "$r:api/openapi.yaml" >/dev/null && { BASE_REF=$r; break; }; done
fi
[[ -z "$BASE_REF" ]] && { echo "No base revision with api/openapi.yaml yet; skipping breaking-change check."; exit 0; }
BASE=$(mktemp -t openapi-base.XXXXXX.yaml)
git show "$BASE_REF:api/openapi.yaml" > "$BASE"
echo "Comparing api/openapi.yaml against $BASE_REF"
oasdiff breaking "$BASE" api/openapi.yaml --fail-on ERR
