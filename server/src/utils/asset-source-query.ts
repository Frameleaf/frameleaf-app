import { sql } from 'kysely';

export const assetSourcePredicate = (contains: string, viewerId?: string | null) =>
  viewerId
    ? sql<boolean>`asset."ownerId" = ${viewerId}::uuid and asset.id in (
      select distinct source."assetId" from asset_source source
      join asset source_asset on source_asset.id = source."assetId"
      where source_asset."ownerId" = ${viewerId}::uuid
        and strpos(lower(f_unaccent(concat_ws(' ', source."pageUrl", source."mediaUrl", source.title,
          source.note, source.creator, source."licenseUrl"))), lower(f_unaccent(${contains}))) > 0
    )`
    : sql<boolean>`false`;
