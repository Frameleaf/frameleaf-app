import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) =>
  readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("required medium tests use the production native runtime and complete suite", () => {
  const dockerfile = read("server/Dockerfile");
  const runner = dockerfile.match(
    /^FROM server AS medium-test\n([\s\S]*?)(?=^FROM )/m,
  )?.[1];
  assert.ok(
    runner,
    "medium-test must inherit the unpruned server and native base",
  );
  assert.match(runner, /COPY --from=plugins .*packages\/plugin-core\/dist/);
  assert.match(
    runner,
    /COPY --from=plugins .*packages\/plugin-core\/manifest.json/,
  );
  assert.match(runner, /WORKDIR \/usr\/src\/app\/server/);
  const command = JSON.parse(runner.match(/^CMD (\[.*\])$/m)[1]);
  assert.deepEqual(command.slice(0, 2), ["bash", "-ec"]);
  assert.match(command[2], /docker version/);
  assert.match(
    command[2],
    /require\("\/usr\/local\/lib\/frameleaf\/image-hdr.node"\)/,
  );
  assert.ok(command[2].endsWith("pnpm run test:medium --run"));
  assert.doesNotMatch(
    command[2],
    /--exclude|--testNamePattern|(?:^|\s)-t\s|\.spec\.ts/,
  );
  assert.equal(
    [...dockerfile.matchAll(/^FROM .* AS (\S+)$/gm)].at(-1)[1],
    "prod",
  );
  const base = (text) =>
    text.match(
      /^# BEGIN frameleaf-server-base\n[\s\S]*?^# END frameleaf-server-base$/m,
    )[0];
  assert.equal(base(dockerfile), base(read("server/Dockerfile.dev")));
  assert.match(
    dockerfile,
    /FRAMELEAF_HDR_ISO_TEST=1 node --test image-hdr.test.mjs/,
  );
  assert.match(
    dockerfile,
    /ghcr.io\/jdx\/mise:2026.9.9@sha256:a88f300ef4365494b88f8eefd271bb92ba467d4a41835739a714426207215730/,
  );
});

test("normal medium job supplies only owned fixture paths and cleans its container", () => {
  const workflow = read(".github/workflows/test.yml");
  const job = workflow
    .split("  server-medium-tests:\n")[1]
    .split("  e2e-tests-server-cli:\n")[0];
  assert.match(job, /target: medium-test/);
  assert.match(job, /load: true/);
  assert.match(job, /cache-from: type=gha,scope=server-medium/);
  assert.match(job, /bash scripts\/checkout-test-assets.sh/);
  assert.match(job, /docker_cli=\$\(readlink -f "\$\(command -v docker\)"\)/);
  assert.match(
    job,
    /src="\$docker_cli",dst=\/usr\/local\/bin\/docker,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/docker\/postgres",dst=\/usr\/src\/app\/docker\/postgres,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/e2e\/src",dst=\/usr\/src\/app\/e2e\/src,readonly/,
  );
  assert.match(
    job,
    /src="\$GITHUB_WORKSPACE\/e2e\/test-assets",dst=\/usr\/src\/app\/e2e\/test-assets,readonly/,
  );
  assert.match(job, /--network host/);
  assert.match(job, /DOCKER_HOST=unix:\/\/\/var\/run\/docker.sock/);
  assert.match(job, /TESTCONTAINERS_HOST_OVERRIDE=localhost/);
  assert.match(
    job,
    /TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE=\/var\/run\/docker.sock/,
  );
  assert.match(job, /docker run --rm --pull never --name "\$MEDIUM_CONTAINER"/);
  assert.match(job, /if: always\(\)[\s\S]*docker rm -f "\$MEDIUM_CONTAINER"/);
  assert.match(job, /timeout-minutes: 90/);
  assert.doesNotMatch(
    job,
    /node_modules|server\/dist|RYUK_DISABLED|--privileged|pnpm.*(?:-t |--exclude)/,
  );
  assert.doesNotMatch(job, /run: mise run ci-medium/);
});
