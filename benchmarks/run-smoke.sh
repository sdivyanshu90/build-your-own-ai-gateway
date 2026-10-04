#!/usr/bin/env bash
# One real call through the gateway to OpenRouter. Run under the shared lock:
#   flock /tmp/claude-1000/flagship-heavy.lock nice -n 15 ionice -c3 benchmarks/run-smoke.sh /path/to/.env.local
# The env file must define OPENROUTER_API_KEY (and optionally OPENROUTER_MODEL); it is read
# here and never echoed, written to results, or passed on a command line.
set -euo pipefail
ENVFILE="${1:?usage: run-smoke.sh <env file with OPENROUTER_API_KEY>}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.deps.yml")
a=$(free -m | awk 'NR==2{print $7}'); [ "$a" -ge 1500 ] || { echo "low memory ($a MB)"; exit 3; }
cleanup() { set +e; docker stop gw-bench-gateway >/dev/null 2>&1; "${COMPOSE[@]}" down -v >/dev/null 2>&1; echo "[cleanup] done"; }
trap cleanup EXIT
OPENROUTER_API_KEY="$(grep -m1 '^OPENROUTER_API_KEY=' "$ENVFILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
OPENROUTER_MODEL="${OPENROUTER_MODEL:-$(grep -m1 '^OPENROUTER_MODEL=' "$ENVFILE" | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//')}"
export OPENROUTER_API_KEY OPENROUTER_MODEL
"${COMPOSE[@]}" up -d --wait >/dev/null
(cd "$REPO" && DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/ai_gateway npx tsx scripts/migrate.ts >/dev/null 2>&1)
"$HERE/run-gateway.sh" >/dev/null
echo "model: $OPENROUTER_MODEL"
taskset -c "${LOAD_CPUS:-5}" node "$HERE/smoke-openrouter.mjs"
