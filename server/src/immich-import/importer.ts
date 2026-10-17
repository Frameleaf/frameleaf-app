import {
  CONTENT_TABLES,
  DEFERRED_COLUMNS,
  PATH_COLUMNS,
  clusterId,
  digest,
  transformRow,
  vectorCompatible,
} from 'src/immich-import/adapters.js';
import { assertCanonicalDestination } from 'src/immich-import/destination-schema.js';
import { EmbeddingAdmission, inspectEmbeddingAdmission } from 'src/immich-import/embeddings.js';
import { mapMediaPath, pathChecksum, verifyMediaFile, verifyMediaRoots } from 'src/immich-import/media.js';
import { ImmichSource } from 'src/immich-import/source.js';
import { getImmichImportState } from 'src/immich-import/state.js';
import { ImportConfig, ImportDatabase, ImportRefused, ImportRow, quote } from 'src/immich-import/types.js';

const IMPORT_LOCK = '7482923371154301';
const BOOTSTRAP_TABLES = new Set([
  'frameleaf_migrations',
  'frameleaf_migrations_lock',
  'job_queue',
  'frameleaf_immich_import',
  'frameleaf_immich_import_checkpoint',
  'frameleaf_immich_import_work',
  'system_metadata',
  'geodata_places',
  'naturalearth_countries',
]);
const localColumns = new Set(['updateId', 'createId']);

// Serialized row/checkpoint parameters enter as text so postgres.js does not JSON-encode them again.
export class ImmichImportService {
  readonly source: ImmichSource;
  private embeddingAdmission?: EmbeddingAdmission;
  constructor(
    readonly destination: ImportDatabase,
    source: ImportDatabase,
    readonly config: ImportConfig,
  ) {
    this.source = new ImmichSource(source, config);
  }

  status() {
    return getImmichImportState(this.destination);
  }

  async preflight() {
    await verifyMediaRoots(this.config.mediaRoots, this.config.media);
    const fingerprint = await this.source.preflight();
    await this.assertDistinctDestination();
    await assertCanonicalDestination(this.destination);
    this.embeddingAdmission = await inspectEmbeddingAdmission(this.source.db, this.destination);
    const [run] = await this.destination.query(
      'SELECT status,source_fingerprint,config_fingerprint FROM public.frameleaf_immich_import',
    );
    if (run) {
      if (run.source_fingerprint !== fingerprint || run.config_fingerprint !== digest(this.config)) {
        throw new ImportRefused('RESUME_SOURCE_OR_CONFIGURATION_CHANGED');
      }
      if (run.status === 'abandoned') {
        throw new ImportRefused('ABANDONED_DESTINATION_REQUIRES_FRESH_DATABASE');
      }
    } else {
      await this.assertFresh();
    }
    return {
      embeddings: Object.entries(this.embeddingAdmission).map(([table, evidence]) => ({
        table,
        sourceDimensions: evidence.sourceDimensions,
        destinationDimensions: evidence.destinationDimensions,
        action: 'regenerate',
        reason: 'SOURCE_PRODUCER_MODEL_UNRECORDED',
      })),
      sourceVersion: this.config.version,
      sourceCommit: this.source.fixture.commit,
      fingerprint,
      status: run?.status ?? 'fresh',
    };
  }

  async run(resume = false): Promise<void> {
    await this.exclusive(async () => {
      const report = await this.preflight();
      if (report.status === 'activated') {
        throw new ImportRefused('IMPORT_ALREADY_ACTIVATED');
      }
      if (resume === (report.status === 'fresh')) {
        throw new ImportRefused(resume ? 'NO_IMPORT_TO_RESUME' : 'USE_RESUME_FOR_PARTIAL_IMPORT');
      }
      if (!resume) {
        await this.destination.query(
          `INSERT INTO public.frameleaf_immich_import
          (source_fingerprint,config_fingerprint,source_version,status) VALUES ($1,$2,$3,'copying')`,
          [report.fingerprint, digest(this.config), this.config.version],
        );
      }
      for (const table of CONTENT_TABLES) {
        if (this.source.fixture.tables[table]) {
          await this.copyTable(table);
        }
      }
      // Cyclic nullable relationships are patched only once both endpoints exist.
      for (const table of Object.keys(DEFERRED_COLUMNS)) {
        for await (const batch of this.source.batches(table)) {
          await this.destination.transaction(async (db) => {
            for (const { row } of batch) {
              const mapped = transformRow(table, row, this.legacyPeople);
              await this.patchReferences(db, table, mapped);
            }
          });
        }
      }
      await this.destination.query("UPDATE public.frameleaf_immich_import SET status='verifying'");
    });
  }

