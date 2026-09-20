---
title: Frameleaf toolchain baseline
---

# Frameleaf toolchain baseline

FL-25 requires tool-version evidence tied to an exact reviewed baseline. `scripts/frameleaf-toolchain-inventory.mjs` reads a defined set of repository runtime declarations without installing or updating anything, verifies every source against an explicit reviewed-baseline commit, hashes the sources and directly relevant package/tool lockfiles, and records which tools are already resolvable on a controlled `PATH`. It re-reads and re-hashes every covered source immediately before returning evidence, rejecting concurrent changes during probing. The reviewed baseline must be a full commit SHA and an ancestor of the current delivery `HEAD`, so committing the inventory itself does not invalidate its evidence.

The evidence distinguishes four concepts:

- **Exact declarations** such as mise pins, `.nvmrc`, Flutter, Gradle wrapper, CocoaPods, and Bundler lock versions.
- **Constraints** such as package-manager engines and supported Python or Dart ranges. A constraint is not an exact installed version.
- **Workflow and container pins** from `.github/workflows/fork-integration.yml` and the six Dockerfiles used by the server, machine-learning, CLI, e2e auth server, and iCloud bridge builds. The inventory records external action commits, runner labels, digest-bearing workflow images, and external Dockerfile `FROM` references.
- **Resolved local versions** observed through a strict allowlist of bounded version commands. Evidence retains only the parsed version token and a controlled `PATH` slot, never raw command output or an absolute executable path.
- **Missing or unprobed tools.** Missing executables remain missing; Flutter and the Gradle wrapper are not invoked because a version command may initialize caches or download artifacts.

Resolved numeric versions are compared with every exact declaration for the same tool. Constraints remain separate, and conflicting exact declarations necessarily produce a mismatch until reconciled.

## Reproduce without installing tools

Run with an explicitly selected, stable `PATH`; do not rely on an interactive shell's ambient `PATH`:

```sh
node scripts/frameleaf-toolchain-inventory.mjs \
  --repository . \
  --expected-baseline 4bedc0c4d384f365ee5c29739ce201cc114fdd85 \
  --output-jsonl docs/docs/developer/evidence/fl25-toolchain-baseline.jsonl \
  --output-markdown docs/docs/developer/evidence/fl25-toolchain-baseline.md
```

The canonical JSONL companion is machine-readable without depending on package installation or formatter plugins. It records SHA-256 digests of the supplied `PATH` entries, not their potentially identifying text. Repeating the command with the same reviewed baseline, unchanged covered sources, tool binaries, and exactly ordered `PATH` produces identical bytes. `--check` has the same explicit-baseline and controlled-`PATH` contract and should be invoked with the same values used to generate the evidence. A delivery commit containing only this script, its tests, documentation, and generated evidence can therefore run `--check` successfully while continuing to report the reviewed source baseline.

Append `--check` to compare freshly observed evidence with the checked-in files without writing them. A difference fails with a stale-evidence error.

The command rejects an unknown or abbreviated baseline, a baseline that is not an ancestor of current `HEAD`, and any covered working-tree source whose bytes differ from that baseline. Choose a new reviewed baseline deliberately when a covered pin source changes; do not update the argument merely to silence the check.

## Limits and remaining acceptance

- Workflow coverage is intentionally limited to `.github/workflows/fork-integration.yml`. Other workflows, reusable workflows reached transitively, action internals, Compose/Helm/deployment image references, and package dependency versions are outside this inventory.
- Container coverage is intentionally limited to external `FROM` declarations in `icloud-bridge/Dockerfile`, `machine-learning/Dockerfile`, `packages/cli/Dockerfile`, `packages/e2e-auth-server/Dockerfile`, `server/Dockerfile`, and `server/Dockerfile.dev`. Build-stage aliases and variable-selected images cannot be resolved statically and are excluded.
- This evidence describes the controlled host used for the run. A `PATH` slot and its digest are reproducible comparison aids, not a portable executable identity or proof of binary integrity.
- Only explicitly allowlisted commands execute, under an environment containing `LANG`, `LC_ALL`, `NO_COLOR`, and controlled `PATH`. Package-manager and SDK wrappers that may initialize state or download content are present/missing-not-probed by default. Raw probe output is never serialized.
- A reported version is not proof that all architecture-specific artifacts in `mise.lock`, application dependency lockfiles, native SDKs, Xcode, Android SDK components, browsers, codecs, or licensed media tools are installed or qualified.
- Conflicting declarations remain visible as separate records and require an owner decision; the inventory does not silently choose one.
- Missing tools must be resolved through the repository's normal pinned setup in a separately authorized environment. This slice does not install them.
- For FL-25, the exact declarations and controlled-host observations above satisfy the tool-version evidence criterion after this acceptance-alignment candidate merges and receives Jira closeout. The mismatches, missing tools, unprobed tools, and probe failures remain explicit setup or qualification concerns; they do not authorize installation and they do not make preserved application source accepted.
