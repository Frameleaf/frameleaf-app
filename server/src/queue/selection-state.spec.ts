import { DummyDriver, Kysely, PostgresAdapter, PostgresIntrospector, PostgresQueryCompiler, sql } from 'kysely';
import { libraryRedactionPage } from 'src/queue/library-admission.js';
import { listRuns } from 'src/queue/run-query.js';
import { libraryMembershipEntitled, selectionItemContext, selectionItemState } from 'src/queue/selection-state.js';
import { PetRepository } from 'src/repositories/pet.repository.js';

/** Compile the actual caller without PostgreSQL; medium controls establish SQL/runtime semantics. */
describe('selection SQL context contracts', () => {
  const queries: string[] = [];
  const db = new Kysely<any>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
    log(event) {
      if (event.level === 'query') queries.push(event.query.sql);
    },
  });
  afterAll(() => db.destroy());

  it('supplies every state-expression alias in the shared primary-key context', () => {
    const query = sql`select ${selectionItemState} ${selectionItemContext(sql<string>`r.id`)}`.compile(db).sql;
    for (const alias of ['i', 'snapshot', 'executor', 'executor_source', 'j'])
      expect(query).toMatch(new RegExp(String.raw`(?:from|join) \w+ ${alias}\b`));
    expect(query).toContain(') canonical on true');
    expect(query).toContain('coalesce(executor_source.state,snapshot.state)');
    expect(query).toContain('initial_entitlement.entitled');
    expect(query).toContain('offset 0)');
  });

  it('evaluates each effective stage state once before aggregate outcomes use it', async () => {
    queries.length = 0;
    expect(await listRuns(db, 10, 0)).toEqual([]);
    const query = queries[0];
    expect(query).toContain(') union all (');
    expect(query).toContain('not coalesce((');
    expect(query.split('initial_entitlements as materialized')).toHaveLength(2);
    expect(query).toContain('i."runId"=snapshot."libraryOperationId"');
    expect(query).toContain('not coalesce(initial_entitlement.entitled,false)');
    expect(query.split(selectionItemState.compile(db).sql)).toHaveLength(2);
  });

  it('compiles all three actual pet reconciliation probes with the complete shared context', async () => {
    queries.length = 0;
    const pets = new PetRepository(db, { setContext() {} } as never);
    expect(await pets.getRun('00000000-0000-0000-0000-000000000001')).toBeUndefined();
    const update = queries.find((query) => query.startsWith('update public.pet_recognition_run'))!;
    expect(update).toBeDefined();
    expect(update.split(selectionItemContext(sql<string>`r.id`).compile(db).sql)).toHaveLength(4);
  });

  it('keeps caller child/origin/membership/original identities outside nested entitlement scopes', () => {
    const query = libraryMembershipEntitled(
      sql<string>`origin."runId"`,
      sql<string>`child."libraryOperationId"`,
    ).compile(db).sql;
    expect(query).toContain('root_proof_source."libraryOperationId" = child."libraryOperationId"');
    expect(query).toContain('root_proof_membership."runId" = origin."runId"');
    expect(query).toContain('frozen_entitlement_original.id = root_proof_original.id');
    expect(query).not.toMatch(/(?:from|join) \w+ (?:child|origin|membership|original)\b/);
  });

  it('materializes the bounded indexed candidate page before locking or probing owner eligibility', () => {
    const { sql: query, parameters } = libraryRedactionPage('paused-library-queue').compile(db);
    const candidates = query.slice(
      query.indexOf('candidates as materialized'),
      query.indexOf('locked as materialized'),
    );
    expect(candidates).toContain('order by i."libraryCleanupId" limit');
    expect(candidates).not.toContain('owner');
    expect(candidates).not.toContain('needs_attention');
    expect(query).toContain('cross join lateral');
    expect(query).toContain('limit 1 for update of owner');
    expect(parameters).toContain(250);
    expect(query).toContain("'through'");
  });
});
