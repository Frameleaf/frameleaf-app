import { GENERIC_LEGACY_FORK_MIGRATIONS } from 'src/fork-schema/migration-manifest.js';

/**
 * FL-180: Frameleaf public migrations for a library past the certified cutover.
 *
 * The cutover moves every Frameleaf public migration name out of `public.kysely_migrations` and into
 * `immich_fork.migration_audit` (phase `ledger-cutover`, classification `legacy-fork`), and leaves
 * the Frameleaf public objects in place. From then on startup classifies the library `isolated` and
 * runs only the certified official provider, which never yields a Frameleaf public migration. A
 * Frameleaf public migration released after the library's cutover would therefore never run there.
 *
 * Such a library keeps its Frameleaf public ledger in `immich_fork.migration_audit` instead:
 *
 * - the names its cutover moved there (phase `ledger-cutover`, classification `legacy-fork`), and
 * - the names applied since (phase `frameleaf-public`, `ISOLATED_FRAMELEAF_AUDIT_PHASE`).
 *
 * A bundled Frameleaf public migration in neither set is pending. Pending migrations run in name
 * order, in one transaction with their audit rows, and never add to or change the certified official
 * ledger. They run:
 *
 * - at startup once the library is active again after its return (`active`, schema version 2), and
 * - during the return itself (`immich-admin fork-handoff prepare-fork`), right after the
 *   post-certified upstream residue is applied again and before any reconciliation reads or writes.
 *   The return cannot finish without them: its final activation locks every table the Frameleaf
 *   catalog manifest lists.
 *
 * They never run while the library is handed over (`inactive`, schema version 2): between the
 * cutover and the return the public schema stays exactly what the cutover checked, so the official
 * server starts on exactly that. A library that never held the Frameleaf public schema (no
 * `ledger-cutover` rows) and a library that has not been cut over (schema version 1, including an
 * official library awaiting adoption) are left alone.
 */
export const ISOLATED_FRAMELEAF_AUDIT_PHASE = 'frameleaf-public';

export type IsolatedFrameleafContext = 'startup' | 'return';

export type IsolatedFrameleafSkipReason =
  /** Schema version 1: before the cutover (the combined provider applies them) or awaiting adoption. */
  | 'not-cut-over'
  /** Cut over without the Frameleaf public schema: nothing to extend. */
  | 'no-frameleaf-schema'
  /** Handed over to the official server: the return applies them. */
  | 'awaiting-return'
  /** A schema version 2 phase in which no Frameleaf public migration may run. */
  | 'unexpected-phase';

export type IsolatedFrameleafPlan = {
  /** Bundled Frameleaf public migrations the library has not recorded, in name order. */
  pending: string[];
  /** Why nothing runs now; `null` when `pending` runs. */
  skipped: IsolatedFrameleafSkipReason | null;
};

export type IsolatedFrameleafResult = IsolatedFrameleafPlan & {
  /** The migrations this call applied and recorded, in the order it applied them. */
  applied: string[];
};

export type IsolatedFrameleafPlanInput = {
  context: IsolatedFrameleafContext;
  state: { phase: string; schemaVersion: string } | undefined;
  /** Names the cutover moved out of the official ledger (`ledger-cutover`, `legacy-fork`). */
  cutoverLedger: readonly string[];
  /** Names applied since the cutover (`ISOLATED_FRAMELEAF_AUDIT_PHASE`). */
  appliedLedger: readonly string[];
  /** Names `createFrameleafPublicMigrationProvider` yields. */
  bundled: readonly string[];
};

export const planIsolatedFrameleafMigrations = ({
  context,
  state,
  cutoverLedger,
  appliedLedger,
  bundled,
}: IsolatedFrameleafPlanInput): IsolatedFrameleafPlan => {
  const foreign = bundled.filter((name) => !GENERIC_LEGACY_FORK_MIGRATIONS.has(name));
  if (foreign.length > 0) {
    throw new Error(`Frameleaf public migrations must not include ${foreign.join(', ')}`);
  }

  if (context === 'return' && (state?.schemaVersion !== '2' || state.phase !== 'inactive')) {
    throw new Error(
      'The return applies Frameleaf migrations only to a handed-over library (inactive, schema version 2)',
    );
  }
  if (state?.schemaVersion !== '2') {
    return { pending: [], skipped: 'not-cut-over' };
  }

  const bundledNames = new Set(bundled);
  const recorded = new Set([...cutoverLedger, ...appliedLedger]);
  const unknown = [...recorded].filter((name) => !bundledNames.has(name)).toSorted();
  if (unknown.length > 0) {
    throw new Error(
      `Frameleaf migration(s) ${unknown.join(', ')} were already applied to this library but are not in this version. ` +
        'This usually means a newer version ran on it. Downgrades are not supported.',
    );
  }
  if (cutoverLedger.length === 0) {
    if (appliedLedger.length > 0) {
      throw new Error('Frameleaf migrations were recorded on a library that was cut over without the Frameleaf schema');
    }
    return { pending: [], skipped: 'no-frameleaf-schema' };
  }

  const pending = bundled.filter((name) => !recorded.has(name)).toSorted();
  if (context === 'return' || state.phase === 'active') {
    return { pending, skipped: null };
  }
  return { pending, skipped: state.phase === 'inactive' ? 'awaiting-return' : 'unexpected-phase' };
};
