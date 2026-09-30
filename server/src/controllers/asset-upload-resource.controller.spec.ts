import { ConflictException } from '@nestjs/common';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AssetUploadResource } from 'src/repositories/asset-upload-resource.repository.js';
import { AssetUploadResourceController } from 'src/controllers/asset-upload-resource.controller.js';

describe('upload resource protocol headers over HTTP', () => {
  it('reports completion only after ingestion and includes durable offset on a mismatching append', async () => {
    let resource = { state: 'finalizing', offset: 8, expectedSize: 8, ingested: false } as AssetUploadResource;
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
