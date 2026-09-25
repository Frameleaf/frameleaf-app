import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { readFile } from 'node:fs/promises';
import type { IntegrityCheckRun, SystemMetadata } from 'src/types.js';
import { GenerateSql } from 'src/decorators.js';
import { IntegrityReport, SystemMetadataKey } from 'src/enum.js';
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
   * FL-81: start a full run of one integrity check, keeping its last completed run. A run that was
   * still in progress is replaced, so a later run never completes an earlier one.
   */
  async startIntegrityRun(type: IntegrityReport, run: IntegrityCheckRun): Promise<void> {
    const key = SystemMetadataKey.IntegrityCheckRuns;
    await this.db
      .insertInto('system_metadata')
      .values({ key, value: { [type]: { current: run } } } as Upsert)
      .onConflict((oc) =>
        oc.columns(['key']).doUpdateSet({
          value: sql`jsonb_set(
            "system_metadata"."value",
            ARRAY[${type}::text],
            coalesce("system_metadata"."value" -> ${type}::text, '{}'::jsonb)
              || jsonb_build_object('current', ${JSON.stringify(run)}::text::jsonb)
          )`,
        } as never),
      )
      .execute();
  }

  /**
   * FL-81: record progress of a run in one statement, so concurrent batches never lose a count:
   * `batches` once every batch is queued, `finished` when a batch completes. Returns the run as it
   * stands after the update, or undefined when `runId` is no longer the check's current run.
   */
  async updateIntegrityRun(
    type: IntegrityReport,
    runId: string,
    { batches, finished = 0 }: { batches?: number; finished?: number },
  ): Promise<IntegrityCheckRun | undefined> {
    const current = sql`(("value" -> ${type}::text) -> 'current')`;
    const row = await this.db
      .updateTable('system_metadata')
      .set({
        value: sql`jsonb_set(
          "value",
          ARRAY[${type}::text, 'current'],
          ${current} || jsonb_build_object(
            'batches', coalesce(to_jsonb(${batches ?? null}::int), ${current} -> 'batches'),
            'done', coalesce((${current} ->> 'done')::int, 0) + ${finished}::int
          )
        )`,
      } as never)
      .where('key', '=', SystemMetadataKey.IntegrityCheckRuns)
      .where(sql<boolean>`${current} ->> 'runId' = ${runId}`)
      .returning(sql<IntegrityCheckRun>`"value" -> ${type}::text -> 'current'`.as('current'))
      .executeTakeFirst();
    return row?.current;
  }

  /**
   * FL-81: the run completed: it becomes the check's last run and stops being current. Only the
   * first caller for a run matches, so completing twice records it once.
   */
  async completeIntegrityRun(type: IntegrityReport, runId: string, at: Date): Promise<boolean> {
    const current = sql`(("value" -> ${type}::text) -> 'current')`;
    const result = await this.db
      .updateTable('system_metadata')
      .set({
        value: sql`jsonb_set(
          "value",
          ARRAY[${type}::text],
          (("value" -> ${type}::text) - 'current') || jsonb_build_object('lastRunAt', ${at.toISOString()}::text)
        )`,
      } as never)
      .where('key', '=', SystemMetadataKey.IntegrityCheckRuns)
      .where(sql<boolean>`${current} ->> 'runId' = ${runId}`)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }

  @GenerateSql({ params: ['metadata_key'] })
  async delete<T extends keyof SystemMetadata>(key: T): Promise<void> {
    await this.db.deleteFrom('system_metadata').where('key', '=', key).execute();
  }

  readFile(filename: string): Promise<string> {
    return readFile(filename, { encoding: 'utf8' });
  }
}
