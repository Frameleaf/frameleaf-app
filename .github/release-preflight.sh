#!/usr/bin/env bash
# Release preflight (FL-1721): checks everything a publish job needs before any build or test time is
# spent on it, and pushes, signs and edits nothing. Publishing 1.2.25 from Forgejo failed three times at
# its last step (no gh on the runner, then two workflow bugs); each was only visible that late.
#
# Environment:
#   TOOLS               commands the publish job runs (space separated)
#   GH_TOKEN            token the publish job uses for the GitHub repository
#   REGISTRY_TOKEN      token for ghcr.io, with ACTOR as the user
#   COSIGN_PRIVATE_KEY, COSIGN_PASSWORD   the Frameleaf signing key; must match the committed cosign.pub
#   RELEASE_TAG         optional: a tag that must not exist yet
set -uo pipefail
failed=0
out=$(mktemp)
check() { # check "what it proves" command...
  local label=$1
  shift
  if "$@" > "$out" 2>&1; then
    echo "ok    $label"
  else
    echo "::error::Release preflight: $label"
    sed 's/^/      /' "$out" | tail -5
    failed=1
  fi
}
repository=${PUBLISH_REPOSITORY:-$GITHUB_REPOSITORY}

for tool in ${TOOLS:-}; do
  check "$tool is installed on this runner" command -v "$tool"
done

can_push() { [[ "$(gh api "repos/$repository" --jq .permissions.push)" == true ]]; }
check "the publish token can write to $repository" can_push

if [[ -n ${RELEASE_TAG:-} ]]; then
  tag_is_free() { # only a 404 proves it; any other failure (bad token, network) is not "free"
    local reply
    reply=$(gh api "repos/$repository/git/ref/tags/$RELEASE_TAG" 2>&1) && { echo "the tag already exists"; return 1; }
    grep -q 'HTTP 404' <<< "$reply" || { echo "$reply"; return 1; }
  }
  check "tag $RELEASE_TAG does not exist yet" tag_is_free
fi

registry_login() {
  local config
  config=$(mktemp -d) # a throwaway config: the job's own Docker login state is left alone
  printf '%s' "$REGISTRY_TOKEN" | docker --config "$config" login ghcr.io --username "$ACTOR" --password-stdin
  local status=$?
  rm -rf "$config"
  return $status
}
check "ghcr.io accepts the registry token for ${ACTOR:-?}" registry_login

signing_key_matches() {
  : "${COSIGN_PRIVATE_KEY:?the signing key is not set}" "${COSIGN_PASSWORD:?the signing key password is not set}"
  diff <(cosign public-key --key env://COSIGN_PRIVATE_KEY) "${COSIGN_PUBLIC_KEY:-cosign.pub}"
}
check "the signing key opens with its password and matches cosign.pub" signing_key_matches

rm -f "$out"
[[ $failed == 0 ]] && echo "Release preflight passed: nothing was pushed, signed or edited."
exit $failed
