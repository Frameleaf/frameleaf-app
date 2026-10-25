import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serverVersion } from 'src/constants.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { BuddyBackupRestoreService } from 'src/services/buddy-backup-restore.service.js';
import * as diskUsage from 'src/utils/disk-usage.js';

vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

it.each(['replace', 'admin-replace', 'keep-matching', 'keep-newer', 'keep-pair-newer', 'missing-proof'] as const)(
  'freezes independent-original adoption at submission: %s',
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), 'buddy-reference-submit-'));
    const ownerId = randomUUID();
    const actorId = mode === 'admin-replace' ? randomUUID() : ownerId;
    const assetId = randomUUID();
    const sourcePath = `frameleaf-source://${randomUUID()}/${'a'.repeat(64)}`;
    const incoming = 'b'.repeat(64);
    const before: any = {
      ownerId,
      originalPath: sourcePath,
      checksum: createHash('sha1').update(sourcePath).digest('hex'),
      checksumAlgorithm: 'sha1-path',
      isExternal: true,
      sourceEpoch: '0',
      sourceReference:
        mode === 'missing-proof'
          ? null
          : {
              resourceId: randomUUID(),
              version: 'c'.repeat(64),
              sha256: mode.includes('newer') ? 'd'.repeat(64) : incoming,
            },
    };
    const auth = {
      user: { id: actorId, isAdmin: mode === 'admin-replace' },
      session: { id: randomUUID(), hasElevatedPermission: true },
    };
    const manifest: any = {
      version: 2,
      snapshotId: randomUUID(),
      frameleafVersion: serverVersion.toString(),
      library: {
        version: 3,
        profiles: {},
        albums: {},
        people: {},
        assets: {
          [assetId]: {
            owner: ownerId,
            type: 'IMAGE',
            originalFileName: 'original.jpg',
            fileCreatedAt: '2026-01-01',
            fileModifiedAt: '2026-01-01',
            localDateTime: '2026-01-01',
            files: [{ role: 'original', path: '/old/upload/original.jpg', sha256: incoming, size: 5 }],
          },
        },
      },
      referenceOriginals: { [assetId]: { version: 1 } },
    };
    const identities: any = { [assetId]: before };
    const ids = [assetId];
    if (mode === 'keep-pair-newer') {
      const motionId = randomUUID();
      ids.push(motionId);
      const motionPath = `frameleaf-source://${randomUUID()}/${'e'.repeat(64)}`;
      identities[motionId] = {
        ...before,
        originalPath: motionPath,
        checksum: createHash('sha1').update(motionPath).digest('hex'),
        sourceReference: { ...before.sourceReference, resourceId: randomUUID(), sha256: incoming },
      };
      manifest.library.assets[motionId] = {
        ...manifest.library.assets[assetId],
        type: 'VIDEO',
        originalFileName: 'motion.mov',
      };
      manifest.referenceOriginals[motionId] = { version: 1 };
      manifest.assetLinks = { [assetId]: { livePhotoVideoId: motionId } };
    }
    if (mode.includes('newer'))
      for (const asset of Object.values(manifest.library.assets) as any[]) asset.files[0].size = 2 * 1024 ** 3;
    const create = vi.fn().mockResolvedValue({ created: { id: randomUUID() } });
    const service = Object.assign(Object.create(BuddyBackupRestoreService.prototype), {
      auth: () => Promise.resolve(auth),
      open: () => Promise.resolve({ manifest, reader: { ring: { vaultId: randomUUID() } } }),
      selection: () => Promise.resolve(ids),
      index: { getOwnerRestoreIdentities: () => Promise.resolve(identities) },
      operations: { createExclusive: create },
      tick: vi.fn(),
      missingOwners: () => Promise.resolve(undefined),
    });
    const capacity = vi
      .spyOn(diskUsage, 'getDiskUsage')
      .mockResolvedValue({ available: 1024 ** 3 + 1024, free: 1024 ** 3 + 1024, total: 1024 ** 4 });
    const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(directory);
    try {
      const request = {
        snapshotId: manifest.snapshotId,
        scope: 'asset',
        assetIds: ids,
        mode: mode.endsWith('replace') ? 'replace' : 'keep',
        confirm: true,
      };
      if (mode === 'missing-proof') {
        await expect(service.prepare(auth, request, false)).rejects.toThrow('source identity unavailable');
        expect(create).not.toHaveBeenCalled();
      } else {
        const response = await service.prepare(auth, request, mode === 'admin-replace');
        const submitted = create.mock.calls[0][0].snapshot;
        expect(submitted.owner.ownerId).toBe(actorId);
        if (mode.includes('newer')) {
          expect(submitted.referenceAdoptions).toBeUndefined();
          expect(response.bytes).toBe(0);
        } else {
          expect(submitted.referenceAdoptions).toBeDefined();
          expect(submitted.referenceAdoptions[assetId]).toMatchObject({
            assetId,
            ownerId,
            physicalFileId: expect.any(String),
            source: { sourcePath, sourceEpoch: { reference: before.sourceReference } },
            file: { sha256: incoming, size: 5 },
          });
          expect(submitted.referenceAdoptions[assetId].file.path).toContain(`/upload/${ownerId}/`);
          before.sourceReference.version = 'e'.repeat(64);
          expect(submitted.referenceAdoptions[assetId].source.sourceEpoch.reference.version).toBe('c'.repeat(64));
        }
      }
    } finally {
      capacity.mockRestore();
      media.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
