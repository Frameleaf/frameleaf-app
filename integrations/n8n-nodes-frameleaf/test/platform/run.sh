#!/bin/sh
# Synthetic platform qualification only; no vendor account, Library data, or public callback.
set -eu
package_dir=$(CDPATH="" cd -- "$(dirname -- "$0")/../.." && pwd)
image='docker.n8n.io/n8nio/n8n@sha256:e29e9cc965a16d07d989f115f729f8a1c7aff58688d4850247fa495d4d7aae2f'
container_id=$(docker run -d \
  --tmpfs /home/node/.n8n:uid=1000,gid=1000,size=268435456 \
  --tmpfs /tmp:uid=1000,gid=1000,size=134217728 \
  --tmpfs /home/node/.n8n/nodes:uid=1000,gid=1000,size=33554432 \
  -v "$package_dir:/qualification:ro" \
  -v "$package_dir:/home/node/.n8n/nodes/node_modules/n8n-nodes-frameleaf:ro" \
  -e NODE_PATH=/usr/local/lib/node_modules/n8n/node_modules \
  -e N8N_ENCRYPTION_KEY=synthetic-frameleaf-platform-qualification \
  -e N8N_DIAGNOSTICS_ENABLED=false -e N8N_VERSION_NOTIFICATIONS_ENABLED=false \
  -e N8N_PERSONALIZATION_ENABLED=false -e N8N_TEMPLATES_ENABLED=false \
  -e N8N_SECURE_COOKIE=false -e N8N_HOST=127.0.0.1 \
  -e N8N_SSRF_PROTECTION_ENABLED=true -e N8N_SSRF_ALLOWED_IP_RANGES=127.0.0.1/32 \
  "$image")
cleanup() { docker logs "$container_id" 2>&1 | tail -25; docker stop -t 5 "$container_id" >/dev/null; docker rm "$container_id" >/dev/null; }
trap cleanup EXIT INT TERM
docker exec "$container_id" node /qualification/test/platform/oauth.mjs
docker exec "$container_id" node /qualification/test/platform/refresh.mjs
docker exec "$container_id" node /qualification/test/platform/wire.mjs
