import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationKind, MediaOperationStatus, SystemMetadataKey } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobDependencyUnavailable } from 'src/queue/dependency.js';
import { DesktopTranscodeService } from 'src/services/desktop-transcode.service.js';
import { MediaService } from 'src/services/media.service.js';
import { DESKTOP_TRANSCODE_PRESENCE_KEY, desktopTranscodeStagingFolder } from 'src/utils/desktop-transcode.js';

const id = '11111111-1111-4111-8111-111111111111';
const claimToken = '22222222-2222-4222-8222-222222222222';
const ownerId = '33333333-3333-4333-8333-333333333333';
const deviceId = '44444444-4444-4444-8444-444444444444';
const grant = { deviceId, sessionId: id, authorizationEpoch: 1, credentialHash: Buffer.alloc(32) };
const checksum = Buffer.from('abcd', 'hex');
const snapshot = {
  assetId: id,
  checksum: 'abcd',
  sourceBytes: 1000,
  command: { inputOptions: [], outputOptions: ['-c:v libx264'], twoPass: false, frameCount: 10 },
};

describe(DesktopTranscodeService.name, () => {
  const auth = { authenticate: vi.fn() };
  const repository = {
    claim: vi.fn(),
    getClaimed: vi.fn(),
    stageResult: vi.fn(),
    ownerOf: vi.fn(),
    setUploadGrant: vi.fn(),
    getByUploadToken: vi.fn(),
    listFinishedStaged: vi.fn(),
    clearStaged: vi.fn(),
    isLockedAsset: vi.fn(),
  };
  const operations = { heartbeat: vi.fn(), fail: vi.fn(), reportProgress: vi.fn() };
  const assets = { getById: vi.fn() };
  const metadata = { setEntry: vi.fn() };
  const storage = { unlinkDir: vi.fn() };
  let sut: DesktopTranscodeService;

  beforeEach(() => {
    vi.resetAllMocks();
    auth.authenticate.mockResolvedValue(grant);
    sut = new DesktopTranscodeService(
      auth as never,
      repository as never,
      operations as never,
      assets as never,
      metadata as never,
      storage as never,
    );
  });

  it('notes the desktop as present even when there is no work', async () => {
    repository.claim.mockResolvedValue(undefined);
    repository.ownerOf.mockResolvedValue(ownerId);
    await expect(sut.claim('Bearer x', 'proof')).resolves.toEqual({ task: null });
    expect(metadata.setEntry).toHaveBeenCalledWith(
      DESKTOP_TRANSCODE_PRESENCE_KEY,
      'devices',
      deviceId,
      expect.objectContaining({ ownerId }),
    );
  });

  it('refuses an original with a lock record before its Locked seal has run', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    assets.getById.mockResolvedValue({ id, ownerId, checksum, originalPath: '/library/video.mov', deletedAt: null });
    repository.isLockedAsset.mockResolvedValue(true);
    await expect(sut.input('Bearer x', 'proof', id, claimToken)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('never serves an original without the live claim', async () => {
    repository.getClaimed.mockResolvedValue(undefined);
    await expect(sut.input('Bearer x', 'proof', id, claimToken)).rejects.toBeInstanceOf(ForbiddenException);
    expect(assets.getById).not.toHaveBeenCalled();
  });

  it('signs the upload size and checksum and stores only a hash of the token', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    repository.setUploadGrant.mockResolvedValue(true);
    const payload = JSON.stringify({ claimToken, checksum: 'a'.repeat(64), sizeInBytes: '5' });
    const { uploadToken } = await sut.grantUpload('Bearer x', 'proof', id, payload);
    expect(auth.authenticate).toHaveBeenCalledWith('Bearer x', 'proof', `transcode-upload-grant:${id}`, payload);
    const stored = repository.setUploadGrant.mock.calls[0][2];
    expect(stored).toMatchObject({ checksum: 'a'.repeat(64), sizeInBytes: '5' });
    expect(stored.tokenHash).not.toBe(uploadToken);
  });

  it('refuses a grant over the size allowance', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    const payload = JSON.stringify({ claimToken, checksum: 'a'.repeat(64), sizeInBytes: String(2 * 1024 ** 3) });
    await expect(sut.grantUpload('Bearer x', 'proof', id, payload)).rejects.toBeInstanceOf(BadRequestException);
    expect(repository.setUploadGrant).not.toHaveBeenCalled();
  });

  it('refuses an upload without a live token before reading it', async () => {
    repository.getByUploadToken.mockResolvedValue(undefined);
    await expect(sut.upload('stale', id, Readable.from([]))).rejects.toBeInstanceOf(ForbiddenException);
    await expect(sut.upload(undefined, id, Readable.from([]))).rejects.toBeInstanceOf(ForbiddenException);
    expect(repository.stageResult).not.toHaveBeenCalled();
  });

  it('keeps sweeping after one staged folder cannot be removed', async () => {
    repository.listFinishedStaged.mockResolvedValue([
      { id, ownerId },
      { id: claimToken, ownerId },
    ]);
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue('/data');
    storage.unlinkDir.mockRejectedValueOnce(new Error('EBUSY')).mockResolvedValueOnce(undefined);
    await sut.sweepStaged();
    expect(repository.clearStaged).toHaveBeenCalledExactlyOnceWith(claimToken);
  });

  it('stores the progress of an accepted heartbeat through the operation (FL-1761)', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    operations.heartbeat.mockResolvedValue(true);
    await sut.heartbeat('Bearer x', 'proof', id, JSON.stringify({ claimToken, progress: 42 }));
    expect(operations.reportProgress).toHaveBeenCalledWith(id, claimToken, {
      status: MediaOperationStatus.Rendering,
      processedUnits: 42,
      totalUnits: 100,
      progress: 42,
    });
  });

  it('still accepts a heartbeat without progress (FL-1761)', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    operations.heartbeat.mockResolvedValue(true);
    const answer = await sut.heartbeat('Bearer x', 'proof', id, JSON.stringify({ claimToken }));
    expect(answer.accepted).toBe(true);
    expect(operations.reportProgress).not.toHaveBeenCalled();
  });

  it('stops a computer that was turned off at its next heartbeat (FL-1761)', async () => {
    repository.getClaimed.mockResolvedValue(undefined);
    const answer = await sut.heartbeat('Bearer x', 'proof', id, JSON.stringify({ claimToken, progress: 50 }));
    expect(answer).toEqual({ accepted: false, expiresAt: null });
    expect(operations.heartbeat).not.toHaveBeenCalled();
    expect(operations.reportProgress).not.toHaveBeenCalled();
  });

  it.each([-1, 101, 4.5, '42'])('refuses a progress of %s (FL-1761)', async (progress) => {
    await expect(
      sut.heartbeat('Bearer x', 'proof', id, JSON.stringify({ claimToken, progress })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('fails without a retry, so the waiting job encodes on the server', async () => {
    repository.getClaimed.mockResolvedValue({ ownerId, snapshot });
    operations.fail.mockResolvedValue('failed');
    const payload = JSON.stringify({ claimToken, code: 'encode-failed' });
    await expect(sut.fail('Bearer x', 'proof', id, payload)).resolves.toEqual({ accepted: true });
    expect(operations.fail).toHaveBeenCalledWith(id, claimToken, expect.anything(), {
      retry: false,
      requireActiveClaim: true,
    });
  });
});

describe('waitForDesktopTranscode', () => {
  const asset = { id, ownerId, originalPath: '/library/video.mov', checksum };
  const source = {
    locked: false,
    spherical: false,
    cinemaRaw: false,
    dolbyVision: false,
    logConversion: false,
  };
  const plan = () => ({
    command: { inputOptions: [], outputOptions: [], twoPass: false, progress: { frameCount: 1, percentInterval: 5 } },
    expected: {
      durationSeconds: 10,
      videoCodec: 'h264',
      shortSide: 720,
      aspect: 16 / 9,
      hasAudio: true,
      audioCodec: 'aac',
    },
  });
  const mediaOperationRepository = {
    getLatestBySubject: vi.fn(),
    createUnlessActive: vi.fn(),
    failUnclaimedDesktopTranscode: vi.fn(),
  };
  const storageRepository = { stat: vi.fn(), unlinkDir: vi.fn() };
  const systemMetadataRepository = { get: vi.fn() };
  const present = { devices: { [deviceId]: { ownerId, at: new Date().toISOString() } } };
  const run = (input = source) =>
    queueExecution.run({ claim: { data: {} }, signal: new AbortController().signal } as never, () =>
      (MediaService.prototype as any).waitForDesktopTranscode.call(
        { mediaOperationRepository, storageRepository, systemMetadataRepository },
        asset,
        '/encoded/video.mp4',
        plan,
        input,
      ),
    );
  const turnedOn = { version: 1, accounts: {}, transcodeEnabledDevices: [deviceId] };
  const withPresence = (value: unknown, policy: unknown = turnedOn) =>
    systemMetadataRepository.get.mockImplementation((key: SystemMetadataKey) =>
      Promise.resolve(key === DESKTOP_TRANSCODE_PRESENCE_KEY ? value : policy),
    );

  beforeEach(() => {
    vi.resetAllMocks();
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([]);
    storageRepository.stat.mockResolvedValue({ size: 1000 });
  });

  it('encodes here when no desktop is present', async () => {
    withPresence(null);
    await expect(run()).resolves.toBe(false);
    expect(mediaOperationRepository.createUnlessActive).not.toHaveBeenCalled();
  });

  it('never offers a video to a computer that is off (FL-1761)', async () => {
    withPresence(present, null);
    await expect(run()).resolves.toBe(false);
    expect(mediaOperationRepository.createUnlessActive).not.toHaveBeenCalled();
  });

  it('offers an eligible video and gives up the job slot', async () => {
    withPresence(present);
    await expect(run()).rejects.toBeInstanceOf(JobDependencyUnavailable);
    expect(mediaOperationRepository.createUnlessActive).toHaveBeenCalledWith(
      expect.objectContaining({ kind: MediaOperationKind.PlaybackTranscode, ownerId }),
      expect.objectContaining({ key: 'assetId', value: id }),
    );
  });

  it('never offers a Locked video', async () => {
    withPresence(present);
    await expect(run({ ...source, locked: true })).resolves.toBe(false);
    expect(mediaOperationRepository.createUnlessActive).not.toHaveBeenCalled();
  });

  it('keeps waiting while a desktop holds the video', async () => {
    withPresence(null);
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([{ id, status: MediaOperationStatus.Rendering }]);
    await expect(run()).rejects.toBeInstanceOf(JobDependencyUnavailable);
  });

  it('takes back a queued offer when every desktop went away', async () => {
    withPresence(null);
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([{ id, status: MediaOperationStatus.Queued }]);
    mediaOperationRepository.failUnclaimedDesktopTranscode.mockResolvedValue(true);
    await expect(run()).resolves.toBe(false);
  });

  it('encodes here right after a failed attempt and removes its staged file', async () => {
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue('/data');
    withPresence(present);
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([
      { id, status: MediaOperationStatus.Failed, finishedAt: new Date() },
    ]);
    await expect(run()).resolves.toBe(false);
    expect(storageRepository.unlinkDir).toHaveBeenCalled();
    expect(mediaOperationRepository.createUnlessActive).not.toHaveBeenCalled();
  });

  describe('a desktop upload', () => {
    const outputPath = '/data/exports/owner/desktop-transcodes/op/file.artifact';
    const validating = {
      id,
      status: MediaOperationStatus.Validating,
      claimToken,
      result: { outputPath, checksum: 'ab'.repeat(32), sizeInBytes: 10 },
      snapshot: {
        checksum: 'abcd',
        expected: {
          durationSeconds: 10,
          videoCodec: 'h264',
          shortSide: 720,
          aspect: 16 / 9,
          hasAudio: false,
          audioCodec: null,
        },
      },
    };
    const self = () => ({
      mediaOperationRepository: { ...mediaOperationRepository, fail: vi.fn(), complete: vi.fn() },
      storageRepository: { ...storageRepository, copyFile: vi.fn() },
      mediaRepository: { probe: vi.fn() },
      storageCore: { ensureFolders: vi.fn() },
      logger: { warn: vi.fn() },
    });
    const adopt = (service: ReturnType<typeof self>, operation: unknown, target = asset) =>
      queueExecution.run({ claim: { data: {} }, signal: new AbortController().signal, adoptions: [] } as never, () =>
        (MediaService.prototype as any).adoptDesktopTranscode.call(service, target, operation, '/encoded/video.mp4'),
      );

    beforeEach(() => {
      vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue('/data');
    });

    it('refuses a file made from an original that changed since', async () => {
      const service = self();
      await expect(adopt(service, validating, { ...asset, checksum: Buffer.from('ffff', 'hex') })).resolves.toBe(false);
      expect(service.mediaOperationRepository.fail).toHaveBeenCalledWith(
        id,
        claimToken,
        expect.objectContaining({ errorCode: 'desktop_transcode_source-changed' }),
        { retry: false, requireActiveClaim: true },
      );
      expect(service.storageRepository.copyFile).not.toHaveBeenCalled();
      expect(service.storageRepository.unlinkDir).toHaveBeenCalled();
    });

    it('refuses a staged file whose checksum does not match without publishing it', async () => {
      const root = await mkdtemp(join(tmpdir(), 'desktop-transcode-'));
      vi.mocked(StorageCore.getMediaLocation).mockReturnValue(root);
      const folder = desktopTranscodeStagingFolder(ownerId, id);
      await mkdir(folder, { recursive: true });
      const stagedPath = join(folder, `${randomUUID()}.artifact`);
      await writeFile(stagedPath, 'not the uploaded bytes');
      const service = self();
      const operation = {
        ...validating,
        result: { outputPath: stagedPath, checksum: 'ab'.repeat(32), sizeInBytes: 22 },
      };
      await expect(adopt(service, operation)).resolves.toBe(false);
      await rm(root, { recursive: true, force: true });
      expect(service.mediaRepository.probe).not.toHaveBeenCalled();
      expect(service.mediaOperationRepository.fail).toHaveBeenCalledWith(
        id,
        claimToken,
        expect.objectContaining({ errorCode: 'desktop_transcode_unreadable' }),
        expect.anything(),
      );
      expect(service.storageRepository.copyFile).not.toHaveBeenCalled();
    });
  });
});
