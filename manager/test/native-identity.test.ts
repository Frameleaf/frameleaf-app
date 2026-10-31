import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  NativeInstallationSchema,
  nativeStopped,
} from '../src/runtime/native.js';

const secureInstallationId = '11111111-1111-4111-8111-111111111111';
const installation = {
  runtime: 'native' as const,
  id: 'a'.repeat(12),
  secureInstallationId,
  controller: join(tmpdir(), 'controller'),
  candidate: join(tmpdir(), 'candidate'),
  state: join(tmpdir(), 'state'),
  manifestSha256: 'b'.repeat(64),
  sourceRevision: 'c'.repeat(40),
  certified: false,
  databasePort: 54321,
  apiPort: 54322,
};

test('native installation requires a canonical nonnil secure UUID independently of its short ID', () => {
  assert.equal(NativeInstallationSchema.safeParse(installation).success, true);
  const { secureInstallationId: _, ...legacy } = installation;
  assert.equal(NativeInstallationSchema.safeParse(legacy).success, false);
  for (const id of [
    '',
    'a'.repeat(12),
    '00000000-0000-0000-0000-000000000000',
    'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
    null,
    4,
  ]) {
    assert.equal(
      NativeInstallationSchema.safeParse({
        ...installation,
        secureInstallationId: id,
      }).success,
      false,
    );
  }
});

test('cold stop proof requires the exact secure installation UUID even when all other fields match', () => {
  const inspection = {
    protocolVersion: 1,
    state: 'quiescent',
    installationId: installation.id,
    secureInstallationId,
    manifestSha256: installation.manifestSha256,
    sourceRevision: installation.sourceRevision,
    certified: false,
    profileIdentity: 'e'.repeat(64),
    generation: '33333333-3333-4333-8333-333333333333',
  };
  assert.doesNotThrow(() =>
    nativeStopped(
      { protocolVersion: 1, state: 'stopped', inspection },
      installation,
    ),
  );
  for (const id of [undefined, '22222222-2222-4222-8222-222222222222']) {
    assert.throws(() =>
      nativeStopped(
        {
          protocolVersion: 1,
          state: 'stopped',
          inspection: { ...inspection, secureInstallationId: id },
        },
        installation,
      ),
    );
  }
});
