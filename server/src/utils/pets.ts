import { PetObservationState, PetSpecies } from 'src/enum.js';

/**
 * Pet identity rules (FL-58), as pure functions so the invariants can be tested without
 * a database.
 *
 * The one rule everything else follows from: a durable record (`pet`, `pet_observation`)
 * is the owner's, and a replaceable record (`pet_detection`, `pet_candidate`) is the
 * model's. Reprocessing rewrites the model's side; it never reads or writes the owner's.
 */

export const PET_NAME_MAX_LENGTH = 100;

/** A durable decision, reduced to what the review rules need. */
export interface DurableDecision {
  assetId: string;
  petId: string;
  state: PetObservationState;
}

/** A proposal from the model, reduced to what the review rules need. */
export interface ProposedCandidate {
  id: string;
  assetId: string;
  petId: string;
  score: number;
}

/**
 * A pet's name, as stored. Production treats a blank name as "not named yet" for people,
 * and pets follow that, so trimming to `''` is a real value rather than an error.
 */
export const normalizePetName = (name: string): string => name.trim().slice(0, PET_NAME_MAX_LENGTH);

export const isNamedPet = (pet: { name: string }): boolean => normalizePetName(pet.name).length > 0;

/**
 * A detector's species guess is advisory. It is recorded on the detection and shown in
 * review, but it never becomes `pet.species`, which is the owner's statement.
 */
export const asKnownSpecies = (value: string | null | undefined): PetSpecies | null => {
  if (!value) {
    return null;
  }
  const match = Object.values(PetSpecies).find((species) => species === value.toLowerCase());
  return match ?? null;
};

const decisionKey = (assetId: string, petId: string) => `${assetId}:${petId}`;

/**
 * Proposals the owner has already answered for this asset and pet, in either direction.
 *
 * This is what makes a review decision survive reprocessing. A rejection is stored as a
 * durable `rejected` observation rather than as the absence of a candidate, so when a
 * new model revision proposes the same pairing again it is filtered out here instead of
 * reappearing in the queue.
 */
export const filterReviewedCandidates = <T extends ProposedCandidate>(
  candidates: T[],
  decisions: DurableDecision[],
): T[] => {
  const answered = new Set(decisions.map(({ assetId, petId }) => decisionKey(assetId, petId)));
  return candidates.filter((candidate) => !answered.has(decisionKey(candidate.assetId, candidate.petId)));
};

/**
 * Review order: the least certain proposals first, because those are the ones a person
 * has to look at. Ties break on candidate id so paging is stable.
 */
export const sortCandidatesForReview = <T extends ProposedCandidate>(candidates: T[]): T[] =>
  [...candidates].sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

/**
 * Merging pet `sourceId` into pet `targetId`: which durable observations the target ends
 * up with.
 *
 * A merge must not quietly drop a decision. Where both pets carry a decision about the
 * same asset, `confirmed` wins over `rejected`: the owner said the animal, which is now
 * one animal, is in that photo. Observations the target does not already have move
 * across; the rest are dropped with the source row.
 */
export interface MergePlan {
  /** Source observation ids to repoint at the target pet. */
  reassign: string[];
  /** Source observation ids the target already answers more strongly; deleted with the source. */
  discard: string[];
  /** Target observation ids to promote from `rejected` to `confirmed`. */
  promote: string[];
}

export const planObservationMerge = (
  source: Array<DurableDecision & { id: string }>,
  target: Array<DurableDecision & { id: string }>,
): MergePlan => {
  const byAsset = new Map(target.map((observation) => [observation.assetId, observation]));
  const plan: MergePlan = { reassign: [], discard: [], promote: [] };

  for (const observation of source) {
    const existing = byAsset.get(observation.assetId);
    if (!existing) {
      plan.reassign.push(observation.id);
      continue;
    }

    plan.discard.push(observation.id);
    if (existing.state === PetObservationState.Rejected && observation.state === PetObservationState.Confirmed) {
      plan.promote.push(existing.id);
    }
  }

  return plan;
};

export interface ModelRevision {
  modelName: string;
  modelRevision: string;
}

/** A detection produced by a model other than the one a run is using. */
export const isStaleDetection = (detection: ModelRevision, run: ModelRevision): boolean =>
  detection.modelName !== run.modelName || detection.modelRevision !== run.modelRevision;

