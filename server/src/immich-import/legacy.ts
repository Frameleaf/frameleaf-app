import { TableShape, quote } from 'src/immich-import/types.js';

/**
 * Read-only views that present an older Immich release's rows in the Immich 3.0.0 column shape and apply
 * the upstream data fixes that release has not run. Each rule is keyed by the upstream migration that made
 * the change, so a release that already ran it reads its table directly. Nothing executes on the source but
 * these SELECTs; expressions mirror the upstream migrations named beside them.
 */
const M = {
  fixColumnNames: '1761755618862-FixColumnNames', // 2.3
  sidecarInAssetFile: '1764698859174-SidecarInAssetFile', // 2.4
  exifLockedProperties: '1764957138636-AddLockedPropertiesToAssetExif', // 2.4
  assetWidthHeight: '1768336661963-AddAssetWidthHeight', // 2.5
  isVisible: '1768336694315-CreateIsVisibleColumns', // 2.5
  assetIsEdited: '1768757482271-SwitchToIsEdited', // 2.5
  assetFileIsEdited: '1768828334807-AddIsEditedToAssetFile', // 2.5
  exifTags: '1768847456553-AddTagsToExif', // 2.5
  isProgressive: '1769441657564-AddIsProgressiveColumn', // 2.5
  rating0ToNull: '1771535611395-ConvertRating0ToNull', // 2.6
  isTransparent: '1771639515206-AddIsTransparentColumn', // 2.6
  assetEditSync: '1771873813973-AssetEditSync', // 2.6
  encodedVideoFiles: '1773242919341-EncodedVideoAssetFiles', // 2.6
  albumLinkAssets: '1773956345315-DuplicateSharedLinkAssets', // 2.6.2
  checksumAlgorithm: '1774548649115-AddChecksumAlgorithm.ts', // 2.7
  albumOwnerToAlbumUser: '1776848612954-MigrateAlbumOwnerIdToAlbumUser', // 3.0
  durationToInteger: '1777667825574-ChangeDurationToInteger', // 3.0
  crossOwnerFaces: '1780435471692-DeleteMismatchedAssetFaces', // 3.0
  assetOcrSync: '1780592071031-AssetOcrSync', // 3.0
  livePhotoStillVisibility: '1782500000000-RestoreLivePhotoStillVisibility', // 3.1
  emptyPasswordToNull: '1784986754473-ConvertUserPasswordEmptyStringToNull', // 3.2
  emptyAlbumDescriptionToNull: '1784986754474-AlbumDescriptionNullable', // 3.2
  ownerlessAlbums: '1786385711807-AlbumOwnerDeleteTrigger', // 3.2
  crossOwnerMemoryAssets: '1787148183730-DeleteMismatchedMemoryAssets', // 3.2
  emptyOAuthIdToNull: '1789419229196-ConvertUserOAuthIdEmptyStringToNull', // 3.3
} as const;
export const LEGACY_MIGRATIONS: readonly string[] = Object.values(M);

type Select = { from: string; columns?: Record<string, string>; where?: string[] };
type View = Select & { union?: Select[] };

const select = (shape: TableShape, { from, columns = {}, where = [] }: Select): string =>
  `SELECT ${shape.columns.map((column) => `${columns[column] ?? `t.${quote(column)}`} AS ${quote(column)}`).join(',')}
  FROM ${from}${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''}`;

