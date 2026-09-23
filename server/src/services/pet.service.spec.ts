import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PetObservationSource, PetObservationState, PetSpecies } from 'src/enum.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { PET_RECOGNITION_UNAVAILABLE_REASON, PetService } from 'src/services/pet.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

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
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

const reviewCandidate = (overrides: Record<string, unknown> = {}) => ({
  id: candidateId,
  score: 0.61,
  petId,
  assetId,
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

describe(PetService.name, () => {
  let sut: PetService;
  let mocks: ServiceMocks;
  let petRepository: PetRepository;

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
      getObservations: vi.fn().mockResolvedValue([]),
      getObservationById: vi.fn().mockResolvedValue(observation()),
      upsertObservation: vi.fn().mockImplementation((value) => Promise.resolve(observation(value))),
      deleteObservation: vi.fn().mockResolvedValue(true),
      getDecisions: vi.fn().mockResolvedValue([]),
      mergeInto: vi.fn(),
      getCandidates: vi.fn().mockResolvedValue([]),
      getCandidateById: vi.fn().mockResolvedValue(reviewCandidate()),
      deleteCandidatesForDetection: vi.fn(),
      getDetectionsForAsset: vi.fn().mockResolvedValue([]),
      replaceDetections: vi.fn(),
      upsertCandidates: vi.fn(),
    } as unknown as PetRepository;

    sut = new PetService(mocks.access as never, petRepository, mocks.logger as never);

    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
  });

  describe('create', () => {
    it('stores a trimmed name and the owner-declared species', async () => {
      (petRepository.create as ReturnType<typeof vi.fn>).mockResolvedValue(pet({ name: 'Biscuit' }));

      await sut.create(authStub.user1, { name: '  Biscuit  ', species: PetSpecies.Cat });

      expect(petRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId, name: 'Biscuit', species: PetSpecies.Cat }),
      );
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

  describe('get', () => {
    it('does not reveal another account’s pet', async () => {
      (petRepository.getById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await expect(sut.get(authStub.user1, petId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.getById).toHaveBeenCalledWith(ownerId, petId);
    });
  });

  describe('addObservation', () => {
    it('checks asset access before writing anything durable', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());

      await expect(sut.addObservation(authStub.user1, petId, { assetId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
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
    it('reports honestly that no recognition model is available', async () => {
      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.recognitionAvailable).toBe(false);
      expect(result.recognitionUnavailableReason).toBe(PET_RECOGNITION_UNAVAILABLE_REASON);
      expect(result.candidates).toEqual([]);
    });

    it('hides a proposal the owner already rejected, so a model rerun cannot resurrect it', async () => {
      (petRepository.getCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
        reviewCandidate({ modelName: 'pet-v2', modelRevision: 'r9' }),
      ]);
      (petRepository.getDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: observationId, assetId, petId, state: PetObservationState.Rejected },
      ]);

      const result = await sut.getCandidates(authStub.user1, { size: 100 });

      expect(result.candidates).toEqual([]);
    });

    it('keeps a proposal about a pet the owner has not answered for that asset', async () => {
      (petRepository.getCandidates as ReturnType<typeof vi.fn>).mockResolvedValue([
        reviewCandidate({ petId: otherPetId }),
      ]);
      (petRepository.getDecisions as ReturnType<typeof vi.fn>).mockResolvedValue([
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
      expect(petRepository.deleteCandidatesForDetection).toHaveBeenCalledWith(detectionId);
    });

    it('checks the reassignment target is the caller’s own pet', async () => {
      (petRepository.getById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await expect(
        sut.acceptCandidate(authStub.user1, candidateId, { petId: otherPetId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.upsertObservation).not.toHaveBeenCalled();
    });

    it('reassigns to a different pet when one is named', async () => {
      await sut.acceptCandidate(authStub.user1, candidateId, { petId: otherPetId });

      expect(petRepository.upsertObservation).toHaveBeenCalledWith(
        expect.objectContaining({ petId: otherPetId, state: PetObservationState.Confirmed }),
      );
    });

    it('does not reveal a candidate over another account’s asset', async () => {
      (petRepository.getCandidateById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

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
      expect(petRepository.deleteCandidatesForDetection).toHaveBeenCalledWith(detectionId);
    });
  });

  describe('merge', () => {
    it('refuses to merge a pet into itself', async () => {
      await expect(sut.merge(authStub.user1, petId, { ids: [petId] })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses when a source pet is not the caller’s', async () => {
      (petRepository.getByIds as ReturnType<typeof vi.fn>).mockResolvedValue([]);

      await expect(sut.merge(authStub.user1, petId, { ids: [otherPetId] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(petRepository.mergeInto).not.toHaveBeenCalled();
    });

    it('promotes a rejection when the merged-in pet was confirmed on the same asset', async () => {
      (petRepository.getByIds as ReturnType<typeof vi.fn>).mockResolvedValue([pet({ id: otherPetId })]);
      (petRepository.getObservations as ReturnType<typeof vi.fn>).mockImplementation((_owner, id) =>
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
      (petRepository.getObservationById as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

      await expect(sut.removeObservation(authStub.user1, observationId)).rejects.toBeInstanceOf(NotFoundException);
      expect(petRepository.deleteObservation).not.toHaveBeenCalled();
    });

    it('removes the caller’s own observation', async () => {
      await sut.removeObservation(authStub.user1, observationId);

      expect(petRepository.deleteObservation).toHaveBeenCalledWith(ownerId, observationId);
    });
  });
});
