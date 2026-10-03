import { Controller, Get } from '@nestjs/common';
import { ApiOperation, DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Test } from '@nestjs/testing';
import { cleanupOpenApiDoc } from 'nestjs-zod';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { PhotographyWorkflowController } from 'src/controllers/photography-workflow.controller.js';
import { PhotographyGalleryDto } from 'src/dtos/photography-workflow.dto.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowService } from 'src/services/photography-workflow.service.js';

vi.mock('src/services/photography-workflow.service.js', () => ({ PhotographyWorkflowService: class {} }));
vi.mock('src/services/auth.service.js', () => ({ AuthService: class {} }));

// Reproduce the application-wide method-only operation ID factory and an unrelated library route.
@Controller('media-health')
class MediaHealthContractController {
  @Get()
  @ApiOperation({ operationId: 'list' })
  list() {
    return [];
  }
}
describe('photography OpenAPI contract', () => {
  it('generates explicit owner/guest response and strict mutation schemas', async () => {
    const module = await Test.createTestingModule({
      controllers: [PhotographyWorkflowController, MediaHealthContractController],
      providers: [
        { provide: PhotographyWorkflowService, useValue: {} },
        { provide: LoggingRepository, useValue: {} },
      ],
    }).compile();
    const app = module.createNestApplication();
    try {
      const document = cleanupOpenApiDoc(
        SwaggerModule.createDocument(app, new DocumentBuilder().setTitle('Photography').setVersion('1').build(), {
          operationIdFactory: (_controller, method) => method,
        }),
      );
      const operations = Object.entries(document.paths).flatMap(([route, item]) =>
        Object.values(item ?? {})
          .filter((operation) => operation && typeof operation === 'object' && 'operationId' in operation)
          .map((operation) => ({ route, id: operation.operationId })),
      );
      expect(new Set(operations.map((operation) => operation.id)).size).toBe(operations.length);
      expect(
        operations
          .filter((operation) => operation.route.startsWith('/photography/'))
          .every((operation) => operation.id?.startsWith('photography')),
      ).toBe(true);
      const reason = (document.components!.schemas!.PhotographyGalleryDto as any).properties.photos.items.properties
        .blockedReason;
      expect(reason).toEqual({
        type: 'string',
        enum: ['permission', 'order', 'payment', 'approval', 'render'],
        nullable: true,
      });
      const checkEnums = (value: unknown): void => {
        if (!value || typeof value !== 'object') return;
        if ('enum' in value && Array.isArray(value.enum)) expect(value.enum).not.toContain(null);
        for (const nested of Object.values(value)) checkEnums(nested);
      };
      checkEnums(document.components!.schemas);
      const runtimeReason = PhotographyGalleryDto.schema.shape.photos.element.shape.blockedReason;
      expect(runtimeReason.safeParse(null).success).toBe(true);
      expect(runtimeReason.safeParse('render').success).toBe(true);
      expect(runtimeReason.safeParse('unvalidated-reason').success).toBe(false);
      // CI already generates/builds the full SDK. This opt-in local probe uses the same pinned CLI without a new dependency.
      if (process.env.PHOTOGRAPHY_TEST_OAZAPFTS_BIN) {
        const folder = mkdtempSync(path.join(os.tmpdir(), 'photography-sdk-contract-'));
        try {
          const specification = path.join(folder, 'openapi.json'),
            sdk = path.join(folder, 'sdk.ts');
          writeFileSync(specification, JSON.stringify(document));
          execFileSync(
            process.env.PHOTOGRAPHY_TEST_OAZAPFTS_BIN,
            ['--optimistic', '--argumentStyle=object', '--useEnumType', '--allSchemas', specification, sdk],
            { stdio: 'pipe' },
          );
          const program = ts.createProgram([sdk], {
            noEmit: true,
            target: ts.ScriptTarget.ESNext,
            skipLibCheck: true,
            noResolve: true,
          });
          const diagnostics = ts
            .getPreEmitDiagnostics(program)
            .filter((diagnostic) => [1061, 2393, 2300].includes(diagnostic.code));
          expect(diagnostics.map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))).toEqual(
            [],
          );
          expect(readFileSync(sdk, 'utf8')).toContain('photographyList');
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      }
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
