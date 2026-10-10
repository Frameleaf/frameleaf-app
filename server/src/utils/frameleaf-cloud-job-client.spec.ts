import { type Mock, describe, expect, it, vi } from 'vitest';
import { MlAdmissionRefusal } from 'src/enum.js';
import { CloudTransferError, FrameleafCloudMlRepository } from 'src/repositories/frameleaf-cloud-ml.repository.js';
import { CloudJobInputError, FrameleafCloudJobClient } from 'src/utils/frameleaf-cloud-job-client.js';
import {
  CloudUploadTarget,
  FrameleafCloudError,
  jobViewSchema,
  uploadTargetSchema,
} from 'src/utils/frameleaf-cloud.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const gateway = { url: 'https://ml.eu.frameleaf.cloud', token: {} as never };
const refreshed = uploadTargetSchema.parse(cloudContractFixture('ml/storage/upload-target-refreshed.json'));
const target = (overrides: Partial<CloudUploadTarget> = {}): CloudUploadTarget => ({ ...refreshed, ...overrides });
const input = { inputId: 'a1', sha256: refreshed.sha256, bytes: refreshed.bytes, path: '/work/input.jpg' };
const now = new Date('2026-09-26T04:05:00.000Z');

const closed = () =>
  new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 409, 'This job no longer takes uploads.', {
    code: 'upload-closed',
    message: 'This job no longer takes uploads.',
    retryable: false,
    refusal: 'request-invalid',
    detail: null,
    data: null,
    requestId: null,
  });

const repository = () =>
  ({
    getUploads: vi.fn().mockResolvedValue([target()]),
    refreshUpload: vi.fn().mockResolvedValue(target({ expiresAt: '2026-09-26T05:00:00.000Z' })),
    uploadInput: vi.fn().mockResolvedValue(undefined),
    startJob: vi.fn(),
    getJobView: vi.fn(),
    downloadOutput: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    deleteJob: vi.fn().mockResolvedValue(undefined),
  }) as unknown as { [K in keyof FrameleafCloudMlRepository]: ReturnType<typeof vi.fn> };