/**
 * Which detections a recognition run replaces for one asset: all of them, its own
 * revision's included, because a rerun is a fresh reading of the same photo.
 *
 * Every id this returns belongs to `pet_detection`, so deleting them cascades only into
 * `pet_candidate`. No durable id can appear here, which is the whole point of naming the
 * set explicitly instead of letting a job issue a broad delete.
 */
export const detectionsToReplace = <T extends ModelRevision & { id: string }>(
  stored: T[],
  run: ModelRevision,
): { staleIds: string[]; currentIds: string[]; allIds: string[] } => {
  const staleIds: string[] = [];
  const currentIds: string[] = [];

  for (const detection of stored) {
    (isStaleDetection(detection, run) ? staleIds : currentIds).push(detection.id);
  }

  return { staleIds, currentIds, allIds: [...staleIds, ...currentIds] };
};

/* -------------------------------------------------------------------------------------------- */
/* Recognition with the configured CLIP model (FL-58)                                           */
/* -------------------------------------------------------------------------------------------- */

/**
 * The pinned revision of the matcher below. It is part of every detection's `modelRevision`, with
 * the CLIP model name, so changing either the rules here or the CLIP model makes every stored
 * detection stale and a rerun replaces them (`detectionsToReplace`). Bump it when a threshold,
 * prompt or scoring rule changes.
 */
export const PET_MATCHER_REVISION = 'clip-knn-1';

export const petRecognitionRun = (clipModelName: string): ModelRevision => ({
  modelName: clipModelName,
  modelRevision: `${PET_MATCHER_REVISION}:${clipModelName}`,
});

/** Zero-shot prompts for the species the owner can pick. `Other` has no prompt of its own. */
export const PET_SPECIES_PROMPTS: ReadonlyArray<{ species: PetSpecies; prompt: string }> = [
  { species: PetSpecies.Cat, prompt: 'a photo of a cat' },
  { species: PetSpecies.Dog, prompt: 'a photo of a dog' },
  { species: PetSpecies.Bird, prompt: 'a photo of a pet bird' },
  { species: PetSpecies.Rabbit, prompt: 'a photo of a rabbit' },
  { species: PetSpecies.Horse, prompt: 'a photo of a horse' },
  { species: PetSpecies.Reptile, prompt: 'a photo of a pet lizard, snake or turtle' },
  { species: PetSpecies.Fish, prompt: 'a photo of an aquarium fish' },
  { species: PetSpecies.SmallMammal, prompt: 'a photo of a hamster or guinea pig' },
];

/** What the photo may be instead of an animal. The gate asks whether an animal wins against these. */
export const PET_NEGATIVE_PROMPTS: readonly string[] = [
  'a photo of a person',
  'a photo of a group of people',
  'a photo of a landscape',
  'a photo of food',
  'a photo of a building',
  'a screenshot or a document',
  'a photo of an everyday object',
];

/** CLIP's logit scale: zero-shot probabilities are a softmax over 100 x cosine. */
const CLIP_LOGIT_SCALE = 100;

export const PET_RECOGNITION_THRESHOLDS = {
  /** The animal prompts together must take at least this share for the photo to count as a pet photo. */
  animalProbability: 0.5,
  /** A pet is proposed at or above this mean similarity to its confirmed photos. */
  candidateSimilarity: 0.7,
  /** At or above this a proposal is a confident match. It is still only a proposal (never confirmed). */
  confidentSimilarity: 0.85,
  /** How many of a pet's closest confirmed photos the similarity averages. */
  neighbours: 3,
  /** The most confirmed photos per pet the matcher compares against, newest first. */
  referencesPerPet: 50,
} as const;

export interface SpeciesReading {
  /** The species prompt that won among the animals, or null when the photo is not a pet photo. */
  species: PetSpecies | null;
  /** The share the animal prompts took together, 0 to 1. */
  animalProbability: number;
  /** Per species share, 0 to 1. */
  probabilities: Partial<Record<PetSpecies, number>>;
}

/**
 * Zero-shot species gate: the asset's CLIP image embedding against the text embeddings of the
 * species and non-animal prompts, as CLIP itself classifies (softmax over scaled cosines). All
 * vectors must be unit length.
 */
