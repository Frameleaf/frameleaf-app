/** The plain-words history of a damaged or missing file: one row per thing tried or found (FL-1337). */
export type FileStepKey =
  | 'added'
  | 'imported'
  | 'moved'
  | 'not-on-drive'
  | 'wont-open'
  | 'checked'
  | 'looked-where-moving'
  | 'searched-copy'
  | 'checked-backups'
  | 'restored'
  | 'asked-phones'
  | 'checked-on-phone'
  | 'repaired'
  | 'kept-damaged'
  | 'put-back'
  | 'unsupported'
  | 'undone'
  | 'kept-as-is'
  | 'removed';

export type FileStepOutcome = 'ok' | 'not-found' | 'failed' | 'waiting' | 'info';

export type NewFileStep = {
  healthId: string;
  assetId: string;
  step: FileStepKey;
  outcome: FileStepOutcome;
  facts?: Record<string, unknown>;
  undo?: Record<string, unknown> | null;
  at?: Date;
};

export type FileStep = Required<Omit<NewFileStep, 'undo'>> & { id: string; undo: Record<string, unknown> | null };

/**
 * A step handed to the write that records its finding (FL-1337). A new finding has no id until it is
 * written, so that write fills in `healthId`, and `assetId` when it is left out, in its own transaction.
 */
export type FindingStep = Omit<NewFileStep, 'healthId' | 'assetId'> & { assetId?: string };

/** The fix states a finding's `evidence.fixState` holds (FL-1337). Plain strings in responses. */
export const FIX_STATES = [
  'repaired',
  'part-saved',
  'found-again',
  'restored',
  'missing',
  'waiting-phone',
  'cant-repair',
  'left-as-is',
  'couldnt-check',
] as const;
export type FixState = (typeof FIX_STATES)[number];
