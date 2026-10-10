import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { PhotographyWorkspaceController } from 'src/controllers/photography-workspace.controller.js';
import { CacheControl } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { factory, newUuid } from 'test/small.factory.js';

it('retains private no-store through the actual Express/shared-file send path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-logo-'));
  try {
    const file = join(directory, 'logo.webp');
    await writeFile(file, Buffer.from('test thumbnail bytes'));
    const auth = factory.auth({ session: {} });
    const id = newUuid();
    const service = {
      logoThumbnail: vi.fn().mockResolvedValue(
        new ImmichFileResponse({
          path: file,
          contentType: 'image/webp',
          fileName: 'studio-logo',
          cacheControl: CacheControl.None,
        }),
      ),
    };
    const controller = new PhotographyWorkspaceController(
      service as unknown as PhotographyWorkspaceService,
      {} as LoggingRepository,
    );
    const app = express();
    app.get('/logo', (_req, res, next) => {
      void controller.getPhotographyLogoThumbnail(auth, { id }, res, next).catch(next);
    });
    const response = await request(app).get('/logo?size=original&edited=true').expect(200);
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['content-type']).toMatch(/^image\/webp/);
    expect(response.headers['content-disposition']).toContain('studio-logo');
    expect(service.logoThumbnail).toHaveBeenCalledExactlyOnceWith(auth, id, 'original');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
