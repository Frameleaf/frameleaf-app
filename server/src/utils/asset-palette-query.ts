import { sql } from 'kysely';
import type { ColorFilter } from 'src/dtos/search.dto.js';
import { rgbToOklab } from 'src/utils/asset-palette.js';

/** Shared by state reads and color search: stale derived rows never count as current matches. */
export const assetPaletteRevision = (alias = 'asset') => {
  const ref = (column: string) => sql.ref(`${alias}.${column}`);
  return sql<string>`md5(jsonb_build_array(
    ${ref('ownerId')}, ${ref('type')}, ${ref('originalFileName')}, ${ref('checksum')}, ${ref('originalPath')}, ${ref('fileModifiedAt')}, ${ref('isEdited')},
    (select jsonb_agg(to_jsonb(e) order by e.sequence, e.id) from asset_edit e where e."assetId" = ${ref('id')}),
    (select jsonb_agg(to_jsonb(f) order by f.id) from asset_file f where f."assetId" = ${ref('id')}),
    (select to_jsonb(x) from asset_exif x where x."assetId" = ${ref('id')}),
    (select jsonb_agg(to_jsonb(d) order by d.id) from asset_develop_revision d where d."assetId" = ${ref('id')} and d."ownerId" = ${ref('ownerId')} and d."isCurrent"),
    (select m."coverTimestampMs" from video_moment_index m where m."assetId" = ${ref('id')})
  )::text)`;
};

const currentPalette = (viewerId: string | null | undefined, alias: string) => sql<boolean>`
  p."assetId" = ${sql.ref(`${alias}.id`)} and p.version = 1 and p.status = 'ready'
  and ${sql.ref(`${alias}.deletedAt`)} is null and not ${sql.ref(`${alias}.isOffline`)}
  and ${sql.ref(`${alias}.visibility`)} != 'hidden' and ${sql.ref(`${alias}.type`)} in ('IMAGE', 'VIDEO')
  and p."sourceRevision" = ${assetPaletteRevision(alias)}
  and (not p."ownerOnly" or ${viewerId ? sql`${sql.ref(`${alias}.ownerId`)} = ${viewerId}::uuid` : sql`false`})`;

const colorCoordinates = (color: ColorFilter) => {
  const channels = [1, 3, 5].map((index) => Number.parseInt(color.hex.slice(index, index + 2), 16) / 255);
  return rgbToOklab(channels[0], channels[1], channels[2]);
};
const colorDistance = ([l, a, b]: [number, number, number]) =>
  sql<number>`((s.l - ${l})^2 + (s.a - ${a})^2 + (s.b - ${b})^2)`;
const colorTolerance = { tight: 0.04, normal: 0.08, broad: 0.12 } as const;

export const assetColorPredicate = (color: ColorFilter, viewerId?: string | null, alias = 'asset') => {
  const coordinates = colorCoordinates(color);
  const [l, a, b] = coordinates;
  const radius = colorTolerance[color.tolerance];
  return sql<boolean>`exists (
    select 1 from asset_palette p join asset_palette_swatch s on s."assetId" = p."assetId"
    where ${currentPalette(viewerId, alias)} and s.weight >= ${color.minWeight}
      and s.l between ${l - radius} and ${l + radius}
      and s.a between ${a - radius} and ${a + radius}
      and s.b between ${b - radius} and ${b + radius}
      and ${colorDistance(coordinates)} <= ${radius ** 2}
  )`;
};

export const assetColorDistance = (color: ColorFilter, viewerId?: string | null, alias = 'asset') => sql<number>`(
  select min(${colorDistance(colorCoordinates(color))}) from asset_palette p
  join asset_palette_swatch s on s."assetId" = p."assetId"
  where ${currentPalette(viewerId, alias)} and s.weight >= ${color.minWeight}
)`;

export const assetTransparencyPredicate = (
  transparent: boolean,
  viewerId?: string | null,
  alias = 'asset',
) => sql<boolean>`exists (
  select 1 from asset_palette p where ${currentPalette(viewerId, alias)} and p."hasTransparency" = ${transparent}
)`;
