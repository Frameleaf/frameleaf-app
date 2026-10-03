#!/usr/bin/env bash
set -euo pipefail
umask 077

# Hosted fixture only. The caller always removes this directory and the isolated Compose project.
: "${RUNNER_TEMP:?Hosted runner temporary directory required}"
: "${GITHUB_ENV:?Hosted environment file required}"
BUDDY_ROOT=$(mktemp -d "$RUNNER_TEMP/fl310-buddy.XXXXXX")
printf 'BUDDY_ROOT=%s\nBUDDY_UID=%s\nBUDDY_GID=%s\n' "$BUDDY_ROOT" "$(id -u)" "$(id -g)" >> "$GITHUB_ENV"
touch "$BUDDY_ROOT/.fl310-buddy-fixture"
mkdir -p "$BUDDY_ROOT/tls" "$BUDDY_ROOT/evidence"
for side in a b; do
  mkdir -p "$BUDDY_ROOT/$side/media" "$BUDDY_ROOT/$side/identity" "$BUDDY_ROOT/$side/incoming"
done

openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 2 \
  -subj '/CN=FL310 disposable Buddy test CA' \
  -keyout "$BUDDY_ROOT/tls/ca.key" -out "$BUDDY_ROOT/tls/ca.crt" 2>/dev/null
for side in a b; do
  label=buddyfixtureaaaa
  if [ "$side" = b ]; then label=buddyfixturebbbb; fi
  openssl req -new -newkey rsa:2048 -nodes -sha256 \
    -subj "/CN=r.$label.buddy.test" \
    -keyout "$BUDDY_ROOT/tls/$side.key" -out "$BUDDY_ROOT/tls/$side.csr" 2>/dev/null
  printf 'subjectAltName=DNS:r.%s.buddy.test\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$label" > "$BUDDY_ROOT/tls/$side.ext"
  openssl x509 -req -sha256 -days 2 -CA "$BUDDY_ROOT/tls/ca.crt" -CAkey "$BUDDY_ROOT/tls/ca.key" \
    -CAcreateserial -in "$BUDDY_ROOT/tls/$side.csr" -extfile "$BUDDY_ROOT/tls/$side.ext" \
    -out "$BUDDY_ROOT/tls/$side.crt" 2>/dev/null
done
# Only ca.crt is mounted into the apps. No TLS private key enters either backup source.
chmod 644 "$BUDDY_ROOT/tls/ca.crt"
