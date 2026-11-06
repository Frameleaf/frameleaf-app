import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
} from 'kysely';
import { type JobName } from 'src/enum.js';
import { type ImportDatabase } from 'src/immich-import/types.js';
import {
  type ManagerLibrarySetup,
  libraryImportDerivedRunId,
  prepareLibraryImportWork,
} from 'src/library-import/derived-work.js';
import { type ReviewedImportContext } from 'src/library-import/reviewed-inputs.js';
import { LibraryImportRefused, parseLibraryImportBinding } from 'src/library-import/state.js';
import { type QueueIntent } from 'src/queue/types.js';
import { type DB } from 'src/schema/index.js';

/** Preparation revalidation joins the caller's transaction without committing it or acquiring another backend. */
const workTransaction = (tx: ImportDatabase) => {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery) => ({
      rows: (await tx.query(query.sql, [...query.parameters])) as R[],
    }),
    streamQuery: () => {
      throw new LibraryImportRefused('DERIVED_WORK_STREAM_UNSUPPORTED');
    },
  };
  const driver: Driver = {
    init: () => Promise.resolve(),
    acquireConnection: () => Promise.resolve(connection),
    beginTransaction: async (_connection, settings) => {
      if (settings.accessMode || settings.isolationLevel)
        throw new LibraryImportRefused('DERIVED_WORK_TRANSACTION_OPTIONS_UNSUPPORTED');
      // PostgreSQL refuses SAVEPOINT outside an explicit transaction; a validator must never autocommit.
      await tx.query('SAVEPOINT frameleaf_activation_work');
    },
    commitTransaction: async () => {
      await tx.query('RELEASE SAVEPOINT frameleaf_activation_work');
    },
    rollbackTransaction: async () => {
      await tx.query('ROLLBACK TO SAVEPOINT frameleaf_activation_work');
      await tx.query('RELEASE SAVEPOINT frameleaf_activation_work');
    },
    releaseConnection: () => Promise.resolve(),
    destroy: () => Promise.resolve(),
  };
  return new Kysely<DB>({
    dialect: {
      createDriver: () => driver,
      createAdapter: () => new PostgresAdapter(),
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
};

/** Reconcile the real held snapshot again in the activation transaction; missing preparation is never repaired. */
export async function validatePreparedLibraryImportWork(
  tx: ImportDatabase,
  intentFor: (name: JobName) => QueueIntent,
  context: ReviewedImportContext,
  managerInput?: ManagerLibrarySetup,
): Promise<string> {
  try {
    const bound = { binding: parseLibraryImportBinding(context.binding), destinationId: context.destinationId };
    const manager = managerInput === undefined ? undefined : { ...managerInput };
    const id = libraryImportDerivedRunId(bound.binding);
    // The run header is the one lock: it serializes with setup and the holds reconciler.
    const [run] = await tx.query(
      `SELECT selection #>> '{managerSetup,preparedAt}' AS prepared
      FROM job_run WHERE id=$1::uuid AND "enumerationDone" FOR UPDATE`,
      [id],
    );
    if (!run) throw new LibraryImportRefused('DERIVED_RUN_IDENTITY_MISMATCH');
    if (manager && !run.prepared) throw new LibraryImportRefused('DERIVED_MANAGER_SETUP_IDENTITY_MISMATCH');
    const db = workTransaction(tx);
    try {
      return await prepareLibraryImportWork(db, intentFor, bound, manager);
    } finally {
      await db.destroy();
    }
  } catch (error) {
    if (error instanceof LibraryImportRefused) throw error;
    throw new LibraryImportRefused('DERIVED_WORK_PREPARATION_FAILED');
  }
}
