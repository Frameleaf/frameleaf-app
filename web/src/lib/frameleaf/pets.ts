import {
  AssetVisibility,
  isHttpError,
  MlDestinationKind,
  PetObservationState,
  PetRecognitionRunStatus,
  PetRecognitionUnavailableReason,
  PetSpecies,
  type PetCandidateResponseDto,
  type PetObservationCreateDto,
  type PetObservationResponseDto,
  type PetRecognitionRunResponseDto,
  type PetResponseDto,
  type SearchFilter,
} from '@immich/sdk';
import type { Translations } from 'svelte-i18n';
import { toPixelBox, type FaceBox, type Size } from '$lib/frameleaf/face-tags';

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
export const speciesLabelKey = (species: PetSpecies): Translations => `frameleaf_pets_species_${species}`;

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

/* -------------------------------------------------------------------------------------------- */
/* Recognition status (FL-58)                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * Where recognition runs, in the owner's words. The managed cloud worker is "Frameleaf Cloud" in
 * every customer string (owner decision, FL-146); a LAN worker is named by its destination name.
 */
export const recognitionDestinationKey = (kind: MlDestinationKind): Translations => {
  switch (kind) {
    case MlDestinationKind.Local: {
      return 'frameleaf_pets_recognition_runs_local';
    }
    case MlDestinationKind.Lan: {
      return 'frameleaf_pets_recognition_runs_lan';
    }
    case MlDestinationKind.Runpod:
    case MlDestinationKind.RunpodVideo: {
      return 'frameleaf_pets_recognition_runs_cloud';
    }
  }
};

/** Why recognition cannot run, as an actionable sentence; the server sends the reason, never a guess. */
export const recognitionReasonKey = (reason: PetRecognitionUnavailableReason): Translations =>
  `frameleaf_pets_recognition_reason_${reason.replaceAll('-', '_')}` as Translations;

/** A run the page should keep following (polling) and offer to stop. */
export const isRecognitionRunActive = (run: Pick<PetRecognitionRunResponseDto, 'status'> | null | undefined) =>
  !!run && (run.status === PetRecognitionRunStatus.Queued || run.status === PetRecognitionRunStatus.Running);

/** How far a run is, 0 to 1. A run that has not counted its photos yet reads as 0, never NaN. */
export const recognitionRunProgress = ({
  assetCount,
  processedCount,
}: Pick<PetRecognitionRunResponseDto, 'assetCount' | 'processedCount'>): number =>
  assetCount > 0 ? Math.min(1, Math.max(0, processedCount / assetCount)) : 0;

/* -------------------------------------------------------------------------------------------- */
/* Observations (FL-58)                                                                          */
/* -------------------------------------------------------------------------------------------- */

/** A drawn region whose photo was replaced afterwards: kept and confirmed, but it needs a look. */
export const isStaleObservation = (observation: Pick<PetObservationResponseDto, 'staleAt'>) =>
  observation.staleAt !== null;

export const hasRegion = (observation: Pick<PetObservationResponseDto, 'boundingBoxX1'>) =>
  observation.boundingBoxX1 !== null;

/** The pets confirmed in one photo, stale regions first so they are seen. */
export const confirmedObservations = (observations: PetObservationResponseDto[]) =>
  observations
    .filter((observation) => observation.state === PetObservationState.Confirmed)
    .sort((a, b) => Number(isStaleObservation(b)) - Number(isStaleObservation(a)));

/** A fraction box as the pixel region the pets API stores, measured on the image the region was drawn on. */
export const regionFromBox = (
  box: FaceBox,
  natural: Size,
): Required<
  Pick<
    PetObservationCreateDto,
    'boundingBoxX1' | 'boundingBoxY1' | 'boundingBoxX2' | 'boundingBoxY2' | 'imageWidth' | 'imageHeight'
  >
> => {
  const { x, y, width, height } = toPixelBox(box, natural);
  return {
    boundingBoxX1: x,
    boundingBoxY1: y,
    boundingBoxX2: x + width,
    boundingBoxY2: y + height,
    imageWidth: natural.width,
    imageHeight: natural.height,
  };
};

/** The same observation written again: what an Undo of its removal sends. */
export const observationToCreate = (
  observation: PetObservationResponseDto,
  expectedChecksum?: string,
): PetObservationCreateDto => ({
  assetId: observation.assetId,
  ...(expectedChecksum && { expectedChecksum }),
  ...(hasRegion(observation) && {
    boundingBoxX1: observation.boundingBoxX1!,
    boundingBoxY1: observation.boundingBoxY1!,
    boundingBoxX2: observation.boundingBoxX2!,
    boundingBoxY2: observation.boundingBoxY2!,
    imageWidth: observation.imageWidth!,
    imageHeight: observation.imageHeight!,
  }),
});

/** A 409 from a pet write: the original changed since the photo was opened (FL-58 source checksums). */
export const isSourceConflict = (error: unknown): boolean => isHttpError(error) && error.status === 409;
