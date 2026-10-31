export type CameraCandidate = {
  make: string | null;
  model: string | null;
  source: 'original' | 'sidecar';
  makeTag?: string;
  modelTag?: string;
};
export type CameraIdentification = {
  version: 1;
  recorded: CameraCandidate | null;
  alternatives: CameraCandidate[];
  suggestion: { method: 'jpeg-signature'; signature: string; matches: string | null } | null;
};

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const nullableText = (value: unknown) => value === null || text(value);
const candidate = (value: unknown): value is CameraCandidate =>
  object(value) &&
  nullableText(value.make) &&
  nullableText(value.model) &&
  (text(value.make) || text(value.model)) &&
  (value.source === 'original' || value.source === 'sidecar') &&
  (value.makeTag === undefined || text(value.makeTag)) &&
  (value.modelTag === undefined || text(value.modelTag));

/** Metadata is owner-editable unknown JSON; display only this version's validated facts. */
export function parseCameraIdentification(value: unknown): CameraIdentification | null {
  if (
    !object(value) ||
    value.version !== 1 ||
    !(value.recorded === null || candidate(value.recorded)) ||
    !Array.isArray(value.alternatives) ||
    !value.alternatives.every(candidate)
  ) {
    return null;
  }
  const clue = value.suggestion;
  if (
    clue !== null &&
    (!object(clue) || clue.method !== 'jpeg-signature' || !text(clue.signature) || !nullableText(clue.matches))
  ) {
    return null;
  }
  return value as CameraIdentification;
}

export const cameraCandidateLabel = (value: CameraCandidate): string =>
  [value.make, value.model].filter(Boolean).join(' · ');

export const cameraCandidateConflicts = (recorded: CameraCandidate | null, alternative: CameraCandidate): boolean =>
  !!recorded &&
  ((!!recorded.make && !!alternative.make && recorded.make !== alternative.make) ||
    (!!recorded.model && !!alternative.model && recorded.model !== alternative.model));
