#!/usr/bin/env bash
# Complete, zero-provider-spend run. Requires Node 22, npm, Docker, and k6.
# Set GATEWAY_BENCH_OLLAMA_DIR to a task-owned extracted Ollama installation
# to include the local GPU model check (its models/ directory is disposable).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="${BENCH_LABEL:-$(date -u +%Y%m%dT%H%M%SZ)}"
mkdir -p "$HERE/results"
STATUS="$HERE/results/run-status-$LABEL.tsv"
[ ! -e "$STATUS" ] || { echo "Result label already exists: $LABEL" >&2; exit 2; }
command -v k6 >/dev/null
[[ "$(node -v)" == v22.* ]] || { echo 'Node 22 required' >&2; exit 2; }
docker info >/dev/null
exec 9>"${TMPDIR:-/tmp}/gateway-benchmark-heavy.lock"
flock 9
taskset -c "${LOAD_CPUS:-5}" node "$HERE/monitor.mjs" "$HERE/results/monitor-$LABEL.jsonl" &
MONITOR_PID=$!
trap 'kill "$MONITOR_PID" 2>/dev/null || true' EXIT
printf 'block\tlabel\tstarted_utc\tfinished_utc\texit_code\n' > "$STATUS"
failures=0
for block in A R S B C D K; do
  run_label="$LABEL"
  [ "$block" = S ] && run_label="$LABEL-sustained"
  started=$(date -u +%FT%TZ)
  rc=0
  BENCH_LABEL="$run_label" "$HERE/run-all.sh" "$block" || rc=$?
  printf '%s\t%s\t%s\t%s\t%s\n' "$block" "$run_label" "$started" "$(date -u +%FT%TZ)" "$rc" >> "$STATUS"
  [ "$rc" -eq 0 ] || failures=$((failures+1))
done
if [ -n "${GATEWAY_BENCH_OLLAMA_DIR:-}" ]; then
  started=$(date -u +%FT%TZ); rc=0
  BENCH_LABEL="$LABEL" "$HERE/run-ollama.sh" "$GATEWAY_BENCH_OLLAMA_DIR" || rc=$?
  printf 'ollama\t%s\t%s\t%s\t%s\n' "$LABEL" "$started" "$(date -u +%FT%TZ)" "$rc" >> "$STATUS"
  [ "$rc" -eq 0 ] || failures=$((failures+1))
fi
echo "Full run completed: $STATUS ($failures blocks with failures)"
[ "$failures" -eq 0 ]
