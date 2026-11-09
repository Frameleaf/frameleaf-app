import { Kysely, sql } from 'kysely';
import { v5 } from 'uuid';
import { z } from 'zod';
import { JobName } from 'src/enum.js';
import { insertRunJobs } from 'src/immich-import/derived-work.js';
import { bindDestinationImportPlan } from 'src/library-import/destination-plan.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { parseImportManifest } from 'src/library-import/manifest.js';
import { ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';
import {
  type LibraryImportBinding,
  LibraryImportRefused,
  parseLibraryImportBinding,
} from 'src/library-import/state.js';
import { QueueIntent, RunHolds } from 'src/queue/types.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';

export const LIBRARY_IMPORT_DERIVED_RUN_KIND = 'library-import-derived';
export const LIBRARY_IMPORT_DERIVED_RUN_STAGES = [
  JobName.AssetExtractMetadata,
  JobName.AssetGenerateThumbnails,
  JobName.SmartSearch,
  JobName.AssetDetectFaces,
  JobName.AssetEncodeVideo,
  JobName.PersonGenerateThumbnail,
] as const;
const managerSchema = z.strictObject({
  installation: z.string().regex(/^[a-f0-9]{12}$/u),
  operationId: z.uuid().transform((value) => value.toLowerCase()),
});
export type ManagerLibrarySetup = z.infer<typeof managerSchema>;
const setupMarkerSchema = managerSchema.extend({
  paused: z.boolean().optional(),
  preparedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable(),
  startedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)))
    .nullable(),
});
export const libraryImportDerivedRunId = (binding: LibraryImportBinding): string =>
  v5(
    JSON.stringify([LIBRARY_IMPORT_DERIVED_RUN_KIND, binding.operationId, binding.manifestSha256, binding.planSha256]),
    v5.URL,
  );
const refuse = (code: string): never => {
  throw new LibraryImportRefused(code);
};

