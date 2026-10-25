import { type Kysely, sql } from 'kysely';
import type { DB } from 'src/schema/index.js';

type Authority = { id: string; ownerId: string; photoSessionId: string; deviceId: string };

// Lock ordering only; callers still validate live authority and resource identity.
export async function lockSourceAuthorities(
  db: Kysely<DB>,
  requested: { sourceId: string; ownerId: string }[],
): Promise<boolean> {
  const ids = [...new Set(requested.map((source) => source.sourceId))].sort();
  if (ids.length === 0) return true;
  const { rows: sources } = await sql<Authority>`SELECT id, "ownerId", "photoSessionId", "deviceId"
    FROM photo_source WHERE id = ANY(${ids}::uuid[])`.execute(db);
  if (
    sources.length !== ids.length ||
    requested.some((request) =>
      sources.every((source) => !(source.id === request.sourceId && source.ownerId === request.ownerId)),
    )
  )
    return false;
  for (const [table, key] of [
    ['user', 'ownerId'],
    ['session', 'photoSessionId'],
    ['desktop_device', 'deviceId'],
  ] as const) {
    const parents = [...new Set(sources.map((source) => source[key]))].sort();
    const { rows } = await sql`SELECT id FROM ${sql.table(table)} WHERE id = ANY(${parents}::uuid[])
      ORDER BY id FOR SHARE`.execute(db);
    if (rows.length !== parents.length) return false;
  }
  const { rows: locked } = await sql<Authority>`SELECT id, "ownerId", "photoSessionId", "deviceId"
    FROM photo_source WHERE id = ANY(${ids}::uuid[]) ORDER BY id FOR UPDATE`.execute(db);
  return (
    locked.length === sources.length &&
    sources.every((source) =>
      locked.some(
        (current) =>
          current.id === source.id &&
          current.ownerId === source.ownerId &&
          current.photoSessionId === source.photoSessionId &&
          current.deviceId === source.deviceId,
      ),
    )
  );
}