export const readSpecies = (
  asset: Float32Array,
  species: ReadonlyArray<{ species: PetSpecies; embedding: Float32Array }>,
  negatives: readonly Float32Array[],
): SpeciesReading => {
  const logits = [...species.map(({ embedding }) => embedding), ...negatives].map(
    (embedding) => CLIP_LOGIT_SCALE * cosine(asset, embedding),
  );
  if (logits.length === 0 || species.length === 0) {
    return { species: null, animalProbability: 0, probabilities: {} };
  }
  const max = Math.max(...logits);
  const exps = logits.map((logit) => Math.exp(logit - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  const probabilities: Partial<Record<PetSpecies, number>> = {};
  let animalProbability = 0;
  let best: { species: PetSpecies; probability: number } | null = null;
  for (const [index, entry] of species.entries()) {
    const probability = exps[index] / total;
    probabilities[entry.species] = probability;
    animalProbability += probability;
    if (!best || probability > best.probability) {
      best = { species: entry.species, probability };
    }
  }
  return {
    species: animalProbability >= PET_RECOGNITION_THRESHOLDS.animalProbability ? (best?.species ?? null) : null,
    animalProbability,
    probabilities,
  };
};

const cosine = (a: Float32Array, b: Float32Array): number => {
  if (a.length !== b.length) {
    return 0;
  }
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i] * b[i];
  }
  return sum;
};

/** A pet as the matcher sees it: its owner-stated species and unit embeddings of its confirmed photos. */
export interface PetReference {
  petId: string;
  species: PetSpecies;
  embeddings: Float32Array[];
}

/**
 * Whether a pet may be proposed for a photo whose animal reads as `detected`. A pet the owner
 * called `Other` may be anything; otherwise the detected species must be the pet's.
 */
export const isSpeciesCompatible = (pet: PetSpecies, detected: PetSpecies | null): boolean =>
  detected !== null && (pet === PetSpecies.Other || pet === detected);

/**
 * Identity by nearest neighbours: the mean cosine similarity of the photo to the pet's
 * `neighbours` closest confirmed photos. One close photo is not enough on its own when the pet has
 * more, which keeps a single look-alike photo from carrying a proposal.
 */
export const neighbourSimilarity = (asset: Float32Array, references: Float32Array[], neighbours: number): number => {
  if (references.length === 0) {
    return 0;
  }
  const similarities = references.map((reference) => cosine(asset, reference)).sort((a, b) => b - a);
  const top = similarities.slice(0, Math.max(1, neighbours));
  return top.reduce((sum, value) => sum + value, 0) / top.length;
};

export interface PetMatch {
  petId: string;
  score: number;
  confident: boolean;
}

/**
 * Which pets to propose for one photo, best first.
 *
 * Pets the owner already answered for this photo (confirmed or rejected) are never proposed: a
 * rejection stays a rejection whatever the model revision. Nothing here confirms anything; every
 * match, confident or not, is a proposal for review.
 */
export const matchPets = (
  asset: Float32Array,
  reading: SpeciesReading,
  references: PetReference[],
  answeredPetIds: ReadonlySet<string>,
): PetMatch[] => {
  const matches: PetMatch[] = [];
  for (const pet of references) {
    if (answeredPetIds.has(pet.petId) || !isSpeciesCompatible(pet.species, reading.species)) {
      continue;
    }
    const score = neighbourSimilarity(asset, pet.embeddings, PET_RECOGNITION_THRESHOLDS.neighbours);
    if (score >= PET_RECOGNITION_THRESHOLDS.candidateSimilarity) {
      matches.push({
        petId: pet.petId,
        score: Math.min(1, score),
        confident: score >= PET_RECOGNITION_THRESHOLDS.confidentSimilarity,
      });
    }
  }
  return matches.sort((a, b) => b.score - a.score || a.petId.localeCompare(b.petId));
};

/**
 * A region drawn on an original that has since been replaced may no longer point at the animal.
 * A whole-photo observation has no region to go wrong, and an observation made before checksums
 * were recorded has nothing to compare, so neither is flagged.
 */
export const isStaleRegion = (
  observation: { boundingBoxX1: number | null; sourceChecksum: Buffer | null },
  currentChecksum: Buffer,
): boolean =>
  observation.boundingBoxX1 !== null &&
  observation.sourceChecksum !== null &&
  !observation.sourceChecksum.equals(currentChecksum);
