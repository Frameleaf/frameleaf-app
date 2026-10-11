import {
  Evidence,
  ProcessingProvenanceEvidence,
  ProcessingProvenanceVersion,
  StudioImportPublicationCancelStatus,
  type RetainedProcessingProvenance,
  type StudioImportPublicationCancelDto,
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
