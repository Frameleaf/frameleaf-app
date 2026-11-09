import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { Refusal } from '../src/contracts.js';
import { command } from '../src/docker.js';
import { explainFailure } from '../src/troubleshooting.js';
import { readable } from '../ui/src/presentation.js';

// FL-1316: what Docker really prints for each problem, with private folders and a password in it.
const PRIVATE = ['/mnt/user/photos/Alice Smith', 'hunter2-very-secret', 'alice@example.com'];
const failures: [string, string, RegExp][] = [
  ['port allocated', 'Error response from daemon: driver failed programming external connectivity on endpoint frameleaf-server: Bind for 0.0.0.0:2283 failed: port is already allocated', /^Port 2283 is in use\. Another app on this server is already using the port Frameleaf would open on\./],
  ['address in use', 'Error response from daemon: failed to bind host port for [::]:2284:172.18.0.2:2283/tcp: address already in use', /^Port 2284 is in use\./],
  ['address in use, no port', 'listen EADDRINUSE', /^Port in use\. Another app/],
  ['bind source missing', 'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /mnt/user/photos/Alice Smith', /^Folder missing\. A folder Frameleaf uses isn’t on this server any more\./],
  ['rate limited', 'Error response from daemon: toomanyrequests: You have reached your pull rate limit.', /^Too many downloads\. .*Wait an hour, then try again\.$/],
  ['registry unreachable', 'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io on 127.0.0.11:53: no such host', /^Manager can’t reach Frameleaf’s downloads\. This server couldn’t connect to ghcr\.io, where Frameleaf is downloaded from\./],
  ['registry timeout', 'failed to resolve reference "ghcr.io/frameleaf/server:1.2.13": failed to do request: Head "https://ghcr.io/v2/frameleaf/server/manifests/1.2.13": dial tcp 140.82.112.33:443: i/o timeout', /^Manager can’t reach Frameleaf’s downloads\./],
  ['Docker Hub unreachable', 'Error response from daemon: Get "https://registry-1.docker.io/v2/": dial tcp: lookup registry-1.docker.io on 127.0.0.11:53: no such host', /^Manager can’t reach Frameleaf’s downloads\. This server couldn’t connect to an image registry .*such as Docker Hub\..*allow ghcr\.io, github\.com and docker\.io\.$/],
  ['Docker storage full', 'failed to register layer: write /var/lib/docker/overlay2/abc/diff/x: no space left on device', /^Not enough room in Docker’s storage\./],
  ['disk full', 'Error response from daemon: mkdir /mnt/user/photos/Alice Smith/upload: no space left on device', /^Disk full\./],
  ['permission', 'Error response from daemon: error while creating mount source path \'/mnt/user/photos/Alice Smith\': mkdir /mnt/user/photos/Alice Smith: permission denied', /^Permission denied\./],
  ['gpu', 'Error response from daemon: could not select device driver "nvidia" with capabilities: [[gpu]]', /^Graphics acceleration failed\./],
];

for (const [name, line, wording] of failures)
  test(`a ${name} failure says what happened and what to do`, () => {
    const stderr = `time="2026-11-09" level=warning msg="DB_PASSWORD=${PRIVATE[1]} for ${PRIVATE[2]}"\n${line}\n`;
    const detail = explainFailure(stderr);
    assert.ok(detail, `${name} not recognised`);
    assert.match(detail, wording);
    for (const leak of [...PRIVATE, '/mnt', '/var/lib/docker', 'Error response', 'daemon', '172.18'])
      assert.ok(!detail.includes(leak), `${leak} reached the screen: ${detail}`);
    assert.equal(readable('docker_operation_failed', detail), detail);
  });

test('an unknown failure keeps today’s message', () => {
  assert.equal(explainFailure('Error response from daemon: something new went wrong in /mnt/user/photos'), undefined);
  assert.equal(explainFailure(''), undefined);
  // A crash points at a report the operation screen does not show.
  assert.equal(explainFailure('panic: runtime error: invalid memory address'), undefined);
  assert.match(readable('docker_operation_failed'), /^A Docker command did not finish\. The Manager container log has/);
});

test('Docker and drive refusals that showed their raw code are worded', () => {
  for (const code of [
    'compose_v2_required',
    'unsupported_docker_host',
    'unsupported_docker_version_or_architecture',
    'docker_storage_unavailable',
    'host_mount_information_required',
    'manager_host_mounts_unverified',
    'dockerman_container_identity',
  ]) {
    const text = readable(code);
    assert.notEqual(text, code.replaceAll('_', ' '), `${code} has no wording`);
    assert.match(text, /\.$/u);
  }
  assert.match(readable('unsupported_docker_version_or_architecture'), /^This version of Docker is too old.*Docker 24 or newer/u);
});

let directory = '';
let fake = '';
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'manager-docker-failure-'));
  fake = join(directory, 'docker');
  await writeFile(fake, `#!${process.execPath}\nprocess.stderr.write(process.env.FAKE_STDERR ?? '');\nprocess.exit(1);\n`);
  await chmod(fake, 0o700);
});
after(() => rm(directory, { recursive: true, force: true }));

const fail = async (stderr: string, args = ['compose', 'up', '-d']) =>
  command('docker', args, { executable: fake, env: { FAKE_STDERR: stderr }, timeout: 10_000 }).then(
    () => assert.fail('the command should fail'),
    (error: unknown) => {
      assert.ok(error instanceof Refusal);
      assert.equal(error.code, 'docker_operation_failed');
      assert.equal(error.status, 503);
      return error;
    },
  );

test('a failed Docker command carries the fix as its detail, never its stderr', async () => {
  const secret = 'hunter2-very-secret';
  const error = await fail(
    `Error response from daemon: invalid mount config for type "bind": bind source path does not exist: ${PRIVATE[0]} (POSTGRES_PASSWORD=${secret})`,
    ['run', `DB_PASSWORD=${secret}`],
  );
  assert.ok(error.detail);
  assert.match(error.detail, /^Folder missing\./);
  for (const leak of [...PRIVATE, 'POSTGRES_PASSWORD', 'invalid mount config']) assert.ok(!error.detail.includes(leak), `${leak} leaked`);
  assert.ok(!readable(error.code, error.detail).includes(secret));
});

test('a failed Docker command with an unknown error has no detail', async () => {
  const error = await fail(`something new went wrong in ${PRIVATE[0]}`);
  assert.equal(error.detail, undefined);
});
