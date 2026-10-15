#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
blocked=$(git ls-files -ci --exclude-standard)
if [[ -n "$blocked" ]]; then
  printf '%s\n' '::error::Tracked ignored files are prohibited. Untrack private work products; do not force-add them.' "$blocked"
  exit 1
fi
# Check incoming history too: merging an old branch can revive deleted reports.
if [[ -n "${HYGIENE_BASE_SHA:-}" ]]; then
  if [[ "$HYGIENE_BASE_SHA" =~ ^0+$ ]]; then
    HYGIENE_BASE_SHA=$(git rev-list --max-parents=0 HEAD | head -n 1)
  fi
  git cat-file -e "$HYGIENE_BASE_SHA^{commit}"
  private_line=$(awk '/^# Private agent tooling / { print NR; exit }' .gitignore)
  [[ -n "$private_line" ]] || { echo '::error::Private artifact ignore rules are missing.'; exit 1; }
  # A merge that brings the base branch in is compared only with that base parent: what the base
  # already holds is not incoming, but anything the merge itself adds still is.
  incoming() {
    local commit parents parent from_base
    git rev-list --parents "$HYGIENE_BASE_SHA..HEAD" | while read -r commit parents; do
      from_base=
      for parent in ${parents#* }; do
        [[ "$parents" == *' '* ]] && git merge-base --is-ancestor "$parent" "$HYGIENE_BASE_SHA" && from_base=$parent
      done
      if [[ -n "$from_base" ]]; then printf '%s %s\n' "$from_base" "$commit"; else printf '%s\n' "$commit"; fi
    done
  }
  if blocked=$(incoming |
    git diff-tree --stdin --root --no-commit-id --name-only --diff-filter=AM --no-renames -r -m -z |
    git check-ignore --no-index --stdin -v -z |
    while IFS= read -r -d '' source && IFS= read -r -d '' line &&
      IFS= read -r -d '' pattern && IFS= read -r -d '' path; do
      if [[ "$source" == .gitignore && "$line" -ge "$private_line" && "$pattern" != '!'* ]]; then
        printf '%s\n' "$path"
      fi
    done); then
    :
  else
    status=$?
    [[ "$status" == 1 ]] || exit "$status"
  fi
  if [[ -n "$blocked" ]]; then
    printf '%s\n' '::error::Private artifacts exist in incoming commits. Rebase or sanitize this branch history.' "$blocked"
    exit 1
  fi
fi
