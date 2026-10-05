#!/usr/bin/env bash
# Start (or restart) the gateway under test in a memory/CPU-capped container.
#   run-gateway.sh [KEY=VALUE ...]     extra env overrides for this run
# Uses the host's compiled dist/ + node_modules mounted read-only into the same
# Node major the Dockerfile targets (node:22), host networking, 512 MiB cap,
# pinned to cores GW_CPUS (default 2,3).
set -euo pipefail
REPO="${GW_REPO:-$(cd "$(dirname "$0")/.." && pwd)}"   # GW_REPO: run a different checkout's dist/ (e.g. a git worktree)
NAME=gw-bench-gateway
docker stop "$NAME" >/dev/null 2>&1 || true
# `--rm` removal is asynchronous; wait until the name is free before reusing it.
for _ in $(seq 1 30); do [ -z "$(docker ps -aq -f "name=^${NAME}$")" ] && break; sleep 0.5; done
EXTRA=()
for kv in "$@"; do EXTRA+=(-e "$kv"); done
PROFILE_MOUNT=()
if [ -n "${GW_PROFILE_DIR:-}" ]; then mkdir -p "$GW_PROFILE_DIR" && chmod 777 "$GW_PROFILE_DIR" && PROFILE_MOUNT=(-v "$GW_PROFILE_DIR:/prof"); fi
# Throwaway credentials for the local benchmark gateway. The encryption key must stay
# stable across restarts (seeded provider keys are stored encrypted), so it is derived
# from a fixed label rather than committed. Override both via the environment.
BENCH_ENCRYPTION_KEY="${BENCH_ENCRYPTION_KEY:-$(printf 'ai-gateway-local-benchmark' | sha256sum | cut -d' ' -f1)}"
BENCH_ADMIN_KEY="${BENCH_ADMIN_KEY:-bench-admin-key-0123456789}"
docker run -d --rm --name "$NAME" --network host \
  --memory 512m --memory-swap 512m --cpuset-cpus "${GW_CPUS:-2,3}" \
  -v "$REPO:/app:ro" "${PROFILE_MOUNT[@]}" -w /app \
  -e NODE_ENV=production -e HOST=127.0.0.1 -e PORT=18080 -e LOG_LEVEL=warn \
  -e DATABASE_URL=postgres://gateway:gateway@127.0.0.1:55432/ai_gateway \
  -e REDIS_URL=redis://127.0.0.1:56379 \
  -e ENCRYPTION_KEY="$BENCH_ENCRYPTION_KEY" \
  -e ADMIN_API_KEY="$BENCH_ADMIN_KEY" \
  -e HEALTH_MONITOR_ENABLED=false -e REGISTRY_CACHE_TTL_SECONDS=3600 \
  "${EXTRA[@]}" \
  node:22.14-bookworm-slim node --enable-source-maps dist/index.js >/dev/null
for i in $(seq 1 60); do
  if curl -fs http://127.0.0.1:18080/ready >/dev/null 2>&1; then echo "gateway ready (${*:-defaults})"; exit 0; fi
  sleep 1
done
echo "gateway failed to become ready" >&2; docker logs "$NAME" 2>&1 | tail -20 >&2; exit 1