describe(FrameleafCloudJobClient.name, () => {
  it('uploads each input once, recording the state, and skips what is already up', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    const state = {};
    const record = vi.fn().mockResolvedValue(true);

    await expect(client.upload('job-1', [input], state, { now, record })).resolves.toBe('uploaded');
    expect(repo.uploadInput).toHaveBeenCalledTimes(1);
    expect(state).toEqual({ a1: { done: true, parts: [] } });
    expect(record).toHaveBeenCalledWith(state);

    repo.getUploads.mockResolvedValue([target({ uploaded: true })]);
    await expect(client.upload('job-1', [input], {}, { now, record })).resolves.toBe('uploaded');
    expect(repo.uploadInput).toHaveBeenCalledTimes(1);
  });

  it('signs a target again before it expires, and once more when storage refuses it as expired', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    repo.getUploads.mockResolvedValue([target({ expiresAt: '2026-09-26T04:05:30.000Z' })]);
    repo.uploadInput.mockRejectedValueOnce(new CloudTransferError('target-expired', 'expired'));

    await client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) });

    expect(repo.refreshUpload).toHaveBeenCalledTimes(2);
    expect(repo.uploadInput).toHaveBeenCalledTimes(2);
  });

  it('refuses to upload a file the job was not admitted with', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);

    await expect(
      client.upload('job-1', [{ ...input, sha256: 'f'.repeat(64) }], {}, { now, record: () => Promise.resolve(true) }),
    ).rejects.toBeInstanceOf(CloudJobInputError);
    expect(repo.uploadInput).not.toHaveBeenCalled();
  });

  it('answers closed when the job no longer takes uploads, and stopped when the caller stops it', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    repo.getUploads.mockRejectedValueOnce(closed());
    await expect(client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) })).resolves.toBe(
      'closed',
    );

    repo.uploadInput.mockRejectedValueOnce(new CloudTransferError('stopped', 'stopped'));
    await expect(client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) })).resolves.toBe(
      'stopped',
    );
  });

  it.each(['storage-unreachable', 'target-expired'] as const)(
    'checks the existing record hook before another %s attempt (FL-201)',
    async (failure) => {
      const repo = repository();
      let allowed = true;
      (repo.uploadInput as Mock<FrameleafCloudMlRepository['uploadInput']>).mockImplementation(() => {
        allowed = false;
        return Promise.reject(new CloudTransferError(failure, 'transfer failed'));
      });
      const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway, {
        sleep: () => Promise.resolve(),
      });
      await expect(client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(allowed) })).resolves.toBe(
        'stopped',
      );
      expect(repo.uploadInput).toHaveBeenCalledTimes(1);
    },
  );

  it('checks the existing record hook before sending the first byte (FL-201)', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    await expect(client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(false) })).resolves.toBe(
      'stopped',
    );
    expect(repo.uploadInput).not.toHaveBeenCalled();
  });

  it('reads a job with its ETag and keeps the next read between one second and the maximum', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    const running = jobViewSchema.parse(cloudContractFixture('ml/job-running.json'));
    repo.getJobView.mockResolvedValueOnce({ notModified: false, data: running, etag: '"a"', retryAfterSeconds: 600 });
    repo.getJobView.mockResolvedValueOnce({ notModified: true, etag: '"a"', retryAfterSeconds: null });

    await expect(client.read('job-1', null, { defaultMs: 5000, maxMs: 60_000 })).resolves.toEqual({
      view: running,
      etag: '"a"',
      delayMs: 60_000,
    });
    await expect(client.read('job-1', '"a"', { defaultMs: 5000, maxMs: 60_000 })).resolves.toEqual({
      view: null,
      etag: '"a"',
      delayMs: 5000,
    });
    expect(repo.getJobView).toHaveBeenLastCalledWith(gateway, 'job-1', '"a"');
  });

  it('downloads only the outputs it does not have, with the job storage headers', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    const view = jobViewSchema.parse(cloudContractFixture('ml/storage/job-completed-result.json'));
    const outputs = view.result!.outputs;

    const files = await client.download(view, outputs, '/work', {
      done: ['a1'],
      exists: () => Promise.resolve(true),
      remove: () => Promise.resolve(),
      fileName: (output) => `out-${output.outputId}.json`,
      record: () => Promise.resolve(true),
    });

    expect(files).toEqual(['/work/out-a1.json', '/work/out-a2.json']);
    expect(repo.downloadOutput).toHaveBeenCalledTimes(1);
    expect(repo.downloadOutput).toHaveBeenCalledWith(gateway, outputs[1], view.result!.headers, '/work/out-a2.json', {
      signal: undefined,
    });
  });

  it('tries a transfer again after storage fails for a moment, and gives up on anything else', async () => {
    const repo = repository();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway, { sleep });
    repo.uploadInput
      .mockRejectedValueOnce(new CloudTransferError('storage-unreachable', 'reset'))
      .mockRejectedValueOnce(new CloudTransferError('storage-refused', 'busy', 503));

    await expect(client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) })).resolves.toBe(
      'uploaded',
    );
    expect(repo.uploadInput).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);

    repo.uploadInput.mockClear();
    repo.uploadInput.mockRejectedValue(new CloudTransferError('storage-refused', 'refused', 400));
    await expect(
      client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) }),
    ).rejects.toBeInstanceOf(CloudTransferError);
    expect(repo.uploadInput).toHaveBeenCalledTimes(1);

    repo.uploadInput.mockClear();
    repo.uploadInput.mockRejectedValue(new CloudTransferError('storage-unreachable', 'down'));
    await expect(
      client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) }),
    ).rejects.toBeInstanceOf(CloudTransferError);
    expect(repo.uploadInput).toHaveBeenCalledTimes(3);
  });

  it('resumes a re-signed upload from the parts recorded before it was refused', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);
    type UploadInput = (
      gateway: unknown,
      target: unknown,
      file: unknown,
      options: { onPart: (part: { partNumber: number; etag: string }) => Promise<void> },
    ) => Promise<void>;
    (repo.uploadInput as Mock<UploadInput>).mockImplementationOnce(async (_gateway, _target, _file, options) => {
      await options.onPart({ partNumber: 1, etag: '"p1"' });
      throw new CloudTransferError('target-expired', 'expired');
    });

    await client.upload('job-1', [input], {}, { now, record: () => Promise.resolve(true) });

    expect(repo.uploadInput).toHaveBeenCalledTimes(2);
    expect(repo.uploadInput.mock.calls[1][3].done).toEqual([{ partNumber: 1, etag: '"p1"' }]);
  });

  it('cancels only a job that has not ended, and takes job-ended as done', async () => {
    const repo = repository();
    const client = new FrameleafCloudJobClient(repo as unknown as FrameleafCloudMlRepository, gateway);

    await client.cancel('job-1', 'completed');
    expect(repo.cancelJob).not.toHaveBeenCalled();

    repo.cancelJob.mockRejectedValueOnce(
      new FrameleafCloudError(MlAdmissionRefusal.RequestInvalid, 409, 'This job already ended.', {
        code: 'job-ended',
        message: 'This job already ended.',
        retryable: false,
        refusal: null,
        detail: null,
        data: null,
        requestId: null,
      }),
    );
    await expect(client.cancel('job-1', 'running')).resolves.toBeUndefined();
    await client.acknowledge('job-1');
    expect(repo.deleteJob).toHaveBeenCalledWith(gateway, 'job-1');
  });
});
