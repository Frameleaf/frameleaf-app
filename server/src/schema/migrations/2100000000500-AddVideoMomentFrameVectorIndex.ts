import { Kysely, sql } from 'kysely';

/**
 * A vector index for `video_moment_frame_embedding.embedding` (FL-59 follow-up, `REC-101`).
 *
 * `VideoMomentRepository.searchFrames` (moment search) orders every owner's frame embeddings by
 * cosine distance from a query embedding (`embedding <=> $1 ... ORDER BY ... LIMIT`) with no
 * index to accelerate it, so it falls back to a full sequential scan of the table as it grows.
 * `video_moment_frame_embedding` was created without one in `2100000000380-AddVideoMomentIndex`
 * because a change of search model empties every embedding table (see that migration's comment),
 * and the initial migration's `smart_search`/`face_search` indexes are built once the table's
 * final dimension is known — here the column already has its final dimension (matched to
 * `smart_search.embedding` at creation), so the index can be added directly.
 *
 * The index picks whichever vector extension the initial migration chose for this database
 * (`vchordrq` or pgvector `hnsw`), the same way `1744910873969-InitialMigration` builds
 * `clip_index` and `face_index`: `DB_VECTOR_EXTENSION` if set, otherwise whichever of `vchord` /
 * `vector` is installed.
 */

async function getVectorExtension(db: Kysely<any>): Promise<'vector' | 'vchord'> {
  const configured = process.env.DB_VECTOR_EXTENSION;
  if (configured === 'pgvector') {
    return 'vector';
  }
  if (configured === 'vectorchord') {
    return 'vchord';
  }

  const extensions = ['vchord', 'vector'] as const;
  const { rows } = await sql<{ name: string }>`
    SELECT name FROM pg_available_extensions WHERE name IN ('vchord', 'vector')
  `.execute(db);
  const available = new Set(rows.map(({ name }) => name));
  const extension = extensions.find((name) => available.has(name));
  if (!extension) {
    throw new Error(`No vector extension found. Available extensions: ${extensions.join(', ')}`);
  }
  return extension;
}

function vectorIndexQuery({
  vectorExtension,
  table,
  indexName,
}: {
  vectorExtension: string;
  table: string;
  indexName: string;
}): string {
  switch (vectorExtension) {
    case 'vchord': {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table} USING vchordrq (embedding vector_cosine_ops) WITH (options = $$
        residual_quantization = false
        [build.internal]
        lists = [1]
        spherical_centroids = true
        build_threads = 4
        sampling_factor = 1024
        $$)`;
    }
    case 'vector': {
      return `
        CREATE INDEX IF NOT EXISTS ${indexName} ON ${table}
        USING hnsw (embedding vector_cosine_ops)
        WITH (ef_construction = 300, m = 16)`;
    }
    default: {
      throw new Error(`Unsupported vector extension: '${vectorExtension}'`);
    }
  }
}

export async function up(db: Kysely<any>): Promise<void> {
  const vectorExtension = await getVectorExtension(db);
  await sql
    .raw(
      vectorIndexQuery({
        vectorExtension,
        table: 'video_moment_frame_embedding',
        indexName: 'video_moment_frame_index',
      }),
    )
    .execute(db);
}

export async function down(db: Kysely<any>): Promise<void> {
  await sql`DROP INDEX IF EXISTS "video_moment_frame_index";`.execute(db);
}
