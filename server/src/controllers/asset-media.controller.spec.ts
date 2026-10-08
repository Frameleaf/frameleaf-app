import { BadRequestException } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { AssetMediaController } from 'src/controllers/asset-media.controller.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetMetadataKey, CacheControl, Permission } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetRestorationService } from 'src/services/asset-restoration.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { factory } from 'test/small.factory.js';
import { ControllerContext, automock, controllerSetup, mockBaseService } from 'test/utils.js';

const makeUploadDto = (options?: { omit: string }): Record<string, any> => {
  const dto: Record<string, any> = {
    fileCreatedAt: new Date().toISOString(),
    fileModifiedAt: new Date().toISOString(),
    isFavorite: 'false',
  };

  const omit = options?.omit;
  if (omit) {
    delete dto[omit];
  }

  return dto;
};

describe(AssetMediaController.name, () => {
  let ctx: ControllerContext;
  const assetData = Buffer.from('123');
  const filename = 'example.png';
  const service = mockBaseService(AssetMediaService);
  // FL-115: no restoration is chosen, so every route serves the ordinary file.
  const restorationService = { getPlaybackChoice: vi.fn().mockResolvedValue({ file: null, revalidate: false }) };

  beforeAll(async () => {
    ctx = await controllerSetup(AssetMediaController, [
      { provide: LoggingRepository, useValue: automock(LoggingRepository, { strict: false }) },
      { provide: AssetMediaService, useValue: service },
      { provide: AssetRestorationService, useValue: restorationService },
    ]);
    return () => ctx.close();
  });

  beforeEach(() => {
    service.resetAllMocks();
    service.uploadAsset.mockResolvedValue({ status: AssetMediaStatus.DUPLICATE, id: factory.uuid() });

    ctx.reset();
  });

  describe('POST /assets', () => {
    it('should accept metadata', async () => {
      const mobileMetadata = { key: AssetMetadataKey.MobileApp, value: { iCloudId: '123' } };
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: JSON.stringify([mobileMetadata]),
        });

      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({ metadata: [mobileMetadata] }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );

      expect(status).toBe(200);
    });

    it('should handle invalid metadata json', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({
          ...makeUploadDto(),
          metadata: 'not-a-string-string',
        });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['metadata'], message: 'Invalid input: expected JSON string, received string' },
        ]),
      );
    });

    it('should require `fileCreatedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto({ omit: 'fileCreatedAt' }) });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should require `fileModifiedAt`', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field(makeUploadDto({ omit: 'fileModifiedAt' }));
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileModifiedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received undefined' },
        ]),
      );
    });

    it('should accept a non-UTC timezone offset', async () => {
      const fileCreatedAt = '2026-05-28T19:51:20.555+02:00';
      const { status } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt });

      expect(status).toBe(200);
      expect(service.uploadAsset).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          fileCreatedAt: new Date(fileCreatedAt),
        }),
        expect.objectContaining({ originalName: 'example.png' }),
        undefined,
      );
    });

    it('should reject a timezone-less datetime', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), fileCreatedAt: '2026-05-28T19:51:20.555706' });

      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['fileCreatedAt'], message: 'Invalid input: expected ISO 8601 datetime string, received string' },
        ]),
      );
    });

    it('should throw if `isFavorite` is not a boolean', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), isFavorite: 'not-a-boolean' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['isFavorite'], message: 'Invalid option: expected one of "true"|"false"' },
        ]),
      );
    });

    it('should throw if `visibility` is not an enum', async () => {
      const { status, body } = await request(ctx.getHttpServer())
        .post('/assets')
        .attach('assetData', assetData, filename)
        .field({ ...makeUploadDto(), visibility: 'not-an-option' });
      expect(status).toBe(400);
      expect(body).toEqual(
        factory.responses.validationError([
          { path: ['visibility'], message: expect.stringContaining('Invalid option: expected one of') },
        ]),
      );
    });

    describe('GET /assets/:id/original', () => {
      it('masks inaccessible originals at the file response boundary', async () => {
        service.downloadOriginal.mockRejectedValue(new BadRequestException('Not found or no asset.read access'));
        const { status, body } = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/original`);
        expect(status).toBe(404);
        expect(body.message).toBe('Not Found');
        expect(service.downloadOriginal).toHaveBeenCalledWith(
          undefined,
          expect.any(String),
          { edited: false },
          expect.any(AbortSignal),
        );
      });
    });

    describe('GET /assets/:id/edit-versions/:versionId/download (FL-39)', () => {
      it('requires download permission without a shared-link route', async () => {
        await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/edit-versions/${factory.uuid()}/download`);
        expect(ctx.authenticate).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: expect.objectContaining({ permission: Permission.AssetDownload, sharedLinkRoute: false }),
          }),
        );
      });

      it('requires a valid version id', async () => {
        const { status, body } = await request(ctx.getHttpServer()).get(
          `/assets/${factory.uuid()}/edit-versions/123/download`,
        );
        expect(status).toBe(400);
        expect(body).toEqual(factory.responses.validationError([{ path: ['versionId'], message: 'Invalid UUID' }]));
        expect(service.downloadVideoEditVersion).not.toHaveBeenCalled();
      });
    });

    // TODO figure out how to deal with `sendFile`
    describe('GET /assets/:id/thumbnail', () => {
      it('should redirect if size=original is requested', async () => {
        const { status } = await request(ctx.getHttpServer()).get(`/assets/${factory.uuid()}/thumbnail?size=original`);
        expect(status).toBe(302);
      });

      it.each(['preview', 'fullsize'])('refuses explicit HDR for a selected SDR restoration (%s)', async (size) => {
        const folder = await mkdtemp(join(tmpdir(), 'frameleaf-restoration-hdr-'));
        try {
          const path = join(folder, 'restored.jpg');
          const bytes = Buffer.from('authored SDR restoration fixture');
          await writeFile(path, bytes);
          restorationService.getPlaybackChoice.mockResolvedValue({
            file: new ImmichFileResponse({
              path,
              contentType: 'image/jpeg',
              cacheControl: CacheControl.PrivateWithoutCache,
            }),
            revalidate: true,
          });
          const id = factory.uuid();
          for (const dynamicRange of ['auto', 'sdr', undefined]) {
            const response = await request(ctx.getHttpServer()).get(
              `/assets/${id}/thumbnail?size=${size}${dynamicRange ? `&dynamicRange=${dynamicRange}` : ''}`,
            );
            expect(response.status).toBe(200);
            expect(response.body).toEqual(bytes);
          }
          const response = await request(ctx.getHttpServer()).get(
            `/assets/${id}/thumbnail?size=${size}&dynamicRange=hdr`,
          );
          expect(response.status).toBe(404);
          expect(response.body.message).toBe('The selected restored photo has no HDR rendition');
          expect(service.viewThumbnail).not.toHaveBeenCalled();
        } finally {
          restorationService.getPlaybackChoice.mockResolvedValue({ file: null, revalidate: false });
          await rm(folder, { recursive: true, force: true });
        }
      });

      it('serves the ordinary edited face preview even when a restoration is selected', async () => {
        const id = factory.uuid();
        service.viewThumbnail.mockResolvedValue({ targetSize: 'original' });
        restorationService.getPlaybackChoice.mockClear();
        restorationService.getPlaybackChoice.mockResolvedValueOnce({
          file: { path: '/restored.jpg' },
          revalidate: false,
        });

        const { status } = await request(ctx.getHttpServer()).get(
          `/assets/${id}/thumbnail?size=preview&edited=false&faceSource=true`,
        );

        expect(status).toBe(302);
        expect(service.viewThumbnail).toHaveBeenCalledWith(
          undefined,
          id,
          expect.objectContaining({ size: 'preview', edited: true, faceSource: true }),
          null,
        );
        expect(restorationService.getPlaybackChoice).not.toHaveBeenCalled();
      });
    });
  });
});
