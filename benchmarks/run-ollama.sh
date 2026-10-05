#!/usr/bin/env bash
# "Real model, zero API spend": gateway in front of a local Ollama (OpenAI-compatible API).
# Correctness + overhead demonstration with a tiny model; NOT a throughput test.
#
#   flock /tmp/claude-1000/flagship-gpu.lock flock /tmp/claude-1000/flagship-heavy.lock \
#     nice -n 15 ionice -c3 benchmarks/run-ollama.sh /path/to/ollama-dir
#
# <ollama-dir> contains bin/ollama (release tarball extracted, no sudo needed). Models are stored
# under <ollama-dir>/models and deleted at the end.
#
# Thermal guard (mandatory on the dev laptop; its MX330 idles around 85 C):
#   * GPU is used only if the temperature drops below 80 C within 5 minutes; otherwise Ollama is
#     forced onto the CPU and the results are labelled so.
#   * A watcher samples temperature + throttle reasons every 2 s into results/ollama-thermal.csv and
#     stops Ollama if the GPU reaches 90 C.
#   * >= 2 minutes of cool-down between the two runs.
set -euo pipefail
OD="${1:?usage: run-ollama.sh <ollama-dir>}"
HERE="$(cd "$(dirname "$0")" && pwd)"; REPO="$(cd "$HERE/.." && pwd)"
COMPOSE=(docker compose -f "$HERE/docker-compose.deps.yml")
MODEL="${OLLAMA_MODEL:-qwen2.5:0.5b}"
LOG="$HERE/results/run-ollama.log"; THERMAL="$HERE/results/ollama-thermal.csv"
mkdir -p "$HERE/results"; : > "$LOG"
export OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODELS="$OD/models" OLLAMA_NUM_PARALLEL=2 OLLAMA_URL=http://127.0.0.1:11434 OLLAMA_MODEL="$MODEL"
log() { echo "$@" | tee -a "$LOG"; }
gpu_temp() { nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null | head -1 | tr -d ' ' || echo 999; }
a=$(free -m | awk 'NR==2{print $7}'); [ "$a" -ge 1500 ] || { log "low memory ($a MB)"; exit 3; }

PIDS=(); WATCH=""
cleanup() {
  set +e
  [ -n "$WATCH" ] && kill "$WATCH" 2>/dev/null
  for p in "${PIDS[@]:-}"; do [ -n "$p" ] && kill "$p" 2>/dev/null; done
  pkill -f "$OD/bin/ollama" 2>/dev/null
  docker stop gw-bench-gateway >/dev/null 2>&1
  "${COMPOSE[@]}" down -v >/dev/null 2>&1
  rm -rf "$OD/models"
  log "[cleanup] done (ollama stopped, model files deleted)"
}
trap cleanup EXIT

# ---- thermal decision -------------------------------------------------------------------------
START_TEMP=$(gpu_temp); log "GPU temperature at start: ${START_TEMP} C ($(nvidia-smi --query-gpu=name --format=csv,noheader))"
BACKEND=gpu; WAITED=0
while [ "$(gpu_temp)" -ge 80 ] && [ "$WAITED" -lt 300 ]; do sleep 10; WAITED=$((WAITED+10)); done
if [ "$(gpu_temp)" -ge 80 ]; then
  BACKEND=cpu; export CUDA_VISIBLE_DEVICES=-1 OLLAMA_LLM_LIBRARY=cpu
  log "GPU stayed >= 80 C for 300 s (now $(gpu_temp) C): thermal guard forces CPU-only inference"
else
  log "GPU below 80 C after ${WAITED} s: GPU inference allowed"
fi
export OLLAMA_BACKEND="$BACKEND"

echo "ts,temp_c,throttle_reasons" > "$THERMAL"
( while true; do
    t=$(gpu_temp); r=$(nvidia-smi --query-gpu=clocks_throttle_reasons.active --format=csv,noheader 2>/dev/null | head -1)
    echo "$(date +%s),$t,$r" >> "$THERMAL"
    if [ "$t" -ge 90 ] 2>/dev/null; then echo "THERMAL TRIP at ${t} C: stopping ollama" >> "$LOG"; pkill -f "$OD/bin/ollama"; fi
    sleep 2; done ) & WATCH=$!

# ---- services -----------------------------------------------------------------------------------
mkdir -p "$OD/models"
taskset -c 4,6,7 "$OD/bin/ollama" serve >"$HERE/results/ollama-serve.log" 2>&1 & PIDS+=($!)
for _ in $(seq 1 60); do curl -fs http://127.0.0.1:11434/api/version >/dev/null 2>&1 && break; sleep 1; done
log "ollama $(curl -s http://127.0.0.1:11434/api/version)"
"$OD/bin/ollama" pull "$MODEL" 2>&1 | tail -1 | tee -a "$LOG"

"${COMPOSE[@]}" up -d --wait >/dev/null
(cd "$REPO" && DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/ai_gateway npx tsx scripts/migrate.ts >/dev/null 2>&1)
MOCK_PORT=9101 taskset -c 4 node "$HERE/mock-upstream.mjs" >>"$LOG" 2>&1 & PIDS+=($!)
sleep 1
"$HERE/run-gateway.sh" | tee -a "$LOG"

bench() { taskset -c 5 node "$HERE/bench.mjs" "$@" 2>&1 | tee -a "$LOG"; }
# Run 1: overhead, accounting
t1=$(gpu_temp); [ "$BACKEND" = gpu ] && [ "$t1" -ge 80 ] && { log "GPU too hot before run 1 ($t1 C); aborting"; exit 4; }
log "run 1 starting, GPU ${t1} C"
bench ollama
log "ollama ps after run 1:"; "$OD/bin/ollama" ps | tee -a "$LOG"
echo "$("$OD/bin/ollama" ps | tail -n +2 | awk '{print $(NF-2),$(NF-1),$NF}')" > "$HERE/results/ollama-processor.txt"
# Cool-down (>= 2 min) then run 2
log "cool-down 130 s (GPU $(gpu_temp) C)"; sleep 130
t2=$(gpu_temp); [ "$BACKEND" = gpu ] && [ "$t2" -ge 80 ] && { log "GPU too hot before run 2 ($t2 C); skipping run 2"; exit 0; }
log "run 2 (failover) starting, GPU ${t2} C"
bench ollamaFailover
log "[done] ollama block"