export const sourceViews = (
  migrations: readonly string[],
  tables: Record<string, TableShape>,
): Record<string, string> => {
  const has = new Set(migrations);
  const lacks = (name: string) => !has.has(name);
  const renamed = lacks(M.fixColumnNames);
  const col = (current: string, legacy: string) => `t.${quote(renamed ? legacy : current)}`;
  const albumOwnerColumn = lacks(M.albumOwnerToAlbumUser);
  // 3.0/3.1 can hold albums whose owner row was removed; 3.2 deletes them and everything cascading from them.
  const owned = (album: string) =>
    !albumOwnerColumn && lacks(M.ownerlessAlbums)
      ? [
          `(${album} IS NULL OR EXISTS (SELECT 1 FROM public.album_user o WHERE o."albumId" = ${album} AND o.role = 'owner'))`,
        ]
      : [];
  const crossOwnerFace = (face: string) =>
    `EXISTS (SELECT 1 FROM public.asset_face f JOIN public.person p ON p.id = f."personId"
      JOIN public.asset a ON a.id = f."assetId" WHERE f.id = ${face} AND p."ownerId" <> a."ownerId")`;
  const fileFlags = {
    ...(lacks(M.assetFileIsEdited) && { isEdited: 'false' }),
    ...(lacks(M.isProgressive) && { isProgressive: 'false' }),
    ...(lacks(M.isTransparent) && { isTransparent: 'false' }),
  };
  // Upstream moved these paths into asset_file rows with generated ids; ours derive from the asset so restarts agree.
  const movedFile = (type: string, column: string): Select => ({
    from: 'public.asset a',
    columns: {
      id: `md5('frameleaf:immich-import:${type}:' || a.id::text)::uuid`,
      assetId: 'a.id',
      createdAt: 'a."createdAt"',
      updatedAt: 'a."updatedAt"',
      type: `'${type}'`,
      path: `a.${quote(column)}`,
      updateId: 'NULL::uuid',
      isEdited: 'false',
      isProgressive: 'false',
      isTransparent: 'false',
    },
    where: [`a.${quote(column)} IS NOT NULL`, `a.${quote(column)} != ''`],
  });

  const views: Record<string, View> = {
    user: {
      from: 'public."user" t',
      columns: {
        ...(lacks(M.emptyPasswordToNull) && { password: `NULLIF(t.password, '')` }),
        ...(lacks(M.emptyOAuthIdToNull) && { oauthId: `NULLIF(t."oauthId", '')` }),
      },
    },
    asset: {
      from: lacks(M.assetWidthHeight)
        ? 'public.asset t LEFT JOIN public.asset_exif e ON e."assetId" = t.id'
        : 'public.asset t',
      columns: {
        ...(lacks(M.durationToInteger) && {
          duration: String.raw`CASE WHEN t.duration ~ '^\d{2}:\d{2}:\d{2}\.\d{3}$'
            THEN substr(t.duration, 1, 2)::int * 3600000 + substr(t.duration, 4, 2)::int * 60000
              + substr(t.duration, 7, 2)::int * 1000 + substr(t.duration, 10, 3)::int END`,
        }),
        ...(lacks(M.checksumAlgorithm) && {
          checksumAlgorithm: `CASE WHEN t."isExternal" THEN 'sha1-path' ELSE 'sha1' END`,
        }),
        ...(lacks(M.assetWidthHeight) && {
          width: `CASE WHEN e.orientation IN ('5','6','7','8','-90','90') THEN e."exifImageHeight" ELSE e."exifImageWidth" END`,
          height: `CASE WHEN e.orientation IN ('5','6','7','8','-90','90') THEN e."exifImageWidth" ELSE e."exifImageHeight" END`,
        }),
        ...(lacks(M.assetIsEdited) && { isEdited: 'false' }),
        ...(lacks(M.livePhotoStillVisibility) && {
          visibility: `CASE WHEN t.type = 'IMAGE' AND t.visibility = 'hidden' AND t."livePhotoVideoId" IS NOT NULL
            THEN 'timeline'::asset_visibility_enum ELSE t.visibility END`,
        }),
      },
    },
    asset_exif: {
      from: 'public.asset_exif t',
      columns: {
        ...(lacks(M.rating0ToNull) && { rating: 'NULLIF(t.rating, 0)' }),
        ...(lacks(M.exifTags) && { tags: 'NULL::character varying[]' }),
        ...(lacks(M.exifLockedProperties) && { lockedProperties: 'NULL::character varying[]' }),
      },
    },
    person: {
      from: 'public.person t',
      columns: lacks(M.crossOwnerFaces)
        ? { faceAssetId: `CASE WHEN ${crossOwnerFace('t."faceAssetId"')} THEN NULL ELSE t."faceAssetId" END` }
        : {},
    },
    asset_face: {
      from: 'public.asset_face t',
      columns: lacks(M.isVisible) ? { isVisible: 'true' } : {},
      where: lacks(M.crossOwnerFaces) ? [`NOT ${crossOwnerFace('t.id')}`] : [],
    },
    // The deleted faces' embeddings cascade with them; reading them would orphan face_search at the destination.
    face_search: {
      from: 'public.face_search t',
      where: lacks(M.crossOwnerFaces) ? [`NOT ${crossOwnerFace('t."faceId"')}`] : [],
    },
    asset_file: {
      from: 'public.asset_file t',
      columns: fileFlags,
      union: [
        ...(lacks(M.sidecarInAssetFile) ? [movedFile('sidecar', 'sidecarPath')] : []),
        ...(lacks(M.encodedVideoFiles) ? [movedFile('encoded_video', 'encodedVideoPath')] : []),
      ],
    },
    asset_edit: {
      from: 'public.asset_edit t',
      columns: lacks(M.assetEditSync)
        ? { updatedAt: '(SELECT a."updatedAt" FROM public.asset a WHERE a.id = t."assetId")', updateId: 'NULL::uuid' }
        : {},
    },
    asset_ocr: {
      from: 'public.asset_ocr t',
      columns: {
        ...(lacks(M.isVisible) && { isVisible: 'true' }),
        ...(lacks(M.assetOcrSync) && { updateId: 'NULL::uuid' }),
      },
    },
    album: {
      from: 'public.album t',
      columns: lacks(M.emptyAlbumDescriptionToNull) ? { description: `NULLIF(t.description, '')` } : {},
      where: owned('t.id'),
    },
    album_user: {
      from: 'public.album_user t',
      columns: { albumId: col('albumId', 'albumsId'), userId: col('userId', 'usersId') },
      where: [
        ...owned(col('albumId', 'albumsId')),
        // The owner moves from album.ownerId into album_user; an owner also listed as a member stays owner.
        ...(albumOwnerColumn
          ? [
              `NOT EXISTS (SELECT 1 FROM public.album a WHERE a.id = ${col('albumId', 'albumsId')} AND a."ownerId" = ${col('userId', 'usersId')})`,
            ]
          : []),
      ],
      union: albumOwnerColumn
        ? [
            {
              from: 'public.album a',
              columns: {
                albumId: 'a.id',
                userId: 'a."ownerId"',
                role: `'owner'`,
                createId: 'NULL::uuid',
                createdAt: 'a."createdAt"',
                updateId: 'NULL::uuid',
                updatedAt: 'a."updatedAt"',
              },
            },
          ]
        : [],
    },
    album_asset: {
      from: 'public.album_asset t',
      columns: { albumId: col('albumId', 'albumsId'), assetId: col('assetId', 'assetsId') },
      where: owned(col('albumId', 'albumsId')),
    },
    activity: { from: 'public.activity t', where: owned('t."albumId"') },
    shared_link: { from: 'public.shared_link t', where: owned('t."albumId"') },
    shared_link_asset: {
      from: 'public.shared_link_asset t',
      columns: { assetId: col('assetId', 'assetsId'), sharedLinkId: col('sharedLinkId', 'sharedLinksId') },
      // Album links share the album itself; 2.6.2 removed the duplicate per-asset rows.
      where: lacks(M.albumLinkAssets)
        ? [
            `NOT EXISTS (SELECT 1 FROM public.shared_link l WHERE l.id = ${col('sharedLinkId', 'sharedLinksId')} AND l.type = 'ALBUM')`,
          ]
        : [],
    },
    tag_asset: {
      from: 'public.tag_asset t',
      columns: { assetId: col('assetId', 'assetsId'), tagId: col('tagId', 'tagsId') },
    },
    memory_asset: {
      from: 'public.memory_asset t',
      columns: { assetId: col('assetId', 'assetsId') },
      where: lacks(M.crossOwnerMemoryAssets)
        ? [
            `NOT EXISTS (SELECT 1 FROM public.memory m JOIN public.asset a ON a.id = ${col('assetId', 'assetsId')}
              WHERE m.id = t."memoriesId" AND m."ownerId" <> a."ownerId")`,
          ]
        : [],
    },
  };

  const result: Record<string, string> = {};
  for (const [table, view] of Object.entries(views)) {
    const shape = tables[table];
    if (shape && !isIdentity(view)) {
      result[table] = [view, ...(view.union ?? [])].map((part) => select(shape, part)).join('\nUNION ALL\n');
    }
  }
  return result;
};

// A view with no filters, no extra rows and only same-named columns reads its table directly.
const isIdentity = (view: View): boolean =>
  (view.where ?? []).length === 0 &&
  (view.union ?? []).length === 0 &&
  Object.entries(view.columns ?? {}).every(([column, expression]) => expression === `t.${quote(column)}`);
