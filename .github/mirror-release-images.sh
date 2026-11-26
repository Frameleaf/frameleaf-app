#!/usr/bin/env bash
# FL-1678: copy published images from GHCR to Docker Hub and the Forgejo registry, unchanged (same
# digests), then sign each copy with the Frameleaf cosign key and verify it against cosign.pub.
#
# Usage: mirror-release-images.sh <image>:<tag> [...]     e.g. frameleaf-server:latest
#
# Env: GHCR_USERNAME, GH_PUBLISH_TOKEN (read GHCR); DOCKERHUB_USERNAME, DOCKERHUB_TOKEN;
#      FORGEJO_REGISTRY (LAN host:port, plain HTTP), FORGEJO_USERNAME, FORGEJO_TOKEN;
#      COSIGN_PRIVATE_KEY, COSIGN_PASSWORD. Needs oras, cosign and jq on PATH.
# FL-1765: safe to run again. A ref already at its digest is not copied, a digest already signed is not
# signed again, tags sharing a digest cost one copy and one signature, and a registry rate limit is waited out.
# ponytail: copies one ref at a time; parallelise if a release ever has dozens of images.
set -euo pipefail
[[ $# -gt 0 ]] || { echo "::error::Name at least one <image>:<tag>"; exit 1; }
for name in GHCR_USERNAME GH_PUBLISH_TOKEN DOCKERHUB_USERNAME DOCKERHUB_TOKEN FORGEJO_REGISTRY FORGEJO_USERNAME FORGEJO_TOKEN COSIGN_PRIVATE_KEY COSIGN_PASSWORD; do
  [[ -n "${!name:-}" ]] || { echo "::error::$name is not set"; exit 1; }
done
printf '%s' "$GH_PUBLISH_TOKEN" | oras login ghcr.io -u "$GHCR_USERNAME" --password-stdin >/dev/null
printf '%s' "$DOCKERHUB_TOKEN" | oras login docker.io -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
printf '%s' "$FORGEJO_TOKEN" | oras login "$FORGEJO_REGISTRY" --plain-http -u "$FORGEJO_USERNAME" --password-stdin >/dev/null
printf '%s' "$DOCKERHUB_TOKEN" | cosign login docker.io -u "$DOCKERHUB_USERNAME" --password-stdin >/dev/null
printf '%s' "$FORGEJO_TOKEN" | cosign login "$FORGEJO_REGISTRY" -u "$FORGEJO_USERNAME" --password-stdin >/dev/null

exec 3>&2
attempts=${MIRROR_ATTEMPTS:-12}
rate_wait=${MIRROR_RATE_LIMIT_WAIT:-960}
signature_wait=${MIRROR_SIGNATURE_WAIT:-20}

# Runs a command, printing its stdout; a rate limit waits and tries again, any other failure returns at once.
registry() {
  local attempt errors output
  errors=$(mktemp)
  for ((attempt = 1; attempt <= attempts; attempt++)); do
    if output=$("$@" 2>"$errors"); then
      rm -f "$errors"
      printf '%s' "$output"
      return 0
    fi
    grep -qiE 'toomanyrequests|too many requests|status code 429' "$errors" || break
    echo "Registry rate limit (attempt $attempt of $attempts): waiting ${rate_wait}s" >&3
    sleep "$rate_wait"
  done
  cat "$errors" >&2
  rm -f "$errors"
  return 1
}

# The index and every manifest in it, because a run stopped mid-signature can leave only some of them signed.
fully_signed() {
  local children child
  children=$(registry oras manifest fetch "ghcr.io/frameleaf/$image@$digest" | jq -r '.manifests[]?.digest')
  for child in "$digest" $children; do
    registry cosign verify "${cosign_http[@]}" --key cosign.pub "$dest@$child" >/dev/null 2>&1 || return 1
  done
}

# A registry can take a moment to serve a signature it has just accepted.
verify_signed() {
  local attempt
  for attempt in 1 2 3 4 5 5; do
    registry cosign verify "${cosign_http[@]}" --key cosign.pub "$dest@$digest" >/dev/null 2>&1 && return 0
    sleep "$signature_wait"
  done
  registry cosign verify "${cosign_http[@]}" --key cosign.pub "$dest@$digest" >/dev/null
}

declare -A placed signed
for ref in "$@"; do
  [[ "$ref" =~ ^frameleaf-[a-z0-9-]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "::error::Invalid image reference $ref"; exit 1; }
  image=${ref%%:*} tag=${ref#*:}
  digest=$(oras resolve "ghcr.io/frameleaf/$image:$tag")
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "::error::No digest for ghcr.io/frameleaf/$image:$tag"; exit 1; }
  for dest in "docker.io/$DOCKERHUB_USERNAME/$image" "$FORGEJO_REGISTRY/frameleaf/$image"; do
    to=() plain=() cosign_http=()
    if [[ "$dest" == "$FORGEJO_REGISTRY"/* ]]; then
      to=(--to-plain-http) plain=(--plain-http) cosign_http=(--allow-http-registry)
    fi
    key="$dest@$digest"
    current=$(registry oras resolve "${plain[@]}" "$dest:$tag" 2>/dev/null || true)
    if [[ "$current" != "$digest" ]]; then
      if [[ -n "${placed[$key]:-}" ]]; then
        registry oras tag "${plain[@]}" "$key" "$tag" >/dev/null
      else
        registry oras cp --recursive "${to[@]}" "ghcr.io/frameleaf/$image@$digest" "$dest:$tag" >/dev/null
      fi
      current=$(registry oras resolve "${plain[@]}" "$dest:$tag")
      [[ "$current" == "$digest" ]] || { echo "::error::$dest:$tag is $current, not $digest"; exit 1; }
    fi
    placed[$key]=1
    if [[ -z "${signed[$key]:-}" ]]; then
      if ! fully_signed; then
        registry cosign sign --yes --recursive "${cosign_http[@]}" --key env://COSIGN_PRIVATE_KEY "$key" >/dev/null
        verify_signed
      fi
      signed[$key]=1
    fi
    echo "$dest:$tag -> $digest (signed)"
  done
done