  async verify(dispatchWork: (config: ImportConfig) => Promise<unknown>): Promise<void> {
    await this.exclusive(async () => {
      const report = await this.preflight();
      if (report.status !== 'verifying') {
        throw new ImportRefused('IMPORT_COPY_NOT_COMPLETE');
      }
      const incomplete = await this.destination.query(
        'SELECT 1 FROM public.frameleaf_immich_import_checkpoint WHERE NOT complete LIMIT 1',
      );
      if (incomplete.length > 0) {
        throw new ImportRefused('INCOMPLETE_CHECKPOINTS');
      }
      for (const table of CONTENT_TABLES) {
        if (!this.source.fixture.tables[table]) {
          continue;
        }
        let expected = 0;
        for await (const batch of this.source.batches(table)) {
          for (const { row } of batch) {
            const mapped = await this.mapRow(table, row);
            if (mapped) {
              expected++;
              await this.verifyRow(table, mapped);
            }
          }
        }
        const [count] = await this.destination.query(`SELECT count(*)::text AS count FROM public.${quote(table)}`);
        if (count.count !== String(expected)) {
          throw new ImportRefused('DESTINATION_CARDINALITY_MISMATCH');
        }
      }
      await this.verifyRelationships();
      // Detect source changes since the copy, including changes during verification.
      if ((await this.source.preflight()) !== report.fingerprint) {
        throw new ImportRefused('SOURCE_CHANGED_DURING_VERIFICATION');
      }
      await this.queueMissingDerivedWork();
      await dispatchWork(this.config);
      const [pending] = await this.destination.query(
        'SELECT count(*)::text AS count FROM public.frameleaf_immich_import_work WHERE dispatched_at IS NULL',
      );
      if (pending.count !== '0') {
        throw new ImportRefused('DERIVED_WORK_NOT_DURABLY_DISPATCHED');
      }
      // These are fresh pgvector indexes on the destination, never copied from upstream.
      await this.destination.query('REINDEX INDEX public.clip_index');
      await this.destination.query('REINDEX INDEX public.face_index');
      // Recheck after verification/dispatch: an intact ledger does not authorize schema drift.
      await assertCanonicalDestination(this.destination);
      await verifyMediaRoots(this.config.mediaRoots, this.config.media);
      await this.destination.query(
        "UPDATE public.frameleaf_immich_import SET status='activated',verified_at=now() WHERE status='verifying'",
      );
    });
  }

  async abandon(): Promise<void> {
    await this.exclusive(async () => {
      const result = await this.destination.query(`UPDATE public.frameleaf_immich_import SET status='abandoned'
        WHERE status IN ('copying','verifying') RETURNING status`);
      if (result.length !== 1) {
        throw new ImportRefused('NO_PARTIAL_IMPORT_TO_ABANDON');
      }
    });
  }

  private get legacyPeople(): boolean {
    return !this.source.fixture.tables.cluster_group;
  }

