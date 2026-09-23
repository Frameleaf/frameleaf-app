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
