import { Kysely, sql } from 'kysely';
import { v5 } from 'uuid';
import { JobName } from 'src/enum.js';
import { digest } from 'src/immich-import/adapters.js';
import { assertMediaPolicy } from 'src/immich-import/media.js';
import { ImportConfig, ImportRefused } from 'src/immich-import/types.js';
import { freezeSelection } from 'src/queue/manifest.js';
import { QUEUE_BATCH, QueueIntent } from 'src/queue/types.js';
import { PersonRepository } from 'src/repositories/person.repository.js';

export const IMPORT_DERIVED_RUN_KIND = 'immich-import-derived';
export const IMPORT_DERIVED_STAGES = [
  ['metadata', JobName.AssetExtractMetadata],
  ['thumbnail', JobName.AssetGenerateThumbnails],
  ['smart-search', JobName.SmartSearch],
  ['face-detection', JobName.AssetDetectFaces],
] as const;

/** The same verified journal must resolve the same run even after a lost commit acknowledgement. */
export const importDerivedRunId = (sourceFingerprint: string, configFingerprint: string): string =>
  v5(JSON.stringify([IMPORT_DERIVED_RUN_KIND, sourceFingerprint, configFingerprint]), v5.URL);

/** Transfer ownership to retained manifests, without creating executions or loading the library into JS. */
export async function transferImportedWork(
  db: Kysely<any>,
  intentFor: (name: JobName) => QueueIntent,
  config?: ImportConfig,
): Promise<string> {
  const media = config?.media;
  const managed = media?.mode === 'manager-in-place';
  if (managed) {
    if (!config) throw new ImportRefused('MANAGER_SETUP_CONFIG_REQUIRED');
    assertMediaPolicy(config.mediaRoots, media);
    if (
      !/^[a-f0-9]{12}$/.test(media.deploymentId) ||
      process.env.FRAMELEAF_MANAGER_ORIGIN !== 'new_import' ||
      process.env.FRAMELEAF_MANAGER_INSTALLATION !== media.deploymentId ||
      process.env.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID !== media.operationId
    ) {
      throw new ImportRefused('MANAGER_SETUP_AUTHORITY_REQUIRED');
    }
  } else if (!config && process.env.FRAMELEAF_MANAGER_ORIGIN === 'new_import') {
    throw new ImportRefused('MANAGER_SETUP_CONFIG_REQUIRED');
  }
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
        managerSetup?: {
          installation: string;
          operationId: string;
          preparedAt: string | null;
          startedAt: string | null;
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
      existing &&
      (managed
        ? !setup ||
          setup.installation !== media.deploymentId ||
          setup.operationId !== media.operationId ||
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
        ...(managed && {
          managerSetup: {
            installation: media.deploymentId,
            operationId: media.operationId,
            preparedAt: null,
            startedAt: null,
          },
        }),
      };
      await sql`insert into job_run(id, kind, selection) values (${id}::uuid, ${IMPORT_DERIVED_RUN_KIND},
        ${JSON.stringify(selection)}::text::jsonb)`.execute(tx);
    }
    return id;
  });

  // Evaluated while freezeSelection holds the run lock, also used by first-setup release.
  const readiness = managed
    ? sql<'enumerating' | 'ready'>`case when (select selection #>> '{managerSetup,startedAt}' from job_run
        where id = ${runId}::uuid) is not null then 'ready' else 'enumerating' end`
    : undefined;

  const stages = IMPORT_DERIVED_STAGES.map(([kind, name]) => {
    const intent = intentFor(name);
    // Regenerating unverified vectors must not discard retained source face identities.
    if (name === JobName.AssetDetectFaces) intent.data = { ...intent.data, preserveImportedFaces: true };
    return { kind, intent };
  });
  for (const { kind, intent } of stages) {
    // The whole stage is frozen by INSERT SELECT, including an empty stage. Retries reuse its
    // original membership; acknowledged rows remain in the journal and are never excluded here.
    await freezeSelection(
      db,
      intent,
      db.selectFrom('frameleaf_immich_import_work').select('asset_id as id').where('kind', '=', kind),
      undefined,
      runId,
      readiness,
    );
  }

  // The verified destination is the imported cohort. Missing people thumbnails are separate from
  // asset thumbnails: matching an existing imported face does not create this follow-up work.
  const people = new PersonRepository(db).selectionForThumbnails(false);
  const personIntent = intentFor(JobName.PersonGenerateThumbnail);
  await freezeSelection(db, personIntent, people, undefined, runId, readiness);
  const { rows: missingPeople } = await sql`select 1 from (${people}) p where not exists (
    select 1 from job_run_item i join job_selection s on s.id = i."selectionId"
    where i."runId" = ${runId}::uuid and s."runId" = i."runId"
      and i.stage = ${personIntent.name} and s.stage = i.stage
      and i.queue = ${personIntent.queue} and s.queue = i.queue
      and s."capturedAt" is not null and i."itemKey" = p.id and i."rootItemKey" = p."rootItemKey"::text
      and i.selection = ${JSON.stringify(personIntent.data)}::text::jsonb || p.data || jsonb_build_object('id', p.id)
  ) limit 1`.execute(db);
  if (missingPeople.length > 0) throw new ImportRefused('DERIVED_PERSON_WORK_MANIFEST_MISMATCH');

  const stageNames = sql.join(
    stages.map(
      ({ kind, intent }) =>
        sql`(${kind}, ${intent.name}, ${intent.queue}, ${JSON.stringify(intent.data)}::text::jsonb)`,
    ),
  );
  const retained = sql`exists (
    select 1 from (values ${stageNames}) as expected(kind, stage, queue, data)
    join job_run_item i on i."runId" = ${runId}::uuid and i."itemKey" = w.asset_id::text and i.stage = expected.stage
    join job_selection s on s.id = i."selectionId" and s."runId" = i."runId" and s.stage = i.stage
    where expected.kind = w.kind and i.queue = expected.queue and s.queue = expected.queue
      and i."rootItemKey" = w.asset_id::text and i.selection = expected.data || jsonb_build_object('id', w.asset_id::text))`;
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
