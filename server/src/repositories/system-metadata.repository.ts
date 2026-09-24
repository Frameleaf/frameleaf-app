import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { readFile } from 'node:fs/promises';
import type { SystemMetadata } from 'src/types.js';
import { GenerateSql } from 'src/decorators.js';
import { DB } from 'src/schema/index.js';
import { SystemMetadataTable } from 'src/schema/tables/system-metadata.table.js';

type Upsert = Insertable<SystemMetadataTable>;

@Injectable()
export class SystemMetadataRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  @GenerateSql({ params: ['metadata_key'] })
  async get<T extends keyof SystemMetadata>(key: T): Promise<SystemMetadata[T] | null> {
    const metadata = await this.db
      .selectFrom('system_metadata')
      .select('value')
      .where('key', '=', key)
      .executeTakeFirst();

    if (!metadata) {
      return null;
    }
    return metadata.value as SystemMetadata[T];
  }

  async set<T extends keyof SystemMetadata>(key: T, value: SystemMetadata[T]): Promise<void> {
    await this.db
      .insertInto('system_metadata')
      .values({ key, value } as Upsert)
      .onConflict((oc) => oc.columns(['key']).doUpdateSet({ value } as Upsert))
      .execute();
  }

  /**
   * Merge `patch` into the stored object in one statement, so writers of different top-level
   * fields never overwrite each other (FL-81: the integrity checks record their runs this way).
   */
  async merge<T extends keyof SystemMetadata>(key: T, patch: Partial<SystemMetadata[T]>): Promise<void> {
    await this.db
      .insertInto('system_metadata')
      .values({ key, value: patch } as Upsert)
      .onConflict((oc) =>
        oc.columns(['key']).doUpdateSet({ value: sql`"system_metadata"."value" || "excluded"."value"` } as Upsert),
      )
      .execute();
  }

  @GenerateSql({ params: ['metadata_key'] })
  async delete<T extends keyof SystemMetadata>(key: T): Promise<void> {
    await this.db.deleteFrom('system_metadata').where('key', '=', key).execute();
  }

  readFile(filename: string): Promise<string> {
    return readFile(filename, { encoding: 'utf8' });
  }
}
