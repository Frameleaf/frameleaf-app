import { readFileSync } from 'node:fs';
import z from 'zod';
import { MlCapabilitiesResponseDto } from 'src/dtos/ml-destination.dto.js';
import { StudioResourceInventoryDto } from 'src/dtos/studio-inventory.dto.js';
import { MediaOperationDestination, MediaOperationKind } from 'src/enum.js';
import { hasStudioPreviewWorker } from 'src/utils/studio-preview-worker.js';
import { previewWorkerRepositoryStub, previewWorkerStub } from 'test/fixtures/studio-preview-worker.stub.js';

describe('Studio preview worker admission', () => {
  it.each([
    'eligible-cpu',
    'export-only',
    'wrong-worker-scope',
    'wrong-session-scope',
    'lan',
    'expired',
    'missing-proof',
  ])('%s', async (scenario) => {
    const worker = previewWorkerStub();
    const repository = previewWorkerRepositoryStub();
    repository.listLiveSessions = () => Promise.resolve([worker]);
    switch (scenario) {
      case 'export-only': {
        worker.worker.kinds = worker.session.scopes = [MediaOperationKind.StudioExport];
        break;
      }
      case 'wrong-worker-scope': {
        worker.worker.kinds = [MediaOperationKind.StudioExport];
        break;
      }
      case 'wrong-session-scope': {
        worker.session.scopes = [MediaOperationKind.StudioExport];
        break;
      }
      case 'lan': {
        worker.worker.destination = MediaOperationDestination.Lan;
        break;
      }
      case 'expired': {
        worker.session.expiresAt = new Date(Date.now() - 1);
        break;
      }
      case 'missing-proof': {
        repository.getSessionCapabilities = () => Promise.resolve(undefined);
        break;
      }
      // No default
    }
    expect(await hasStudioPreviewWorker(repository, MediaOperationKind.StudioPreview)).toBe(
      scenario === 'eligible-cpu',
    );
  });

  it('keeps both additive capability fields optional and synchronized with the API checkpoint', () => {
    const checkpoint = JSON.parse(
      readFileSync(new URL('../../../open-api/immich-openapi-specs.json', import.meta.url), 'utf8'),
    );
    expect(checkpoint.components.schemas.StudioWorkerCapability.enum).toEqual(
      StudioResourceInventoryDto.schema.shape.items.element.shape.capability.unwrap().options,
    );
    const schema = checkpoint.components.schemas.StudioCapabilitiesDto;
    for (const name of ['previewWorker', 'previewStreamWorker'] as const) {
      expect(schema.required).not.toContain(name);
      expect(schema.properties[name]).toEqual(
        z.toJSONSchema(MlCapabilitiesResponseDto.schema.shape.studio.shape[name], { target: 'openapi-3.0' }),
      );
    }
  });
});
