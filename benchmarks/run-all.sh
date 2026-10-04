#!/usr/bin/env bash
# Orchestrates one benchmark block end to end and cleans up after itself.
#
#   flock /tmp/claude-1000/flagship-heavy.lock nice -n 15 ionice -c3 benchmarks/run-all.sh A
#   flock ... benchmarks/run-all.sh B
#
# Block A: overhead, streaming, throughput, cache, rate limit, memory, rate-limiter-off variant.
# Block B: failover and circuit breaker (gateway on ROUND_ROBIN with short breaker timers).
# Block C: Redis and Postgres outages as seen by clients.
# Block D: V8 CPU profile of the gateway under load (summary only is kept).
#
# Safety rails (the dev machine has ~6 GB RAM and is shared):
#   * refuses to start if available memory < 1500 MB
#   * every container is memory-capped; deps pinned to cores 0,1, gateway to 2,3,
#     mock upstream to 4, load generator to 5 (override with *_CPUS env vars)
#   * always tears down containers and background processes (trap)
set -euo pipefail
BLOCK="${1:?usage: run-all.sh A|B|C|D|F}"
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.deps.yml")
MOCK_CPUS="${MOCK_CPUS:-4}"; LOAD_CPUS="${LOAD_CPUS:-5}"
LOG="$HERE/results/run-$BLOCK.log"
mkdir -p "$HERE/results"; : > "$LOG"

avail() { free -m | awk 'NR==2{print $7}'; }
guard() { local a; a=$(avail); if [ "$a" -lt 1500 ]; then echo "available memory ${a} MB < 1500 MB; aborting" | tee -a "$LOG"; exit 3; fi; echo "[mem] available ${a} MB" | tee -a "$LOG"; }

PIDS=()
cleanup() {
  set +e
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  docker stop gw-bench-gateway >/dev/null 2>&1
  "${COMPOSE[@]}" down -v >/dev/null 2>&1
  echo "[cleanup] done" | tee -a "$LOG"
}
trap cleanup EXIT

guard
# BENCH_REBUILD=1 recompiles dist/ from the working tree (and stamps the commit) first.
if [ "${BENCH_REBUILD:-0}" = "1" ] || [ ! -d "$REPO/dist" ]; then
  (cd "$REPO" && npm run build && git rev-parse --short HEAD > dist/.built-from)
fi
[ -d "$HERE/node_modules/autocannon" ] || (cd "$HERE" && npm install --maxsockets=4 --no-audit --no-fund)

{
  echo "== environment =="; date -u; uname -srm; node -v; docker --version
  grep -m1 'model name' /proc/cpuinfo; nproc; free -m | sed -n 1,2p
  echo "git HEAD: $(cd "$REPO" && git rev-parse --short HEAD); dist built from: $(cat "$REPO/dist/.built-from" 2>/dev/null || echo unknown)"
} | tee -a "$LOG"

"${COMPOSE[@]}" up -d --wait >/dev/null
(cd "$REPO" && DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/ai_gateway npx tsx scripts/migrate.ts 2>&1 | tail -2) | tee -a "$LOG"

MOCK_PORT=9100 taskset -c "$MOCK_CPUS" node "$HERE/mock-upstream.mjs" >>"$LOG" 2>&1 & PIDS+=($!)
MOCK_PORT=9101 taskset -c "$MOCK_CPUS" node "$HERE/mock-upstream.mjs" >>"$LOG" 2>&1 & PIDS+=($!)
sleep 1

"$HERE/run-gateway.sh" | tee -a "$LOG"
taskset -c "$LOAD_CPUS" node "$HERE/seed.mjs" | tee -a "$LOG"
bench() { guard; taskset -c "$LOAD_CPUS" node "$HERE/bench.mjs" "$@" 2>&1 | tee -a "$LOG"; }

case "$BLOCK" in
  A)
    bench overhead
    bench streaming
    bench throughput
    bench cache
    bench ratelimit
    bench memory
    # Variant: rate limiter disabled, to isolate its cost at c=64.
    "$HERE/run-gateway.sh" RATE_LIMIT_ENABLED=false | tee -a "$LOG"
    BENCH_STEPS=64 bench throughput ratelimit-off
    "$HERE/run-gateway.sh" | tee -a "$LOG"
    BENCH_STEPS=64 bench throughput ratelimit-on-c64
    ;;
  B)
    "$HERE/run-gateway.sh" LOAD_BALANCER_STRATEGY=ROUND_ROBIN CB_FAILURE_THRESHOLD=5 CB_SUCCESS_THRESHOLD=2 CB_TIMEOUT_MS=5000 CB_HALF_OPEN_MAX_PROBES=1 | tee -a "$LOG"
    bench failover
    BENCH_CB_TIMEOUT_MS=5000 bench breaker
    "$HERE/run-gateway.sh" | tee -a "$LOG"
    bench abort
    ;;
  C)
    "$HERE/run-gateway.sh" | tee -a "$LOG"
    # Verify the documented default-partition pitfall against real PostgreSQL 16.
    PG=gw-bench-postgres-1
    {
      echo "== partition pitfall check =="
      docker exec "$PG" psql -U gateway -d ai_gateway -v ON_ERROR_STOP=0 -c \
        "INSERT INTO request_logs (created_at, cache_hit, failover_count) VALUES ('2031-03-15', false, 0);" \
        -c "SELECT tableoid::regclass AS landed_in FROM request_logs WHERE created_at >= '2031-03-01';" \
        -c "SELECT create_request_logs_partition(2031, 3);" 2>&1 || true
      docker exec "$PG" psql -U gateway -d ai_gateway -c "DELETE FROM request_logs WHERE created_at >= '2031-03-01';" 2>&1 || true
    } | tee -a "$LOG" > "$HERE/results/partition-check.txt"
    bench outage
    ;;
  D)
    # CPU profile of the gateway under moderate load (V8 --cpu-prof, written on graceful exit).
    PROF="$HERE/results/profile"; rm -rf "$PROF"
    GW_PROFILE_DIR="$PROF" "$HERE/run-gateway.sh" "NODE_OPTIONS=--cpu-prof --cpu-prof-dir=/prof" | tee -a "$LOG"
    BENCH_STEPS="${BENCH_STEPS:-32}" bench throughput profile
    docker stop -t 20 gw-bench-gateway >/dev/null 2>&1 || true
    sleep 2
    for f in "$PROF"/*.cpuprofile; do node "$HERE/profile-summary.mjs" "$f" 30 | tee "$HERE/results/profile-summary${PROFILE_LABEL:-}.txt" | tee -a "$LOG"; done
    rm -rf "$PROF"   # raw profiles are large; the summary is what we keep
    ;;
  F)
    # Re-run of the headline phases (set BENCH_LABEL, e.g. "after") after code changes.
    bench overhead
    bench streaming
    bench throughput
    bench cache
    bench ratelimit
    bench memory
    bench abort
    ;;
  *) echo "unknown block"; exit 2 ;;
esac
echo "[done] block $BLOCK" | tee -a "$LOG"
