import { AssetVisibility, PetSpecies, type PetCandidateResponseDto, type PetResponseDto } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  confidencePercent,
  filterPetsByName,
  findPet,
  groupCandidatesByAsset,
  isUnnamedPet,
  petAgeInYears,
  petPhotosFilter,
  petSpeciesOptions,
  reviewEmptyState,
  sortPets,
  speciesLabelKey,
} from '$lib/frameleaf/pets';

const pet = (overrides: Partial<PetResponseDto> = {}): PetResponseDto =>
  ({
    id: 'pet-1',
    name: 'Biscuit',
    species: PetSpecies.Cat,
    birthDate: null,
    featuredAssetId: null,
    isHidden: false,
    isFavorite: false,
    assetCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }) as PetResponseDto;

const candidate = (overrides: Partial<PetCandidateResponseDto> = {}): PetCandidateResponseDto =>
  ({
    id: 'candidate-1',
    petId: 'pet-1',
    assetId: 'asset-1',
    score: 0.5,
    detectedSpecies: 'cat',
    modelName: 'pet-v1',
    modelRevision: 'r1',
    boundingBoxX1: 0,
    boundingBoxY1: 0,
    boundingBoxX2: 10,
    boundingBoxY2: 10,
    imageWidth: 100,
    imageHeight: 100,
    ...overrides,
  }) as PetCandidateResponseDto;

describe('pet names', () => {
  it('treats a blank name as not named yet', () => {
    expect(isUnnamedPet(pet({ name: '' }))).toBe(true);
    expect(isUnnamedPet(pet({ name: '   ' }))).toBe(true);
    expect(isUnnamedPet(pet({ name: 'Biscuit' }))).toBe(false);
  });

  it('filters case-insensitively and keeps everything for an empty query', () => {
    const pets = [pet({ id: 'a', name: 'Biscuit' }), pet({ id: 'b', name: 'Rufus' })];

    expect(filterPetsByName(pets, 'bisc').map(({ id }) => id)).toEqual(['a']);
    expect(filterPetsByName(pets, '  ').map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('sorts favorites first, then named alphabetically, then the unnamed', () => {
    const pets = [
      pet({ id: 'unnamed', name: '' }),
      pet({ id: 'rufus', name: 'Rufus' }),
      pet({ id: 'fav', name: 'Zebedee', isFavorite: true }),
      pet({ id: 'biscuit', name: 'Biscuit' }),
    ];

    expect(sortPets(pets).map(({ id }) => id)).toEqual(['fav', 'biscuit', 'rufus', 'unnamed']);
  });

  it('does not mutate the input', () => {
    const pets = [pet({ id: 'b', name: 'B' }), pet({ id: 'a', name: 'A' })];
    sortPets(pets);
    expect(pets.map(({ id }) => id)).toEqual(['b', 'a']);
  });
});

describe('species', () => {
  it('produces a translation key rather than a raw enum value', () => {
    expect(speciesLabelKey(PetSpecies.SmallMammal)).toBe('frameleaf_pets_species_small_mammal');
  });

  it('offers every species the contract allows', () => {
    expect([...petSpeciesOptions()].sort()).toEqual([...Object.values(PetSpecies)].sort());
  });
});

describe('petAgeInYears', () => {
  const today = new Date('2026-09-22T00:00:00.000Z');

  it('counts whole years', () => {
    expect(petAgeInYears('2020-09-22', today)).toBe(6);
    expect(petAgeInYears('2020-09-23', today)).toBe(5);
  });

  it('returns nothing for a missing, unparseable or future birthday', () => {
    expect(petAgeInYears(null, today)).toBeNull();
    expect(petAgeInYears('not a date', today)).toBeNull();
    expect(petAgeInYears('2030-01-01', today)).toBeNull();
  });
});

describe('confidencePercent', () => {
  it('clamps and rounds', () => {
    expect(confidencePercent(0.614)).toBe(61);
    expect(confidencePercent(-3)).toBe(0);
    expect(confidencePercent(4)).toBe(100);
  });
});

describe('groupCandidatesByAsset', () => {
  it('shows one photo at a time with every pet proposed for it', () => {
    const groups = groupCandidatesByAsset([
      candidate({ id: 'c1', assetId: 'asset-1', petId: 'pet-1' }),
      candidate({ id: 'c2', assetId: 'asset-2', petId: 'pet-1' }),
      candidate({ id: 'c3', assetId: 'asset-1', petId: 'pet-2' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].assetId).toBe('asset-1');
    expect(groups[0].candidates.map(({ id }) => id)).toEqual(['c1', 'c3']);
    expect(groups[1].candidates.map(({ id }) => id)).toEqual(['c2']);
  });

  it('returns nothing for an empty queue', () => {
    expect(groupCandidatesByAsset([])).toEqual([]);
  });
});

describe('reviewEmptyState', () => {
  it('distinguishes "nothing can propose anything" from "nothing left to review"', () => {
    expect(reviewEmptyState({ candidateCount: 0, recognitionAvailable: false })).toBe('unavailable');
    expect(reviewEmptyState({ candidateCount: 0, recognitionAvailable: true })).toBe('reviewed');
    expect(reviewEmptyState({ candidateCount: 3, recognitionAvailable: true })).toBe('none');
    expect(reviewEmptyState({ candidateCount: 3, recognitionAvailable: false })).toBe('none');
  });
});

describe('findPet', () => {
  it('finds by id and returns nothing for an unknown one', () => {
    const pets = [pet({ id: 'a' }), pet({ id: 'b' })];
    expect(findPet(pets, 'b')?.id).toBe('b');
    expect(findPet(pets, 'c')).toBeUndefined();
  });
});

describe(petPhotosFilter.name, () => {
  it('narrows to the pet and keeps to what the library timeline shows', () => {
    expect(petPhotosFilter('pet-1')).toEqual({
      petIds: { any: ['pet-1'] },
      visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
      trashedAt: { eq: null },
    });
  });

  it('never asks for Locked or hidden media, so no elevated session is needed', () => {
    const { visibility } = petPhotosFilter('pet-1');
    expect(visibility?.in).not.toContain(AssetVisibility.Locked);
    expect(visibility?.in).not.toContain(AssetVisibility.Hidden);
  });

  it('returns a fresh filter each time, so a caller cannot mutate the next page', () => {
    expect(petPhotosFilter('pet-1')).not.toBe(petPhotosFilter('pet-1'));
  });
});
