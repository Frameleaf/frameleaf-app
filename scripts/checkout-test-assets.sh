#!/usr/bin/env bash
# Frameleaf owns this frozen fixture input; no branch, tag, submodule or tracking update is followed.
set -euo pipefail
fixture_commit=6742055402de1aa48f93d12ded7d18f4057f9d1f
fixture_source=https://github.com/Frameleaf/frameleaf-test-assets.git
fixture_root="$(git rev-parse --show-toplevel)/e2e/test-assets"
if [[ -d "$fixture_root/.git" ]]; then
  [[ "$(git -C "$fixture_root" rev-parse HEAD)" == "$fixture_commit" ]] || { echo 'Unexpected fixture checkout' >&2; exit 1; }
  git -C "$fixture_root" diff --quiet
  git -C "$fixture_root" diff --cached --quiet
else
  mkdir -p "$fixture_root"
  [[ -z "$(ls -A "$fixture_root")" ]] || { echo 'Fixture destination must be empty' >&2; exit 1; }
  git init "$fixture_root"
  git -C "$fixture_root" fetch --no-tags --depth=1 "$fixture_source" "$fixture_commit"
  git -C "$fixture_root" checkout --detach FETCH_HEAD
  [[ "$(git -C "$fixture_root" rev-parse HEAD)" == "$fixture_commit" ]]
fi
# Source bytes are authenticated by Git's frozen commit/tree; retain attribution in owned artifact.
printf '%s\n' "Source: $fixture_source" "Commit: $fixture_commit" 'Original source: https://github.com/immich-app/test-assets' 'Fixtures retain their original licenses and author attribution.' > "$fixture_root/FRAMELEAF-FIXTURE-SOURCE.txt"
