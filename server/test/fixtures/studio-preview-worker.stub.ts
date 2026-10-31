import type { AuthenticatedRenderWorker, RenderWorkerRepository } from 'src/repositories/render-worker.repository.js';
import { MediaOperationDestination, MediaOperationKind, RenderWorkerStatus } from 'src/enum.js';
import { BUNDLED_RENDER_WORKER_APPROVAL } from 'src/utils/bundled-render-worker.js';

export const previewWorkerCapabilities = { codecs: ['webcodecs-avc'], formats: ['mp4'] };

/** CPU qualification without a hardware-name assumption; operation scopes remain explicit. */
export const previewWorkerStub = (): AuthenticatedRenderWorker =>
  ({
    worker: {
      id: 'preview-worker',
      status: RenderWorkerStatus.Active,
      destination: MediaOperationDestination.Local,
      kinds: [MediaOperationKind.StudioPreview, MediaOperationKind.StudioPreviewStream],
      engineDigest: null,
      conformanceMaxAgeMs: 86_400_000,
      maxConcurrentOperations: 1,
      gpuWorkingBudgetApproval: BUNDLED_RENDER_WORKER_APPROVAL,
    },
    session: {
      id: 'preview-session',
      workerId: 'preview-worker',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 3_600_000),
      conformanceReportedAt: new Date(),
      engineDigest: 'engine',
      scopes: [MediaOperationKind.StudioPreview, MediaOperationKind.StudioPreviewStream],
      gpuMemoryBytes: String(4 * 1024 ** 3),
      codecs: previewWorkerCapabilities.codecs,
      colorPrecision: null,
      lastUsedAt: new Date(),
      gpuWorkingBudgetEvidence: null,
    },
  }) as AuthenticatedRenderWorker;

export const previewWorkerRepositoryStub = () =>
  ({
    listLiveSessions: () => Promise.resolve([previewWorkerStub()]),
    getSessionCapabilities: () => Promise.resolve(previewWorkerCapabilities),
  }) as unknown as RenderWorkerRepository;
