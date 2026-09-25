import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Mock } from 'vitest';
import { AuthSession } from 'src/database.js';
import {
  JobName,
  MlDestinationKind,
  PetObservationSource,
  PetObservationState,
  PetRecognitionUnavailableReason,
  PetSpecies,
} from 'src/enum.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { PetRecognitionService, PetRecognitionStatus } from 'src/services/pet-recognition.service.js';
import { PetService } from 'src/services/pet.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

// eslint-friendly alias: a mock whose implementation may return anything, promises included.
type AnyMock = Mock<(...args: any[]) => any>;

const ownerId = authStub.user1.user.id;
const petId = '11111111-1111-4111-8111-111111111111';
const otherPetId = '22222222-2222-4222-8222-222222222222';
const assetId = '33333333-3333-4333-8333-333333333333';
const candidateId = '44444444-4444-4444-8444-444444444444';
const detectionId = '55555555-5555-4555-8555-555555555555';
const observationId = '66666666-6666-4666-8666-666666666666';

const pet = (overrides: Record<string, unknown> = {}) => ({
  id: petId,
  ownerId,
  name: 'Biscuit',
  species: PetSpecies.Cat,
  birthDate: null,
  featuredAssetId: null,
  isHidden: false,
  isFavorite: false,
  assetCount: 0,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const observation = (overrides: Record<string, unknown> = {}) => ({
  id: observationId,
  petId,
  assetId,
  state: PetObservationState.Confirmed,
  source: PetObservationSource.Manual,
  boundingBoxX1: null,
  boundingBoxY1: null,
  boundingBoxX2: null,
  boundingBoxY2: null,
  imageWidth: null,
  imageHeight: null,
  sourceChecksum: null,
  staleAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const checksum = Buffer.from('current original');
const unavailable: PetRecognitionStatus = {
  available: false,
  reason: PetRecognitionUnavailableReason.WorkloadNotRouted,
  detail: 'no destination is routed for pet-recognition',
  destination: null,
  hasConfirmedPhotos: true,
  run: null,
};

const reviewCandidate = (overrides: Record<string, unknown> = {}) => ({
  id: candidateId,
  score: 0.61,
  petId,
  assetId,
  assetChecksum: Buffer.from('current original'),
  detectionId,
  detectedSpecies: 'cat',
  modelName: 'pet-v1',
  modelRevision: 'r1',
  boundingBoxX1: 10,
  boundingBoxY1: 20,
  boundingBoxX2: 110,
  boundingBoxY2: 140,
  imageWidth: 800,
  imageHeight: 600,
  ...overrides,
});

/** A session that is not unlocked while the owner suppresses `petId` (owner decision, September 22, 2026). */
const lockedAuth = () => ({
  ...authStub.user1,
  hideNsfwAssets: true,
  hiddenContent: {
    userId: ownerId,
    includeNsfw: false,
    tagIds: [],
    personIds: [],
    petIds: [petId],
    scope: 'owned' as const,
  },
});

/** The same owner, unlocked: `auth.hiddenContent` is never set for an elevated session. */
const unlockedAuth = () => ({
  ...authStub.user1,
  suppressedContent: lockedAuth().hiddenContent,
});

describe(PetService.name, () => {
  let sut: PetService;
  let mocks: ServiceMocks;
  let petRepository: PetRepository;
  let petRecognition: PetRecognitionService;

  beforeEach(() => {
    mocks = getMocks();
    petRepository = {
      getAll: vi.fn().mockResolvedValue([]),
      getById: vi.fn().mockResolvedValue(pet()),
      getByIds: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      isOwnedAsset: vi.fn().mockResolvedValue(true),
      isOwnLockedAsset: vi.fn().mockResolvedValue(false),
      getObservations: vi.fn().mockResolvedValue([]),
      getObservationById: vi.fn().mockResolvedValue(observation()),
      upsertObservation: vi.fn().mockImplementation((value) => Promise.resolve(observation(value))),
      deleteObservation: vi.fn().mockResolvedValue(true),
      getDecisions: vi.fn().mockResolvedValue([]),
      mergeInto: vi.fn(),
      getCandidates: vi.fn().mockResolvedValue([]),
      getCandidateById: vi.fn().mockResolvedValue(reviewCandidate()),
      deleteCandidates: vi.fn(),
      getDetectionsForAsset: vi.fn().mockResolvedValue([]),
      replaceDetections: vi.fn(),
      upsertCandidates: vi.fn(),
      getOwnedAssetChecksum: vi.fn().mockResolvedValue(checksum),
      getObservationsForAsset: vi.fn().mockResolvedValue([]),
    } as unknown as PetRepository;
    petRecognition = {
      getStatus: vi.fn().mockResolvedValue(unavailable),
      startRun: vi.fn(),
      cancelRun: vi.fn(),
    } as unknown as PetRecognitionService;

    sut = new PetService(
      mocks.access as never,
      petRepository,
      mocks.logger as never,
      mocks.job as never,
      petRecognition,
    );

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
  });

  describe('create', () => {
    it('stores a trimmed name and the owner-declared species', async () => {
      (petRepository.create as AnyMock).mockResolvedValue(pet({ name: 'Biscuit' }));

      await sut.create(authStub.user1, { name: '  Biscuit  ', species: PetSpecies.Cat });

      expect(petRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId, name: 'Biscuit', species: PetSpecies.Cat }),
      );
    });

    it('refuses a Locked photo as the featured photo (FL-53)', async () => {
      (petRepository.isOwnLockedAsset as AnyMock).mockResolvedValue(true);

      await expect(sut.create(authStub.user1, { species: PetSpecies.Dog, featuredAssetId: assetId })).rejects.toThrow(
        'A Locked photo cannot be a featured photo',
      );
      expect(petRepository.create).not.toHaveBeenCalled();
    });

    it('refuses a featured photo the account does not own', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(
        sut.create(authStub.user1, { species: PetSpecies.Dog, featuredAssetId: assetId }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(petRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('getAll', () => {
    it('lists without a privacy filter in an unlocked session', async () => {
      await sut.getAll(authStub.user1, {});

      expect(petRepository.getAll).toHaveBeenCalledWith(ownerId, { withHidden: false });
    });

    it('hands the session hidden-content filter to the listing so suppressed pets stay out', async () => {
      const hiddenContent = {
        userId: ownerId,
        includeNsfw: false,
        tagIds: [],
        personIds: [],
        petIds: [petId],
        scope: 'owned' as const,
      };

      await sut.getAll({ ...authStub.user1, hiddenContent, hideNsfwAssets: true }, { withHidden: true });

      expect(petRepository.getAll).toHaveBeenCalledWith(ownerId, { withHidden: true, hiddenContent });
    });
  });

  describe('update', () => {
    it('refuses a Locked photo as the featured photo (FL-53)', async () => {
      (petRepository.isOwnLockedAsset as AnyMock).mockResolvedValue(true);

      await expect(sut.update(authStub.user1, petId, { featuredAssetId: assetId })).rejects.toThrow(
        'A Locked photo cannot be a featured photo',
      );
      expect(petRepository.isOwnLockedAsset).toHaveBeenCalledWith(ownerId, assetId);
      expect(petRepository.update).not.toHaveBeenCalled();
    });

    it('accepts a featured photo that is not Locked', async () => {
      await sut.update(authStub.user1, petId, { featuredAssetId: assetId });

      expect(petRepository.update).toHaveBeenCalledWith(ownerId, petId, { featuredAssetId: assetId });
    });

    it('clears the featured photo without looking at any asset', async () => {
      await sut.update(authStub.user1, petId, { featuredAssetId: null });

      expect(petRepository.isOwnLockedAsset).not.toHaveBeenCalled();
      expect(petRepository.update).toHaveBeenCalledWith(ownerId, petId, { featuredAssetId: null });
    });
  });

  describe('get', () => {
    it('does not reveal another account’s pet', async () => {
      (petRepository.getById as AnyMock).mockResolvedValue(undefined);

      await expect(sut.get(authStub.user1, petId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.getById).toHaveBeenCalledWith(ownerId, petId, {});
    });
  });

  describe('Locked media (FL-34)', () => {
    it('counts, lists and proposes the caller’s Locked media only in an elevated session', async () => {
      const elevated = { ...authStub.user1, session: { id: 'session-id', hasElevatedPermission: true } as AuthSession };
      const locked = { lockedOwnerId: ownerId };

      await sut.getAll(elevated, {});
      await sut.getObservations(elevated, petId);
      await sut.getCandidates(elevated, { size: 10 });

      expect(petRepository.getAll).toHaveBeenCalledWith(ownerId, { withHidden: false, ...locked });
      expect(petRepository.getById).toHaveBeenCalledWith(ownerId, petId, locked);
      expect(petRepository.getObservations).toHaveBeenCalledWith(ownerId, petId, locked);
      expect(petRepository.getCandidates).toHaveBeenCalledWith(ownerId, 10, locked);
    });

    it('leaves Locked media out of an ordinary session', async () => {
      await sut.getAll(authStub.user1, {});
      await sut.getObservations(authStub.user1, petId);

      expect(petRepository.getAll).toHaveBeenCalledWith(ownerId, { withHidden: false });
      expect(petRepository.getObservations).toHaveBeenCalledWith(ownerId, petId, {});
    });

    it('merges every observation, Locked ones included', async () => {
      (petRepository.getByIds as AnyMock).mockResolvedValue([pet({ id: otherPetId })]);

      await sut.merge(authStub.user1, petId, { ids: [otherPetId] });

      expect(petRepository.getObservations).toHaveBeenCalledWith(ownerId, otherPetId, { withLocked: true });
      expect(petRepository.getObservations).toHaveBeenCalledWith(ownerId, petId, { withLocked: true });
    });

    it('answers a pet suppressed while the session is locked exactly like a missing one', async () => {
      const suppressed = await sut.get(lockedAuth(), petId).catch((error: unknown) => error);
      (petRepository.getById as AnyMock).mockResolvedValue(undefined);
      const missing = await sut.get(authStub.user1, otherPetId).catch((error: unknown) => error);

      expect(suppressed).toBeInstanceOf(NotFoundException);
      expect(missing).toBeInstanceOf(NotFoundException);
      expect((suppressed as NotFoundException).getResponse()).toEqual((missing as NotFoundException).getResponse());
    });

    it('shows a suppressed pet once the session is unlocked', async () => {
      await expect(sut.get(unlockedAuth(), petId)).resolves.toEqual(expect.objectContaining({ id: petId }));
    });

    it('still shows a pet that is not suppressed in a locked session', async () => {
      (petRepository.getById as AnyMock).mockResolvedValue(pet({ id: otherPetId }));

      await expect(sut.get(lockedAuth(), otherPetId)).resolves.toEqual(expect.objectContaining({ id: otherPetId }));
    });
  });

  describe('writes to a suppressed pet while locked', () => {
    it('answers an update with 404 and writes nothing', async () => {
      await expect(sut.update(lockedAuth(), petId, { name: 'Rex' })).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.update).not.toHaveBeenCalled();
    });

    it('answers a delete with 404 and deletes nothing', async () => {
      await expect(sut.remove(lockedAuth(), petId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.delete).not.toHaveBeenCalled();
    });

    it('answers a new observation with 404', async () => {
      await expect(sut.addObservation(lockedAuth(), petId, { assetId })).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('answers its observation list with 404', async () => {
      await expect(sut.getObservations(lockedAuth(), petId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.getObservations).not.toHaveBeenCalled();
    });

    it('answers removing one of its observations with 404', async () => {
      await expect(sut.removeObservation(lockedAuth(), observationId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.deleteObservation).not.toHaveBeenCalled();
    });

    it('answers a merge into it with 404', async () => {
      await expect(sut.merge(lockedAuth(), petId, { ids: [otherPetId] })).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.mergeInto).not.toHaveBeenCalled();
    });

    it('refuses to merge it into another pet the same way as a missing source', async () => {
      (petRepository.getById as AnyMock).mockResolvedValue(pet({ id: otherPetId }));
      (petRepository.getByIds as AnyMock).mockResolvedValue([pet()]);

      await expect(sut.merge(lockedAuth(), otherPetId, { ids: [petId] })).rejects.toThrow('Pet not found');
      expect(petRepository.mergeInto).not.toHaveBeenCalled();
    });

    it('answers accepting or rejecting a proposal about it with 404', async () => {
      await expect(sut.acceptCandidate(lockedAuth(), candidateId, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.rejectCandidate(lockedAuth(), candidateId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('lets the unlocked session change it', async () => {
      await sut.remove(unlockedAuth(), petId);

      expect(petRepository.delete).toHaveBeenCalledWith(ownerId, petId);
    });
  });

  describe('addObservation', () => {
    it('checks asset access before writing anything durable', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.addObservation(authStub.user1, petId, { assetId })).rejects.toBeInstanceOf(BadRequestException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('refuses a drawn region with 409 when the original changed since the photo was opened', async () => {
      await expect(
        sut.addObservation(authStub.user1, petId, {
          assetId,
          expectedChecksum: Buffer.from('old').toString('base64'),
          boundingBoxX1: 1,
          boundingBoxY1: 1,
          boundingBoxX2: 10,
          boundingBoxY2: 10,
          imageWidth: 100,
          imageHeight: 100,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('confirms and then looks for the pet in the owner’s most similar photos', async () => {
      await sut.addObservation(authStub.user1, petId, { assetId, expectedChecksum: checksum.toString('base64') });

      expect(petRepository.upsertObservation).toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PetRecognitionNearest, data: { petId, assetId } });
    });

    it('records a whole-photo observation when no region is drawn', async () => {
      await sut.addObservation(authStub.user1, petId, { assetId });

      expect(petRepository.upsertObservation).toHaveBeenCalledWith({
        petId,
        assetId,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
        boundingBoxX1: null,
        boundingBoxY1: null,
        boundingBoxX2: null,
        boundingBoxY2: null,
        imageWidth: null,
        imageHeight: null,
      });
    });

    it('rejects a partial region', async () => {
      await expect(
        sut.addObservation(authStub.user1, petId, { assetId, boundingBoxX1: 1, boundingBoxY1: 2 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a region that falls outside the image', async () => {
      await expect(
        sut.addObservation(authStub.user1, petId, {
          assetId,
          boundingBoxX1: 0,
          boundingBoxY1: 0,
          boundingBoxX2: 900,
          boundingBoxY2: 10,
          imageWidth: 800,
          imageHeight: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects an inverted region', async () => {
      await expect(
        sut.addObservation(authStub.user1, petId, {
          assetId,
          boundingBoxX1: 100,
          boundingBoxY1: 100,
          boundingBoxX2: 10,
          boundingBoxY2: 200,
          imageWidth: 800,
          imageHeight: 600,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('getCandidates', () => {
    it('leaves out proposals about a pet suppressed while the session is locked', async () => {
      (petRepository.getCandidates as AnyMock).mockResolvedValue([
        reviewCandidate(),
        reviewCandidate({ id: 'other-candidate', petId: otherPetId }),
      ]);

      const locked = await sut.getCandidates(lockedAuth(), { size: 50 });
      const unlocked = await sut.getCandidates(unlockedAuth(), { size: 50 });

      expect(locked.candidates.map(({ petId }) => petId)).toEqual([otherPetId]);
      expect(unlocked.candidates).toHaveLength(2);
    });

    it('reports the routed destination’s refusal instead of claiming the queue is reviewed', async () => {
      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.recognitionAvailable).toBe(false);
      expect(result.recognitionUnavailableReason).toBe(PetRecognitionUnavailableReason.WorkloadNotRouted);
      expect(result.recognition).toMatchObject({ available: false, destination: null, run: null });
      expect(result.candidates).toEqual([]);
    });

    it('names the destination recognition runs on when it is available', async () => {
      (petRecognition.getStatus as AnyMock).mockResolvedValue({
        ...unavailable,
        available: true,
        reason: null,
        detail: null,
        destination: { kind: MlDestinationKind.Lan, name: 'Garage PC' },
      });

      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.recognitionAvailable).toBe(true);
      expect(result.recognition.destination).toEqual({ kind: MlDestinationKind.Lan, name: 'Garage PC' });
    });

    it('hides a proposal the owner already rejected, so a model rerun cannot resurrect it', async () => {
      (petRepository.getCandidates as AnyMock).mockResolvedValue([
        reviewCandidate({ modelName: 'pet-v2', modelRevision: 'r9' }),
      ]);
      (petRepository.getDecisions as AnyMock).mockResolvedValue([
        { id: observationId, assetId, petId, state: PetObservationState.Rejected },
      ]);

      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.candidates).toEqual([]);
    });

    it('keeps a proposal about a pet the owner has not answered for that asset', async () => {
      (petRepository.getCandidates as AnyMock).mockResolvedValue([reviewCandidate({ petId: otherPetId })]);
      (petRepository.getDecisions as AnyMock).mockResolvedValue([
        { id: observationId, assetId, petId, state: PetObservationState.Rejected },
      ]);

      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.candidates).toHaveLength(1);
      expect(result.candidates[0]).toMatchObject({ petId: otherPetId, modelName: 'pet-v1', modelRevision: 'r1' });
    });
  });

  describe('acceptCandidate', () => {
    it('writes a durable confirmation carrying the detected region and clears the proposals', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, {});

      expect(petRepository.upsertObservation).toHaveBeenCalledWith({
        petId,
        assetId,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Review,
        boundingBoxX1: 10,
        boundingBoxY1: 20,
        boundingBoxX2: 110,
        boundingBoxY2: 140,
        imageWidth: 800,
        imageHeight: 600,
      });
      expect(petRepository.deleteCandidates).toHaveBeenCalledWith(detectionId, [petId]);
    });

    it('never answers for other pets proposed for the same photo', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, { petId: otherPetId });

      expect(petRepository.deleteCandidates).toHaveBeenCalledWith(detectionId, [petId, otherPetId]);
    });

    it('looks for the pet again in the owner’s most similar photos', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, {});

      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PetRecognitionNearest, data: { petId, assetId } });
    });

    it('refuses with 409 when the original changed since the photo was opened', async () => {
      await expect(
        sut.acceptCandidate(authStub.user1, candidateId, { expectedChecksum: Buffer.from('old').toString('base64') }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('accepts when the named checksum is the current one', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, { expectedChecksum: checksum.toString('base64') });

      expect(petRepository.upsertObservation).toHaveBeenCalled();
    });

    it('checks the reassignment target is the caller’s own pet', async () => {
      (petRepository.getById as AnyMock).mockResolvedValue(undefined);

      await expect(sut.acceptCandidate(authStub.user1, candidateId, { petId: otherPetId })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('reassigns to a different pet when one is named', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, { petId: otherPetId });

      expect(petRepository.upsertObservation).toHaveBeenCalledWith(
        expect.objectContaining({ petId: otherPetId, state: PetObservationState.Confirmed }),
      );
    });

    it('does not reveal a candidate over another account’s asset', async () => {
      (petRepository.getCandidateById as AnyMock).mockResolvedValue(undefined);

      await expect(sut.acceptCandidate(authStub.user1, candidateId, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('rejectCandidate', () => {
    it('stores the rejection durably rather than only deleting the proposal', async () => {
      await sut.rejectCandidate(authStub.user1, candidateId);

      expect(petRepository.upsertObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          petId,
          assetId,
          state: PetObservationState.Rejected,
          source: PetObservationSource.Review,
        }),
      );
      expect(petRepository.deleteCandidates).toHaveBeenCalledWith(detectionId, [petId]);
    });

    it('refuses with 409 when the original changed since the photo was opened', async () => {
      await expect(
        sut.rejectCandidate(authStub.user1, candidateId, { expectedChecksum: Buffer.from('old').toString('base64') }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });
  });

  describe('recognition runs', () => {
    it('refuses to start with the destination’s reason, queueing nothing', async () => {
      await expect(sut.startRecognition(authStub.user1)).rejects.toThrow(/workload-not-routed/);
      expect(petRecognition.startRun).not.toHaveBeenCalled();
    });

    it('refuses to start before any pet is confirmed in a photo', async () => {
      (petRecognition.getStatus as AnyMock).mockResolvedValue({
        ...unavailable,
        available: true,
        reason: null,
        hasConfirmedPhotos: false,
      });

      await expect(sut.startRecognition(authStub.user1)).rejects.toBeInstanceOf(BadRequestException);
      expect(petRecognition.startRun).not.toHaveBeenCalled();
    });

    it('starts a run on the routed destination', async () => {
      (petRecognition.getStatus as AnyMock).mockResolvedValue({
        ...unavailable,
        available: true,
        reason: null,
        detail: null,
        destination: { kind: MlDestinationKind.Local, name: 'This server' },
      });

      await sut.startRecognition(authStub.user1);

      expect(petRecognition.startRun).toHaveBeenCalledWith(ownerId, MlDestinationKind.Local);
    });

    it('cancels the owner’s own run', async () => {
      await sut.cancelRecognition(authStub.user1);

      expect(petRecognition.cancelRun).toHaveBeenCalledWith(ownerId);
    });
  });

  describe('getAssetObservations', () => {
    it('checks the caller may read the asset first', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.getAssetObservations(authStub.user1, { assetId })).rejects.toBeInstanceOf(BadRequestException);
      expect(petRepository.getObservationsForAsset).not.toHaveBeenCalled();
    });

    it('lists the owner’s decisions with their source checksum and stale flag', async () => {
      (petRepository.getObservationsForAsset as AnyMock).mockResolvedValue([
        observation({
          boundingBoxX1: 1,
          sourceChecksum: Buffer.from('old'),
          staleAt: new Date('2026-02-01T00:00:00.000Z'),
        }),
      ]);

      const [result] = await sut.getAssetObservations(authStub.user1, { assetId });

      expect(result).toMatchObject({
        sourceChecksum: Buffer.from('old').toString('base64'),
        staleAt: '2026-02-01T00:00:00.000Z',
      });
    });

    it('leaves out a pet suppressed while the session is locked', async () => {
      (petRepository.getObservationsForAsset as AnyMock).mockResolvedValue([observation()]);

      await expect(sut.getAssetObservations(lockedAuth(), { assetId })).resolves.toEqual([]);
    });
  });

  describe('merge', () => {
    it('refuses to merge a pet into itself', async () => {
      await expect(sut.merge(authStub.user1, petId, { ids: [petId] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when a source pet is not the caller’s', async () => {
      (petRepository.getByIds as AnyMock).mockResolvedValue([]);

      await expect(sut.merge(authStub.user1, petId, { ids: [otherPetId] })).rejects.toBeInstanceOf(BadRequestException);
      expect(petRepository.mergeInto).not.toHaveBeenCalled();
    });

    it('promotes a rejection when the merged-in pet was confirmed on the same asset', async () => {
      (petRepository.getByIds as AnyMock).mockResolvedValue([pet({ id: otherPetId })]);
      (petRepository.getObservations as AnyMock).mockImplementation((_owner, id) =>
        Promise.resolve(
          id === otherPetId
            ? [observation({ id: 'source-1', petId: otherPetId, state: PetObservationState.Confirmed })]
            : [observation({ id: 'target-1', petId, state: PetObservationState.Rejected })],
        ),
      );

      await sut.merge(authStub.user1, petId, { ids: [otherPetId] });

      expect(petRepository.mergeInto).toHaveBeenCalledWith(ownerId, {
        sourceId: otherPetId,
        targetId: petId,
        reassign: [],
        discard: ['source-1'],
        promote: ['target-1'],
      });
    });
  });

  describe('removeObservation', () => {
    it('does not remove an observation belonging to another account', async () => {
      (petRepository.getObservationById as AnyMock).mockResolvedValue(undefined);

      await expect(sut.removeObservation(authStub.user1, observationId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.deleteObservation).not.toHaveBeenCalled();
    });

    it('removes the caller’s own observation and sends the photo back through recognition', async () => {
      await sut.removeObservation(authStub.user1, observationId);

      expect(petRepository.deleteObservation).toHaveBeenCalledWith(ownerId, observationId);
      expect(mocks.job.queue).toHaveBeenCalledWith({ name: JobName.PetRecognition, data: { id: assetId } });
    });

    it('refuses an undo with 409 when the original changed since the photo was opened', async () => {
      await expect(
        sut.removeObservation(authStub.user1, observationId, {
          expectedChecksum: Buffer.from('old').toString('base64'),
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(petRepository.deleteObservation).not.toHaveBeenCalled();
    });
  });
});
