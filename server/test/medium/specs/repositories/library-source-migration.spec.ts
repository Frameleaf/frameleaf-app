import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { libraryRedactionPage } from 'src/queue/library-admission.js';
import * as lineage from 'src/schema/migrations/1791101500000-RetainSelectionLineage.js';
import * as library from 'src/schema/migrations/1791101600000-LibraryScanSources.js';
import { getLibraryQueueDB } from 'test/medium/library-queue-database.js';

it('enforces the 160 source, paired ownership and database-generated cleanup identities', async () => {
  const db = await getLibraryQueueDB(),
    run = randomUUID(),
    source = randomUUID(),
    queue = `library-ddl-${randomUUID()}`;
  try {
    await sql`insert into job_queue(name) values (${queue})`.execute(db);
    await sql`insert into job_run(id,kind,selection) values (${run}::uuid,'ddl-control','{}'::jsonb)`.execute(db);
    await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state)
      values (${source}::uuid,${run}::uuid,'ddl-control',${queue},false,true,60000,'ready')`.execute(db);
    expect(
      (
        await sql`select "sourceKind","libraryOperationId","sourceClosedAt","appendSequence"::int,"librarySharesExecution"
      from job_selection where id=${source}::uuid`.execute(db)
      ).rows,
    ).toEqual([
      {
        sourceKind: 'frozen',
        libraryOperationId: null,
        sourceClosedAt: null,
        appendSequence: 0,
        librarySharesExecution: false,
      },
    ]);
    await expect(
      sql`update job_selection set "sourceKind"='library-initial' where id=${source}::uuid`.execute(db),
    ).rejects.toThrow('job_selection_library_source');
    await expect(
      sql`update job_selection set "appendSequence"=-1 where id=${source}::uuid`.execute(db),
    ).rejects.toThrow('job_selection_append_sequence');
    await sql`update job_selection set "sourceKind"='library-initial',"libraryOperationId"=${run}::uuid where id=${source}::uuid`.execute(
      db,
    );
    await sql`insert into job_run_item("runId","itemKey",stage,queue,selection,"selectionId")
      values (${run}::uuid,'root','ddl-control',${queue},'{}'::jsonb,${source}::uuid)`.execute(db);
    await expect(
      sql`update job_run_item set "libraryExecutionRunId"=${run}::uuid where "runId"=${run}::uuid`.execute(db),
    ).rejects.toThrow('job_library_execution_identity');
    await expect(
      sql`update job_run_item set "librarySourceKey"='unpaired' where "runId"=${run}::uuid`.execute(db),
    ).rejects.toThrow('job_run_item_library_intent');
    await expect(
      sql`update job_run_item set "libraryCleanupId"=1 where "runId"=${run}::uuid`.execute(db),
    ).rejects.toThrow('can only be updated to DEFAULT');
    const cleanup = (
      await sql<{
        value: string;
        identity: string;
        nullable: string;
      }>`select i."libraryCleanupId"::text value,a.attidentity identity,a.attnotnull::text nullable
      from job_run_item i cross join pg_attribute a where i."runId"=${run}::uuid and a.attrelid='job_run_item'::regclass and a.attname='libraryCleanupId'`.execute(
        db,
      )
    ).rows[0];
    expect(Number(cleanup.value)).toBeGreaterThan(0);
    expect(cleanup.identity).toBe('a');
    expect(cleanup.nullable).toBe('true');
    const outcome = (
      await sql<{
        definition: string;
      }>`select pg_get_indexdef('job_library_initial_outcome'::regclass) definition`.execute(db)
    ).rows[0].definition;
    expect(outcome).toContain('("selectionId", "runId", "itemKey", stage)');
    expect(outcome).toContain('"libraryIntent" IS NOT NULL');
    expect(outcome).toContain('"libraryExecutionRunId" IS NOT NULL');
    await sql`insert into job_library_source_producer("selectionId","producerId") values (${source}::uuid,${randomUUID()}::uuid)`.execute(
      db,
    );
    await sql`update job_selection set state='cancelled',"sourceClosedAt"=now(),"capturedAt"=now() where id=${source}::uuid`.execute(
      db,
    );
    await sql`update job_run_item set state='cancelled' where "runId"=${run}::uuid`.execute(db);
    await library.down(db);
    expect(
      (
        await sql`select to_regclass('job_library_initial_outcome')::text index,to_regclass('job_library_source_producer')::text "table"`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ index: null, table: null }]);
    await library.up(db);
    expect(
      (await sql`select "sourceKind","appendSequence"::int from job_selection where id=${source}::uuid`.execute(db))
        .rows,
    ).toEqual([{ sourceKind: 'frozen', appendSequence: 0 }]);
  } finally {
    await db.destroy();
  }
});

/** Synthetic ledger rows exercise DDL/global cleanup, never a library submission entrypoint. */
it('preserves fail-closed downgrade, 150/160 ordering and fair global cleanup after identity replacement', async () => {
  const db = await getLibraryQueueDB(),
    run = randomUUID(),
    source = randomUUID(),
    queue = `library-migration-${randomUUID()}`;
  try {
    expect((await sql<{ version: string }>`select version()`.execute(db)).rows[0].version).toContain(
      'PostgreSQL 19beta4',
    );
    expect(
      (await sql<{ statement_timeout: string }>`show statement_timeout`.execute(db)).rows[0].statement_timeout,
    ).toBe('5s');
    expect((await sql<{ lock_timeout: string }>`show lock_timeout`.execute(db)).rows[0].lock_timeout).toBe('3s');
    await sql`insert into job_queue(name) values (${queue})`.execute(db);
    await sql`insert into job_run(id,kind,selection) values (${run}::uuid,'migration-fixture','{}'::jsonb)`.execute(db);
    await sql`insert into job_selection(id,"runId",stage,queue,"safeToRetry",sensitive,"deadlineMs",state,"sourceKind","libraryOperationId")
      values (${source}::uuid,${run}::uuid,'library-child/migration-fixture',${queue},false,true,60000,'enumerating','library-child',${run}::uuid)`.execute(
      db,
    );
    await expect(library.down(db)).rejects.toThrow('Settle library sources');
    await sql`update job_selection set state='cancelled',"sourceClosedAt"=now(),"capturedAt"=now() where id=${source}::uuid`.execute(
      db,
    );
    const declared = JSON.stringify({
      data: { secret: 'synthetic-migration' },
      options: { delay: 0 },
      sensitive: true,
    });
    for (let first = 1; first <= 50_000; first += 250)
      await sql`insert into job_run_item("runId","itemKey","rootItemKey",stage,queue,selection,"selectionId","librarySourceKey","libraryIntent")
        select ${run}::uuid,n::text,n::text,'migration-fixture',${queue},'{}'::jsonb,${source}::uuid,n::text,${declared}::text::jsonb from generate_series(${first}::int,${first + 249}::int) n`.execute(
        db,
      );
    await sql`analyze job_run_item`.execute(db);
    await expect(library.down(db)).rejects.toThrow('Settle library sources');
    type Plan = {
      'Relation Name'?: string;
      'Index Name'?: string;
      'Actual Rows': number;
      'Actual Loops': number;
      'Rows Removed by Filter'?: number;
      Plans?: Plan[];
    };
    const flatten = (node: Plan): Plan[] => [node, ...(node.Plans ?? []).flatMap((child) => flatten(child))];
    const explain = await db.transaction().execute(async (tx) => {
      await sql`select name from job_queue order by name for no key update`.execute(tx);
      return sql<{
        'QUERY PLAN': { Plan: Plan }[];
      }>`explain (analyze,buffers,format json) ${libraryRedactionPage()}`.execute(tx);
    });
    const nodes = flatten(explain.rows[0]['QUERY PLAN'][0].Plan);
    expect(nodes.some((node) => node['Index Name'] === 'job_library_redact_all_cursor')).toBe(true);
    for (const node of nodes)
      if (node['Relation Name'] === 'job_run_item')
        expect(
          (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'],
        ).toBeLessThanOrEqual(250);
    const count = async () =>
      (
        await sql<{
          count: number;
        }>`select count(*)::int count from job_run_item where "runId"=${run}::uuid and "libraryIntent"->'data'!='{}'::jsonb`.execute(
          db,
        )
      ).rows[0].count;
    expect(await count()).toBe(49_750);
    for (let first = 1; first <= 50_000; first += 250)
      await sql`update job_run_item set state='needs_attention' where "runId"=${run}::uuid and "itemKey" in (select n::text from generate_series(${first}::int,${first + 249}::int) n)`.execute(
        db,
      );
    await library.down(db);
    await lineage.down(db);
    expect(
      (await sql<{ index: string | null }>`select to_regclass('job_library_redact_all_cursor')::text index`.execute(db))
        .rows[0].index,
    ).toBeNull();
    await lineage.up(db);
    await library.up(db);
    // New synthetic payloads/identities, not recovered or replayed execution. The retained
    // old cursor is allowed to finish one fixed pass, then must revisit the new low prefix.
    await sql`update job_selection set "sourceKind"='library-child',"libraryOperationId"=${run}::uuid where id=${source}::uuid`.execute(
      db,
    );
    for (let first = 1; first <= 50_000; first += 250)
      await sql`update job_run_item set "librarySourceKey"="itemKey","libraryIntent"=${declared}::text::jsonb where "runId"=${run}::uuid and "itemKey" in (select n::text from generate_series(${first}::int,${first + 249}::int) n)`.execute(
        db,
      );
    let visits = 0;
    while ((await count()) > 0 && visits < 202) {
      const page = await db.transaction().execute(async (tx) => {
        await sql`select name from job_queue order by name for no key update`.execute(tx);
        return libraryRedactionPage().execute(tx);
      });
      expect(page.rows[0].visited).toBeLessThanOrEqual(250);
      expect(page.rows[0].redacted).toBeLessThanOrEqual(250);
      visits++;
    }
    expect(await count()).toBe(0);
    expect((await sql`select id from job where queue=${queue}`.execute(db)).rows).toEqual([]);
    console.info(
      'library-global-migration-calibration',
      JSON.stringify({ rows: 50_000, visits, pool: 2, statementMs: 5000, lockMs: 3000 }),
    );
  } finally {
    await db.destroy();
  }
}, 60_000);
