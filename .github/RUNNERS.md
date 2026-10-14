# Fork CI runners

Linux workflow jobs use Namespace Ubuntu 24.04 runners:
`nscloud-ubuntu-24.04-amd64-8x16` (AMD64) and
`nscloud-ubuntu-24.04-arm64-8x16` (ARM64). Both request 8 vCPU and 16 GB RAM;
container builds remain native, without QEMU.

These exact jobs stay on GitHub-hosted runners until Namespace can run them;
`check-runners.cjs` pins each one and fails if the list or its runners change:

- Manager (`manager.yml/manager`, `ubuntu-24.04` and `ubuntu-24.04-arm`): Namespace
  Docker 29.3.0-namespace ignores read-only on the `/proc/1/mountinfo` bind mount,
  which Manager's host-mount check requires.
- End-to-End Image, Tests (Server & CLI), Tests (Web) and the Success aggregator
  (`test.yml`, `ubuntu-24.04` and `ubuntu-24.04-arm`): on Namespace ARM64 these
  suites hit repeated reset, readiness and Playwright timeouts.
- Unit Test CLI (Windows) (`test.yml/cli-unit-tests-win`, `windows-latest`): no
  Namespace runner ever picked up `nscloud-windows-2022-amd64-8x16`.

The private FL103 Linux intake runs only in `Frameleaf/frameleaf-qualification`
on `ubuntu-24.04`, because it needs systemd. Every other executable workflow job
routes to Namespace.

The Namespace Managed Runners GitHub App must have access to this public
repository. Runner-group policies must allow public repositories when using
organization runners. Namespace usage is billed separately from GitHub Actions.
See https://namespace.so/docs/reference/github-actions/runner-configuration.

Repository admission guards, immutable action pins, release ancestry checks,
and container-cache publication restrictions remain in place. Only the fork
`Frameleaf/frameleaf-app` is in scope.

Playwright installs both Chromium and its OS dependencies, then launches the
browser before E2E stack setup to provide early shared-library diagnostics.
A preflight failure fails the job; existing explicit `!cancelled()` steps may
still run afterward.

On Namespace, `configure-dockerhub-mirror.sh` verifies the managed Docker daemon
is ready instead of changing its configuration or restarting it with systemd.
CI images retain their exact frozen `mirror.gcr.io` digests and BuildKit mirror
settings. Other hosts retain the helper's daemon merge, restart and active-mirror
checks. See https://namespace.so/docs/solutions/github-actions/docker-builds.

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
