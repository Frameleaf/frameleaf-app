import { Injectable } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { jsonArrayFrom } from 'kysely/helpers/postgres';
import { InjectKysely } from 'nestjs-kysely';
import { AssetPaletteDto } from 'src/dtos/asset-palette.dto.js';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { assetPaletteRevision } from 'src/utils/asset-palette-query.js';

@Injectable()
export class AssetPaletteRepository {
  constructor(@InjectKysely() private db: Kysely<DB>) {}

  source(id: string, db = this.db) {
    return db
      .selectFrom('asset')
      .select([
        'asset.id',
        'asset.ownerId',
        'asset.originalPath',
        'asset.originalFileName',
        'asset.type',
        'asset.isEdited',
        assetPaletteRevision().as('sourceRevision'),
        sql<{ orientation: string | null; imageEncoding: { dynamicRange?: string } | null } | null>`
        (select jsonb_build_object('orientation', x.orientation, 'imageEncoding', x."imageEncoding") from asset_exif x where x."assetId" = asset.id)
      `.as('exif'),
        sql<{ id: string; status: string; masterPath: string | null; previewPath: string | null } | null>`
        (select jsonb_build_object('id', d.id, 'status', d.status, 'masterPath', d."masterPath", 'previewPath', d."previewPath")
         from asset_develop_revision d where d."assetId" = asset.id and d."ownerId" = asset."ownerId" and d."isCurrent" limit 1)
      `.as('develop'),
      ])
      .select((eb) => [
        jsonArrayFrom(
          eb
            .selectFrom('asset_file')
            .select(['path', 'type', 'isEdited', 'isTransparent'])
            .whereRef('asset_file.assetId', '=', 'asset.id')
            .orderBy('id'),
        ).as('files'),
        jsonArrayFrom(
          eb
            .selectFrom('asset_edit')
            .select(['action', 'parameters'])
            .whereRef('asset_edit.assetId', '=', 'asset.id')
            .orderBy('sequence')
            .orderBy('id'),
        ).as('edits'),
      ])
      .where('asset.id', '=', id)
      .where('asset.deletedAt', 'is', null)
      .where('asset.isOffline', '=', false)
      .where('asset.visibility', '!=', AssetVisibility.Hidden)
      .where('asset.type', 'in', [AssetType.Image, AssetType.Video])
      .executeTakeFirst();
  }

  async get(id: string, viewerId?: string | null): Promise<AssetPaletteDto | undefined> {
    const source = await this.source(id);
    if (!source) return;
    if (source.develop && viewerId !== undefined && viewerId !== source.ownerId) {
      return {
        version: 1,
        sourceRevision: '',
        status: 'unavailable',
        swatches: [],
        hasTransparency: false,
        representative: 'image',
      };
    }
    const state = await this.db.selectFrom('asset_palette').selectAll().where('assetId', '=', id).executeTakeFirst();
    return state?.version === 1 && state.sourceRevision === source.sourceRevision
      ? AssetPaletteDto.schema.parse(state)
      : {
          version: 1,
          sourceRevision: source.sourceRevision,
          status: 'pending',
          swatches: [],
          hasTransparency: false,
          representative:
            source.type === AssetType.Video || source.originalFileName.toLowerCase().endsWith('.gif')
              ? 'frame'
              : 'image',
        };
  }

  async publish(id: string, revision: string, input: AssetPaletteDto, db = this.db): Promise<boolean> {
    const result = AssetPaletteDto.schema.parse(input);
    if (result.sourceRevision !== revision) throw new Error('Palette source revision mismatch');
    const write = async (tx: Kysely<DB>) => {
      const asset = await tx.selectFrom('asset').select('id').where('id', '=', id).forUpdate().executeTakeFirst();
      const source = asset ? await this.source(id, tx) : undefined;
      if (!source || source.sourceRevision !== revision) return false;
      const ownerOnly = !!source.develop;
      await tx
        .insertInto('asset_palette')
        .values({ assetId: id, ...result, ownerOnly })
        .onConflict((oc) => oc.column('assetId').doUpdateSet({ ...result, ownerOnly, updatedAt: new Date() }))
        .execute();
      await tx.deleteFrom('asset_palette_swatch').where('assetId', '=', id).execute();
      if (result.status === 'ready' && result.swatches.length > 0)
        await tx
          .insertInto('asset_palette_swatch')
          .values(
            result.swatches.map(({ oklab: [l, a, b], weight }, position) => ({
              assetId: id,
              position,
              l,
              a,
              b,
              weight,
            })),
          )
          .execute();
      return true;
    };
    return db.isTransaction ? write(db) : db.transaction().execute(write);
  }

  page(afterId?: string) {
    let query = this.db
      .selectFrom('asset')
      .select('id')
      .where('deletedAt', 'is', null)
      .where('isOffline', '=', false)
      .where('visibility', '!=', AssetVisibility.Hidden)
      .where('type', 'in', [AssetType.Image, AssetType.Video]);
    if (afterId) query = query.where('id', '>', afterId);
    return query.orderBy('id').limit(100).execute();
  }
}
