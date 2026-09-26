import { describe, expect, it } from 'vitest';
import { PetObservationState, PetSpecies } from 'src/enum.js';
import {
  PET_MATCHER_REVISION,
  PET_RECOGNITION_THRESHOLDS,
  asKnownSpecies,
  detectionsToReplace,
  filterReviewedCandidates,
  isNamedPet,
  isSpeciesCompatible,
  isStaleDetection,
  isStaleRegion,
  matchPets,
  neighbourSimilarity,
  normalizePetName,
  petRecognitionRun,
  planObservationMerge,
  readSpecies,
  sortCandidatesForReview,
} from 'src/utils/pets.js';

const decision = (assetId: string, petId: string, state: PetObservationState, id = `${assetId}-${petId}`) => ({
  id,
  assetId,
  petId,
  state,
});

const candidate = (id: string, assetId: string, petId: string, score: number) => ({ id, assetId, petId, score });

describe('normalizePetName', () => {
  it('trims and keeps an empty name as a real "not named yet" value', () => {
    expect(normalizePetName('  Biscuit  ')).toBe('Biscuit');
    expect(normalizePetName(' '.repeat(3))).toBe('');
    expect(isNamedPet({ name: ' '.repeat(3) })).toBe(false);
    expect(isNamedPet({ name: 'Biscuit' })).toBe(true);
  });

  it('caps the stored length', () => {
    expect(normalizePetName('a'.repeat(400))).toHaveLength(100);
  });
});

describe('asKnownSpecies', () => {
  it('maps a detector guess onto a known species, or nothing', () => {
    expect(asKnownSpecies('Cat')).toBe(PetSpecies.Cat);
    expect(asKnownSpecies('wolverine')).toBeNull();
    expect(asKnownSpecies(null)).toBeNull();
    expect(asKnownSpecies('')).toBeNull();
  });
});

describe('filterReviewedCandidates', () => {
  it('drops a proposal the owner already confirmed', () => {
    const candidates = [candidate('c1', 'asset-1', 'pet-1', 0.9)];
    const result = filterReviewedCandidates(candidates, [decision('asset-1', 'pet-1', PetObservationState.Confirmed)]);
    expect(result).toEqual([]);
  });

  it('drops a proposal the owner already rejected, so reprocessing cannot resurrect it', () => {
    const candidates = [candidate('c1', 'asset-1', 'pet-1', 0.42)];
    const result = filterReviewedCandidates(candidates, [decision('asset-1', 'pet-1', PetObservationState.Rejected)]);
    expect(result).toEqual([]);
  });

  it('keeps a proposal about a different pet in the same asset', () => {
    const candidates = [candidate('c1', 'asset-1', 'pet-2', 0.5)];
    const result = filterReviewedCandidates(candidates, [decision('asset-1', 'pet-1', PetObservationState.Rejected)]);
    expect(result).toEqual(candidates);
  });

  it('keeps a proposal about the same pet in a different asset', () => {
    const candidates = [candidate('c1', 'asset-2', 'pet-1', 0.5)];
    const result = filterReviewedCandidates(candidates, [decision('asset-1', 'pet-1', PetObservationState.Confirmed)]);
    expect(result).toEqual(candidates);
  });
});

describe('sortCandidatesForReview', () => {
  it('puts the least certain proposals first and breaks ties stably', () => {
    const candidates = [
      candidate('c2', 'asset-1', 'pet-1', 0.9),
      candidate('c3', 'asset-2', 'pet-1', 0.2),
      candidate('c1', 'asset-3', 'pet-1', 0.2),
    ];
    expect(sortCandidatesForReview(candidates).map(({ id }) => id)).toEqual(['c1', 'c3', 'c2']);
  });

  it('does not mutate the input', () => {
    const candidates = [candidate('c2', 'a', 'p', 0.9), candidate('c1', 'a', 'p', 0.1)];
    sortCandidatesForReview(candidates);
    expect(candidates.map(({ id }) => id)).toEqual(['c2', 'c1']);
  });
});

describe('planObservationMerge', () => {
  it('moves observations the target does not have', () => {
    const plan = planObservationMerge(
      [decision('asset-1', 'source', PetObservationState.Confirmed, 'o1')],
      [decision('asset-2', 'target', PetObservationState.Confirmed, 'o2')],
    );
    expect(plan).toEqual({ reassign: ['o1'], discard: [], promote: [] });
  });

  it('promotes a rejection to a confirmation when the other pet was confirmed there', () => {
    const plan = planObservationMerge(
      [decision('asset-1', 'source', PetObservationState.Confirmed, 'o1')],
      [decision('asset-1', 'target', PetObservationState.Rejected, 'o2')],
    );
    expect(plan).toEqual({ reassign: [], discard: ['o1'], promote: ['o2'] });
  });

  it('keeps an existing confirmation and drops the duplicate', () => {
    const plan = planObservationMerge(
      [decision('asset-1', 'source', PetObservationState.Rejected, 'o1')],
      [decision('asset-1', 'target', PetObservationState.Confirmed, 'o2')],
    );
    expect(plan).toEqual({ reassign: [], discard: ['o1'], promote: [] });
  });

  it('never loses a decision: every source observation is either reassigned or discarded', () => {
    const source = [
      decision('asset-1', 'source', PetObservationState.Confirmed, 'o1'),
      decision('asset-2', 'source', PetObservationState.Rejected, 'o2'),
      decision('asset-3', 'source', PetObservationState.Confirmed, 'o3'),
    ];
    const target = [decision('asset-2', 'target', PetObservationState.Confirmed, 't2')];

    const plan = planObservationMerge(source, target);
    expect([...plan.reassign, ...plan.discard].sort()).toEqual(['o1', 'o2', 'o3']);
  });
});

