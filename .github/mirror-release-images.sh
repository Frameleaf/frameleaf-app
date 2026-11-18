#!/usr/bin/env bash
# FL-1678: copy published images from GHCR to Docker Hub and the Forgejo registry, unchanged (same
# digests), then sign each copy with the Frameleaf cosign key and verify it against cosign.pub.
#
# Usage: mirror-release-images.sh <image>:<tag> [...]     e.g. frameleaf-server:latest
#
# Env: GHCR_USERNAME, GH_PUBLISH_TOKEN (read GHCR); DOCKERHUB_USERNAME, DOCKERHUB_TOKEN;
#      FORGEJO_REGISTRY (LAN host:port, plain HTTP), FORGEJO_USERNAME, FORGEJO_TOKEN;
#      COSIGN_PRIVATE_KEY, COSIGN_PASSWORD. Needs oras and cosign on PATH.
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

for ref in "$@"; do
  [[ "$ref" =~ ^frameleaf-[a-z0-9-]+:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || { echo "::error::Invalid image reference $ref"; exit 1; }
  image=${ref%%:*} tag=${ref#*:}
  digest=$(oras resolve "ghcr.io/frameleaf/$image:$tag")
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "::error::No digest for ghcr.io/frameleaf/$image:$tag"; exit 1; }
  for dest in "docker.io/$DOCKERHUB_USERNAME/$image" "$FORGEJO_REGISTRY/frameleaf/$image"; do
    http=(); [[ "$dest" == "$FORGEJO_REGISTRY"/* ]] && http=(--to-plain-http)
    cosign_http=(); [[ "$dest" == "$FORGEJO_REGISTRY"/* ]] && cosign_http=(--allow-http-registry)
    oras cp --recursive "${http[@]}" "ghcr.io/frameleaf/$image@$digest" "$dest:$tag" >/dev/null
    copied=$(oras resolve "${http[@]/--to-plain-http/--plain-http}" "$dest:$tag")
    [[ "$copied" == "$digest" ]] || { echo "::error::$dest:$tag is $copied, not $digest"; exit 1; }
    cosign sign --yes --recursive "${cosign_http[@]}" --key env://COSIGN_PRIVATE_KEY "$dest@$digest" >/dev/null
    cosign verify "${cosign_http[@]}" --key cosign.pub "$dest@$digest" >/dev/null
    echo "$dest:$tag -> $digest (signed)"
  done
done
