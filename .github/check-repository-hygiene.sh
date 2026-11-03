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
  # Incoming paths are classified with this branch's .gitignore, so the private block may only grow:
  # a PR that removes or narrows a rule (reports/ -> reports/x/) could otherwise bring the report it
  # unignored with it. Every private rule the base branch has must still be present here. The block
  # ends at its first blank line; the sections after it (reviewed guides, Studio output, Vitest) are
  # not private rules.
  private_rules() {
    awk 'found && /^[[:space:]]*$/ { exit } found && !/^#/ { print } /^# Private agent tooling / { found=1 }' | sort -u
  }
  base_gitignore=$(git show "$HYGIENE_BASE_SHA:.gitignore" 2>/dev/null || true)
  base_rules=$(printf '%s\n' "$base_gitignore" | private_rules)
  head_rules=$(private_rules < .gitignore)
  removed_rules=$(comm -23 <(printf '%s\n' "$base_rules") <(printf '%s\n' "$head_rules"))
  if [[ -n "$removed_rules" ]]; then
    printf '%s\n' '::error::Private artifact ignore rules were removed or narrowed in this change. Restore them; private work products stay outside the repository.' "$removed_rules"
    exit 1
  fi
  # Git applies the last matching pattern, so a kept rule is no protection once a later `!` rule
  # re-includes the path: no negation may be added anywhere after the private marker...
  negations() {
    awk 'found && /^!/ { print } /^# Private agent tooling / { found=1 }' | sort -u
  }
  added_negations=$(comm -13 <(printf '%s\n' "$base_gitignore" | negations) <(negations < .gitignore))
  if [[ -n "$added_negations" ]]; then
    printf '%s\n' '::error::Ignore exceptions were added after the private artifact rules. Private work products stay outside the repository; remove them.' "$added_negations"
    exit 1
  fi
  # ...and every base private rule must still ignore a path it matches, wherever the override lives.
  # The sample is derived from the rule (dir/ -> dir/x, *.ext -> a.ext, name -> x/name) and only
  # counts when the base .gitignore ignores it too, so the derivation cannot fail a rule on its own.
  private_sample() {
    local rule=${1#/} sample
    [[ "$1" == /* || "$rule" == */?* ]] || rule="x/$rule"
    sample=${rule//\*/a}
    [[ "$sample" == */ ]] && sample="${sample}x"
    printf '%s\n' "$sample"
  }
  base_tree=$(mktemp -d)
  trap 'rm -rf "$base_tree"' EXIT
  git -C "$base_tree" init -q
  printf '%s\n' "$base_gitignore" > "$base_tree/.gitignore"
  unprotected=
  while IFS= read -r rule; do
    [[ -n "$rule" && "$rule" != '!'* ]] || continue
    sample=$(private_sample "$rule")
    git -C "$base_tree" check-ignore -q --no-index "$sample" || continue
    git check-ignore -q --no-index "$sample" || unprotected+="$rule ($sample is no longer ignored)"$'\n'
  done <<< "$base_rules"
  if [[ -n "$unprotected" ]]; then
    printf '%s' '::error::Private artifact ignore rules are overridden in this change. Private work products stay outside the repository; remove the override.'$'\n' "$unprotected"
    exit 1
  fi
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