export const parseManagerLibrarySetup = (input: unknown, binding: LibraryImportBinding) => {
  if (input === undefined) return;
  const parsed = managerSchema.safeParse(input);
  if (!parsed.success || parsed.data.operationId !== binding.operationId)
    return refuse('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
  return parsed.data;
};

/** Retain all regeneration atomically; only the activation controller may release this held run. */
export async function prepareLibraryImportWork(
  db: Kysely<DB>,
  intentFor: (name: JobName) => QueueIntent,
  context: ReviewedImportContext,
  managerInput?: ManagerLibrarySetup,
): Promise<string> {
  const binding = parseLibraryImportBinding(context.binding);
  const runId = libraryImportDerivedRunId(binding);
  const manager = parseManagerLibrarySetup(managerInput, binding);
  try {
    return await db.transaction().execute(async (tx) => {
      const { rows: locks } = await sql<{ acquired: boolean }>`select pg_try_advisory_xact_lock(
        ${LIBRARY_IMPORT_LOCK}::bigint) as acquired`.execute(tx);
      if (!locks[0]?.acquired) return refuse('IMPORT_ALREADY_RUNNING');
      const { rows: journals } = await sql<{
        binding: unknown;
        status: string;
        reviewed_manifest: unknown;
        reviewed_plan: unknown;
      }>`select binding,status,reviewed_manifest,reviewed_plan from frameleaf_library_import for update`.execute(tx);
      const journal = journals[0];
      if (!journal) return refuse('IMPORT_JOURNAL_MISSING');
      if (JSON.stringify(parseLibraryImportBinding(journal.binding)) !== JSON.stringify(binding))
        return refuse('IMPORT_BINDING_CHANGED');
      if (journal.status !== 'verifying') return refuse('IMPORT_NOT_VERIFYING');
      if (journal.reviewed_manifest === null || journal.reviewed_plan === null)
        return refuse('IMPORT_REVIEWED_INPUTS_MISSING');
      const manifest = parseImportManifest(journal.reviewed_manifest);
      const plan = bindDestinationImportPlan(journal.reviewed_plan, binding, manifest, context.destinationId);
      if (manifest.version !== 3 && manifest.version !== 4 && manifest.version !== 5)
        return refuse('DERIVED_WORK_REQUIRES_SEALED_MANIFEST');

      // Reconcile the complete source/owner/type cohort before capturing any canonical IDs.
      const expectedOwners = sql`select o."sourceId",o."destinationId"::uuid as id
        from jsonb_to_recordset(${JSON.stringify(plan.owners)}::text::jsonb) o("sourceId" text,"destinationId" text)`;
      const ownerMappings = sql`select source_id as "sourceId",destination_id as id
        from frameleaf_library_import_mapping where operation_id=${binding.operationId}::uuid and entity_kind='owner'`;
      const expectedAssets = sql`select a.id as source_id,o.id as "ownerId",a.type
        from jsonb_to_recordset(${JSON.stringify(manifest.assets.map(({ id, ownerId, type }) => ({ id, ownerId, type })))}::text::jsonb) a(id text,"ownerId" text,type text)
        join (${expectedOwners}) o on o."sourceId"=a."ownerId"`;
      const mappedAssets = sql`select m.source_id,m.destination_id,a."ownerId",a.type
        from frameleaf_library_import_mapping m left join asset a on a.id=m.destination_id
        where m.operation_id=${binding.operationId}::uuid and m.entity_kind='asset'`;
      const { rows: invalidCohort } = await sql`
        ((${expectedOwners}) except (${ownerMappings})) union all
        ((${ownerMappings}) except (${expectedOwners}))`.execute(tx);
      if (invalidCohort.length > 0) return refuse('DERIVED_OWNER_COHORT_MISMATCH');
      const { rows: invalidAssets } = await sql`select 1 where exists (
        (select source_id,"ownerId",type from (${expectedAssets}) e
         except select source_id,"ownerId",type::text from (${mappedAssets}) m)
        union all
        (select source_id,"ownerId",type::text from (${mappedAssets}) m
         except select source_id,"ownerId",type from (${expectedAssets}) e)
      ) or exists (select 1 from (${mappedAssets}) m group by destination_id having count(*)<>1)
        or exists (select 1 from asset a where not exists (select 1 from (${mappedAssets}) m where m.destination_id=a.id))
        or exists (select 1 from asset where "libraryScope"<>'personal' or "libraryId" is not null
          or "isExternal" or "isOffline")
        or exists (select 1 from (${expectedOwners}) o left join "user" u on u.id=o.id
          where u.id is null or u.status<>'active' or u."deletedAt" is not null or u."isAdmin")`.execute(tx);
      if (invalidAssets.length > 0) return refuse('DERIVED_ASSET_COHORT_MISMATCH');

      const stages = LIBRARY_IMPORT_DERIVED_RUN_STAGES.map((name) => {
        const intent = intentFor(name);
        if (intent.name !== name || Object.keys(intent.data).length > 0) return refuse('DERIVED_INTENT_INVALID');
        return {
          ...intent,
          data: name === JobName.AssetDetectFaces ? { preserveImportedFaces: true } : {},
        };
      });
      // FL-1265: everything waits for activation (or Manager's first setup) to release it.
      const held: RunHolds = Object.fromEntries(stages.map((intent) => [intent.name, 'setup']));
      const selection = {
        version: 1,
        operationId: binding.operationId,
        destinationId: plan.destinationId.toLowerCase(),
        manifestSha256: binding.manifestSha256,
        planSha256: binding.planSha256,
        prepared: true,
      };
      const { rows: runs } = await sql<{ kind: string; valid: boolean; managed: boolean; setup: unknown }>`select kind,
        (selection - 'managerSetup' - 'managerSetupRequired' - 'holds' - 'holdsDirty' - 'holdsCursor' - 'releasedAt'
          - 'authorityHeld'
          =${JSON.stringify(selection)}::text::jsonb
          and (not selection ? 'managerSetupRequired' or selection->'managerSetupRequired'='true'::jsonb)
          and ("finishedAt" is null or ("enumerationDone" and not exists (
            select 1 from job where "runId"=job_run.id))))
          as valid,(selection ? 'managerSetup' or selection ? 'managerSetupRequired') as managed,selection->'managerSetup' as setup
          from job_run where id=${runId}::uuid for update`.execute(tx);
      if (runs[0] && (runs[0].kind !== LIBRARY_IMPORT_DERIVED_RUN_KIND || !runs[0].valid))
        return refuse('DERIVED_RUN_IDENTITY_MISMATCH');
      if (runs[0]) {
        const marker = setupMarkerSchema.safeParse(runs[0].setup);
        if (
          manager
            ? !runs[0].managed ||
              !marker.success ||
              marker.data.installation !== manager.installation ||
              marker.data.operationId !== manager.operationId ||
              marker.data.startedAt !== null
            : runs[0].managed
        )
          return refuse('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
      } else {
        const retained = {
          ...selection,
          holds: held,
          ...(manager && {
            managerSetupRequired: true,
            managerSetup: { ...manager, preparedAt: null, startedAt: null },
          }),
        };
        await sql`insert into job_run(id,kind,selection) values (${runId}::uuid,${LIBRARY_IMPORT_DERIVED_RUN_KIND},${JSON.stringify(retained)}::text::jsonb)`.execute(
          tx,
        );
      }

      if (manager)
        await sql`update job_run set selection=selection || '{"managerSetupRequired":true}'::jsonb
          where id=${runId}::uuid and not selection ? 'managerSetupRequired'`.execute(tx);

      const cohort = sql<{ destination_id: string; ownerId: string; type: string }>`(${mappedAssets})`.as('mapped');
      const assets = tx.selectFrom(cohort).select('mapped.destination_id as id');
      const people = new PersonRepository(tx)
        .selectionForThumbnails(false, undefined, true)
        .innerJoin(cohort, 'mapped.destination_id', 'face.assetId')
        .whereRef('person.ownerId', '=', 'mapped.ownerId');
      for (const intent of stages) {
        // Named so TypeScript doesn't have to expand the union of all three query shapes (TS2590).
        const selected: Parameters<typeof insertRunJobs>[3] =
          intent.name === JobName.PersonGenerateThumbnail
            ? people
            : intent.name === JobName.AssetEncodeVideo
              ? assets.where('mapped.type', '=', 'VIDEO')
              : assets;
        if (!runs[0]) await insertRunJobs(tx, runId, intent, selected);
        // Independently compare both directions; held work is never silently repaired.
        const expected = sql`select p.id::text as "itemKey",coalesce(to_jsonb(p)->>'rootItemKey',p.id::text) as "rootItemKey",
          ${JSON.stringify(intent.data)}::text::jsonb || coalesce(to_jsonb(p)->'data','{}'::jsonb) || jsonb_build_object('id',p.id) as data
          from (${selected}) p`;
        const actual = sql`select "itemKey","rootItemKey",data from job where "runId"=${runId}::uuid and name=${intent.name}`;
        const { rows: invalid } = await sql`select 1 where exists (
          ((${expected}) except (${actual})) union all ((${actual}) except (${expected})))`.execute(tx);
        if (invalid.length > 0) return refuse('DERIVED_WORK_MANIFEST_MISMATCH');
      }
      // Every job of the run is one of these stages, still held and never started.
      const expectedStages = sql.join(
        stages.map(
          (intent) =>
            sql`(${intent.name}::text,${intent.queue}::text,${intent.safeToRetry}::boolean,${intent.sensitive}::boolean,
            ${intent.deadlineMs}::int)`,
        ),
      );
      const { rows: invalidState } = await sql`select 1 from job_run where id=${runId}::uuid
          and coalesce(selection->'holds','{}'::jsonb)<>${JSON.stringify(held)}::text::jsonb
        union all select 1 from job j
        left join (values ${expectedStages}) as e(name,queue,"safeToRetry",sensitive,"deadlineMs") on e.name=j.name
        where j."runId"=${runId}::uuid and (e.name is null or j.queue<>e.queue or j."safeToRetry"<>e."safeToRetry"
          or j.sensitive<>e.sensitive or j."deadlineMs"<>e."deadlineMs" or j.state<>'pending' or j.attempt<>0
          or j."availableAt"<>'infinity'::timestamptz or j."parentId" is not null)
        limit 1`.execute(tx);
      if (invalidState.length > 0) return refuse('DERIVED_WORK_MANIFEST_MISMATCH');
      if (manager)
        await sql`update job_run set selection=jsonb_set(selection,'{managerSetup,preparedAt}',to_jsonb(clock_timestamp()))
          where id=${runId}::uuid and selection #>> '{managerSetup,preparedAt}' is null`.execute(tx);
      return runId;
    });
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    // Database errors can contain private inventory and source paths.
    throw new LibraryImportRefused('DERIVED_WORK_PREPARATION_FAILED');
  }
}
