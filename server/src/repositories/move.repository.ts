import { Injectable } from '@nestjs/common';
import { type Insertable, type Kysely, type Updateable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import { DummyValue, GenerateSql } from 'src/decorators.js';
import { AssetFileType, AssetPathType, type PathType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { MoveTable } from 'src/schema/tables/move.table.js';

export type PendingAssetMove = {
  id: string;
  entityId: string;
  pathType: PathType;
  oldPath: string;
  newPath: string;
  assetExists: boolean;
  isExternal: boolean;
  originalPath: string | null;
  currentPath: string | null;
};

@Injectable()
export class MoveRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  create(entity: Insertable<MoveTable>) {
    return this.db.insertInto('move_history').values(entity).returningAll().executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID, DummyValue.STRING] })
  getByEntity(entityId: string, pathType: PathType) {
    return this.db
      .selectFrom('move_history')
      .selectAll()
      .where('entityId', '=', entityId)
      .where('pathType', '=', pathType)
      .executeTakeFirst();
  }

  update(id: string, entity: Updateable<MoveTable>) {
    return this.db
      .updateTable('move_history')
      .set(entity)
      .where('id', '=', id)
      .returningAll()
      .executeTakeFirstOrThrow();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  delete(id: string) {
    return this.db.deleteFrom('move_history').where('id', '=', id).returningAll().executeTakeFirstOrThrow();
  }

  /**
   * FL-179: the assets' storage moves that are recorded but not finished, for the nightly retry, with
   * where the asset records the file now (`currentPath`; null when the asset is gone).
   */
  async getPendingAssetMoves(): Promise<PendingAssetMove[]> {
    const types = [...Object.values(AssetPathType), ...Object.values(AssetFileType)];
    const { rows } = await sql<PendingAssetMove>`
      SELECT
        move.id,
        move."entityId",
        move."pathType",
        move."oldPath",
        move."newPath",
        asset.id IS NOT NULL AS "assetExists",
        coalesce(asset."isExternal", false) AS "isExternal",
        asset."originalPath",
        CASE
          WHEN move."pathType" = ${AssetPathType.Original} THEN asset."originalPath"
          ELSE (
            SELECT file.path FROM public.asset_file file
            WHERE file."assetId" = asset.id AND file.type::text = move."pathType" AND file."isEdited" = false
          )
        END AS "currentPath"
      FROM public.move_history move
      LEFT JOIN public.asset asset ON asset.id = move."entityId"
      WHERE move."pathType" = ANY(${types}::text[])
    `.execute(this.db);
    return rows;
  }

  /**
   * FL-179: forgets recorded moves that can never finish, each only while it still names the paths it
   * was judged by; a record re-targeted since is kept.
   */
  async deleteMoves(moves: Array<{ id: string; oldPath: string; newPath: string }>): Promise<void> {
    for (const { id, oldPath, newPath } of moves) {
      await this.db
        .deleteFrom('move_history')
        .where('id', '=', id)
        .where('oldPath', '=', oldPath)
        .where('newPath', '=', newPath)
        .execute();
    }
  }

  async cleanMoveHistory(): Promise<void> {
    await this.db
      .deleteFrom('move_history')
      .where((eb) =>
        eb(
          'move_history.entityId',
          'not in',
          eb.selectFrom('asset').select('id').whereRef('asset.id', '=', 'move_history.entityId'),
        ),
      )
      .where('move_history.pathType', '=', sql.lit(AssetPathType.Original))
      .execute();
  }

  @GenerateSql({ params: [DummyValue.UUID] })
  async cleanMoveHistorySingle(assetId: string): Promise<void> {
    await this.db
      .deleteFrom('move_history')
      .where('move_history.pathType', '=', sql.lit(AssetPathType.Original))
      .where('entityId', '=', assetId)
      .execute();
  }
}
