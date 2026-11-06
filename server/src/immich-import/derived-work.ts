import { Kysely, SelectQueryBuilder, sql } from 'kysely';
import { v5 } from 'uuid';
import { JobName } from 'src/enum.js';
import { digest } from 'src/immich-import/adapters.js';
import { assertMediaPolicy, managerImportAuthority } from 'src/immich-import/media.js';
import { ImportConfig, ImportRefused } from 'src/immich-import/types.js';
import { QUEUE_BATCH, QueueIntent, RunHolds } from 'src/queue/types.js';
import { PersonRepository } from 'src/repositories/person.repository.js';

export const IMPORT_DERIVED_RUN_KIND = 'immich-import-derived';
export const IMPORT_DERIVED_STAGES = [
  ['metadata', JobName.AssetExtractMetadata],
  ['thumbnail', JobName.AssetGenerateThumbnails],
  ['smart-search', JobName.SmartSearch],
  ['face-detection', JobName.AssetDetectFaces],
] as const;

/** Every stage a derived run holds: the per-asset stages, people thumbnails and (FL-414) identical files. */
export const IMPORT_DERIVED_RUN_STAGES = [
  ...IMPORT_DERIVED_STAGES.map(([, stage]) => stage),
  JobName.PersonGenerateThumbnail,
  JobName.IdenticalFilesCheck,
] as const;

/** FL-414: the import's one identical-files item; the run itself covers the whole server. */
export const IMPORT_IDENTICAL_FILES_ITEM = 'identical-files';

/** The same verified journal must resolve the same run even after a lost commit acknowledgement. */
export const importDerivedRunId = (sourceFingerprint: string, configFingerprint: string): string =>
  v5(JSON.stringify([IMPORT_DERIVED_RUN_KIND, sourceFingerprint, configFingerprint]), v5.URL);

/**
 * FL-1265: one job per selected item in the run, inserted once (a retry adds only what is missing). A stage the run's
 * holds name starts held (`availableAt = 'infinity'`); setup changes holds under the run's FOR UPDATE, so reading them
 * FOR SHARE keeps an older view from re-holding work a concurrent release just let go.
 */
export async function insertRunJobs(
  db: Kysely<any>,
  runId: string,
  intent: QueueIntent,
  selection: SelectQueryBuilder<any, any, { id: string }>,
) {
  const insert = async (tx: Kysely<any>) => {
    await sql`insert into job_queue(name) values (${intent.queue}) on conflict do nothing`.execute(tx);
    const {
      rows: [run],
    } = await sql<{ held: boolean }>`select coalesce(selection->'holds','{}'::jsonb) ? ${intent.name} as held
      from job_run where id = ${runId}::uuid for share`.execute(tx);
    await sql`insert into job(id, queue, name, data, "safeToRetry", sensitive, "deadlineMs", "availableAt",
        "runId", "itemKey", "rootItemKey")
      select gen_random_uuid(), ${intent.queue}, ${intent.name},
        ${JSON.stringify(intent.data)}::text::jsonb || coalesce(to_jsonb(s)->'data','{}'::jsonb) || jsonb_build_object('id', s.id),
        ${intent.safeToRetry}, ${intent.sensitive}, ${intent.deadlineMs},
        ${run?.held ? sql`'infinity'::timestamptz` : sql`now()`}, ${runId}::uuid, s.id::text,
        coalesce(to_jsonb(s)->>'rootItemKey', s.id::text)
      from (${selection}) s on conflict do nothing`.execute(tx);
  };
  return db.isTransaction ? insert(db) : db.transaction().execute(insert);
}

