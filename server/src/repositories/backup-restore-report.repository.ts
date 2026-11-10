import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Selectable, type Updateable } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { DB } from 'src/schema/index.js';
import type { BackupRestoreReportTable } from 'src/schema/tables/backup-restore-report.table.js';

export type BackupRestoreReport = Selectable<BackupRestoreReportTable>;

/** FL-879: restore drills and their signed reports, newest first. */
@Injectable()
export class BackupRestoreReportRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  /** A drill starting (or starting again after a pause): its row reads as running until it finishes. */
  async start(report: Insertable<BackupRestoreReportTable>): Promise<void> {
    await this.db
      .insertInto('backup_restore_report')
      .values(report)
      .onConflict((conflict) =>
        conflict.column('id').doUpdateSet({
          startedAt: report.startedAt,
          finishedAt: null,
          result: 'running',
          failedStep: null,
          counts: {},
          sampleSize: 0,
          mismatches: [],
          report: null,
          signature: null,
          keyFingerprint: null,
          signerKey: null,
        }),
      )
      .execute();
  }

  async finish(id: string, values: Updateable<BackupRestoreReportTable>): Promise<void> {
    await this.db.updateTable('backup_restore_report').set(values).where('id', '=', id).execute();
  }

  async remove(id: string): Promise<void> {
    await this.db.deleteFrom('backup_restore_report').where('id', '=', id).execute();
  }

  get(id: string): Promise<BackupRestoreReport | undefined> {
    return this.db.selectFrom('backup_restore_report').selectAll().where('id', '=', id).executeTakeFirst();
  }

  list(limit: number): Promise<BackupRestoreReport[]> {
    return this.db
      .selectFrom('backup_restore_report')
      .selectAll()
      .orderBy('startedAt', 'desc')
      .orderBy('id', 'desc')
      .limit(limit)
      .execute();
  }

  /** FL-879: when each of these items was added to the live library (read only). */
  async assetsAddedAt(ids: string[]): Promise<Map<string, Date>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db.selectFrom('asset').select(['id', 'createdAt']).where('id', 'in', ids).execute();
    return new Map(rows.map((row) => [row.id, new Date(row.createdAt as unknown as string | Date)]));
  }

  /** The newest finished drill, passed or failed. */
  latestFinished(): Promise<BackupRestoreReport | undefined> {
    return this.db
      .selectFrom('backup_restore_report')
      .selectAll()
      .where('result', 'in', ['passed', 'failed'])
      .orderBy('startedAt', 'desc')
      .limit(1)
      .executeTakeFirst();
  }
}
