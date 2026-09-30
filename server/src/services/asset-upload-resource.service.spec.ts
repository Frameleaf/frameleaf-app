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
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { writeAssetUploadPart } from 'src/utils/asset-upload-resource.js';

describe('resumable asset byte commit boundaries', () => {
  let folder: string;
  beforeEach(async () => {
    folder = await mkdtemp(join(tmpdir(), 'asset-upload-boundary-'));
  });
  afterEach(async () => {
    await rm(folder, { recursive: true, force: true });
  });

  const setup = () => {
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
    );
    vi.spyOn(service as unknown as { owner: (auth: AuthDto) => Promise<string> }, 'owner').mockResolvedValue('owner');
    vi.spyOn(service as unknown as { folder: (id: string) => string }, 'folder').mockReturnValue(folder);
    return {
      service,
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

  it('fails closed without creating scratch when Redis admission is unavailable', async () => {
    const harness = setup();
    harness.rateLimits.claimUploadStream.mockRejectedValue(new Error('Redis unavailable'));
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
});