/** Transfer ownership to retained manifests, without creating executions or loading the library into JS. */
export async function transferImportedWork(
  db: Kysely<any>,
  intentFor: (name: JobName) => QueueIntent,
  config?: ImportConfig,
): Promise<string> {
  const media = config?.media;
  if (!config && process.env.FRAMELEAF_MANAGER_ORIGIN === 'new_import')
    throw new ImportRefused('MANAGER_SETUP_CONFIG_REQUIRED');
  const authority = managerImportAuthority(media);
  const managed = !!authority;
  if (config) assertMediaPolicy(config.mediaRoots, media);
  if (media?.mode === 'manager-in-place' && !authority) throw new ImportRefused('MANAGER_SETUP_AUTHORITY_REQUIRED');
  const runId = await db.transaction().execute(async (tx) => {
    const {
      rows: [journal],
    } = await sql<{
      status: string;
      source_fingerprint: string;
      config_fingerprint: string;
    }>`select status, source_fingerprint, config_fingerprint from frameleaf_immich_import for update`.execute(tx);
    if (journal?.status !== 'verifying') throw new ImportRefused('DERIVED_WORK_REQUIRES_VERIFYING_IMPORT');
    if (config && digest(config) !== journal.config_fingerprint) {
      throw new ImportRefused('DERIVED_WORK_CONFIG_MISMATCH');
    }
    const id = importDerivedRunId(journal.source_fingerprint, journal.config_fingerprint);
    const {
      rows: [existing],
    } = await sql<{
      kind: string;
      selection: {
        source: string;
        config: string;
        managerSetupRequired?: unknown;
        managerSetup?: {
          installation: string;
          operationId: string;
          preparedAt: string | null;
          startedAt: string | null;
          paused?: boolean;
        };
      } | null;
    }>`select kind, selection from job_run where id = ${id}::uuid for update`.execute(tx);
    if (
      existing &&
      (existing.kind !== IMPORT_DERIVED_RUN_KIND ||
        existing.selection?.source !== journal.source_fingerprint ||
        existing.selection?.config !== journal.config_fingerprint)
    ) {
      throw new ImportRefused('DERIVED_RUN_IDENTITY_MISMATCH');
    }
    const setup = existing?.selection?.managerSetup;
    if (
      existing?.selection?.managerSetupRequired !== undefined &&
      (existing.selection.managerSetupRequired !== true || !managed)
    )
      throw new ImportRefused('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
    if (
      existing &&
      (managed
        ? !setup ||
          setup.installation !== authority.installation ||
          setup.operationId !== authority.operationId ||
          (setup.paused !== undefined && typeof setup.paused !== 'boolean') ||
          (setup.preparedAt !== null &&
            (typeof setup.preparedAt !== 'string' || !Number.isFinite(Date.parse(setup.preparedAt)))) ||
          (setup.startedAt !== null &&
            (!setup.preparedAt || typeof setup.startedAt !== 'string' || !Number.isFinite(Date.parse(setup.startedAt))))
        : !!setup)
    ) {
      // Never retrofit a hold onto an older ready run which could already have been dispatched.
      throw new ImportRefused('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
    }
    // A legacy hot-queue dispatch cannot be proved by this protocol. Never give it a new budget.
    if (!existing) {
      const { rows } =
        await sql`select 1 from frameleaf_immich_import_work where dispatched_at is not null limit 1`.execute(tx);
      if (rows.length > 0) throw new ImportRefused('DERIVED_WORK_ACKNOWLEDGEMENT_WITHOUT_RUN');
      const selection = {
        source: journal.source_fingerprint,
        config: journal.config_fingerprint,
        // FL-1265: a managed import's work is held until first setup releases it.
        ...(managed && {
          holds: Object.fromEntries(IMPORT_DERIVED_RUN_STAGES.map((stage) => [stage, 'setup'])) as RunHolds,
          managerSetupRequired: true,
          managerSetup: {
            installation: authority.installation,
            operationId: authority.operationId,
            preparedAt: null,
            startedAt: null,
          },
        }),
      };
      await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${IMPORT_DERIVED_RUN_KIND},
        ${JSON.stringify(selection)}::text::jsonb)`.execute(tx);
    }
    if (managed && existing && existing.selection?.managerSetupRequired === undefined)
      await sql`update job_run set selection=selection || '{"managerSetupRequired":true}'::jsonb where id=${id}::uuid`.execute(
        tx,
      );
    return id;
  });

  // The importer bulk-loads the journal; plan the inserts below from fresh statistics rather than whatever sample
  // autovacuum last took. SKIP_LOCKED leaves a table alone while autovacuum is already analyzing it.
  await sql`analyze (skip_locked) frameleaf_immich_import_work`.execute(db);
  const stages = IMPORT_DERIVED_STAGES.map(([kind, name]) => {
    const intent = intentFor(name);
    // Regenerating unverified vectors must not discard retained source face identities.
    if (name === JobName.AssetDetectFaces) intent.data = { ...intent.data, preserveImportedFaces: true };
    return { kind, intent };
  });
  for (const { kind, intent } of stages) {
    await insertRunJobs(
      db,
      runId,
      intent,
      db.selectFrom('frameleaf_immich_import_work').select('asset_id as id').where('kind', '=', kind),
    );
  }

  // The verified destination is the imported cohort. Missing people thumbnails are separate from
  // asset thumbnails: matching an existing imported face does not create this follow-up work.
  const people = new PersonRepository(db).selectionForThumbnails(false);
  const personIntent = intentFor(JobName.PersonGenerateThumbnail);
  await insertRunJobs(db, runId, personIntent, people);
  const { rows: missingPeople } = await sql`select 1 from (${people}) p where not exists (
    select 1 from job j where j."runId" = ${runId}::uuid and j.name = ${personIntent.name}
      and j.queue = ${personIntent.queue} and j."itemKey" = p.id::text and j."rootItemKey" = p."rootItemKey"::text
      and j.data @> (${JSON.stringify(personIntent.data)}::text::jsonb || coalesce(to_jsonb(p)->'data','{}'::jsonb)
        || jsonb_build_object('id', p.id))
  ) limit 1`.execute(db);
  if (missingPeople.length > 0) throw new ImportRefused('DERIVED_PERSON_WORK_MANIFEST_MISMATCH');

  // FL-414: once the import is activated, the identical-files run (FL-413) reads every file again,
  // stores identical files once, merges identical photos and recovers orphans into Recovered Media.
  // One item for the whole server, inserted here like every stage, so the importer still changes no files.
  const identicalIntent = intentFor(JobName.IdenticalFilesCheck);
  identicalIntent.data = { ...identicalIntent.data, importRunId: runId };
  await insertRunJobs(
    db,
    runId,
    identicalIntent,
    db.selectNoFrom(sql<string>`${sql.lit(IMPORT_IDENTICAL_FILES_ITEM)}`.as('id')),
  );
  const { rows: identical } = await sql`select 1 from job where "runId" = ${runId}::uuid
    and name = ${identicalIntent.name} and "itemKey" = ${IMPORT_IDENTICAL_FILES_ITEM} limit 1`.execute(db);
  if (identical.length === 0) throw new ImportRefused('DERIVED_IDENTICAL_FILES_MANIFEST_MISMATCH');
  await sql`analyze (skip_locked) job`.execute(db);

  const stageNames = sql.join(
    stages.map(
      ({ kind, intent }) =>
        sql`(${kind}, ${intent.name}, ${intent.queue}, ${JSON.stringify(intent.data)}::text::jsonb)`,
    ),
  );
  // Containment, not equality: handlers add routing (`_queueDestinations`) to a job's data as it runs.
  const retained = sql`exists (
    select 1 from (values ${stageNames}) as expected(kind, stage, queue, data)
    join job j on j."runId" = ${runId}::uuid and j."itemKey" = w.asset_id::text and j.name = expected.stage
    where expected.kind = w.kind and j.queue = expected.queue and j."rootItemKey" = w.asset_id::text
      and j.data @> (expected.data || jsonb_build_object('id', w.asset_id::text)))`;
  let cursor: { asset_id: string; kind: string } | undefined;
  while (true) {
    const page = await db.transaction().execute(async (tx) => {
      const { rows } = await sql<{
        asset_id: string;
        kind: string;
      }>`select asset_id, kind from frameleaf_immich_import_work
        where dispatched_at is null ${cursor ? sql`and (asset_id, kind) > (${cursor.asset_id}::uuid, ${cursor.kind})` : sql``}
        order by asset_id, kind limit ${QUEUE_BATCH} for update`.execute(tx);
      if (rows.length === 0) return rows;
      const { rows: acknowledged } = await sql`update frameleaf_immich_import_work w set dispatched_at = now()
        where (w.asset_id, w.kind) in (select * from unnest(${rows.map((row) => row.asset_id)}::uuid[], ${rows.map((row) => row.kind)}::text[]))
          and ${retained} returning asset_id`.execute(tx);
      if (acknowledged.length !== rows.length) throw new ImportRefused('DERIVED_WORK_MANIFEST_MISMATCH');
      return rows;
    });
    if (page.length === 0) break;
    cursor = page.at(-1);
  }
  // Also audit already acknowledged rows on resume. A timestamp alone cannot authorize activation.
  const { rows } = await sql`select 1 from frameleaf_immich_import_work w
    where w.dispatched_at is null or not ${retained} limit 1`.execute(db);
  if (rows.length > 0) throw new ImportRefused('DERIVED_WORK_MANIFEST_MISMATCH');
  if (managed) {
    // Preparation is distinct from start. Only first setup can release this retained run after
    // activation and validated initial settings; a resumed transfer never clears either timestamp.
    await sql`update job_run set selection = jsonb_set(selection, '{managerSetup,preparedAt}', to_jsonb(clock_timestamp()))
      where id = ${runId}::uuid and selection #>> '{managerSetup,preparedAt}' is null`.execute(db);
  }
  return runId;
}
