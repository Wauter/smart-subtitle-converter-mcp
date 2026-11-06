#!/usr/bin/env bash
# Contract suite (spec §14) against a real API image: run 1 with defaults, run 2 with small limits + API keys.
# Usage: scripts/contract.sh <api-image>
set -euo pipefail
IMAGE="$1"
KEY="contract-$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
cleanup() { docker rm -f se-contract-1 se-contract-2 >/dev/null 2>&1 || true; }
trap cleanup EXIT

wait_ready() {
  for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$1/healthz" >/dev/null && return 0; sleep 1; done
  echo "::error::API on port $1 did not become healthy"; docker logs "$2" | tail -40; return 1
}

docker run -d --name se-contract-1 -p 127.0.0.1:18181:8080 --read-only --tmpfs /tmp --cap-drop ALL "$IMAGE" >/dev/null
docker run -d --name se-contract-2 -p 127.0.0.1:18182:8080 --read-only --tmpfs /tmp --cap-drop ALL \
  -e API_KEYS="$KEY" -e MAX_UPLOAD_BYTES=1048576 "$IMAGE" >/dev/null
wait_ready 18181 se-contract-1
wait_ready 18182 se-contract-2
echo "API: $(curl -s http://127.0.0.1:18181/healthz)"

echo "::group::contract run 1 (defaults)"
CONTRACT_API_URL=http://127.0.0.1:18181 npm run test:contract
echo "::endgroup::"
echo "::group::contract run 2 (small limits + API keys)"
CONTRACT_API_URL=http://127.0.0.1:18182 CONTRACT_API_KEY="$KEY" CONTRACT_SMALL_LIMITS=1 npm run test:contract
echo "::endgroup::"
