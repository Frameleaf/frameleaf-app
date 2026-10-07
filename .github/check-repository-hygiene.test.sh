#!/usr/bin/env bash
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
cp "$repo/.gitignore" "$scratch/.gitignore"
mkdir "$scratch/design"
cp "$repo/design/.gitignore" "$scratch/design/.gitignore"
cp "$repo/.github/check-repository-hygiene.sh" "$scratch/check.sh"
cd "$scratch"
git init -q
git config user.name 'Hygiene test'
git config user.email 'hygiene-test@example.invalid'
printf '%s\n' '# Product documentation' > README.md
git add .gitignore design/.gitignore check.sh README.md
git commit -qm baseline
base=$(git rev-parse HEAD)
bash check.sh
for path in .agents/skills/test/SKILL.md .superpowers/task-report.md docs/superpowers/specs/test.md reports/private.md docs/docs/developer/frameleaf-plan/backlog.json studio/channel-preservation-test-packet.md CLAUDE.md design/frameleaf-manager/app.js design/frameleaf/template/src/App.jsx design/private-preview/index.html; do
  mkdir -p "$(dirname "$path")"
  printf '%s\n' private > "$path"
  git check-ignore -q "$path"
  git add -f "$path"
  if bash check.sh > /dev/null; then
    printf '%s\n' "FAILED: accepted force-added $path"
    exit 1
  fi
  git reset -q -- "$path"
done
# A deleted private report must still fail the incoming-history check.
git add -f reports/private.md
git commit -qm 'add private report'
git rm -q reports/private.md
git commit -qm 'delete private report'
bash check.sh
if HYGIENE_BASE_SHA="$base" bash check.sh > /dev/null; then
  printf '%s\n' 'FAILED: accepted private report in incoming history'
  exit 1
fi
# The same source tree without the report history must pass.
git reset -q --soft "$base"
git commit --allow-empty -qm 'clean candidate'
HYGIENE_BASE_SHA="$base" bash check.sh
for path in README.md AGENTS.md design/.gitignore design/AGENTS.md design/README.md design/frameleaf/brand-kit/frameleaf-symbol.svg design/frameleaf/derivatives/frameleaf-logo-light.svg docs/docs/guides/setup.md docs/docs/administration/upstream-handoff.md server/test/fixtures/SOURCE.md studio/rights-evidence/license.txt; do
  if git check-ignore -q --no-index "$path"; then
    printf '%s\n' "FAILED: ignored reviewed source $path"
    exit 1
  fi
done
# A report introduced only by a merge commit must also be rejected.
git checkout -qb merge-side
printf '%s\n' side > side.txt
git add side.txt
git commit -qm side
git checkout -q -
printf '%s\n' main > main.txt
git add main.txt
git commit -qm main
git merge -q --no-ff --no-commit merge-side
mkdir -p reports
printf '%s\n' private > reports/merge-report.md
git add -f reports/merge-report.md
git commit -qm 'merge with private report'
git rm -q reports/merge-report.md
git commit -qm 'remove merge report'
if HYGIENE_BASE_SHA="$base" bash check.sh > /dev/null; then
  printf '%s\n' 'FAILED: accepted report introduced only by merge'
  exit 1
fi
printf '%s\n' 'PASS: normal source, force-add rejection, deleted-report history, and merge history'
