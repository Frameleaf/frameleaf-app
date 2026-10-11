import {
  Evidence,
  ProcessingProvenanceEvidence,
  ProcessingProvenanceVersion,
  StudioImportPublicationCancelStatus,
  type RetainedProcessingProvenance,
  type StudioImportPublicationCancelDto,
  type StudioImportPublicationDto,
  Status12,
  type ReconciliationHistoryDto,
  type ReconciliationResultDto,
  type SyncAssetTrashStateV1,
} from '../build/index.js';

const resultEvidence: ReconciliationResultDto['evidence'] =
  Evidence.RegisteredCurrentOriginals;
const historyEvidence: ReconciliationHistoryDto['runs'][number]['evidence'] =
  Evidence.RegisteredCurrentOriginals;
const active: SyncAssetTrashStateV1['status'] = Status12.Active;
const trashed: SyncAssetTrashStateV1['status'] = Status12.Trashed;
const deleted: SyncAssetTrashStateV1['status'] = Status12.Deleted;

const provenanceEvidence: RetainedProcessingProvenance['evidence'] =
  ProcessingProvenanceEvidence.ClientReported;
const provenanceVersion: RetainedProcessingProvenance['version'] =
  ProcessingProvenanceVersion.$1;
const cancelled: StudioImportPublicationCancelDto['status'] =
  StudioImportPublicationCancelStatus.Cancelled;

const plainProvenance: RetainedProcessingProvenance = {
  version: 1,
  family: 'anime4k',
  evidence: 'client-reported',
  variant: 'animation',
  source: { namespace: 'freecut-media', id: 'source', projectId: 'project' },
  input: { width: 640, height: 360 },
  output: {
    width: 1280,
    height: 720,
    fps: 29.97,
    frameCount: 30,
    codec: 'avc1',
  },
  outputSha256: 'ab'.repeat(32),
};
const plainStates: StudioImportPublicationDto['state'][] = [
  'registered',
  'preparing',
  'published',
  'aborted',
];
const plainCancellation: StudioImportPublicationCancelDto['status'][] = [
  'cancelled',
  'already-published',
];
// @ts-expect-error Unsupported version must remain outside the generated contract.
const unsupportedVersion: RetainedProcessingProvenance['version'] = 2;
// @ts-expect-error Historical evidence cannot become a server certification.
const unsupportedEvidence: RetainedProcessingProvenance['evidence'] =
  'server-certified';
// @ts-expect-error Unknown publication states must remain outside the generated contract.
const unsupportedState: StudioImportPublicationDto['state'] = 'unknown';
// @ts-expect-error Unknown cancellation results must remain outside the generated contract.
const unsupportedCancellation: StudioImportPublicationCancelDto['status'] =
  'unknown';
