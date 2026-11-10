import { createHash } from 'node:crypto';
import {
  CONTENT_TABLES,
  PATH_COLUMNS,
  canonicalJson,
  digest,
  frozenSource,
  newestContainedRelease,
  withForkContent,
} from 'src/immich-import/adapters.js';
import { assertMediaPolicy, lostOriginalReason, mapInOrder, verifyMediaFile } from 'src/immich-import/media.js';
import { readSourceStructure, verifyReadableStructure, verifySourceStructure } from 'src/immich-import/schema.js';
import {
  FrozenSource,
  ImportConfig,
  ImportDatabase,
  ImportRefused,
  ImportRow,
  quote,
} from 'src/immich-import/types.js';

// Gallery-only data the import does not carry yet (FL-995), by source table. Preflight lists those holding rows.
const NOODLE_ONLY: Record<string, string> = {
  shared_space: 'Spaces',
  shared_space_person: 'people named in Spaces',
  person_user: 'people shared between accounts',
  person_pet: 'pets',
  user_group: 'user groups',
  asset_image_adjust: 'exposure, contrast, saturation and invert adjustments',
  asset_video_trim: 'video trims',
  cleanup_decision: 'clean-up review decisions',
};
// Each owner's favourite is asset."isFavorite"; asset_favorite also holds favourites other people set.
const OTHERS_FAVOURITES = `SELECT EXISTS (SELECT 1 FROM public.asset_favorite f JOIN public.asset a ON a.id = f."assetId"
  WHERE f."userId" <> a."ownerId") AS rows`;

export class ImmichSource {
  /** Noodle Gallery data that stays in the source, named for people. */
  notImported: string[] = [];
  private frozen: FrozenSource;
  /** The frozen shape, plus pre-Frameleaf fork content once preflight has seen the source. */
  fixture: FrozenSource;
  constructor(
    readonly db: ImportDatabase,
    readonly config: ImportConfig,
  ) {
    this.frozen = this.fixture = frozenSource(config.version);
  }

  async preflight(): Promise<string> {
    assertMediaPolicy(this.config.mediaRoots, this.config.media);
    if (!this.config.writersStopped || !this.config.sourceId || this.config.mediaRoots.length === 0) {
      throw new ImportRefused('OFFLINE_SOURCE_AND_MEDIA_MAP_REQUIRED');
    }
    const [role] = await this.db.query(`SELECT r.rolsuper, r.rolbypassrls,
      current_setting('transaction_read_only') AS readonly FROM pg_roles r WHERE r.rolname = current_user`);
    if (!role || role.rolsuper || role.rolbypassrls || role.readonly !== 'on') {
      throw new ImportRefused('SOURCE_ROLE_MUST_BE_READ_ONLY');
    }
    const elevated = await this.db.query(`SELECT 1 FROM pg_roles WHERE
      (rolsuper OR rolbypassrls) AND pg_has_role(current_user, oid, 'MEMBER') LIMIT 1`);
    const writable = await this.db.query(`SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND (
        has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')
        OR pg_has_role(current_user,c.relowner,'MEMBER')) LIMIT 1`);
    // An unprivileged reader sees other roles' sessions but PostgreSQL hides their backend_type.
    // Unknown session metadata cannot prove that every writer has stopped.
    const others = await this.db.query(`SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
      AND pid <> pg_backend_pid() AND (backend_type = 'client backend' OR backend_type IS NULL) LIMIT 1`);
    if (elevated.length > 0 || writable.length > 0 || others.length > 0) {
      throw new ImportRefused('SOURCE_WRITERS_OR_WRITE_AUTHORITY_PRESENT');
    }
    const [ledgers] = await this.db.query(`SELECT to_regclass('public.frameleaf_migrations') IS NOT NULL AS present,
      to_regclass('public.gallery_migrations') IS NOT NULL AS noodle`);
    if (ledgers?.present) throw new ImportRefused('SOURCE_IS_FRAMELEAF');
    const migrations = await this.db.query('SELECT name FROM public.kysely_migrations ORDER BY name');
    const names = migrations.map((row) => String(row.name));
    if (ledgers?.noodle || this.config.product === 'Noodle Gallery') {
      // Noodle Gallery's version is its own release (5.x), and its migrations sit in gallery_migrations (5.9+)
      // or beside upstream's: the Immich base comes from the upstream ledger, and its added tables and columns
      // pass the readable-columns check.
      const base = newestContainedRelease(names);
      if (!base) throw new ImportRefused('UNKNOWN_SOURCE_MIGRATIONS');
      this.frozen = { ...frozenSource(base), exact: false };
      this.notImported = await this.noodleOnlyData();
    }
    const structure = await readSourceStructure(this.db);
    if (this.frozen.exact && canonicalJson(names) === canonicalJson(this.frozen.migrations)) {
      verifySourceStructure(structure, this.frozen.structure);
    } else {
      // A replayed 2.x shape or a newer release: the selected frozen shape must be the newest one its ledger contains.
      const newest = newestContainedRelease(names);
      if (!newest || frozenSource(newest).migrations !== this.frozen.migrations) {
        throw new ImportRefused('UNKNOWN_SOURCE_MIGRATIONS');
      }
      verifyReadableStructure(structure, this.frozen);
      // Fork sources carry extra migrations, so they always take this path.
      this.fixture = withForkContent(this.frozen, structure);
    }
    const identity = await this.db.query(`SELECT current_database() AS database,
      (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
      system_identifier::text AS system_identifier FROM pg_control_system()`);
    const hash = createHash('sha256').update(
      digest({ structure, identity, migrations, sourceId: this.config.sourceId }),
    );
    for (const table of CONTENT_TABLES) {
      if (!this.fixture.tables[table]) {
        continue;
      }
      hash.update(table);
      for await (const batch of this.batches(table)) {
        // Files are checked concurrently; their fingerprint parts are applied in row order.
        for (const parts of await mapInOrder(batch, ({ row }) => this.rowFingerprint(table, row))) {
          for (const part of parts) hash.update(part);
        }
      }
    }
    return hash.digest('hex');
  }

