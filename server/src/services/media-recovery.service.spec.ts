import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AssetStatus, AssetType, ChecksumAlgorithm } from 'src/enum.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import {
  MediaRecoveryRepository,
  RecoveryCandidate,
  RecoveryReservation,
} from 'src/repositories/media-recovery.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { MediaIntegrityService } from 'src/services/media-integrity.service.js';
import { MediaRecoveryInput, MediaRecoveryService } from 'src/services/media-recovery.service.js';
import { getMocks } from 'test/utils.js';

describe(MediaRecoveryService.name, () => {
  const bytes = Buffer.from('complete synthetic original');
  let directory: string;
  let input: MediaRecoveryInput;
  let sut: MediaRecoveryService;
  let original: string;
  let candidate: RecoveryCandidate;
  let reservation: RecoveryReservation;
  const importedId = randomUUID();
  const repository = {
    getResource: vi.fn(),
    findCandidates: vi.fn(),
    reserve: vi.fn(),
    commit: vi.fn(),
    commitVerifiedReuse: vi.fn(),
  };
  beforeEach(async () => {
    vi.clearAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'icloud-recovery-test-'));
    const mocks = getMocks();
    mocks.media.decodeImage.mockResolvedValue({ data: bytes, info: {} } as never);
    const integrity = new MediaIntegrityService(
      new StorageRepository(mocks.logger as never),
      new CryptoRepository(),
      mocks.media as never,
    );
    input = {
      resourceId: randomUUID(),
      leaseToken: randomUUID(),
      ownerId: randomUUID(),
      stagedPath: join(directory, 'stage.jpg'),
      originalFileName: 'photo.jpg',
      type: AssetType.Image,
      includeHidden: false,
    };
    await writeFile(input.stagedPath, bytes);
    const verified = await integrity.validate({
      path: input.stagedPath,
      originalFileName: 'photo.jpg',
      type: AssetType.Image,
    });
    if (verified.status !== 'healthy') {
      throw new Error('fixture_failed');
    }
    original = join(directory, 'old.jpg');
    candidate = {
      id: randomUUID(),
      ownerId: input.ownerId,
      updateId: randomUUID(),
      originalPath: original,
      checksum: verified.sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      originalFileName: 'photo.jpg',
      type: AssetType.Image,
      isExternal: false,
      libraryId: null,
      deletedAt: null,
      status: AssetStatus.Active,
      isOffline: false,
      hidden: false,
      physicalOriginalFileId: null,
      forkPhysicalFileId: null,
      sizeInBytes: bytes.length,
      damaged: false,
      matchesContent: true,
      identityConflict: false,
    };
    repository.getResource.mockResolvedValue({
      stagingPath: input.stagedPath,
      expectedSize: bytes.length,
      assetId: candidate.id,
      sha1: verified.sha1,
      sha256: verified.sha256,
    });
    repository.findCandidates.mockResolvedValue([candidate]);
    repository.reserve.mockImplementation(({ outcome, proposedPath, candidate: target }) => {
      expect(proposedPath === original || proposedPath.includes('/.icloud-recovery/')).toBe(true);
      reservation = {
        promotedPath: outcome === 'reused' ? original : join(directory, '.icloud-recovery', 'final.jpg'),
        target: {
          assetId: target?.id ?? importedId,
          updateId: candidate.updateId,
          originalPath: original,
          checksumHex: candidate.checksum.toString('hex'),
          checksumAlgorithm: candidate.checksumAlgorithm,
          isExternal: false,
          libraryId: null,
          physicalOriginalFileId: null,
          forkPhysicalFileId: null,
          outcome,
        },
      };
      return Promise.resolve(reservation);
    });
    repository.commit.mockImplementation(async ({ verifyFinal, reservation }) => {
      expect(await verifyFinal()).toMatchObject({
        status: 'healthy',
        sha256: verified.sha256,
        sizeInBytes: bytes.length,
      });
      return { outcome: reservation.target.outcome, assetId: reservation.target.assetId };
    });
    repository.commitVerifiedReuse.mockImplementation(async ({ verifyFinal }) => {
      expect(await verifyFinal()).toMatchObject({ status: 'healthy', sha256: verified.sha256 });
      return { outcome: 'reused', assetId: candidate.id };
    });
    sut = new MediaRecoveryService(repository as unknown as MediaRecoveryRepository, integrity);
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  it('repairs missing originals at a new path with the same ID and retained stage', async () => {
    expect(await sut.reconcile(input)).toEqual({ outcome: 'repaired-missing', assetId: candidate.id });
    expect(await readFile(reservation.promotedPath)).toEqual(bytes);
    expect(await readFile(input.stagedPath)).toEqual(bytes);
  });
  it('repairs incorrect bytes without overwriting a shared original', async () => {
    await writeFile(original, 'damaged original');
    expect(await sut.reconcile(input)).toEqual({ outcome: 'repaired-corrupt', assetId: candidate.id });
    expect(await readFile(original, 'utf8')).toBe('damaged original');
    expect(await readFile(input.stagedPath)).toEqual(bytes);
  });
  it('rehashes the actual healthy original before reuse', async () => {
    await writeFile(original, bytes);
    expect(await sut.reconcile(input)).toEqual({ outcome: 'reused', assetId: candidate.id });
    expect(reservation.promotedPath).toBe(original);
  });
  it.each([
    [{ hidden: true }, 'needs-review', 'hidden_match_requires_consent'],
    [{ status: AssetStatus.Trashed }, 'preserve-trashed', 'destination_not_active'],
  ])('preserves lifecycle/privacy %j', async (patch, outcome, reason) => {
    Object.assign(candidate, patch);
    expect(await sut.reconcile(input)).toMatchObject({ outcome, reason });
    expect(repository.commit).not.toHaveBeenCalled();
    expect(await readFile(input.stagedPath)).toEqual(bytes);
  });
  it('does not equate an unrelated mapping with content identity', async () => {
    candidate.matchesContent = false;
    expect(await sut.reconcile(input)).toMatchObject({
      outcome: 'needs-review',
      reason: 'mapped_asset_identity_changed',
    });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it('retains both recovery copies when commit loses a race', async () => {
    repository.commit.mockResolvedValue({ outcome: 'retry', reason: 'target_changed' });
    expect(await sut.reconcile(input)).toMatchObject({ outcome: 'retry' });
    expect(await readFile(input.stagedPath)).toEqual(bytes);
    expect(await readFile(reservation.promotedPath)).toEqual(bytes);
  });
  it('rejects a truncated staged transfer before reserving', async () => {
    await writeFile(input.stagedPath, 'short');
    expect(await sut.reconcile(input)).toMatchObject({ outcome: 'failed', reason: 'expected_mismatch' });
    expect(repository.reserve).not.toHaveBeenCalled();
  });
  it('skips transfer only after verified mapped bytes and a CAS commit', async () => {
    await writeFile(original, bytes);
    expect(await sut.verifyMapped(input)).toEqual({ outcome: 'reused', assetId: candidate.id });
    expect(repository.commitVerifiedReuse).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'wrong bytes', 'offline', 'dismissed damage'])('redownloads mapped %s', async (condition) => {
    if (condition !== 'missing') {
      await writeFile(original, condition === 'wrong bytes' ? 'bad' : bytes);
    }
    candidate.isOffline = condition === 'offline';
    candidate.damaged = condition === 'dismissed damage';
    expect(await sut.verifyMapped(input)).toBeUndefined();
    expect(repository.commitVerifiedReuse).not.toHaveBeenCalled();
  });
  // owner decision (FL-69): recovery always stores a managed copy; an external match is evidence only
  it.each(['healthy', 'missing', 'damaged'])(
    'imports a new managed asset beside a %s external original and leaves it untouched',
    async (condition) => {
      candidate.isExternal = true;
      candidate.libraryId = randomUUID();
      if (condition !== 'missing') {
        await writeFile(original, condition === 'damaged' ? 'damaged original' : bytes);
      }
      const external = { ...candidate, checksum: Buffer.from(candidate.checksum) };
      expect(await sut.verifyMapped(input)).toBeUndefined();
      expect(repository.commitVerifiedReuse).not.toHaveBeenCalled();
      expect(await sut.reconcile(input)).toEqual({ outcome: 'imported', assetId: importedId });
      expect(repository.reserve).toHaveBeenCalledWith(
        expect.objectContaining({ candidate: undefined, outcome: 'imported', matchedExternalAssetId: candidate.id }),
      );
      expect(reservation.promotedPath).not.toBe(original);
      expect(await readFile(reservation.promotedPath)).toEqual(bytes);
      expect(candidate).toEqual(external);
      if (condition === 'missing') {
        await expect(readFile(original)).rejects.toThrow();
      } else {
        expect(await readFile(original)).toEqual(condition === 'damaged' ? Buffer.from('damaged original') : bytes);
      }
    },
  );
  it('keeps reusing a managed original when an external original matches too', async () => {
    await writeFile(original, bytes);
    repository.findCandidates.mockResolvedValue([{ ...candidate, id: randomUUID(), isExternal: true }, candidate]);
    expect(await sut.reconcile(input)).toEqual({ outcome: 'reused', assetId: candidate.id });
    expect(repository.reserve).toHaveBeenCalledWith(
      expect.not.objectContaining({ matchedExternalAssetId: expect.anything() }),
    );
  });
  it('keeps an established mapping when another same-owner content match exists', async () => {
    repository.findCandidates.mockResolvedValue([{ ...candidate, id: randomUUID() }, candidate]);
    expect(await sut.reconcile(input)).toEqual({ outcome: 'repaired-missing', assetId: candidate.id });
  });
});
