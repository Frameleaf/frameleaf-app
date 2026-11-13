import { Injectable } from '@nestjs/common';
import { Kysely, type Selectable, sql } from 'kysely';
import { InjectKysely } from 'nestjs-kysely';
import type { AssetDevelopRecipe } from 'src/dtos/asset-develop.dto.js';
import type { DevelopStyleProfileTable } from 'src/schema/tables/develop-style-profile.table.js';
import { AssetFileType, AssetStatus, AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { hiddenByOwnerRules } from 'src/utils/database.js';

@Injectable()
export class DevelopStyleRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  getProfile(userId: string) {
    return this.db.selectFrom('develop_style_profile').selectAll().where('userId', '=', userId).executeTakeFirst();
  }

  async saveProfile(profile: Selectable<DevelopStyleProfileTable>, expectedTrainedAt: Date | null) {
    const row = expectedTrainedAt
      ? await this.db
          .updateTable('develop_style_profile')
          .set(profile)
          .where('userId', '=', profile.userId)
          .where('trainedAt', '=', expectedTrainedAt)
          .returning('userId')
          .executeTakeFirst()
      : await this.db
          .insertInto('develop_style_profile')
          .values(profile)
          .onConflict((oc) => oc.column('userId').doNothing())
          .returning('userId')
          .executeTakeFirst();
    return !!row;
  }

  async forget(userId: string) {
    await this.db.deleteFrom('develop_style_profile').where('userId', '=', userId).execute();
  }

  profilesDue(before: Date) {
    return this.db
      .selectFrom('develop_style_profile')
      .select(['userId', 'trainedAt'])
      .where('trainedAt', '<=', before)
      .stream();
  }

  private eligible(ownerId: string) {
    return this.db
      .selectFrom('asset as a')
      .innerJoin('asset_file as f', (join) =>
        join.onRef('f.assetId', '=', 'a.id').on('f.type', '=', AssetFileType.Preview).on('f.isEdited', '=', false),
      )
      .leftJoin('asset_lock as locked', 'locked.assetId', 'a.id')
      .where('a.ownerId', '=', ownerId)
      .where('a.type', '=', AssetType.Image)
      .where('a.status', '=', AssetStatus.Active)
      .where('a.isOffline', '=', false)
      .where('a.deletedAt', 'is', null)
      .where('a.visibility', 'in', [AssetVisibility.Timeline, AssetVisibility.Archive])
      .where('locked.assetId', 'is', null)
      .where(sql<boolean>`not ${hiddenByOwnerRules('a')}`);
  }

  trainingPhotos(ownerId: string, since?: Date) {
    const recipe = sql<AssetDevelopRecipe>`(
      SELECT recipe FROM asset_develop_revision
      WHERE "assetId" = ${sql.ref('a.id')} AND "ownerId" = ${ownerId}::uuid
        AND kind = 'recipe' AND status = 'rendered' AND "styleBatchId" IS NULL AND "recipeVersion" = 1
        AND NOT jsonb_path_exists(recipe, '$.cleanup[*] ? (@.enabled == true)')
        ${since ? sql`AND "createdAt" > ${since}` : sql``}
      ORDER BY revision DESC LIMIT 1
    )`;
    return this.eligible(ownerId)
      .where(sql<boolean>`${recipe} is not null`)
      .select(['a.id', 'f.path', recipe.as('recipe')])
      .orderBy('a.id', 'desc')
      .limit(150)
      .execute();
  }

  shootPhotos(ownerId: string, albumId: string, ids?: string[]) {
    return this.eligible(ownerId)
      .innerJoin('album_asset as member', (join) =>
        join.onRef('member.assetId', '=', 'a.id').on('member.albumId', '=', albumId),
      )
      .leftJoin('asset_exif as exif', 'exif.assetId', 'a.id')
      .where((eb) => eb.or([eb('exif.rating', 'is', null), eb('exif.rating', '!=', -1)]))
      .$if(!!ids, (qb) => qb.where('a.id', 'in', ids!))
      .select(['a.id', 'f.path'])
      .orderBy('a.id')
      .limit(501)
      .execute();
  }
}