  /**
   * Where Immich was last moving each original (its `move_history` rows, one per photo and kind), by photo id.
   * Empty when the source has no such table. The pair (entityId, pathType) is unique there.
   */
  async intendedPaths(assetIds: string[]): Promise<Map<string, string>> {
    const moves = new Map<string, string>();
    if (assetIds.length === 0) return moves;
    const [table] = await this.db.query(`SELECT to_regclass('public.move_history') IS NOT NULL AS present`);
    if (!table?.present) return moves;
    for (let index = 0; index < assetIds.length; index += 1000) {
      const rows = await this.db.query(
        `SELECT "entityId"::text AS "entityId", "newPath" FROM public.move_history
        WHERE "pathType" = 'original' AND "entityId" IN (SELECT jsonb_array_elements_text($1::text::jsonb)::uuid)
        ORDER BY "entityId"`,
        [JSON.stringify(assetIds.slice(index, index + 1000))],
      );
      for (const row of rows) {
        if (typeof row.newPath === 'string' && row.newPath) moves.set(String(row.entityId), row.newPath);
      }
    }
    return moves;
  }

  private async noodleOnlyData(): Promise<string[]> {
    const [found] = await this.db.query(
      `SELECT coalesce(array_agg(c.relname::text), '{}') AS tables FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r','p')
        AND c.relname IN (SELECT jsonb_array_elements_text($1::text::jsonb))`,
      [JSON.stringify([...Object.keys(NOODLE_ONLY), 'asset_favorite'])],
    );
    const tables = new Set(found?.tables as string[] | undefined);
    const names: string[] = [];
    for (const [table, name] of Object.entries(NOODLE_ONLY)) {
      if (!tables.has(table)) continue;
      const [held] = await this.db.query(`SELECT EXISTS (SELECT 1 FROM public.${quote(table)}) AS rows`);
      if (held?.rows) names.push(name);
    }
    if (tables.has('asset_favorite') && (await this.db.query(OTHERS_FAVOURITES))[0]?.rows) {
      names.push('favourites set by other people');
    }
    return names;
  }

  private async rowFingerprint(table: string, row: ImportRow): Promise<string[]> {
    const parts = [canonicalJson(row), '\n'];
    if (this.config.media?.mode !== 'manager-in-place') return parts;
    for (const column of PATH_COLUMNS[table] ?? []) {
      const path = row[column];
      if (typeof path !== 'string' || !path) continue;
      parts.push(canonicalJson({ column, path }));
      try {
        await verifyMediaFile(path, this.config.mediaRoots, undefined, undefined, this.config.media, (identity) => {
          parts.push(identity);
        });
      } catch (error) {
        const lost =
          table === 'asset' ? await lostOriginalReason(error, path, this.config.mediaRoots, this.config.media) : null;
        if (lost) {
          parts.push(`lost-original:${lost}`);
        } else if (
          (error as NodeJS.ErrnoException).code !== 'ENOENT' ||
          (table !== 'asset_file' && table !== 'person')
        ) {
          throw error;
        } else {
          parts.push('missing-regenerable-output');
        }
      }
      parts.push('\n');
    }
    return parts;
  }

  async *batches(table: string, after: string[] | null = null): AsyncGenerator<{ row: ImportRow; cursor: string[] }[]> {
    const shape = this.fixture.tables[table];
    if (!shape || shape.key.length === 0 || !(CONTENT_TABLES as readonly string[]).includes(table)) {
      throw new ImportRefused('UNSUPPORTED_IMPORT_TABLE');
    }
    const fields = shape.columns
      .flatMap((column) => [
        `'${column.replaceAll("'", "''")}'`,
        // Text roundtrip preserves bigint values and bytea without JS number precision loss.
        `CASE WHEN pg_typeof(${quote(column)})::text = 'bigint' THEN to_jsonb(${quote(column)}::text) ELSE to_jsonb(${quote(column)}) END`,
      ])
      .join(',');
    const keys = shape.key.map((column) => `${quote(column)}::text COLLATE "C"`);
    let cursor = after;
    while (true) {
      const where = cursor
        ? `WHERE ROW(${keys.join(',')}) > ROW(${cursor.map((_, i) => `$${i + 1}::text COLLATE "C"`).join(',')})`
        : '';
      const results = await this.db.query(
        `SELECT jsonb_build_object(${fields}) AS row,
        ARRAY[${shape.key.map((column) => `${quote(column)}::text`).join(',')}] AS cursor
        FROM ${this.fixture.views[table] ? `(${this.fixture.views[table]}) AS ${quote(table)}` : `public.${quote(table)}`}
        ${where} ORDER BY ${keys.join(',')} LIMIT 250`,
        cursor ?? [],
      );
      if (results.length === 0) {
        return;
      }
      const batch = results.map((result) => ({ row: result.row as ImportRow, cursor: result.cursor as string[] }));
      yield batch;
      cursor = batch.at(-1)!.cursor;
    }
  }
}
