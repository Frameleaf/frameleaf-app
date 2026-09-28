import { JobName, JobStatus, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import {
  EditOperationEdit,
  JOB_QUEUE_CLAIMANT,
  JOB_QUEUE_EXECUTOR,
  canCancelEdit,
  canRetryEdit,
  editOperationCreate,
  editOperationEdit,
  editOperationJobItem,
  editOperationOutcome,
} from 'src/utils/edit-operation.js';

describe('edit operations (FL-43)', () => {
  describe('editOperationCreate', () => {
    it('records a queued edit as a local quick edit held by the job queue', () => {
      const row = editOperationCreate({
        ownerId: 'owner-1',
        edit: EditOperationEdit.VideoExport,
        assetId: 'asset-1',
        label: 'IMG_0001.MOV',
        revisionId: 'version-1',
        job: { name: JobName.AssetVideoEditGeneration, data: { id: 'asset-1', versionId: 'version-1' } },
      });

      expect(row).toMatchObject({
        ownerId: 'owner-1',
        kind: MediaOperationKind.QuickEdit,
        destination: 'local',
        label: 'IMG_0001.MOV',
        assetId: 'asset-1',
        resultAssetId: null,
        revisionId: 'version-1',
        settings: { edit: EditOperationEdit.VideoExport },
        claimedBy: JOB_QUEUE_CLAIMANT,
        snapshot: {
          executor: JOB_QUEUE_EXECUTOR,
          edit: EditOperationEdit.VideoExport,
          assetId: 'asset-1',
          revisionId: 'version-1',
          job: { name: JobName.AssetVideoEditGeneration, data: { id: 'asset-1', versionId: 'version-1' } },
        },
      });
    });
  });

  describe('editOperationEdit', () => {
    it('reads the edit only from a quick edit row', () => {
      expect(
        editOperationEdit({ kind: MediaOperationKind.QuickEdit, settings: { edit: EditOperationEdit.PhotoEdit } }),
      ).toBe(EditOperationEdit.PhotoEdit);
      expect(editOperationEdit({ kind: MediaOperationKind.QuickEdit, settings: { edit: 'resize' } })).toBeUndefined();
      expect(editOperationEdit({ kind: MediaOperationKind.QuickEdit, settings: null })).toBeUndefined();
      expect(
        editOperationEdit({ kind: MediaOperationKind.StudioExport, settings: { edit: EditOperationEdit.PhotoEdit } }),
      ).toBeUndefined();
    });
  });

  describe('cancel and retry', () => {
    it('cancels only a photo version, whose render stops between stages', () => {
      expect(canCancelEdit(EditOperationEdit.PhotoVersion)).toBe(true);
      expect(canCancelEdit(EditOperationEdit.PhotoEdit)).toBe(false);
      expect(canCancelEdit(EditOperationEdit.VideoEdit)).toBe(false);
      expect(canCancelEdit(EditOperationEdit.VideoExport)).toBe(false);
    });

    it('retries every failed edit, and a photo version that was cancelled', () => {
      for (const edit of Object.values(EditOperationEdit)) {
        expect(canRetryEdit(edit, MediaOperationStatus.Failed)).toBe(true);
        expect(canRetryEdit(edit, MediaOperationStatus.Completed)).toBe(false);
        expect(canRetryEdit(edit, MediaOperationStatus.Rendering)).toBe(false);
      }
      expect(canRetryEdit(EditOperationEdit.PhotoVersion, MediaOperationStatus.Cancelled)).toBe(true);
      expect(canRetryEdit(EditOperationEdit.VideoEdit, MediaOperationStatus.Cancelled)).toBe(false);
    });
  });

  describe('editOperationJobItem', () => {
    const snapshot = (job: unknown) => ({ executor: JOB_QUEUE_EXECUTOR, job });

    it('queues the named edit job with the row id attached', () => {
      expect(
        editOperationJobItem('op-1', snapshot({ name: JobName.AssetEditThumbnailGeneration, data: { id: 'a' } })),
      ).toEqual({ name: JobName.AssetEditThumbnailGeneration, data: { id: 'a', operationId: 'op-1' } });
      expect(
        editOperationJobItem(
          'op-2',
          snapshot({ name: JobName.AssetVideoEditGeneration, data: { id: 'a', versionId: 'v', extra: true } }),
        ),
      ).toEqual({ name: JobName.AssetVideoEditGeneration, data: { id: 'a', versionId: 'v', operationId: 'op-2' } });
    });

    it('refuses anything but the three edit jobs, and carries no other field', () => {
      expect(editOperationJobItem('op', snapshot({ name: JobName.FileDelete, data: { id: 'a' } }))).toBeUndefined();
      expect(editOperationJobItem('op', snapshot({ name: JobName.AssetDevelopRender, data: {} }))).toBeUndefined();
      expect(
        editOperationJobItem('op', { job: { name: JobName.AssetDevelopRender, data: { id: 'r' } } }),
      ).toBeUndefined();
      expect(editOperationJobItem('op', null)).toBeUndefined();
      expect(
        editOperationJobItem('op', snapshot({ name: JobName.AssetDevelopRender, data: { id: 'r', delay: 1 } })),
      ).toEqual({ name: JobName.AssetDevelopRender, data: { id: 'r', operationId: 'op' } });
    });
  });

  describe('editOperationOutcome', () => {
    it('maps what the executor returned to the row outcome', () => {
      expect(editOperationOutcome(JobStatus.Success)).toBe('published');
      expect(editOperationOutcome(JobStatus.Skipped)).toBe('nothing');
      expect(editOperationOutcome(JobStatus.Failed)).toBe('failed');
    });
  });
});
