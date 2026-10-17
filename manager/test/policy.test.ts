import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recentBackup, redact, publicSource, type Backup, type Source } from '../src/contracts.js';
import { databaseCandidates, mediaMappings } from '../src/discovery.js';
import { offered } from '../src/releases.js';
import { removeAutostart } from '../src/fencing.js';
import { sharesMedia, type Container } from '../src/docker.js';

const source = { id: 'source', postgres: { identity: 'cluster:library' } } as Source;
const now = Date.UTC(2026, 9, 4, 12);
const backup: Backup = {
  source: source.id,
  database: source.postgres.identity,
  name: 'immich-db-backup.sql.gz',
  takenAt: now - 86_400_000,
  verified: true,
  sha256: 'a'.repeat(64),
};
test('a verified backup at exactly 24 hours is reused; older, future, incomplete and other DB backups are not', () => {
  assert.equal(recentBackup([backup], source, now), backup);
  for (const patch of [
    { takenAt: backup.takenAt - 1 },
    { takenAt: now + 1 },
    { verified: false },
    { source: 'other' },
    { database: 'another-cluster:library' },
    { sha256: '' },
  ])
    assert.equal(recentBackup([{ ...backup, ...patch }], source, now), undefined);
  assert.equal(recentBackup([{ ...backup, takenAt: now - 100 }, backup], source, now)?.takenAt, now - 100);
});
test('database selection uses network identity, never familiar container names', () => {
  const app = { Id: 'app', NetworkSettings: { Networks: { private: {} } } } as Container;
  const wrong = {
    Id: 'wrong',
    Name: '/database',
    NetworkSettings: { Networks: { unrelated: { Aliases: ['db'] } } },
  } as Container;
  const right = {
    Id: 'right',
    Name: '/renamed-data',
    NetworkSettings: { Networks: { private: { IPAddress: '172.20.0.5', Aliases: ['db'] } } },
  } as Container;
  assert.deepEqual(databaseCandidates(app, [wrong, right], 'db'), [right]);
  assert.deepEqual(databaseCandidates(app, [wrong, right], '172.20.0.5'), [right]);
  assert.equal(databaseCandidates(app, [right, { ...right, Id: 'duplicate' }], 'db').length, 2);
});
test('split mounts, named volumes and custom read-only external libraries keep their destinations', () => {
  const app = {
    Mounts: [
      {
        Type: 'volume',
        Name: 'original-media',
        Source: '/var/lib/docker/volumes/original-media/_data',
        Destination: '/data',
        RW: true,
      },
      { Type: 'bind', Source: '/fixtures/encoded', Destination: '/data/encoded-video', RW: true },
      { Type: 'bind', Source: '/fixtures/archive', Destination: '/gallery/family', RW: false },
      { Type: 'bind', Source: '/secrets/db', Destination: '/run/secrets/db', RW: false },
    ],
  } as Container;
  const result = mediaMappings(app, '/data', ['/gallery/family/2025']);
  assert.deepEqual(
    result.map((m) => [m.source, m.target, m.readOnly]),
    [
      ['original-media', '/data', false],
      ['/fixtures/encoded', '/data/encoded-video', false],
      ['/fixtures/archive', '/gallery/family', true],
    ],
  );
  assert.throws(() => mediaMappings(app, '/data', ['/missing']), /unmounted_media_path/);
  assert.equal(
    sharesMedia(
      { Mounts: [{ Type: 'bind', Source: '/fixtures/encoded/sub', Destination: '/other', RW: true }] } as Container,
      result,
    ),
    true,
  );
  assert.equal(
    sharesMedia(
      { Mounts: [{ Type: 'bind', Source: '/fixtures/encoded-other', Destination: '/other', RW: true }] } as Container,
      result,
    ),
    false,
  );
});
test('Unraid removal is exact, preserves other containers and delay values', () => {
  const input = 'frameleaf-server 20\nframeleaf-server-test 3\npostgres\n';
  assert.equal(removeAutostart(input, ['frameleaf-server']), 'frameleaf-server-test 3\npostgres\n');
});
test('withdrawn and malformed staged releases are refused without an override', () => {
  assert.equal(offered('', 'seed', 'frameleaf-v3.2.0-1'), true);
  assert.equal(offered('withdrawn: failed migration', 'seed', 'frameleaf-v3.2.0-1'), false);
  for (const percent of ['nope', '101', '-1', '0'])
    assert.equal(offered(`rollout: ${percent}`, 'seed', 'frameleaf-v3.2.0-1'), false);
  assert.equal(offered('rollout: 100%', 'seed', 'frameleaf-v3.2.0-1'), true);
});
test('diagnostics remove exact secrets, URL passwords, bearer tokens and ordinary password fields', () => {
  const result = redact('password=hungry Bearer AABBCC https://user:p%40ss@host known-value', ['known-value']);
  for (const secret of ['hungry', 'AABBCC', 'p%40ss', 'known-value']) assert.ok(!result.includes(secret));
});
