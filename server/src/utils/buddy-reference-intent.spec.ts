import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BuddyReferenceRestoreIntent, loadBuddyReferenceIntent } from 'src/utils/buddy-reference-intent.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'buddy-reference-intent-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const intent = (): BuddyReferenceRestoreIntent => {
  const assetId = randomUUID();
  const ownerId = randomUUID();
  return {
    version: 1,
    operationId: randomUUID(),
    snapshotId: randomUUID(),
    vaultId: randomUUID(),
    keyFingerprint: 'b'.repeat(64),
    manifestHash: 'c'.repeat(64),
    mode: 'replace',
    adoption: {
      assetId,
      ownerId,
      type: 'IMAGE',
      physicalFileId: randomUUID(),
      source: {
        version: 1,
        sourcePath: `frameleaf-source://${randomUUID()}/${'d'.repeat(64)}`,
        sourceEpoch: {
          assetId,
          ownerId,
          epoch: '0',
          reference: { resourceId: randomUUID(), version: 'e'.repeat(64), sha256: 'f'.repeat(64) },
        },
      },
      file: { path: `/media/upload/${ownerId}/${assetId}.jpg`, size: 5, sha256: 'f'.repeat(64) },
    },
  };
};
const path = (value: BuddyReferenceRestoreIntent) =>
  join(root, 'restores', value.operationId, 'adoptions', `${value.adoption.assetId}.json`);

it('persists the immutable submitted adoption and reloads its physical ID across restarts', async () => {
  const expected = intent();
  await expect(loadBuddyReferenceIntent(root, expected)).resolves.toEqual(expected);
  const bytes = await readFile(path(expected), 'utf8');
  await expect(loadBuddyReferenceIntent(root, structuredClone(expected))).resolves.toEqual(expected);
  expect(await readFile(path(expected), 'utf8')).toBe(bytes);
});

it.each(['physical', 'operation', 'snapshot', 'version', 'bytes', 'mode'] as const)(
  'rejects a retained intent changed in %s without rewriting it',
  async (change) => {
    const expected = intent();
    await loadBuddyReferenceIntent(root, expected);
    const changed = structuredClone(expected);
    switch (change) {
      case 'physical': {
        changed.adoption.physicalFileId = randomUUID();
        break;
      }
      case 'operation': {
        changed.operationId = randomUUID();
        break;
      }
      case 'snapshot': {
        changed.manifestHash = 'd'.repeat(64);
        break;
      }
      case 'version': {
        changed.adoption.source.sourceEpoch.reference.version = 'a'.repeat(64);
        break;
      }
      case 'bytes': {
        changed.adoption.file.sha256 = 'a'.repeat(64);
        break;
      }
      case 'mode': {
        changed.mode = 'keep';
        break;
      }
    }
    const bytes = JSON.stringify(changed);
    await writeFile(path(expected), bytes);
    await expect(loadBuddyReferenceIntent(root, expected)).rejects.toThrow('Buddy reference restore intent changed');
    expect(await readFile(path(expected), 'utf8')).toBe(bytes);
  },
);

it('does not repair a malformed retained journal', async () => {
  const expected = intent();
  await loadBuddyReferenceIntent(root, expected);
  await writeFile(path(expected), '{');
  await expect(loadBuddyReferenceIntent(root, expected)).rejects.toThrow();
  expect(await readFile(path(expected), 'utf8')).toBe('{');
});

it('rejects a journal address outside an operation before accessing it', async () => {
  const expected = intent();
  expected.operationId = '../../other';
  await expect(loadBuddyReferenceIntent(root, expected)).rejects.toThrow('Invalid reference restore intent identity');
});
