import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

test('Manager publication reuses both tested native archives and verifies signatures before latest', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/manager.yml', import.meta.url), 'utf8');
  const [build, publish] = workflow.split('\n  publish:\n');
  assert.ok(publish);
  assert.match(build, /publish:\n(?:[^\n]*\n){0,5}        default: false/);
  assert.match(build, /cancel-in-progress: \$\{\{ github.event_name == 'pull_request' \}\}/);
  for (const architecture of ['amd64', 'arm64']) assert.ok(build.includes(`architecture: ${architecture}`));
  assert.ok(build.indexOf('node manager/test/container.mjs') < build.indexOf('docker save --output'));
  assert.ok(build.indexOf('node manager/test/postgres-container.mjs') < build.indexOf('docker save --output'));
  assert.ok(build.indexOf('docker save --output') < build.indexOf('name: Retain tested image and receipt'));
  assert.match(build, /uname -m/);
  assert.match(build, /--entrypoint node frameleaf-manager:test -p process.arch/);
  assert.match(build, /name: manager-tested-\$\{\{ matrix.architecture \}\}/);
  assert.match(build, /docker build --provenance=false --file manager\/Dockerfile/);
  assert.match(publish, /needs: manager/);
  assert.match(publish, /environment: production/);
  assert.match(publish, /github.repository == 'Frameleaf\/frameleaf-app'/);
  assert.match(publish, /github.event_name == 'workflow_dispatch'/);
  assert.match(publish, /inputs.publish && github.ref == 'refs\/heads\/fork\/main'/);
  assert.doesNotMatch(publish, /docker build|build-push-action|if: always/);
  assert.match(publish, /pattern: manager-tested-\*/);
  const firstPush = publish.indexOf('docker push "$candidate"');
  for (const required of [
    '${COSIGN_PRIVATE_KEY:?', '${COSIGN_PASSWORD:?', 'for architecture in amd64 arm64;',
    'sha256sum -c SHA256SUMS', '.sourceCommit==$source', '.repository==$repository',
    '.runId==$run', '.runAttempt==$attempt', '.archiveSha256==$hash',
    '.integration=="passed"', '.recovery=="passed"', 'docker load --input "$archive/image.tar"',
    '.Id==$receipt[0].configDigest', '.RootFS.Layers==$receipt[0].rootfsDiffIds',
    '.Architecture==$a', '.Config.Labels["org.opencontainers.image.revision"]==$s',
    '[[ "$(git rev-parse FETCH_HEAD)" == "$SOURCE_SHA" ]]',
  ]) {
    assert.ok(publish.indexOf(required) >= 0 && publish.indexOf(required) < firstPush, required);
  }
  assert.match(publish, /\.config.digest==\$receipt\[0\].configDigest/);
  assert.equal(publish.match(/cosign sign --yes --key env:\/\/COSIGN_PRIVATE_KEY "\$image@\$digest"/g)?.length, 2);
  assert.equal(publish.match(/cosign verify --key cosign.pub "\$image@\$digest"/g)?.length, 2);
  const latest = publish.indexOf('oras tag "ghcr.io/frameleaf/frameleaf-manager@$DIGEST" latest');
  assert.ok(latest > publish.lastIndexOf('cosign verify --key cosign.pub'));
  assert.ok(latest > publish.indexOf('uses: actions/attest-build-provenance@'));
  const promotion = publish.slice(publish.indexOf('- name: Update latest only after signature and provenance'));
  assert.ok(promotion.indexOf('git fetch --no-tags origin refs/heads/fork/main') < promotion.indexOf('oras tag'));
  assert.match(promotion, /\[\[ "\$\(git rev-parse FETCH_HEAD\)" == "\$SOURCE_SHA" \]\]/);
  assert.match(promotion, /\[\[ "\$\(oras resolve ghcr.io\/frameleaf\/frameleaf-manager:latest\)" == "\$DIGEST" \]\]/);
});
