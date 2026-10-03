import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { describe, expect, it, vi } from 'vitest';
import { PhotographyWorkflowController } from 'src/controllers/photography-workflow.controller.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';

vi.mock('src/services/photography-workflow.service.js', () => ({ PhotographyWorkflowService: class {} }));
vi.mock('src/services/auth.service.js', () => ({ AuthService: class {} }));

describe('photography OpenAPI contract', () => {
  it('generates explicit owner/guest response and strict mutation schemas', async () => {
    const module = await Test.createTestingModule({
      controllers: [PhotographyWorkflowController],
      providers: [
        { provide: PhotographyWorkflowService, useValue: {} },
        { provide: LoggingRepository, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication();
    try {
      const document = cleanupOpenApiDoc(
        SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Photography').setVersion('1').build()),
      );
      const owner = document.paths['/photography/workflows/{id}'].get!.responses['200'];
      expect(owner).toMatchObject({
        content: { 'application/json': { schema: { $ref: '#/components/schemas/PhotographyWorkflowDto' } } },
      });
      const guest = document.paths['/photography/galleries/{id}'].get!.responses['200'];
      expect(guest).toMatchObject({
        content: { 'application/json': { schema: { $ref: '#/components/schemas/PhotographyGalleryDto' } } },
      });
      expect(document.paths['/photography/presets'].post?.requestBody).toBeTruthy();
      expect(
        document.paths['/photography/workflows/{id}/studio-presets/{presetId}/apply'].post?.requestBody,
      ).toBeTruthy();
      expect(document.paths['/photography/galleries/{id}/photos/{captureId}/outputs/{outputId}'].get).toBeTruthy();
      const schemas = document.components!.schemas!;
      expect(schemas.PhotographyGalleryDto).toMatchObject({
        properties: { checkoutAvailable: { type: 'boolean' }, photos: { type: 'array' } },
      });
      expect(schemas.PhotographyWorkflowConfigDto).toMatchObject({
        additionalProperties: false,
        required: expect.arrayContaining(['expectedRevision', 'config']),
      });
      expect(schemas.PhotographyPublicSiteDto).toMatchObject({
        properties: { brand: expect.any(Object), portfolio: { type: 'array' } },
      });
    } finally {
      await app.close();
    }
  });
});
