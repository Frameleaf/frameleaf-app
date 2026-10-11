# Fork CI runners

Linux AMD64 jobs run on Namespace managed runners through the profile label
`namespace-profile-fl` (FL-380, owner decision 2026-10-11, release and publish
jobs included). ARM64 jobs still use GitHub-hosted `ubuntu-24.04-arm` until an
ARM profile is named, and Windows CLI tests use GitHub-hosted `windows-latest`.
Container builds stay native per architecture, without QEMU.

Repository admission guards, immutable action pins, release ancestry checks,
and container-cache publication restrictions remain in place. Only the fork
`adamtaylor152/immich` is in scope.

Playwright installs both Chromium and its OS dependencies, then launches the
browser before building the E2E stack. This catches missing shared libraries
before the expensive Docker build and test retries.

Run `node .github/check-runners.cjs`, `node .github/check-release.cjs`, and
`actionlint -shellcheck='' -pyflakes=''` after installing workspace dependencies.
The runner check covers every workflow job and executes the native build-matrix
generator, including rejection of unsupported platforms.

The old self-hosted runner image and smoke check remain under `.github/runner/`
for operator rollback only; no workflow targets that runner. Switching workflows
does not stop or unregister the existing container.

Routing is versioned with each workflow. Rerunning an old commit does not adopt
these changes. Default-branch events (including `pull_request_target`, schedules,
and `workflow_run`) adopt the routing only after it lands on `fork/main`.
