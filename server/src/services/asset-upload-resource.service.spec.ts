import { ConflictException, HttpException } from '@nestjs/common';
import express from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetUploadResourceController } from 'src/controllers/asset-upload-resource.controller.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { writeAssetUploadPart } from 'src/utils/asset-upload-resource.js';

describe('resumable asset byte commit boundaries', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(process.env.FL285_VOLUME_FOLDER ?? tmpdir(), 'asset-upload-boundary-'));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(folder, { recursive: true, force: true });
  });

  const setup = () => {
    vi.spyOn(StorageCore, 'getBaseFolder').mockReturnValue(folder);
    let locked = false;
    let row = {
      id: randomUUID(),
      ownerId: 'owner',
      state: 'receiving',
      offset: 0,
      expectedSize: 4,
      maxSize: 8,
      maxAppendSize: 8,
      expectedChecksum: createHash('sha256').update('abcd').digest(),
      metadata: { filename: 'test.jpg', fileCreatedAt: new Date(), fileModifiedAt: new Date() },
    } as AssetUploadResource;
    const inserts: unknown[] = [];
    const tx = {
      insertInto: () => ({
        values: (value: unknown) => ({
          execute: () => {
            inserts.push(value);
            return Promise.resolve();
          },
        }),
      }),
      updateTable: () => ({
        set: (value: Partial<AssetUploadResource>) => {
          const query = {
            where: () => query,
            returningAll: () => query,
            executeTakeFirstOrThrow: () => {
              row = { ...row, ...value };
              return Promise.resolve(row);
            },
          };
          return query;
        },
      }),
    };
    const uploads = {
      get: vi.fn(() => Promise.resolve(row)),
      locked: vi.fn(async (_id, _owner, callback) => {
        locked = true;
        try {
          return await callback(tx, row);
        } finally {
          locked = false;
        }
      }),
      parts: vi.fn(),
      lockedMany: vi.fn(),
      publishLivePhoto: vi.fn(),
      livePhotoPairIngested: vi.fn(() => Promise.resolve(false)),
      completeDuplicate: vi.fn(() => Promise.resolve(undefined)),
      claimIngestion: vi.fn(() => Promise.resolve(undefined)),
      publish: vi.fn(() => {
        row = { ...row, state: 'published', ingested: true };
        return Promise.resolve(row);
      }),
    };
    const media = {
      prepareUploadAsset: vi.fn(() => Promise.resolve({})),
      getUploadAssetIdByChecksum: vi.fn(() => Promise.resolve({ id: 'asset' })),
    };
    const storage = {
      checkDiskUsage: vi.fn().mockResolvedValue({ available: 1024 }),
      unlink: vi.fn((path: string) => rm(path, { force: true })),
      utimes: vi.fn(() => {
        expect(locked).toBe(false);
        return Promise.resolve();
      }),
    };
    let activeToken: string | undefined;
    const rateLimits = {
      claimUploadStream: vi.fn((_id: string, token: string) => {
        if (activeToken) {
          return Promise.resolve(false);
        }
        activeToken = token;
        return Promise.resolve(true);
      }),
      isUploadStreamCurrent: vi.fn((_id: string, token: string) => Promise.resolve(activeToken === token)),
      releaseUploadStream: vi.fn((_id: string, token: string) => {
        if (activeToken === token) {
          activeToken = undefined;
        }
        return Promise.resolve();
      }),
    };
    const physical = {
      deleteUnreferencedPath: vi.fn(async (path: string, remove: () => Promise<void>) => {
        if (path === row.finalPath && row.state === 'published') {
          return { deleted: false, references: 1 };
        }
        await remove();
        return { deleted: true, references: 0 };
      }),
    };
    const service = new AssetUploadResourceService(
      uploads as never,
      media as never,
      {} as never,
      {} as never,
      storage as never,
      physical as never,
      { warn: vi.fn() } as never,
      rateLimits as never,
      { claims: vi.fn().mockResolvedValue([]), recordDevice: vi.fn() } as never,
    );
    vi.spyOn(service as unknown as { owner: (auth: AuthDto) => Promise<string> }, 'owner').mockResolvedValue('owner');
    vi.spyOn(service as unknown as { folder: (id: string) => string }, 'folder').mockReturnValue(folder);
    return {
      service,
      media,
      uploads,
      inserts,
      storage,
      physical,
      rateLimits,
      isLocked: () => locked,
      row: () => row,
      mutate: (value: Partial<AssetUploadResource>) => {
        row = { ...row, ...value };
      },
    };
  };
  const auth = { user: { id: 'owner' } } as AuthDto;

  it.runIf(process.env.FL285_VOLUME_FOLDER)(
    'retains the acknowledged prefix when a real constrained volume runs out of space',
    async () => {
      const harness = setup();
      harness.mutate({ expectedSize: null, maxSize: 64 * 2 ** 20, maxAppendSize: 64 * 2 ** 20 });
      const storage = new StorageRepository({ setContext: vi.fn() } as never);
      const disk = await storage.checkDiskUsage(folder);
      expect(disk.available).toBeLessThanOrEqual(32 * 2 ** 20);
      expect(disk.available).toBeGreaterThan(2 ** 20);
      harness.storage.checkDiskUsage.mockImplementation(() => storage.checkDiskUsage(folder));
      expect((await harness.service.limits()).maxSize).toBe(Math.floor(disk.available / 2));
      await harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('ab')]), 0, false);
      const files = await readdir(folder);
      await expect(
        harness.service['receive'](
          auth,
          harness.row().id,
          Readable.from(
            (function* () {
              const chunk = Buffer.alloc(2 ** 20);
              for (let index = 0; index < 64; index++) yield chunk;
            })(),
          ),
          2,
          false,
        ),
      ).rejects.toMatchObject({ status: 507 });
      expect(harness.row().offset).toBe(2);
      expect(harness.inserts).toHaveLength(1);
      expect(await readdir(folder)).toEqual(files);
      await harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('cd')]), 2, false);
      expect(harness.row().offset).toBe(4);
    },
  );

  it('resumes persisted parts after service replacement and a temporary storage refusal without publishing twice', async () => {
    const harness = setup();
    harness.uploads.parts.mockImplementation(() => Promise.resolve(harness.inserts));
    await harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('ab')]), 0, false);
    await harness.service.onShutdown();
    const replacement = new AssetUploadResourceService(
      harness.uploads as never,
      harness.media as never,
      {} as never,
      {} as never,
      harness.storage as never,
      harness.physical as never,
      { warn: vi.fn() } as never,
      harness.rateLimits as never,
      {} as never,
    );
    vi.spyOn(replacement as unknown as { owner: (auth: AuthDto) => Promise<string> }, 'owner').mockResolvedValue(
      'owner',
    );
    vi.spyOn(replacement as unknown as { folder: (id: string) => string }, 'folder').mockReturnValue(folder);
    harness.storage.checkDiskUsage.mockResolvedValue({ available: 5 });
    const append = {
      'upload-draft-interop-version': '9',
      'content-type': 'application/partial-upload',
      'upload-offset': '2',
      'upload-complete': '?1',
    };
    await expect(
      replacement.append(auth, harness.row().id, append, Readable.from([Buffer.from('cd')])),
    ).rejects.toMatchObject({ status: 507 });
    expect((await replacement.head(auth, harness.row().id)).offset).toBe(2);
    expect(harness.inserts).toHaveLength(1);
    // The replacement advertises a smaller ceiling for NEW resources; the persisted resource still completes.
    harness.storage.checkDiskUsage.mockResolvedValue({ available: 6 });
    expect((await replacement.limits()).maxSize).toBe(3);
    const outcome = await replacement.append(auth, harness.row().id, append, Readable.from([Buffer.from('cd')]));
    expect(outcome.resource).toMatchObject({ offset: 4, state: 'published', ingested: true, maxSize: 8 });
    expect(outcome.resource.verifiedChecksum).toEqual(createHash('sha256').update('abcd').digest());
    await replacement.append(auth, harness.row().id, { ...append, 'upload-offset': '4' }, Readable.from([]));
    expect(harness.uploads.publish).toHaveBeenCalledOnce();
    expect(harness.inserts).toHaveLength(2);
  });

  it('retries lost final responses through the real empty PATCH wire without creating another asset', async () => {
    const harness = setup();
    harness.mutate({
      state: 'published',
      offset: 4,
      resultAssetId: 'asset',
      resultStatus: 'created',
      ingested: false,
      verifiedChecksum: createHash('sha256').update('abcd').digest(),
    });
    const controller = new AssetUploadResourceController(harness.service);
    const app = express();
    app.patch('/uploads/test', (req, res) => {
      void controller.appendAssetUploadResource(auth, { id: harness.row().id }, req, res).catch((error: unknown) => {
        if (error instanceof HttpException) {
          res.status(error.getStatus()).json(error.getResponse());
        } else {
          res.status(500).end();
        }
      });
    });
    const server = createServer(app);
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/uploads/test`;
    const request = {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/partial-upload',
        'Upload-Draft-Interop-Version': '9',
        'Upload-Complete': '?1',
        'Upload-Offset': '4',
      },
    };
    try {
      const pending = await fetch(url, request);
      expect(pending.status).toBe(202);
      expect(pending.headers.get('Upload-Complete')).toBe('?0');
      expect(pending.headers.get('Upload-Offset')).toBe('4');
      harness.mutate({ ingested: true });
      const complete = await fetch(url, request);
      expect(complete.status).toBe(200);
      expect(complete.headers.get('Upload-Complete')).toBe('?1');
      expect(await complete.json()).toEqual({
        id: 'asset',
        status: 'created',
        sha256: createHash('sha256').update('abcd').digest('hex'),
      });
      expect((await fetch(url, { ...request, body: 'x' })).status).toBe(413);
      expect(harness.uploads.publish).not.toHaveBeenCalled();
      expect(harness.inserts).toHaveLength(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('allows only one simultaneous real byte stream per resource and releases it after failure', async () => {
    const harness = setup();
    const { promise: gate, resolve: resume } = Promise.withResolvers<void>();
    const { promise: started, resolve: entered } = Promise.withResolvers<void>();
    const first = harness.service['receive'](
      auth,
      harness.row().id,
      Readable.from(
        (async function* () {
          entered();
          await gate;
          yield Buffer.from('ab');
        })(),
      ),
      0,
      false,
    );
    await started;
    await expect(
      harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('cd')]), 0, false),
    ).rejects.toThrow('active request');
    expect(await readdir(folder)).toHaveLength(1);
    resume();
    await first;
    await expect(
      harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('cd')]), 2, false),
    ).resolves.toMatchObject({ resource: { offset: 4 } });
    expect(harness.rateLimits.releaseUploadStream).toHaveBeenCalledTimes(2);
  });

  it('fails closed without creating scratch when PostgreSQL admission is unavailable', async () => {
    const harness = setup();
    harness.rateLimits.claimUploadStream.mockRejectedValue(new Error('database unavailable'));
    await expect(
      harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('ab')]), 0, false),
    ).rejects.toThrow('admission unavailable');
    expect(await readdir(folder)).toHaveLength(0);
    expect(harness.inserts).toHaveLength(0);
  });

  it('never acknowledges a fsynced attempt whose admission token became stale', async () => {
    const harness = setup();
    harness.rateLimits.isUploadStreamCurrent.mockResolvedValue(false);
    await expect(
      harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('ab')]), 0, false),
    ).rejects.toThrow('admission expired');
    expect(harness.inserts).toHaveLength(0);
    expect(harness.row().offset).toBe(0);
    expect(harness.rateLimits.releaseUploadStream).toHaveBeenCalledOnce();
  });

  it.each(['finalizing', 'verified', 'published'] as const)(
    'retries the same %s finalization with an exact-offset empty completion',
    async (state) => {
      const harness = setup();
      harness.mutate({ state, offset: 4 });
      const pending = { resource: harness.row() };
      const result = vi
        .spyOn(harness.service as unknown as { resolveResult: AssetUploadResourceService['result'] }, 'resolveResult')
        .mockResolvedValue(pending);
      expect(await harness.service['receive'](auth, harness.row().id, Readable.from([]), 4, true)).toEqual(pending);
      expect(result).toHaveBeenCalledExactlyOnceWith(auth, harness.row().id, expect.any(Function));
      expect(harness.uploads.locked).not.toHaveBeenCalled();
      expect(harness.inserts).toHaveLength(0);
    },
  );

  it('never discards additional bytes during a pending completion retry', async () => {
    const harness = setup();
    harness.mutate({ state: 'verified', offset: 4 });
    const result = vi.spyOn(
      harness.service as unknown as { resolveResult: AssetUploadResourceService['result'] },
      'resolveResult',
    );
    await expect(
      harness.service['receive'](auth, harness.row().id, Readable.from([Buffer.from('x')]), 4, true),
    ).rejects.toThrow('Upload part exceeds');
    expect(result).not.toHaveBeenCalled();
    expect(harness.inserts).toHaveLength(0);
  });

  it('streams and fsyncs an interrupted prefix before the short manifest transaction', async () => {
    const harness = setup();
    const input = Readable.from(
      (function* () {
        expect(harness.isLocked()).toBe(false);
        yield Buffer.from('ab');
        expect(harness.isLocked()).toBe(false);
        throw new Error('connection lost');
      })(),
    );
    const outcome = await harness.service['receive'](auth, harness.row().id, input, 0, false);
    expect(outcome.resource.offset).toBe(2);
    expect(harness.inserts).toHaveLength(1);
  });

  it('refuses a racing offset advance after streaming without acknowledging its scratch', async () => {
    const harness = setup();
    const input = Readable.from(
      (function* () {
        yield Buffer.from('ab');
        harness.mutate({ offset: 1 });
      })(),
    );
    await expect(harness.service['receive'](auth, harness.row().id, input, 0, false)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(harness.inserts).toHaveLength(0);
    expect(harness.row().offset).toBe(1);
    expect(await readdir(folder)).toHaveLength(1); // private, unacknowledged scratch remains sweepable
  });

  it('duplicate recovery waits for original ingestion without claiming or repeating sideeffects', async () => {
    const harness = setup();
    harness.mutate({ state: 'published', ingested: false, resultStatus: 'duplicate' });
    await harness.service['ingest'](auth, harness.row());
    expect(harness.uploads.completeDuplicate).toHaveBeenCalledWith(harness.row().id, auth.user.id);
    expect(harness.uploads.claimIngestion).not.toHaveBeenCalled();
  });

  it('refuses completed results when a current filesystem reference check fails', async () => {
    const harness = setup();
    const part = await writeAssetUploadPart(folder, Readable.from([Buffer.from('abcd')]), 4);
    harness.mutate({ state: 'published', ingested: true, offset: 4 });
    harness.physical.deleteUnreferencedPath.mockRejectedValueOnce(new Error('reference database unavailable'));
    await expect(harness.service['finalize'](auth, harness.row().id, () => Promise.resolve())).rejects.toThrow(
      'reference database unavailable',
    );
    expect(await readdir(folder)).toEqual([part.path.split('/').at(-1)]);
    expect(harness.storage.unlink).not.toHaveBeenCalled();
    expect(harness.row().offset).toBe(4);
  });

  it('refuses cleanup after the admission token expires without removing any private file', async () => {
    const harness = setup();
    const part = await writeAssetUploadPart(folder, Readable.from([Buffer.from('abcd')]), 4);
    harness.mutate({ state: 'published', ingested: true, offset: 4 });
    await expect(
      harness.service['finalize'](auth, harness.row().id, () => Promise.reject(new ConflictException('expired token'))),
    ).rejects.toThrow('expired token');
    expect(await readdir(folder)).toEqual([part.path.split('/').at(-1)]);
    expect(harness.physical.deleteUnreferencedPath).not.toHaveBeenCalled();
  });

  it('assembles and hashes acknowledged parts and applies timestamps outside the pool', async () => {
    const harness = setup();
    const part = await writeAssetUploadPart(folder, Readable.from([Buffer.from('abcd')]), 4);
    harness.mutate({ state: 'finalizing', offset: 4 });
    harness.uploads.parts.mockImplementation(() => {
      expect(harness.isLocked()).toBe(false);
      return Promise.resolve([{ path: part.path, size: 4, offset: 0 }]);
    });
    const result = await harness.service['finalize'](auth, harness.row().id, () => Promise.resolve());
    expect(result.state).toBe('published');
    expect(harness.storage.utimes).toHaveBeenCalledOnce();
    expect(await readdir(folder)).toEqual([harness.row().finalPath!.split('/').at(-1)]);
    expect(harness.row().verifiedChecksum).toEqual(createHash('sha256').update('abcd').digest());
  });
  it('verifies a declared Live Photo half without preparing or publishing an independent asset', async () => {
    const harness = setup();
    const part = await writeAssetUploadPart(folder, Readable.from([Buffer.from('abcd')]), 4);
    harness.mutate({
      state: 'pair-finalizing',
      offset: 4,
      metadata: { ...harness.row().metadata, publication: 'live-photo' } as AssetUploadResource['metadata'],
    });
    harness.uploads.parts.mockResolvedValue([{ path: part.path, size: 4, offset: 0 }]);
    const result = await harness.service['finalize'](auth, harness.row().id, () => Promise.resolve());
    expect(result.state).toBe('pair-verified');
    expect(result.verifiedChecksum).toEqual(createHash('sha256').update('abcd').digest());
    expect(harness.uploads.publish).not.toHaveBeenCalled();
  });
  it('appends declared pair bytes only through held states and hashes them without publication', async () => {
    const harness = setup();
    harness.mutate({ state: 'pair-receiving', metadata: { ...harness.row().metadata, publication: 'live-photo' } });
    harness.uploads.parts.mockImplementation(() => Promise.resolve(harness.inserts));
    const outcome = await harness.service['receive'](
      auth,
      harness.row().id,
      Readable.from([Buffer.from('abcd')]),
      0,
      true,
      4,
    );
    expect(outcome.resource.state).toBe('pair-verified');
    expect(outcome.resource.verifiedChecksum).toEqual(createHash('sha256').update('abcd').digest());
    expect(outcome.result).toBeUndefined();
    expect(harness.uploads.publish).not.toHaveBeenCalled();
    expect(harness.uploads.claimIngestion).not.toHaveBeenCalled();
  });

  it('standalone result leaves a held verified half private and does not invoke publication or ingestion', async () => {
    const harness = setup();
    harness.mutate({
      state: 'pair-verified',
      offset: 4,
      expectedSize: 4,
      verifiedChecksum: harness.row().expectedChecksum,
      metadata: { ...harness.row().metadata, publication: 'live-photo' },
    });
    const outcome = await harness.service.result(auth, harness.row().id);
    expect(outcome.resource.state).toBe('pair-verified');
    expect(outcome.result).toBeUndefined();
    expect(harness.uploads.publish).not.toHaveBeenCalled();
    expect(harness.uploads.claimIngestion).not.toHaveBeenCalled();
  });

  it('refuses same-resource pair commit before acquiring an upload admission', async () => {
    const harness = setup();
    await expect(
      harness.service.commitLivePhoto(auth, {
        stillResourceId: harness.row().id,
        videoResourceId: harness.row().id,
      }),
    ).rejects.toThrow('Distinct resources');
    expect(harness.rateLimits.claimUploadStream).not.toHaveBeenCalled();
  });

  it('refuses undeclared resources before finalize can publish either half', async () => {
    const harness = setup();
    const finalize = vi.spyOn(harness.service as never, 'finalize' as never);
    // Per-resource admissions are independent in production; both claims succeed in this control-flow test.
    harness.rateLimits.claimUploadStream.mockResolvedValue(true);
    await expect(
      harness.service.commitLivePhoto(auth, {
        stillResourceId: harness.row().id,
        videoResourceId: randomUUID(),
      }),
    ).rejects.toThrow('Both resources must declare Live Photo');
    expect(finalize).not.toHaveBeenCalled();
    expect(harness.uploads.publish).not.toHaveBeenCalled();
    expect(harness.rateLimits.releaseUploadStream).toHaveBeenCalledTimes(2);
  });
  it('withholds HEAD and result completion for an ingested half whose sibling is still pending', async () => {
    const harness = setup();
    harness.mutate({
      state: 'published',
      ingested: true,
      metadata: { ...harness.row().metadata, publication: 'live-photo' },
    });
    expect((await harness.service.head(auth, harness.row().id)).ingested).toBe(false);
    const outcome = await harness.service.result(auth, harness.row().id);
    expect(outcome.result).toBeUndefined();
    expect(outcome.resource.ingested).toBe(false);
    harness.uploads.livePhotoPairIngested.mockResolvedValue(true);
    expect((await harness.service.head(auth, harness.row().id)).ingested).toBe(true);
  });
  it('refuses pair publication after either shared admission expires', async () => {
    const harness = setup();
    harness.mutate({
      state: 'pair-verified',
      finalPath: '/private/test.jpg',
      verifiedChecksum: harness.row().expectedChecksum,
      legacyChecksum: Buffer.alloc(20),
      metadata: { ...harness.row().metadata, publication: 'live-photo' },
    });
    harness.rateLimits.claimUploadStream.mockResolvedValue(true);
    harness.rateLimits.isUploadStreamCurrent.mockResolvedValue(false);
    await expect(
      harness.service.commitLivePhoto(auth, {
        stillResourceId: harness.row().id,
        videoResourceId: randomUUID(),
      }),
    ).rejects.toThrow('Upload admission expired');
    expect(harness.uploads.publishLivePhoto).not.toHaveBeenCalled();
    expect(harness.uploads.lockedMany).not.toHaveBeenCalled();
    expect(harness.rateLimits.releaseUploadStream).toHaveBeenCalledTimes(2);
  });
});

describe('Live Photo required postcommit ingestion', () => {
  it('withholds success on one-half ingestion failure and retries only the unfinished half', async () => {
    const ownerId = randomUUID();
    const auth = { user: { id: ownerId } } as AuthDto;
    const rows = ['still.jpg', 'motion.mov'].map((filename) => ({
      id: randomUUID(),
      ownerId,
      state: 'pair-verified',
      offset: 4,
      ingested: false,
      resultAssetId: randomUUID(),
      resultStatus: 'created',
      finalPath: `/private/${filename}`,
      expectedChecksum: createHash('sha256').update(filename).digest(),
      verifiedChecksum: createHash('sha256').update(filename).digest(),
      legacyChecksum: Buffer.alloc(20),
      metadata: { filename, fileCreatedAt: new Date(), fileModifiedAt: new Date(), publication: 'live-photo' },
    })) as AssetUploadResource[];
    const rowFor = (id: string) => rows.find((row) => row.id === id)!;
    const uploads = {
      get: vi.fn((id: string) => Promise.resolve(rowFor(id))),
      lockedMany: vi.fn((_ids, _owner, callback) => callback({}, rows)),
      publishLivePhoto: vi.fn(() => {
        for (const row of rows) {
          row.state = 'published';
        }
        return Promise.resolve({ still: rows[0], video: rows[1] });
      }),
      claimIngestion: vi.fn((id: string) => Promise.resolve(rowFor(id))),
      checkIngestion: vi.fn(() => Promise.resolve()),
      completeIngestion: vi.fn((id: string) => {
        rowFor(id).ingested = true;
        return Promise.resolve();
      }),
      livePhotoPairIngested: vi.fn(() => Promise.resolve(rows.every((row) => row.ingested))),
    };
    const media = {
      prepareUploadAsset: vi.fn(() => Promise.resolve({})),
      finishUploadAsset: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('still ingestion failed'))
        .mockResolvedValue(undefined),
      getUploadAssetIdByChecksum: vi.fn((_auth, checksum: string) =>
        Promise.resolve({ id: rows.find((row) => row.verifiedChecksum!.toString('hex') === checksum)!.resultAssetId }),
      ),
    };
    const rateLimits = {
      claimUploadStream: vi.fn(() => Promise.resolve(true)),
      isUploadStreamCurrent: vi.fn(() => Promise.resolve(true)),
      releaseUploadStream: vi.fn(() => Promise.resolve()),
    };
    const service = new AssetUploadResourceService(
      uploads as never,
      media as never,
      { getById: vi.fn((id) => Promise.resolve({ id })) } as never,
      {} as never,
      {} as never,
      {} as never,
      { warn: vi.fn() } as never,
      rateLimits as never,
      { claims: vi.fn().mockResolvedValue([]), recordDevice: vi.fn() } as never,
    );
    vi.spyOn(service as unknown as { owner: () => Promise<string> }, 'owner').mockResolvedValue(ownerId);
    vi.spyOn(
      service as unknown as { finalize: (_auth: AuthDto, id: string) => Promise<AssetUploadResource> },
      'finalize',
    ).mockImplementation((_auth, id) => Promise.resolve(rowFor(id)));
    const dto = { stillResourceId: rows[0].id, videoResourceId: rows[1].id };
    await expect(service.commitLivePhoto(auth, dto)).rejects.toThrow('still ingestion failed');
    expect(rows.map((row) => row.ingested)).toEqual([false, true]);
    expect(uploads.completeIngestion).toHaveBeenCalledTimes(1);
    const result = await service.commitLivePhoto(auth, dto);
    expect(result).toEqual({
      still: { id: rows[0].resultAssetId, status: 'created', sha256: rows[0].verifiedChecksum!.toString('hex') },
      video: { id: rows[1].resultAssetId, status: 'created', sha256: rows[1].verifiedChecksum!.toString('hex') },
    });
    expect(media.finishUploadAsset).toHaveBeenCalledTimes(3);
    await expect(service.commitLivePhoto(auth, dto)).resolves.toEqual(result);
    expect(media.finishUploadAsset).toHaveBeenCalledTimes(3);
    expect(rateLimits.releaseUploadStream).toHaveBeenCalledTimes(6);
  });
});

describe('iCloud source identity on resumable uploads (FL-296)', () => {
  const ASSET = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
  const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';
  const setup = (claims: Array<{ id: string; holder: string }> = []) => {
    const identities = {
      claims: vi.fn().mockResolvedValue(claims.map((claim) => ({ ...claim, cplAssetRecordName: ASSET }))),
      recordDevice: vi.fn(),
      ownsDevice: vi.fn((_owner: string, key: string) => Promise.resolve(key !== 'stranger-key')),
    };
    const logger = { warn: vi.fn() };
    const service = new AssetUploadResourceService(
      ...(Array.from({ length: 6 }, () => ({})) as never as [never, never, never, never, never, never]),
      logger as never,
      {} as never,
      identities as never,
    );
    const internals = service as unknown as {
      refuseClaimedItem: (owner: string, source: unknown) => Promise<void>;
      recordSourceIdentity: (owner: string, row: unknown) => Promise<void>;
    };
    return { identities, internals, logger };
  };
  afterEach(() => vi.unstubAllEnvs());
  const source = (overrides: Record<string, unknown> = {}) => ({
    kind: 'icloud',
    cloudIdentifier: `${ASSET}:001:${MASTER}`,
    role: 'original',
    ...overrides,
  });

  it('refuses an upload of an item another path claimed, before any bytes, and lets the claim holder in', async () => {
    const claimId = randomUUID();
    const { internals } = setup([{ id: claimId, holder: 'icloud-sync:connection' }]);
    await expect(internals.refuseClaimedItem('owner', source())).rejects.toThrow(ConflictException);
    await expect(internals.refuseClaimedItem('owner', source())).rejects.toThrow('icloud_claimed');
    await expect(internals.refuseClaimedItem('owner', source({ claimId }))).resolves.toBeUndefined();
    await expect(internals.refuseClaimedItem('owner', undefined)).resolves.toBeUndefined();
    // the device named must be one of the caller's own
    await expect(internals.refuseClaimedItem('owner', source({ claimId, deviceKey: 'stranger-key' }))).rejects.toThrow(
      HttpException,
    );
  });

  it('never stops a backup over the identifier itself: it is only a hint', async () => {
    const { identities, internals, logger } = setup([{ id: randomUUID(), holder: 'icloud-sync:connection' }]);
    // an identifier the server cannot read
    await expect(
      internals.refuseClaimedItem('owner', source({ cloudIdentifier: 'nonsense' })),
    ).resolves.toBeUndefined();
    expect(identities.claims).not.toHaveBeenCalled();

    // a claim check that cannot be made
    identities.claims.mockRejectedValueOnce(new Error('relation "public.icloud_claim" does not exist'));
    await expect(internals.refuseClaimedItem('owner', source())).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledTimes(1);

    // identity matching switched off: hash only
    identities.claims.mockClear();
    vi.stubEnv('FRAMELEAF_ICLOUD_IDENTITY_MATCHING', 'false');
    await expect(internals.refuseClaimedItem('owner', source())).resolves.toBeUndefined();
    expect(identities.claims).not.toHaveBeenCalled();
    await internals.recordSourceIdentity('owner', {
      resultAssetId: 'asset-1',
      verifiedChecksum: Buffer.alloc(32, 7),
      metadata: { filename: 'IMG_0001.HEIC', fileCreatedAt: '2026-06-01T10:00:00.000Z', sourceIdentity: source() },
    });
    expect(identities.recordDevice).not.toHaveBeenCalled();
  });

  it('records the identity once the asset exists, with the claim to give back', async () => {
    const { identities, internals } = setup();
    const claimId = randomUUID();
    const sha256 = Buffer.alloc(32, 7);
    const row = {
      resultAssetId: 'asset-1',
      verifiedChecksum: sha256,
      metadata: {
        filename: 'IMG_0001.HEIC',
        fileCreatedAt: '2026-06-01T10:00:00.000Z',
        sourceIdentity: source({ claimId, deviceKey: randomUUID() }),
      },
    };
    await internals.recordSourceIdentity('owner', row);
    expect(identities.recordDevice).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: 'owner',
        assetId: 'asset-1',
        parsed: { cplAssetRecordName: ASSET, cplMasterRecordName: MASTER },
        role: 'original',
        editVersion: '',
        sha256,
        claimId,
        metadata: { originalFilename: 'IMG_0001.HEIC', creationDate: '2026-06-01T10:00:00.000Z' },
      }),
    );

    identities.recordDevice.mockClear();
    await internals.recordSourceIdentity('owner', { ...row, metadata: { ...row.metadata, sourceIdentity: undefined } });
    await internals.recordSourceIdentity('owner', { ...row, resultAssetId: null });
    expect(identities.recordDevice).not.toHaveBeenCalled();
  });
});
