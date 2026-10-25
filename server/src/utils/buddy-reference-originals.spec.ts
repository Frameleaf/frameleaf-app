import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BuddyManifest } from 'src/services/buddy-backup-capture.service.js';
import { buddyObjectId, createBuddyKeyring, encryptBuddyBlock } from 'src/utils/buddy-backup-crypto.js';
import { BuddyBackupReader } from 'src/utils/buddy-backup-reader.js';
import { readBuddyRecovery } from 'src/utils/buddy-backup-recovery.js';
import { BuddyVault } from 'src/utils/buddy-backup-vault.js';
import { readBuddyReferenceOriginals, referenceOriginalPath } from 'src/utils/buddy-reference-originals.js';

const assetId = randomUUID();
const ownerId = randomUUID();
const sourcePath = `frameleaf-source://${randomUUID()}/${'ef'.repeat(32)}`;
const sha256 = 'ab'.repeat(32);
const originalFileName = 'Holiday.CR2';
const make = (storageRoot = '/media') => {
  const path = referenceOriginalPath(storageRoot, ownerId, assetId, originalFileName);
  return {
    version: 2,
    storageRoot,
    library: {
      assets: {
        [assetId]: {
          owner: ownerId,
          originalFileName,
          files: [{ role: 'original', path, sha256, size: 5, mtime: null }],
        },
      },
    },
    contents: { [sha256]: { bytes: 5, keyVersion: 1, blocks: ['cd'.repeat(32)] } },
    referenceOriginals: {
      [assetId]: {
        version: 1,
        sourcePath,
        sourceEpoch: {
          assetId,
          ownerId,
          epoch: '0',
          reference: { resourceId: randomUUID(), version: '12'.repeat(32), sha256 },
        },
      },
    },
  } as unknown as BuddyManifest;
};

it.each(['/media', String.raw`C:\Frameleaf`, 'C:/Frameleaf', String.raw`\\server\library`, '//server/library'])(
  'binds independent original bytes and provenance for %s',
  (root) => {
    const manifest = make(root);
    expect(readBuddyReferenceOriginals(manifest)).toEqual(manifest.referenceOriginals);
    expect(manifest.library.assets[assetId].files[0].path).not.toContain('frameleaf-source:');
  },
);

it('preserves legacy owned-original archives and rejects metadata-only reference archives', () => {
  const manifest = make();
  delete manifest.referenceOriginals;
  manifest.version = 1;
  expect(readBuddyReferenceOriginals(manifest)).toEqual({});
  manifest.library.assets[assetId].files[0].path = sourcePath;
  expect(() => readBuddyReferenceOriginals(manifest)).toThrow('Buddy reference original');
});

it.each([
  'owner',
  'asset',
  'epoch',
  'resource',
  'version',
  'digest',
  'path',
  'content',
  'size',
  'blocks',
  'duplicate',
  'orphan',
  'format',
  'source',
  'negative-bytes',
  'malformed-block',
  'null',
])('refuses a mismatched %s binding without changing the manifest', (kind) => {
  const manifest = make();
  const binding = manifest.referenceOriginals![assetId];
  const file = manifest.library.assets[assetId].files[0];
  switch (kind) {
    case 'owner': {
      binding.sourceEpoch.ownerId = randomUUID();
      break;
    }
    case 'asset': {
      binding.sourceEpoch.assetId = randomUUID();
      break;
    }
    case 'epoch': {
      binding.sourceEpoch.epoch = '-1';
      break;
    }
    case 'resource': {
      binding.sourceEpoch.reference.resourceId = 'invalid';
      break;
    }
    case 'version': {
      binding.sourceEpoch.reference.version = 'invalid';
      break;
    }
    case 'digest': {
      binding.sourceEpoch.reference.sha256 = '34'.repeat(32);
      break;
    }
    case 'path': {
      file.path = '/elsewhere/original.CR2';
      break;
    }
    case 'content': {
      delete manifest.contents[sha256];
      break;
    }
    case 'size': {
      manifest.contents[sha256].bytes++;
      break;
    }
    case 'blocks': {
      manifest.contents[sha256].blocks = [];
      break;
    }
    case 'duplicate': {
      manifest.library.assets[assetId].files.push({ ...file });
      break;
    }
    case 'orphan': {
      delete manifest.library.assets[assetId];
      break;
    }
    case 'format': {
      Object.assign(binding, { version: 2 });
      break;
    }
    case 'source': {
      binding.sourcePath = '/local/pretend-original';
      break;
    }
    case 'negative-bytes': {
      file.size = -1;
      manifest.contents[sha256] = { bytes: -1, keyVersion: 1, blocks: [] };
      break;
    }
    case 'malformed-block': {
      manifest.contents[sha256].blocks = ['not-an-encrypted-block-id'];
      break;
    }
    case 'null': {
      Object.assign(manifest, { referenceOriginals: null });
      break;
    }
  }
  const before = JSON.stringify(manifest);
  expect(() => readBuddyReferenceOriginals(manifest)).toThrow('Buddy reference original');
  expect(JSON.stringify(manifest)).toBe(before);
});