  private async exclusive(body: () => Promise<void>): Promise<void> {
    const [lock] = await this.destination.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [IMPORT_LOCK]);
    if (!lock.acquired) {
      throw new ImportRefused('IMPORT_ALREADY_RUNNING');
    }
    try {
      await body();
    } finally {
      await this.destination.query('SELECT pg_advisory_unlock($1::bigint)', [IMPORT_LOCK]);
    }
  }

  private async assertDistinctDestination(): Promise<void> {
    const statement = `SELECT system_identifier::text AS system_identifier,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid FROM pg_control_system()`;
    const [source, target] = await Promise.all([this.source.db.query(statement), this.destination.query(statement)]);
    if (digest(source) === digest(target)) {
      throw new ImportRefused('SOURCE_IS_DESTINATION');
    }
    const [version] = await this.destination.query("SELECT current_setting('server_version_num')::int AS version");
    if (Number(version.version) < 190_000 || Number(version.version) >= 200_000) {
      throw new ImportRefused('DESTINATION_REQUIRES_POSTGRES_19');
    }
    const extensions = await this.destination.query(
      "SELECT extname FROM pg_extension WHERE extname IN ('vector','vectors','vchord')",
    );
    if (extensions.length !== 1 || extensions[0].extname !== 'vector') {
      throw new ImportRefused('DESTINATION_REQUIRES_PGVECTOR_ONLY');
    }
    const indexes = await this.destination.query(`SELECT c.relname, am.amname, pg_get_indexdef(c.oid) AS definition
      FROM pg_class c JOIN pg_am am ON am.oid=c.relam
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('clip_index','face_index')`);
    if (
      indexes.length !== 2 ||
      indexes.some((index) => index.amname !== 'hnsw' || !String(index.definition).includes('vector_cosine_ops'))
    ) {
      throw new ImportRefused('DESTINATION_REQUIRES_PGVECTOR_HNSW');
    }
  }

  private async assertFresh(): Promise<void> {
    const tables = await this.destination.query(
      `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    for (const row of tables) {
      const table = String(row.tablename);
      if (!BOOTSTRAP_TABLES.has(table)) {
        const records = await this.destination.query(`SELECT 1 FROM public.${quote(table)} LIMIT 1`);
        if (records.length > 0) {
          throw new ImportRefused('DESTINATION_NOT_FRESH');
        }
      }
    }
    for (const table of ['frameleaf_immich_import_checkpoint', 'frameleaf_immich_import_work']) {
      if ((await this.destination.query(`SELECT 1 FROM public.${quote(table)} LIMIT 1`)).length > 0) {
        throw new ImportRefused('ORPHANED_IMPORT_JOURNAL');
      }
    }
  }

  private async copyTable(table: string): Promise<void> {
    const [checkpoint] = await this.destination.query(
      'SELECT cursor,complete FROM public.frameleaf_immich_import_checkpoint WHERE table_name=$1',
      [table],
    );
    if (checkpoint?.complete) {
      return;
    }
    for await (const batch of this.source.batches(table, (checkpoint?.cursor as string[] | null) ?? null)) {
      const mapped: { row: ImportRow; mapped: ImportRow | null }[] = [];
      for (const item of batch) {
        mapped.push({ ...item, mapped: await this.mapRow(table, item.row) });
      }
      await this.destination.transaction(async (db) => {
        for (const { row, mapped: target } of mapped) {
          if (!target) {
            continue;
          }
          if (this.legacyPeople && table === 'user') {
            await this.insert(db, 'cluster_group', { id: target.clusterGroupId });
          }
          if (this.legacyPeople && table === 'person') {
            await this.insert(db, 'person_group', {
              id: target.personGroupId,
              clusterGroupId: clusterId(String(target.ownerId)),
            });
          }
          const initial = { ...target };
          for (const column of DEFERRED_COLUMNS[table] ?? []) {
            initial[column] = null;
          }
          await this.insert(db, table, initial);
          if (table === 'asset') {
            // Missing output repair is durably resolved at verification.
            await db.query(
              `INSERT INTO public.frameleaf_immich_import_work(asset_id,kind) VALUES ($1,'metadata') ON CONFLICT DO NOTHING`,
              [row.id],
            );
          }
        }
        await db.query(
          `INSERT INTO public.frameleaf_immich_import_checkpoint(table_name,cursor,row_count)
          VALUES ($1,$2::text::jsonb,$3) ON CONFLICT(table_name) DO UPDATE SET cursor=excluded.cursor,
          row_count=frameleaf_immich_import_checkpoint.row_count+excluded.row_count`,
          [table, JSON.stringify(batch.at(-1)!.cursor), batch.length],
        );
      });
    }
    await this.destination.query(
      `INSERT INTO public.frameleaf_immich_import_checkpoint(table_name,complete)
      VALUES ($1,true) ON CONFLICT(table_name) DO UPDATE SET complete=true`,
      [table],
    );
  }

  private async mapRow(table: string, source: ImportRow): Promise<ImportRow | null> {
    const row = transformRow(table, source, this.legacyPeople);
    if (
      (table === 'smart_search' || table === 'face_search') &&
      !vectorCompatible(row.embedding, this.embeddingAdmission?.[table])
    ) {
      return null;
    }
    for (const column of PATH_COLUMNS[table] ?? []) {
      const path = row[column];
      if (typeof path === 'string' && path) {
        try {
          row[column] = await verifyMediaFile(
            path,
            this.config.mediaRoots,
            table === 'asset' ? String(row.checksum) : undefined,
            table === 'asset' ? String(row.checksumAlgorithm) : undefined,
            this.config.media,
          );
        } catch (error) {
          // Missing regenerable output is allowed; originals and profile images are never silently dropped.
          if ((error as NodeJS.ErrnoException).code === 'ENOENT' && (table === 'asset_file' || table === 'person')) {
            if (table === 'asset_file') {
              return null;
            }
            row[column] = '';
          } else {
            throw error;
          }
        }
      }
    }
    if (table === 'asset' && row.checksumAlgorithm === 'sha1-path') {
      if (row.isExternal !== true || !row.libraryId || typeof row.originalPath !== 'string') {
        throw new ImportRefused('PATH_CHECKSUM_REQUIRES_EXTERNAL_LIBRARY_ASSET');
      }
      // Source verification used the upstream path. Destination identity must use its mapped path.
      row.checksum = String.raw`\x${pathChecksum(row.originalPath)}`;
    }
    if (table === 'library') {
      row.importPaths = (row.importPaths as string[]).map(
        (path) => mapMediaPath(path, this.config.mediaRoots, this.config.media).target,
      );
    }
    return row;
  }

  private async insert(db: ImportDatabase, table: string, row: ImportRow): Promise<void> {
    const columns = Object.keys(row).filter((column) => !localColumns.has(column));
    await db.query(
      `INSERT INTO public.${quote(table)} (${columns.map((column) => quote(column)).join(',')})
      SELECT ${columns.map((column) => quote(column)).join(',')} FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb)`,
      [JSON.stringify(row)],
    );
  }

  private targetKeys(table: string): string[] {
    return table === 'person' && this.legacyPeople
      ? ['ownerId', 'personGroupId']
      : this.source.fixture.tables[table].key;
  }

  private async patchReferences(db: ImportDatabase, table: string, row: ImportRow): Promise<void> {
    const columns = DEFERRED_COLUMNS[table];
    const keys = this.targetKeys(table);
    await db.query(
      `UPDATE public.${quote(table)} d SET ${columns.map((column) => `${quote(column)}=s.${quote(column)}`).join(',')}
      FROM jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) s
      WHERE ${keys.map((key) => `d.${quote(key)}=s.${quote(key)}`).join(' AND ')}`,
      [JSON.stringify(row)],
    );
  }

  private async verifyRow(table: string, row: ImportRow): Promise<void> {
    // Reference restoration fires updatedAt triggers; sync identities belong to Frameleaf.
    const columns = Object.keys(row).filter((column) => !localColumns.has(column) && column !== 'updatedAt');
    const keys = this.targetKeys(table);
    const records = await this.destination.query(
      `SELECT 1 FROM public.${quote(table)} d,
      jsonb_populate_record(NULL::public.${quote(table)},$1::text::jsonb) s
      WHERE ${keys.map((key) => `d.${quote(key)}=s.${quote(key)}`).join(' AND ')}
      AND ${columns.map((column) => `d.${quote(column)} IS NOT DISTINCT FROM s.${quote(column)}`).join(' AND ')}`,
      [JSON.stringify(row)],
    );
    if (records.length !== 1) {
      throw new ImportRefused('DESTINATION_ROW_OR_PERMISSION_MISMATCH');
    }
  }

  private async verifyRelationships(): Promise<void> {
    // Check all actual canonical FKs without disabling constraints or trusting source triggers.
    const constraints = await this.destination.query(`SELECT c.relname AS child, p.relname AS parent,
      array_agg(a.attname ORDER BY k.ordinality) AS child_columns,
      array_agg(b.attname ORDER BY k.ordinality) AS parent_columns
      FROM pg_constraint f JOIN pg_class c ON c.oid=f.conrelid JOIN pg_class p ON p.oid=f.confrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      CROSS JOIN LATERAL unnest(f.conkey,f.confkey) WITH ORDINALITY k(child_key,parent_key,ordinality)
      JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.child_key
      JOIN pg_attribute b ON b.attrelid=p.oid AND b.attnum=k.parent_key
      WHERE f.contype='f' AND n.nspname='public' GROUP BY f.oid,c.relname,p.relname`);
    for (const constraint of constraints) {
      const child = constraint.child_columns as string[];
      const parent = constraint.parent_columns as string[];
      const invalid = await this.destination.query(`SELECT 1 FROM public.${quote(String(constraint.child))} c
        WHERE ${child.map((column) => `c.${quote(column)} IS NOT NULL`).join(' AND ')}
        AND NOT EXISTS (SELECT 1 FROM public.${quote(String(constraint.parent))} p
          WHERE ${child.map((column, i) => `p.${quote(parent[i])}=c.${quote(column)}`).join(' AND ')}) LIMIT 1`);
      if (invalid.length > 0) {
        throw new ImportRefused('DESTINATION_RELATIONSHIP_MISMATCH');
      }
    }
  }

  private async queueMissingDerivedWork(): Promise<void> {
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'thumbnail' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.asset_file f WHERE f."assetId"=a.id AND f.type='thumbnail') ON CONFLICT DO NOTHING`);
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'smart-search' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.smart_search s WHERE s."assetId"=a.id) ON CONFLICT DO NOTHING`);
    await this.destination.query(`INSERT INTO public.frameleaf_immich_import_work(asset_id,kind)
      SELECT a.id,'face-detection' FROM public.asset a WHERE NOT EXISTS
      (SELECT 1 FROM public.asset_face f WHERE f."assetId"=a.id)
      OR EXISTS (SELECT 1 FROM public.asset_face f WHERE f."assetId"=a.id AND NOT EXISTS
        (SELECT 1 FROM public.face_search s WHERE s."faceId"=f.id))
      ON CONFLICT DO NOTHING`);
  }
}
