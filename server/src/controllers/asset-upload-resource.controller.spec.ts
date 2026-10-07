import { ConflictException } from '@nestjs/common';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetUploadResourceController } from 'src/controllers/asset-upload-resource.controller.js';

describe('upload resource protocol headers over HTTP', () => {
  it('advertises current capacity on OPTIONS and the persisted ceiling on 104, POST and HEAD', async () => {
    const headers = new Map<string, string>();
    const resource = {
      maxSize: 8,
      maxAppendSize: 8,
      state: 'receiving',
      offset: 0,
      expectedSize: 4,
    } as AssetUploadResource;
    const res = {
      setHeader: (name: string, value: unknown) => headers.set(name, String(value)),
      getHeader: (name: string) => headers.get(name),
      status: () => res,
      end: vi.fn(),
      writeInformation: vi.fn(),
    };
    const controller = new AssetUploadResourceController({
      limits: () => Promise.resolve({ maxSize: 10, maxAppendSize: 10, maxAge: 86_400, maxActive: 4 }),
      head: () => Promise.resolve(resource),
      create: (_auth: unknown, _headers: unknown, _input: unknown, resume: (row: AssetUploadResource) => void) => {
        resume(resource);
        return Promise.resolve({ resource });
      },
    } as never);
    await controller.getAssetUploadResourceLimits(res as never);
    expect(headers.get('Upload-Limit')).toBe('max-size=10, max-append-size=10, max-age=86400, min-size=1');
    await controller.createAssetUploadResource(
      {} as never,
      { rawHeaders: [], headers: {}, originalUrl: '/uploads' } as never,
      res as never,
    );
    const storedLimit = 'max-size=8, max-append-size=8, max-age=86400, min-size=1';
    expect(res.writeInformation).toHaveBeenCalledWith(104, expect.objectContaining({ 'Upload-Limit': storedLimit }));
    expect(headers.get('Upload-Limit')).toBe(storedLimit);
    await controller.getAssetUploadResourceOffset({} as never, { id: 'test' }, res as never);
    expect(headers.get('Upload-Limit')).toBe(storedLimit);
  });

  it('reports completion only after ingestion and includes durable offset on a mismatching append', async () => {
    let resource = {
      state: 'finalizing',
      offset: 8,
      expectedSize: 8,
      ingested: false,
      maxSize: 8,
      maxAppendSize: 8,
    } as AssetUploadResource;
    const controller = new AssetUploadResourceController({
      head: () => Promise.resolve(resource),
      append: () =>
        Promise.reject(
          new ConflictException({
            message: 'Upload offset does not match',
            expectedOffset: 8,
            providedOffset: 0,
            type: 'https://iana.org/assignments/http-problem-types#mismatching-upload-offset',
          }),
        ),
    } as never);
    const app = express();
    app.head('/uploads/test', (_req, res) => {
      void controller.getAssetUploadResourceOffset({} as never, { id: 'test' }, res);
    });
    app.patch('/uploads/test', (req, res) => {
      void controller.appendAssetUploadResource({} as never, { id: 'test' }, req, res).catch((error: unknown) => {
        if (error instanceof ConflictException) {
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
    try {
      for (const state of ['finalizing', 'verified', 'published'] as const) {
        resource = { ...resource, state };
        const pending = await fetch(url, { method: 'HEAD' });
        expect(pending.headers.get('Upload-Complete')).toBe('?0');
        expect(pending.headers.get('Upload-Offset')).toBe('8');
      }
      resource = { ...resource, ingested: true };
      expect((await fetch(url, { method: 'HEAD' })).headers.get('Upload-Complete')).toBe('?1');
      const conflict = await fetch(url, { method: 'PATCH' });
      expect(conflict.status).toBe(409);
      expect(conflict.headers.get('Upload-Offset')).toBe('8');
      expect(conflict.headers.get('Upload-Complete')).toBe('?0');
      expect(conflict.headers.get('Cache-Control')).toContain('no-store');
      expect(await conflict.json()).toMatchObject({ expectedOffset: 8, providedOffset: 0 });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
