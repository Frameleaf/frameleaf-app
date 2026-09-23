import {
  AssetVisibility,
  PetSpecies,
  type PetCandidateResponseDto,
  type PetResponseDto,
  type SearchFilter,
} from '@immich/sdk';

/**
 * Frameleaf Pets page (FL-58): small pure helpers shared by the grid and the recognition
 * review panel. Nothing here calls the network; the page owns every mutation through the
 * `@immich/sdk` pet services (`createPet`, `updatePet`, `deletePet`, `mergePets`,
 * `acceptPetCandidate`, `rejectPetCandidate`, `deletePetObservation`).
 *
 * These helpers only ever touch the durable identity. The candidate helpers read a
 * proposal but never write one: a proposal is the model's and is replaced whenever the
 * model runs again.
 */

/** Matches the People convention: an empty or whitespace-only name means "not named yet". */
export const isUnnamedPet = (pet: { name: string }): boolean => !pet.name?.trim();

export const matchesPetSearch = (pet: { name: string }, query: string): boolean => {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) {
    return true;
  }
  return pet.name.toLocaleLowerCase().includes(trimmed);
};

export const filterPetsByName = <T extends { name: string }>(pets: T[], query: string): T[] =>
  pets.filter((pet) => matchesPetSearch(pet, query));

/** Favorites first, then named pets alphabetically, then the unnamed ones. */
export const sortPets = <T extends { name: string; isFavorite: boolean }>(pets: T[]): T[] =>
  [...pets].sort(
    (a, b) =>
      Number(b.isFavorite) - Number(a.isFavorite) ||
      Number(isUnnamedPet(a)) - Number(isUnnamedPet(b)) ||
      a.name.localeCompare(b.name),
  );

/** The i18n key for a species, so the page never renders a raw enum value. */
export const speciesLabelKey = (species: PetSpecies): string => `frameleaf_pets_species_${species}`;

export const petSpeciesOptions = (): PetSpecies[] => [
  PetSpecies.Dog,
  PetSpecies.Cat,
  PetSpecies.Bird,
  PetSpecies.Rabbit,
  PetSpecies.Horse,
  PetSpecies.SmallMammal,
  PetSpecies.Reptile,
  PetSpecies.Fish,
  PetSpecies.Other,
];

/** A birthday shown as an age in whole years, or nothing when there is no birthday. */
export const petAgeInYears = (birthDate: string | null, today = new Date()): number | null => {
  if (!birthDate) {
    return null;
  }

  const born = new Date(birthDate);
  if (Number.isNaN(born.getTime()) || born > today) {
    return null;
  }

  let years = today.getUTCFullYear() - born.getUTCFullYear();
  const hadBirthday =
    today.getUTCMonth() > born.getUTCMonth() ||
    (today.getUTCMonth() === born.getUTCMonth() && today.getUTCDate() >= born.getUTCDate());
  if (!hadBirthday) {
    years -= 1;
  }

  return years < 0 ? null : years;
};

/** Confidence as a whole percentage, for the review card. */
export const confidencePercent = (score: number): number => Math.round(Math.max(0, Math.min(1, score)) * 100);

/**
 * Group proposals by the asset they are about, so review shows one photo at a time with
 * every pet proposed for it, rather than the same photo repeated per pet.
 */
export interface CandidateGroup {
  assetId: string;
  candidates: PetCandidateResponseDto[];
}

export const groupCandidatesByAsset = (candidates: PetCandidateResponseDto[]): CandidateGroup[] => {
  const groups = new Map<string, PetCandidateResponseDto[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.assetId);
    if (existing) {
      existing.push(candidate);
    } else {
      groups.set(candidate.assetId, [candidate]);
    }
  }

  return [...groups].map(([assetId, grouped]) => ({ assetId, candidates: grouped }));
};

export const findPet = (pets: PetResponseDto[], id: string): PetResponseDto | undefined =>
  pets.find((pet) => pet.id === id);

/**
 * What the review panel should say when it has nothing to show.
 *
 * There are two different empty states and conflating them would be dishonest: the
 * server may have no recognition model at all, in which case nothing can ever propose
 * anything, or it may simply have nothing left to review. The server reports which.
 */
export type ReviewEmptyState = 'unavailable' | 'reviewed' | 'none';

export const reviewEmptyState = ({
  candidateCount,
  recognitionAvailable,
}: {
  candidateCount: number;
  recognitionAvailable: boolean;
}): ReviewEmptyState => {
  if (candidateCount > 0) {
    return 'none';
  }
  return recognitionAvailable ? 'reviewed' : 'unavailable';
};

/**
 * The search filter behind a pet's own page (FL-58): the photos the owner confirmed this pet in, as
 * the library shows them. The server matches `petIds` on confirmed observations of the caller's own
 * pets only; the rest keeps the page to what the timeline would show — timeline and archive, never a
 * hidden live-photo part or Locked media, and nothing from the trash, which a structured search
 * otherwise includes.
 */
export const petPhotosFilter = (petId: string): SearchFilter => ({
  petIds: { any: [petId] },
  visibility: { in: [AssetVisibility.Timeline, AssetVisibility.Archive] },
  trashedAt: { eq: null },
});
