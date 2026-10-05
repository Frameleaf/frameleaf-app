import { createPostgres } from '@frameleaf/sql-tools';
import { CompiledQuery, Kysely, sql } from 'kysely';
import { PostgresJSDialect } from 'kysely-postgres-js';
import { DB } from 'src/schema/index.js';
import { boundPoolClose } from 'src/utils/database.js';
import { boundExecutionReservations } from 'src/utils/execution-database.js';
import { getKyselyDB } from 'test/utils.js';

const settlementSamples = new WeakMap<Kysely<DB>, { ms: number; query: CompiledQuery }>();
const readSamples = new WeakMap<Kysely<DB>, CompiledQuery>();

export async function explainLibraryRunRead(db: Kysely<DB>, analyze = false) {
  const query = readSamples.get(db);
  if (!query) throw new Error('No actual public run read observed');
  const result = await db.executeQuery(
    // Retain actual row/loop/buffer work and total execution time without one clock
    // measurement per plan-node visit on million-row public reads. SQL limits stay unchanged.
    CompiledQuery.raw(`explain (${analyze ? 'analyze,buffers,timing false,' : ''}format json) ` + query.sql, [
      ...query.parameters,
    ]),
  );
  return result.rows[0];
}

/** Diagnostic decomposition of the observed production read, with the same unchanged SQL limits. */
export async function profileLibraryRunRead(db: Kysely<DB>) {
  const query = readSamples.get(db);
  if (!query) throw new Error('No actual public run read observed');
  const phases = [
    ['headers', '), stages as (', ' select id,"enumerationDone" from runs'],
    ['states', '), selected as (', ' select state,outcome,count(*) from run_stages group by state,outcome'],
    ['roots', '), item_counts as (', ' select outcome,count(*) from selected group by outcome'],
  ];
  for (const [phase, marker, suffix] of phases) {
    const split = query.sql.indexOf(marker);
    if (split === -1) throw new Error('Public read diagnostic structure changed');
    const body = query.sql.slice(0, split) + ')' + suffix;
    const highest = Math.max(...Array.from(body.matchAll(/\$(\d+)/g), (match) => Number(match[1])));
    const started = performance.now();
    try {
      const result = await db.executeQuery(
        CompiledQuery.raw('explain (analyze,buffers,format json) ' + body, query.parameters.slice(0, highest)),
      );
      console.info(
        'library-public-read-phase',
        JSON.stringify({ phase, elapsedMs: performance.now() - started, plan: result.rows[0] }),
      );
    } catch (error) {
      console.info(
        'library-public-read-phase',
        JSON.stringify({ phase, elapsedMs: performance.now() - started, error: String(error) }),
      );
    }
  }
}

/** Explain one measured actual settlement under the same catalogue guard and SQL limits. */
export async function explainLibrarySettlement(db: Kysely<DB>) {
  const sample = settlementSamples.get(db);
  if (!sample) throw new Error('No actual settlement query observed');
  const result = await db.transaction().execute(async (tx) => {
    await sql`select name from job_queue order by name for no key update`.execute(tx);
    return tx.executeQuery(
      CompiledQuery.raw('explain (analyze,buffers,format json) ' + sample.query.sql, [...sample.query.parameters]),
    );
  });
  return result.rows[0];
}

/** Clone the migrated synthetic template, then use the coordinator's exact pool/SQL limits.
 * The temporary admin connection exists only after both execution connections are closed.
 */
export async function getLibraryQueueDB(): Promise<Kysely<DB>> {
  const clone = await getKyselyDB();
  const name = (await sql<{ name: string }>`select current_database() name`.execute(clone)).rows[0].name;
  await clone.destroy();
  if (!/^frameleaf_[a-z0-9_]+$/.test(name)) throw new Error('Refusing a non-fixture database');
  const target = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  if (!['localhost', '127.0.0.1'].includes(target.hostname))
    throw new Error('Library fixture requires local PostgreSQL');
  target.pathname = `/${name}`;
  const client = boundExecutionReservations(
    createPostgres({
      connection: { connectionType: 'url', url: target.href },
      maxConnections: 2,
      connectTimeoutSeconds: 5,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 3000,
    }),
  );
  let maximumSqlMs = 0,
    queryCount = 0,
    totalSqlMs = 0,
    slowestSql = '';
  const db = new Kysely<DB>({
    dialect: new PostgresJSDialect({ postgres: boundPoolClose(client) }),
    log(event) {
      if (event.query.sql.startsWith('with runs as')) readSamples.set(db, event.query);
      if (
        event.query.sql.startsWith('update job_run r set') &&
        event.queryDurationMillis > (settlementSamples.get(db)?.ms ?? 0)
      )
        settlementSamples.set(db, { ms: event.queryDurationMillis, query: event.query });
      queryCount++;
      totalSqlMs += event.queryDurationMillis;
      if (event.queryDurationMillis > maximumSqlMs) {
        maximumSqlMs = event.queryDurationMillis;
        slowestSql = event.query.sql.slice(0, 1200);
      }
    },
  });
  const destroy = db.destroy.bind(db);
  db.destroy = async () => {
    settlementSamples.delete(db);
    readSamples.delete(db);
    await destroy();
    if (maximumSqlMs > 100)
      console.info(
        'library-fixture-sql-calibration',
        JSON.stringify({ queryCount, totalSqlMs, maximumSqlMs, slowestSql }),
      );
    target.pathname = '/postgres';
    const admin = createPostgres({
      connection: { connectionType: 'url', url: target.href },
      maxConnections: 1,
      statementTimeoutMs: 5000,
      lockTimeoutMs: 3000,
    });
    try {
      await admin.unsafe(`drop database "${name}"`);
    } finally {
      await admin.end();
    }
  };
  return db;
}
