#!/usr/bin/env bash
# provision.sh — find or provision a browser-class chromium for visual-verify.
#
# The cat-cave GitHub Actions runners are podman containers (catcave-runner-N,
# Ubuntu 24.04): node 22 + python3 built in, but NO chromium and NO nix. They
# DO share the host podman socket (/var/run/docker.sock -> DOCKER_HOST), so a
# chromium image pulled once through that socket serves the whole fleet.
#
# Ladder (first hit wins):
#   1. $CHROMIUM_BIN already set and executable
#   2. chromium / chromium-browser / google-chrome on PATH (workstations,
#      NixOS hosts: /run/current-system/sw/bin/chromium)
#   3. nix present: nix-shell -p chromium (agent-ops style hosts)
#   4. docker socket present: run a sibling chromium container sharing THIS
#      network namespace (the itotori `--network container:$(hostname)` trick),
#      CDP reachable on 127.0.0.1:9333. The image pull lands in the shared
#      podman store, so every runner gets it after the first pull.
#
# Usage:  eval "$(./provision.sh)"   — sets CHROMIUM_BIN or VV_CONNECT and a
#                                     vv_chromium_cleanup function for callers
#                                     that used the container leg
set -euo pipefail

CHROME_PORT="${VV_CHROMIUM_PORT:-9333}"
CONTAINER_NAME="visual-verify-chromium"
IMAGE="docker.io/zenika/alpine-chrome:latest"

emit_bin() { printf 'export CHROMIUM_BIN=%q\n' "$1"; exit 0; }

if [ -n "${CHROMIUM_BIN:-}" ] && [ -x "${CHROMIUM_BIN}" ]; then emit_bin "$CHROMIUM_BIN"; fi
for c in chromium chromium-browser google-chrome google-chrome-stable; do
  p="$(command -v "$c" 2>/dev/null || true)"
  [ -n "$p" ] && [ -x "$p" ] && emit_bin "$p"
done
if command -v nix-shell >/dev/null 2>&1; then
  bin="$(nix-shell -p chromium --run 'command -v chromium' 2>/dev/null || true)"
  [ -n "$bin" ] && [ -x "$bin" ] && emit_bin "$bin"
fi
if command -v docker >/dev/null 2>&1 && docker version >/dev/null 2>&1; then
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  docker pull -q "$IMAGE" >/dev/null
  docker run -d --name "$CONTAINER_NAME" \
    --network "container:$(hostname)" \
    --shm-size=1g \
    --user chrome \
    "$IMAGE" \
    --headless=new --no-sandbox --disable-dev-shm-usage \
    --remote-debugging-port="$CHROME_PORT" --remote-debugging-address=127.0.0.1 \
    --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader \
    --window-size=1280,860 --no-first-run about:blank >/dev/null
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${CHROME_PORT}/json/version" >/dev/null 2>&1; then
      printf 'export VV_CONNECT=http://127.0.0.1:%s\n' "$CHROME_PORT"
      printf 'vv_chromium_cleanup() { docker rm -f %q >/dev/null 2>&1 || true; }\n' "$CONTAINER_NAME"
      exit 0
    fi
    sleep 0.5
  done
  echo "provision.sh: chromium container started but CDP never answered on 127.0.0.1:${CHROME_PORT}" >&2
  docker logs "$CONTAINER_NAME" >&2 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  exit 1
fi
echo "provision.sh: no chromium on PATH, no nix, no working docker socket — see README.md" >&2
exit 1
