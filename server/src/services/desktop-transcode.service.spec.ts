import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Readable } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { MediaOperationKind, MediaOperationStatus, SystemMetadataKey } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { JobDependencyUnavailable } from 'src/queue/dependency.js';
import { DesktopTranscodeService } from 'src/services/desktop-transcode.service.js';
import { MediaService } from 'src/services/media.service.js';
import { DESKTOP_TRANSCODE_PRESENCE_KEY } from 'src/utils/desktop-transcode.js';

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
    isLockedAsset: vi.fn(),
  };
  const operations = { heartbeat: vi.fn(), fail: vi.fn() };
  const assets = { getById: vi.fn() };
  const metadata = { setEntry: vi.fn() };
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
  const command = () => ({
    inputOptions: [],
    outputOptions: [],
    twoPass: false,
    progress: { frameCount: 1, percentInterval: 5 },
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
        command,
        input,
      ),
    );
  const withPresence = (value: unknown) =>
    systemMetadataRepository.get.mockImplementation((key: SystemMetadataKey) =>
      Promise.resolve(key === DESKTOP_TRANSCODE_PRESENCE_KEY ? value : null),
    );

  beforeEach(() => {
    vi.resetAllMocks();
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([]);
    storageRepository.stat.mockResolvedValue({ size: 1000 });
  });

  it('encodes here when no desktop is present', async () => {
    withPresence(null);
    await expect(run()).resolves.toBeUndefined();
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
    await expect(run({ ...source, locked: true })).resolves.toBeUndefined();
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
    await expect(run()).resolves.toBeUndefined();
  });

  it('encodes here right after a failed attempt and removes its staged file', async () => {
    vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue('/data');
    withPresence(present);
    mediaOperationRepository.getLatestBySubject.mockResolvedValue([
      { id, status: MediaOperationStatus.Failed, finishedAt: new Date() },
    ]);
    await expect(run()).resolves.toBeUndefined();
    expect(storageRepository.unlinkDir).toHaveBeenCalled();
    expect(mediaOperationRepository.createUnlessActive).not.toHaveBeenCalled();
  });
});
