import { Kysely, sql } from 'kysely';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import { up as indexMlAccountingJobs } from 'src/fork-schema/migrations/0000000000170-MlWorkloadAccountingJobIndex.js';
import { up as addRenderSessionOutputEvidence } from 'src/fork-schema/migrations/0000000000172-RenderSessionOutputEvidence.js';
import { up as indexMlAccountingCloudJobs } from 'src/fork-schema/migrations/0000000000201-MlWorkloadAccountingCloudJobIndex.js';
import supportedVersions from 'src/fork-schema/supported-versions.json' with { type: 'json' };
import { LEGACY_WORKFLOW_MIGRATION, WorkflowCompatibility } from 'src/fork-schema/workflow-compatibility.js';

/**
 * FL-44: adopting a library the official server created.
 *
 * The first Frameleaf boot on an official v3.1.0 database (`official-origin`) runs only the certified
 * official provider and the isolated `immich_fork` migrations, so the public schema stays byte-exact
 * with the certified tag and the official server can still take the library back without a cutover.
 * That library is not yet a Frameleaf library: the post-certified upstream migrations (e.g.
 * `1787148183729-ClusterGroups`) and every Frameleaf public migration (`2100…`) are missing, and
 * `immich_fork.state` is `inactive` / schema version `1`.
 *
 * `immich-admin fork-schema adopt` closes that gap in one transaction: it applies the missing
 * post-certified migrations through their registered applies and the Frameleaf public migrations in
 * name order (never the Frameleaf copy of the workflow rewrite, whose official original already ran),
 * repeats the parts of `immich_fork` migrations that only act when a Frameleaf public table exists,
 * and moves the state to `legacy`, the phase a fresh Frameleaf install starts in. From there the
 * normal compatibility backfill (`fork-schema start`) and the certified handoff apply unchanged.
 */
export const OFFICIAL_ADOPTION_AUDIT = 'official-origin-adoption';

export type OfficialAdoptionResult = {
  /** False when the library had already been adopted and nothing changed. */
  adopted: boolean;
  /** Migration names adoption recorded in the official ledger, in the order it applied them. */
  applied: string[];
};

const RESIDUE_ORDER: readonly string[] = supportedVersions.postCertifiedUpstreamMigrations;

/**
 * The adoptable ledger is the exact certified tag, optionally followed by an ordered prefix of the
 * post-certified upstream migrations (an official server newer than the certified tag), and nothing
 * else.
 */
export const assertAdoptableOfficialLedger = (ledger: readonly string[]): void => {
  const legacy = ledger.filter((name) => LEGACY_FORK_MIGRATIONS.has(name));
  if (legacy.length > 0) {
    throw new Error(`Library already holds Frameleaf migrations: ${legacy.join(', ')}`);
  }
  const allowed = [...CERTIFIED_TAG_MIGRATIONS, ...RESIDUE_ORDER];
  const exact =
    ledger.length >= CERTIFIED_TAG_MIGRATIONS.length &&
    ledger.length <= allowed.length &&
    ledger.every((name, index) => name === allowed[index]);
  if (!exact) {
    throw new Error(
      'Adoption requires the exact certified v3.1.0 migration ledger; upgrade the official server to v3.1.0 and start it once first',
    );
  }
};

/**
 * The migrations adoption applies: every bundled migration the ledger lacks, in name order (the
 * order a fresh install applies them relative to each other). Only post-certified upstream and
 * Frameleaf public migrations may be pending, and every Frameleaf public migration must be.
 */
export const planOfficialAdoption = (ledger: readonly string[], bundled: readonly string[]): string[] => {
  assertAdoptableOfficialLedger(ledger);
  if (bundled.includes(LEGACY_WORKFLOW_MIGRATION)) {
    throw new Error(`Adoption must never run ${LEGACY_WORKFLOW_MIGRATION}; its official original already ran`);
  }
  const applied = new Set(ledger);
  const pending = bundled.filter((name) => !applied.has(name)).toSorted();
  const unexpected = pending.filter(
    (name) => !POST_CERTIFIED_UPSTREAM_MIGRATIONS.has(name) && !GENERIC_LEGACY_FORK_MIGRATIONS.has(name),
  );
  if (unexpected.length > 0) {
    throw new Error(`Adoption found unexpected pending migration(s): ${unexpected.join(', ')}`);
  }
  const pendingSet = new Set(pending);
  const missing = [
    ...[...GENERIC_LEGACY_FORK_MIGRATIONS].filter((name) => !pendingSet.has(name)),
    ...RESIDUE_ORDER.filter((name) => !applied.has(name) && !pendingSet.has(name)),
  ];
  if (missing.length > 0) {
    throw new Error(`Adoption is missing bundled migration(s): ${missing.join(', ')}`);
  }
  return pending;
};

/**
 * Workflow and plugin data crosses adoption unchanged. `1786741078327-AddWorkflowLogsTable` appends
 * `workflow.logging`, so the workflow rows' digest legitimately changes and only their count is
 * compared; plugins, methods and steps must be byte-identical.
 */
export const assertWorkflowDataPreserved = (before: WorkflowCompatibility, after: WorkflowCompatibility): void => {
  if (before.mode !== 'official' || after.mode !== 'official' || before.timestamp !== after.timestamp) {
    throw new Error('Adoption changed the workflow migration marker');
  }
  const beforeByTable = new Map(before.rowDigests.map((row) => [row.table, row]));
  const changed = after.rowDigests.filter((row) => {
    const previous = beforeByTable.get(row.table);
    return (
      !previous || previous.count !== row.count || (row.table !== 'public.workflow' && previous.digest !== row.digest)
    );
  });
  if (changed.length > 0 || after.rowDigests.length !== before.rowDigests.length) {
    throw new Error(`Adoption changed workflow data: ${changed.map(({ table }) => table).join(', ')}`);
  }
};

/**
 * Parts of released `immich_fork` migrations that only act when a Frameleaf public table exists.
 * They ran at the first boot, before adoption created those tables, so they are repeated here. The
 * `up` functions of 0000000000170, 0000000000172 and 0000000000201 are idempotent and run as
 * released; 0000000000176 also creates a fork table that already exists, so only its
 * `pet_observation` statement is repeated. The history carry-over of 0000000000175 is not: an
 * official library has no Frameleaf face decisions to carry over.
 */
export async function applyAdoptionForkFollowUps(db: Kysely<any>): Promise<void> {
  await indexMlAccountingJobs(db);
  await addRenderSessionOutputEvidence(db);
  await sql`
    ALTER TABLE public.pet_observation
      ADD COLUMN IF NOT EXISTS "sourceChecksum" bytea,
      ADD COLUMN IF NOT EXISTS "staleAt" timestamp with time zone
  `.execute(db);
  await indexMlAccountingCloudJobs(db);
}
