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
  | 'asked-icloud'
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

/** The operating systems of a phone or tablet, in lower case (FL-1337). */
const PHONE_SYSTEMS = new Set(['ios', 'ipados', 'android']);
/** Phones and tablets that have not been used for this long are no longer asked (FL-1337). */
export const PHONE_ACTIVE_DAYS = 90;

/** Whether a session is on a phone or tablet. */
export const isPhoneSession = (session: { deviceOS: string }) =>
  PHONE_SYSTEMS.has(session.deviceOS.trim().toLowerCase());

/** Whether a session is a phone or tablet, used recently enough to still hold a lost photo. */
export const isActivePhone = (session: { deviceOS: string; updatedAt: Date }, now = Date.now()) =>
  isPhoneSession(session) && session.updatedAt.getTime() >= now - PHONE_ACTIVE_DAYS * 24 * 60 * 60 * 1000;

/** What the history calls a session's device: the model the app sends, else its system. */
export const phoneName = (session: { deviceType: string; deviceOS: string }) =>
  session.deviceType.trim() || session.deviceOS.trim();
