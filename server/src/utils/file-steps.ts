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