describe('detectionsToReplace', () => {
  const run = { modelName: 'pet-v1', modelRevision: 'r2' };

  it('marks detections from another revision stale', () => {
    expect(isStaleDetection({ modelName: 'pet-v1', modelRevision: 'r1' }, run)).toBe(true);
    expect(isStaleDetection({ modelName: 'pet-v2', modelRevision: 'r2' }, run)).toBe(true);
    expect(isStaleDetection({ modelName: 'pet-v1', modelRevision: 'r2' }, run)).toBe(false);
  });

  it('replaces the whole replaceable side for the asset, stale and current alike', () => {
    const stored = [
      { id: 'd1', modelName: 'pet-v1', modelRevision: 'r1' },
      { id: 'd2', modelName: 'pet-v1', modelRevision: 'r2' },
    ];

    expect(detectionsToReplace(stored, run)).toEqual({
      staleIds: ['d1'],
      currentIds: ['d2'],
      allIds: ['d1', 'd2'],
    });
  });

  it('returns nothing to replace for an asset with no detections', () => {
    expect(detectionsToReplace([], run)).toEqual({ staleIds: [], currentIds: [], allIds: [] });
  });
});

describe('pet recognition with CLIP (FL-58)', () => {
  const unit = (...values: number[]) => {
    const norm = Math.hypot(...values);
    return new Float32Array(values.map((value) => value / norm));
  };
  const species = [
    { species: PetSpecies.Cat, embedding: unit(1, 0, 0, 0) },
    { species: PetSpecies.Dog, embedding: unit(0, 1, 0, 0) },
  ];
  const negatives = [unit(0, 0, 1, 0)];

  it('pins the matcher revision to the CLIP model, so a model change replaces every detection', () => {
    expect(petRecognitionRun('ViT-B-32__openai')).toEqual({
      modelName: 'ViT-B-32__openai',
      modelRevision: `${PET_MATCHER_REVISION}:ViT-B-32__openai`,
    });
    expect(isStaleDetection(petRecognitionRun('a'), petRecognitionRun('b'))).toBe(true);
  });

  it('reads the species of an animal photo and nothing for a landscape', () => {
    expect(readSpecies(unit(1, 0, 0, 1), species, negatives)).toMatchObject({ species: PetSpecies.Cat });
    expect(readSpecies(unit(0, 0, 1, 1), species, negatives)).toMatchObject({ species: null });
  });

  it('only proposes pets of the species the photo reads as, or pets of any kind', () => {
    expect(isSpeciesCompatible(PetSpecies.Cat, PetSpecies.Cat)).toBe(true);
    expect(isSpeciesCompatible(PetSpecies.Dog, PetSpecies.Cat)).toBe(false);
    expect(isSpeciesCompatible(PetSpecies.Other, PetSpecies.Cat)).toBe(true);
    expect(isSpeciesCompatible(PetSpecies.Other, null)).toBe(false);
  });

  it('averages the closest confirmed photos, so one look-alike does not carry a proposal', () => {
    const photo = unit(1, 0, 0, 0);
    expect(neighbourSimilarity(photo, [unit(1, 0, 0, 0), unit(0, 1, 0, 0), unit(0, 0, 1, 0)], 3)).toBeCloseTo(1 / 3);
    expect(neighbourSimilarity(photo, [unit(1, 0, 0, 0)], 3)).toBeCloseTo(1);
    expect(neighbourSimilarity(photo, [], 3)).toBe(0);
  });

  it('proposes uncertain and confident matches alike, never an answered pair', () => {
    const photo = unit(1, 0, 0, 1);
    const reading = readSpecies(photo, species, negatives);
    const references = [
      { petId: 'confident', species: PetSpecies.Cat, embeddings: [unit(1, 0, 0, 1)] },
      { petId: 'uncertain', species: PetSpecies.Cat, embeddings: [unit(1, 0.9, 0, 1)] },
      { petId: 'unlike', species: PetSpecies.Cat, embeddings: [unit(0, 1, 1, 0)] },
      { petId: 'rejected', species: PetSpecies.Cat, embeddings: [unit(1, 0, 0, 1)] },
      { petId: 'dog', species: PetSpecies.Dog, embeddings: [unit(1, 0, 0, 1)] },
    ];

    const matches = matchPets(photo, reading, references, new Set(['rejected']));

    expect(matches.map(({ petId, confident }) => [petId, confident])).toEqual([
      ['confident', true],
      ['uncertain', false],
    ]);
    expect(matches[1].score).toBeGreaterThanOrEqual(PET_RECOGNITION_THRESHOLDS.candidateSimilarity);
    expect(matches[1].score).toBeLessThan(PET_RECOGNITION_THRESHOLDS.confidentSimilarity);
  });

  it('flags only drawn regions whose original was replaced', () => {
    const current = Buffer.from('new');
    expect(isStaleRegion({ boundingBoxX1: 1, sourceChecksum: Buffer.from('old') }, current)).toBe(true);
    expect(isStaleRegion({ boundingBoxX1: 1, sourceChecksum: Buffer.from('new') }, current)).toBe(false);
    expect(isStaleRegion({ boundingBoxX1: null, sourceChecksum: Buffer.from('old') }, current)).toBe(false);
    expect(isStaleRegion({ boundingBoxX1: 1, sourceChecksum: null }, current)).toBe(false);
  });
});
