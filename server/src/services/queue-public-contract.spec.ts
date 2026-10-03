import { describe, expect, it, vi } from 'vitest';
import z from 'zod';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { QueueJobRow } from 'src/repositories/job.repository.js';
import { QueueJobResponseDto } from 'src/dtos/queue.dto.js';
import { JobName, QueueJobStatus, QueueJobWorkerKind, QueueName } from 'src/enum.js';
import { QueueService } from 'src/services/queue.service.js';

// Exercise the public projection without loading every repository or starting any workers.
vi.mock('src/services/base.service.js', () => ({ BaseService: class {} }));

const assetId = '6f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a01';
const workflowId = '0f1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a02';
const ownerId = 'af1d7c6e-2b0f-4c55-9b0e-6b8f2c1c1a03';

const setup = (rows: QueueJobRow[]) => {
  const searchJobs = vi.fn().mockResolvedValue(rows);
  const getJobSubjectOwners = vi.fn().mockResolvedValue([{ subjectId: assetId, ownerId, ownerName: 'Studio' }]);
  const service = Object.assign(Object.create(QueueService.prototype) as QueueService, {
    jobRepository: { searchJobs },
    userRepository: { getJobSubjectOwners },
  });
  return { service, searchJobs, getJobSubjectOwners };
};

describe('public queue job compatibility (FL-283)', () => {
  it('retains every legacy job name in runtime validation and the response schema', () => {
    const legacyNames = Object.values(JobName).filter((name) => name !== JobName.PhotographyWorkflowRender);
    const schema = QueueJobResponseDto.schema.shape.name;

    expect(z.toJSONSchema(schema).enum).toEqual(legacyNames);
    for (const name of legacyNames) expect(schema.parse(name)).toBe(name);
    expect(schema.safeParse(JobName.PhotographyWorkflowRender).success).toBe(false);
  });

  it.each([undefined, ownerId])(
    'preserves legacy job details while excluding internal rows (owner %s)',
    async (owner) => {
      const legacy: QueueJobRow = {
        id: 'legacy-job',
        name: JobName.AssetGenerateThumbnails,
        timestamp: 123,
        status: QueueJobStatus.Failed,
        data: { id: assetId },
        attemptsMade: 2,
        failedReason: 'Source unavailable',
      };
      const internal: QueueJobRow = {
        id: 'internal-job',
        name: JobName.PhotographyWorkflowRender,
        timestamp: 124,
        status: QueueJobStatus.Waiting,
        data: { id: workflowId },
      };
      const { service, searchJobs, getJobSubjectOwners } = setup([internal, legacy]);
      const query = owner ? { ownerId: owner } : {};

      const result = await service.searchJobs({} as AuthDto, QueueName.ThumbnailGeneration, query);

      expect(searchJobs).toHaveBeenCalledWith(QueueName.ThumbnailGeneration, query);
      expect(getJobSubjectOwners).toHaveBeenCalledWith([assetId]);
      expect(result).toEqual([
        {
          id: 'legacy-job',
          name: JobName.AssetGenerateThumbnails,
          timestamp: 123,
          data: { id: assetId },
          attemptsMade: 2,
          failedReason: 'Source unavailable',
          account: { id: ownerId, name: 'Studio' },
          worker: { kind: QueueJobWorkerKind.Server, name: null },
        },
      ]);
      expect(QueueJobResponseDto.schema.array().parse(result)).toEqual(result);
      // The repository keeps the internal job intact for the worker and scoped workflow API.
      expect(internal.name).toBe(JobName.PhotographyWorkflowRender);
      expect(internal.data).toEqual({ id: workflowId });
    },
  );

  it.each(Object.values(QueueJobStatus))(
    'excludes an internal-only %s queue without looking up private subjects',
    async (status) => {
      const { service, getJobSubjectOwners } = setup([
        { name: JobName.PhotographyWorkflowRender, status, timestamp: 123, data: { id: workflowId } },
      ]);

      await expect(
        service.searchJobs({} as AuthDto, QueueName.ThumbnailGeneration, { status: [status] }),
      ).resolves.toEqual([]);
      expect(getJobSubjectOwners).not.toHaveBeenCalled();
    },
  );
});
