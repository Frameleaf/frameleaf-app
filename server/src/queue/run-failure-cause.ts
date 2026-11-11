import { type RawBuilder, sql } from 'kysely';
import { JobName } from 'src/enum.js';

/**
 * FL-1349: the plain cause of a photo a run left over, most telling first. A photo with several failed tasks takes
 * the first cause any of them has (drive > missing > damaged > unsupported > other).
 */
export const RUN_FAILURE_CAUSES = ['drive', 'missing', 'damaged', 'unsupported', 'other'] as const;
export type RunFailureCause = (typeof RUN_FAILURE_CAUSES)[number];

/**
 * Matched case-insensitively by Postgres (`~*`, ARE) and by JavaScript (`new RegExp(p, 'i')`), so only the syntax
 * both read the same: no `\b`, `\y`, `\m` or lookarounds. A word boundary is spelled out as `(^|[^a-z])`.
 */
export const FAILURE_PATTERNS = {
  unreachable: 'ENOENT|ENOTDIR|EACCES|ESTALE|EHOSTDOWN|no such file',
  // file wording only: machine learning's "404 Not Found" or "model not found" isn't a missing photo
  missing: 'ENOENT|no such file|file not found',
  // FL-1430: exiftool's words for a damaged file ("File format error", "Entire file is binary zeros")
  damaged:
    'premature end|truncated|incomplete|huffman|(^|[^a-z])SOI([^a-z]|$)|marker|APP[0-9]* segment|improper image header|corrupt|file format error|entire file is binary zeros',
  unsupported: 'unsupported|unknown format|no decode delegate|not supported',
} as const satisfies Record<'unreachable' | 'missing' | 'damaged' | 'unsupported', string>;

/** The run kinds that are the overnight schedule's work: Recent work folds them into one card. */
export const NIGHTLY_RUN_KINDS: readonly string[] = [JobName.OvernightSequence];

export type RunFailureInput = {
  /** The task's photo exists; without one (a non-photo root, a removed asset) the cause is always other */
  asset: boolean;
  error: string | null;
  /** The photo is in an external library */
  external: boolean;
  offline: boolean;
  /** Its open Library care finding (or a damaged file Library care fixed); missing first when it has both */
  finding: 'missing' | 'corrupt' | null;
};

/** FL-1430: exiftool reports one problem twice ("X; X"); it is shown once. */
export const singleMessage = (message: string | null) => {
  if (!message) return message;
  const parts = message.split('; ');
  return parts.length > 1 && parts.every((part) => part === parts[0]) ? parts[0] : message;
};

const matches = (error: string | null, pattern: string) => new RegExp(pattern, 'i').test(error ?? '');

/** The cause of one failed task. Mirrors `failureCauseSql`, which is what the server counts with. */
export const runFailureCause = ({ asset, error, external, offline, finding }: RunFailureInput): RunFailureCause => {
  if (!asset) return 'other';
  if (offline || (external && matches(error, FAILURE_PATTERNS.unreachable))) return 'drive';
  if (finding === 'missing' || (!external && matches(error, FAILURE_PATTERNS.missing))) return 'missing';
  if (finding === 'corrupt' || matches(error, FAILURE_PATTERNS.damaged)) return 'damaged';
  if (matches(error, FAILURE_PATTERNS.unsupported)) return 'unsupported';
  return 'other';
};

/** A cause's rank: the lowest of a photo's tasks is its cause. */
export const causeRank = (cause: RunFailureCause) => RUN_FAILURE_CAUSES.indexOf(cause) + 1;

type CauseColumns = {
  asset: RawBuilder<unknown>;
  error: RawBuilder<unknown>;
  external: RawBuilder<unknown>;
  offline: RawBuilder<unknown>;
  finding: RawBuilder<unknown>;
};

/** `runFailureCause` in SQL, as its rank (1 = drive … 5 = other); `failureCauseName` turns a rank back into a cause. */
export const failureCauseRank = ({ asset, error, external, offline, finding }: CauseColumns) => {
  const text = sql`coalesce(${error}, '')`;
  const is = (pattern: string) => sql`${text} ~* ${pattern}::text`;
  return sql<number>`case
    when not coalesce(${asset}, false) then 5
    when coalesce(${offline}, false) or (coalesce(${external}, false) and ${is(FAILURE_PATTERNS.unreachable)}) then 1
    when ${finding} = 'missing' or (not coalesce(${external}, false) and ${is(FAILURE_PATTERNS.missing)}) then 2
    when ${finding} = 'corrupt' or ${is(FAILURE_PATTERNS.damaged)} then 3
    when ${is(FAILURE_PATTERNS.unsupported)} then 4
    else 5 end`;
};

export const failureCauseName = (rank: RawBuilder<unknown>) =>
  sql<RunFailureCause>`(${sql.val(RUN_FAILURE_CAUSES)}::text[])[${rank}]`;

/** The cause of each failed task `j` of a photo `a` (nullable) with its finding column `finding`. */
export const failureCauseSql = (columns: CauseColumns) => failureCauseName(failureCauseRank(columns));