it('never derives a managed target from untrusted identity or filename traversal', () => {
  expect(() => referenceOriginalPath('/media', '../owner', assetId, originalFileName)).toThrow();
  expect(() => referenceOriginalPath('/media', ownerId, '../asset', originalFileName)).toThrow();
  expect(referenceOriginalPath('/media', ownerId, assetId, '../../other.CR2')).toBe(
    `/media/upload/${ownerId}/${assetId.slice(0, 2)}/${assetId.slice(2, 4)}/${assetId}.cr2`,
  );
});

it('requires a new manifest version so older readers cannot silently ignore independent-original provenance', () => {
  const manifest = make();
  manifest.version = 1;
  expect(() => readBuddyReferenceOriginals(manifest)).toThrow('Buddy reference original');
});

it.each(['legacy-owned', 'metadata-only', 'unversioned-reference', 'new-format', 'future-format'] as const)(
  'checks %s content through authenticated manifest reading and prepared offline recovery',
  async (kind) => {
    const manifest = make();
    if (kind === 'future-format') Object.assign(manifest, { version: 3 });
    else if (kind !== 'new-format') manifest.version = 1;
    if (kind === 'legacy-owned' || kind === 'metadata-only') delete manifest.referenceOriginals;
    if (kind === 'metadata-only') manifest.library.assets[assetId].files[0].path = sourcePath;
    const ring = createBuddyKeyring(randomUUID());
    Object.assign(manifest, { vaultId: ring.vaultId, snapshotId: randomUUID(), sequence: 1, previous: null });
    manifest.library.version = 2;
    const bytes = Buffer.from(JSON.stringify(manifest));
    const key = Buffer.from(ring.keys[ring.current], 'base64url');
    const id = buddyObjectId(key, ring.vaultId, bytes);
    const encrypted = encryptBuddyBlock(key, { vaultId: ring.vaultId, id, keyVersion: ring.current }, bytes);
    const reader = new BuddyBackupReader(
      ring,
      {
        signature: '',
        snapshot: {
          version: 1,
          vaultId: ring.vaultId,
          id: manifest.snapshotId,
          sequence: 1,
          previous: null,
          createdAt: new Date().toISOString(),
          retainUntil: new Date().toISOString(),
          keyVersion: ring.current,
          manifest: [id],
          objects: [BuddyVault.receipt(id, encrypted)],
        },
      },
      () => Promise.resolve(encrypted),
    );
    const root = await mkdtemp(join(tmpdir(), 'buddy-reference-manifest-'));
    try {
      const directory = join(root, 'recovery', manifest.snapshotId);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, 'prepared.json'),
        JSON.stringify({
          version: 1,
          scope: 'server',
          mode: 'replace',
          manifest,
          files: manifest.library.assets[assetId].files,
        }),
      );
      if (kind === 'legacy-owned' || kind === 'new-format') {
        await expect(reader.manifest()).resolves.toMatchObject({ version: manifest.version });
        await expect(readBuddyRecovery(root, manifest.snapshotId)).resolves.toMatchObject({ version: 1 });
        if (kind === 'new-format') {
          await writeFile(
            join(directory, 'prepared.json'),
            JSON.stringify({ version: 1, scope: 'server', mode: 'replace', manifest, files: [] }),
          );
          await expect(readBuddyRecovery(root, manifest.snapshotId)).rejects.toThrow('Invalid prepared recovery');
        }
      } else {
        await expect(reader.manifest()).rejects.toThrow();
        await expect(readBuddyRecovery(root, manifest.snapshotId)).rejects.toThrow();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
