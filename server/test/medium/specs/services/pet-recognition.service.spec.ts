import { Kysely } from 'kysely';
import {
  JobStatus,
  MlWorkload,
  PetObservationSource,
  PetObservationState,
  PetSpecies,
  SystemMetadataKey,
} from 'src/enum.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PetRecognitionService, clearPetPromptCache } from 'src/services/pet-recognition.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { PET_NEGATIVE_PROMPTS, PET_SPECIES_PROMPTS } from 'src/utils/pets.js';
import { mlDestinationStub } from 'test/fixtures/ml-destination.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

/** A fake 512-wide CLIP space: each prompt owns an axis, and axis 500 is what photos of one cat share. */
const vector = (...axes: number[]) => {
  const values = Array.from({ length: 512 }, (_, i) => (axes.includes(i) ? 1 : 0));
  const norm = Math.hypot(...values);
  return `[${values.map((value) => value / norm).join(',')}]`;
};
const prompts = [...PET_SPECIES_PROMPTS.map(({ prompt }) => prompt), ...PET_NEGATIVE_PROMPTS];
const CAT_PHOTO = vector(0, 500);
const LANDSCAPE = vector(PET_SPECIES_PROMPTS.length + 2, 501);

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [ConfigRepository, SearchRepository, SystemMetadataRepository],
    mock: [LoggingRepository, MlDestinationRepository, MachineLearningRepository, JobRepository],
  });
  const pets = new PetRepository(defaultDatabase, LoggingRepository.create());
  const machineLearning = ctx.getMock(MachineLearningRepository);
  const destinations = ctx.getMock(MlDestinationRepository);
  const destination = {
    ...mlDestinationStub.local,
    workloads: [...mlDestinationStub.local.workloads, MlWorkload.PetRecognition],
    lastProbeWorkloads: [...(mlDestinationStub.local.lastProbeWorkloads ?? []), MlWorkload.PetRecognition],
  };
  destinations.getById.mockResolvedValue(destination);
  machineLearning.probe.mockResolvedValue({
    reachable: true,
    workloads: destination.lastProbeWorkloads,
    hardware: null,
    latencyMs: 1,
    probedAt: new Date(),
    error: null,
  });
  machineLearning.encodeText.mockImplementation((_selection, text: string) =>
    Promise.resolve(vector(prompts.indexOf(text))),
  );
  const sut = new PetRecognitionService(
    LoggingRepository.create(),
    pets,
    destinations,
    machineLearning,
    ctx.getMock(JobRepository),
    ctx.get(ConfigRepository),
    ctx.get(SystemMetadataRepository),
  );
  return { ctx, sut, pets, search: ctx.get(SearchRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(() => {
  clearConfigCache();
  clearPetPromptCache();
});

describe(PetRecognitionService.name, () => {
  it('proposes a confirmed cat in a new photo of it, keeps a rejection, and survives a model revision change', async () => {
    const { ctx, sut, pets, search } = setup();
    const { user } = await ctx.newUser();
    const { asset: confirmed } = await ctx.newAsset({ ownerId: user.id });
    const { asset: candidate } = await ctx.newAsset({ ownerId: user.id });
    const { asset: landscape } = await ctx.newAsset({ ownerId: user.id });
    await search.upsert(confirmed.id, CAT_PHOTO);
    await search.upsert(candidate.id, CAT_PHOTO);
    await search.upsert(landscape.id, LANDSCAPE);
    const biscuit = await pets.create({ ownerId: user.id, name: 'Biscuit', species: PetSpecies.Cat });
    const rex = await pets.create({ ownerId: user.id, name: 'Rex', species: PetSpecies.Dog });
    const manual = await pets.upsertObservation({
      petId: biscuit.id,
      assetId: confirmed.id,
      state: PetObservationState.Confirmed,
      source: PetObservationSource.Manual,
    });

    await expect(sut.handleRecognize({ id: candidate.id })).resolves.toBe(JobStatus.Success);
    await expect(sut.handleRecognize({ id: landscape.id })).resolves.toBe(JobStatus.Success);

    const [proposal] = await pets.getCandidates(user.id, 10);
    expect(proposal).toMatchObject({ petId: biscuit.id, assetId: candidate.id, detectedSpecies: PetSpecies.Cat });
    expect(await pets.getCandidates(user.id, 10)).toHaveLength(1); // no dog, no landscape
    await expect(pets.getDetectionsForAsset(landscape.id)).resolves.toEqual([]);

    // the owner ignores it; a rerun under a new CLIP model proposes nothing again
    await pets.upsertObservation({
      petId: biscuit.id,
      assetId: candidate.id,
      state: PetObservationState.Rejected,
      source: PetObservationSource.Review,
    });
    await pets.deleteCandidates(proposal.detectionId, [biscuit.id]);
    await ctx.get(SystemMetadataRepository).set(SystemMetadataKey.SystemConfig, {
      machineLearning: { clip: { modelName: 'ViT-B-32__openai' } },
    });
    clearConfigCache();

    await sut.handleRecognize({ id: candidate.id });

    const detections = await pets.getDetectionsForAsset(candidate.id);
    expect(detections).toEqual([expect.objectContaining({ modelName: 'ViT-B-32__openai' })]);
    await expect(pets.getCandidates(user.id, 10)).resolves.toEqual([]);
    // durable data untouched: the manual confirmation, the pets and their names
    await expect(pets.getObservationById(user.id, manual.id)).resolves.toMatchObject({
      state: PetObservationState.Confirmed,
      source: PetObservationSource.Manual,
    });
    await expect(pets.getById(user.id, rex.id)).resolves.toMatchObject({ name: 'Rex' });
  });

  it('finds the owner’s most similar photos only after a confirmation', async () => {
    const { ctx, pets, search } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: confirmed } = await ctx.newAsset({ ownerId: user.id });
    const { asset: near } = await ctx.newAsset({ ownerId: user.id });
    const { asset: far } = await ctx.newAsset({ ownerId: user.id });
    const { asset: stranger } = await ctx.newAsset({ ownerId: other.id });
    await search.upsert(confirmed.id, CAT_PHOTO);
    await search.upsert(near.id, vector(0, 500, 3));
    await search.upsert(far.id, LANDSCAPE);
    await search.upsert(stranger.id, CAT_PHOTO);

    await expect(pets.getNearestAssetIds(user.id, confirmed.id, 1)).resolves.toEqual([near.id]);
    await expect(pets.getNearestAssetIds(user.id, confirmed.id, 10)).resolves.not.toContain(stranger.id);
  });
});
