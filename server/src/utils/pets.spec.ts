import { PetObservationState, PetSpecies } from 'src/enum.js';
import {
  asKnownSpecies,
  detectionsToReplace,
  filterReviewedCandidates,
  isNamedPet,
  isStaleDetection,
  normalizePetName,
  planObservationMerge,
  sortCandidatesForReview,
} from 'src/utils/pets.js';
import { describe, expect, it } from 'vitest';

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
    expect(normalizePetName('   ')).toBe('');
    expect(isNamedPet({ name: '   ' })).toBe(false);
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
