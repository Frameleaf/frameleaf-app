import { Injectable } from '@nestjs/common';
import { Insertable, Kysely, Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DB } from 'src/schema/index.js';
import { DevelopExportTable, DevelopPresetTable } from 'src/schema/tables/photo-tools.table.js';

export type DevelopPreset = Selectable<DevelopPresetTable>;
export type DevelopExport = Selectable<DevelopExportTable>;

const json = (value: unknown) => sql<Record<string, unknown>>`${JSON.stringify(value)}::text::jsonb`;

/**
 * Storage for reusable develop presets and exported originals (FL-64). Every read and write is
 * scoped by owner; callers never reach another account's preset or export through this class.
 */
@Injectable()
export class PhotoToolsRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  listPresets(ownerId: string): Promise<DevelopPreset[]> {
    return this.db
      .selectFrom('develop_preset')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .orderBy('name', 'asc')
      .execute();
  }

  countPresets(ownerId: string): Promise<number> {
    return this.db
      .selectFrom('develop_preset')
      .select((eb) => eb.fn.countAll<number>().as('count'))
      .where('ownerId', '=', ownerId)
      .executeTakeFirstOrThrow()
      .then(({ count }) => Number(count));
  }

  getPreset(ownerId: string, id: string): Promise<DevelopPreset | undefined> {
    return this.db
      .selectFrom('develop_preset')
      .selectAll()
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
  }

  getPresetByName(ownerId: string, name: string): Promise<DevelopPreset | undefined> {
    return this.db
      .selectFrom('develop_preset')
      .selectAll()
      .where('ownerId', '=', ownerId)
      .where('name', '=', name)
      .executeTakeFirst();
  }

  createPreset(preset: Insertable<DevelopPresetTable>): Promise<DevelopPreset> {
    return this.db
      .insertInto('develop_preset')
      .values({ ...preset, settings: json(preset.settings) })
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  updatePreset(
    ownerId: string,
    id: string,
    patch: { name?: string; settings?: Record<string, unknown> },
  ): Promise<DevelopPreset | undefined> {
    return this.db
      .updateTable('develop_preset')
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.settings !== undefined && { settings: json(patch.settings) }),
        updatedAt: new Date(),
      })
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .returningAll()
      .executeTakeFirst();
  }

  async deletePreset(ownerId: string, id: string): Promise<boolean> {
    const result = await this.db
      .deleteFrom('develop_preset')
      .where('id', '=', id)
      .where('ownerId', '=', ownerId)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }

  createExport(item: Insertable<DevelopExportTable>): Promise<DevelopExport> {
    return this.db.insertInto('develop_export').values(item).returningAll().executeTakeFirstOrThrow();
  }

  listExports(assetId: string): Promise<DevelopExport[]> {
    return this.db
      .selectFrom('develop_export')
      .selectAll()
      .where('assetId', '=', assetId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .execute();
  }

  getExport(id: string): Promise<DevelopExport | undefined> {
    return this.db.selectFrom('develop_export').selectAll().where('id', '=', id).executeTakeFirst();
  }
}
