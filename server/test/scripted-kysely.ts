import {
  CompiledQuery,
  DatabaseConnection,
  Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  QueryResult,
} from 'kysely';
import { DB } from 'src/schema/index.js';

export type ScriptedQuery = { sql: string; parameters: readonly unknown[] };
export type ScriptedAnswer = { rows?: Record<string, unknown>[]; numAffectedRows?: bigint } | undefined;

/**
 * A Kysely instance that never reaches a database: every compiled statement is recorded and
 * answered by `answer` (FL-44). Unit specs use it to check which guard statements a repository
 * issues, in which order, and what it does with their answers.
 */
export const scriptedKysely = (answer: (query: ScriptedQuery) => ScriptedAnswer = () => ({})) => {
  const queries: ScriptedQuery[] = [];
  const connection: DatabaseConnection = {
    executeQuery<R>(compiled: CompiledQuery): Promise<QueryResult<R>> {
      const query = { sql: compiled.sql, parameters: compiled.parameters };
      queries.push(query);
      const result = answer(query);
      return Promise.resolve({
        rows: (result?.rows ?? []) as R[],
        numAffectedRows: result?.numAffectedRows,
      });
    },
    streamQuery() {
      throw new Error('streaming is not scripted');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: () => {
      queries.push({ sql: 'begin', parameters: [] });
      return Promise.resolve();
    },
    commitTransaction: () => {
      queries.push({ sql: 'commit', parameters: [] });
      return Promise.resolve();
    },
    rollbackTransaction: () => {
      queries.push({ sql: 'rollback', parameters: [] });
      return Promise.resolve();
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  const db = new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (kysely) => new PostgresIntrospector(kysely),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
  return { db, queries };
};
