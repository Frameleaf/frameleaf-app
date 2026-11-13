import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { FoundFileStep, FoundFileTable } from 'src/schema/tables/found-file.table.js';
import { DB } from 'src/schema/index.js';

export type FoundFile = Selectable<FoundFileTable>;

/** FL-1532: what Frameleaf remembers about each file it found on the drive that no library lists. */
@Injectable()
export class FoundFileRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** The files among `paths` that were read before. */
  getByPaths(paths: string[]): Promise<FoundFile[]> {
    if (paths.length === 0) {
      return Promise.resolve([]);
    }
    return this.db
      .selectFrom('found_file')
      .selectAll()
      .where(sql<boolean>`"path" = any(${paths}::text[])`)
      .execute();
  }

  /** What was learned about the file at this path replaces what was known about it. */
  async upsert(file: Insertable<FoundFileTable>): Promise<void> {
    // A JSON array has to be sent as JSON text: the driver would send a JavaScript array as a Postgres
    // array, and JSON cast straight to jsonb would be stored as one JSON string (see jsonb-cast.spec.ts).
    const row = { ...file, steps: sql<FoundFileStep[]>`${JSON.stringify(file.steps ?? [])}::text::jsonb` };
    const { path: _path, ...changes } = row;
    await this.db
      .insertInto('found_file')
      .values(row)
      .onConflict((oc) => oc.column('path').doUpdateSet({ ...changes, sortedAt: sql`now()` }))
      .execute();
  }
}
