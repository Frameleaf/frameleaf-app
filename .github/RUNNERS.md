# Fork CI runners

Every workflow job runs on GitHub-hosted runners: `ubuntu-24.04` (AMD64),
`ubuntu-24.04-arm` (ARM64) and `windows-latest`. Container builds stay native on
each architecture, without QEMU. `check-runners.cjs` fails on any other label,
including Namespace (`nscloud-*`) and self-hosted runners.

The private FL103 Linux intake runs only in `Frameleaf/frameleaf-qualification`
on `ubuntu-24.04`, because it needs systemd.

Repository admission guards, immutable action pins, release ancestry checks,
and container-cache publication restrictions remain in place. Only the fork
`Frameleaf/frameleaf-app` is in scope.

Playwright installs both Chromium and its OS dependencies, then launches the
browser before E2E stack setup to provide early shared-library diagnostics.
A preflight failure fails the job; existing explicit `!cancelled()` steps may
still run afterward.

Run `node .github/check-runners.cjs`, `node .github/check-release.cjs`, and
`actionlint -shellcheck='' -pyflakes=''` after installing workspace dependencies.
The runner check covers every workflow job and executes the native build-matrix
generator, including rejection of unsupported platforms.

The old self-hosted runner image and smoke check remain under `.github/runner/`
for operator rollback only; no workflow targets that runner.

Routing is versioned with each workflow. Rerunning an old commit does not adopt
these changes. Default-branch events (including `pull_request_target`, schedules,
and `workflow_run`) adopt the routing only after it lands on `main`.
