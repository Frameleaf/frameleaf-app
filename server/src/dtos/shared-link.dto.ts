import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { SharedLink } from 'src/database.js';
import { HistoryBuilder } from 'src/decorators.js';
import { AlbumResponseSchema, mapAlbum } from 'src/dtos/album.dto.js';
import { AssetResponseSchema, mapAsset } from 'src/dtos/asset-response.dto.js';
import { AssetType, SharedLinkType, SharedLinkTypeSchema } from 'src/enum.js';
import { isoDatetimeToDate } from 'src/validation.js';

const SharedLinkSearchSchema = z
  .object({
    albumId: z.uuidv4().optional().describe('Filter by album ID'),
    id: z
      .uuidv4()
      .optional()
      .describe('Filter by shared link ID')
      .meta(new HistoryBuilder().added('v2.5.0').getExtensions()),
  })
  .meta({ id: 'SharedLinkSearchDto' });

const SharedLinkCreateSchema = z
  .object({
    type: SharedLinkTypeSchema,
    assetIds: z.array(z.uuidv4()).optional().describe('Asset IDs (for individual assets)'),
    albumId: z.uuidv4().optional().describe('Album ID (for album sharing)'),
    description: z.string().nullable().optional().describe('Link description'),
    password: z.string().nullable().optional().describe('Link password'),
    slug: z.string().nullable().optional().describe('Custom URL slug'),
    expiresAt: isoDatetimeToDate.nullable().describe('Expiration date').default(null).optional(),
    allowUpload: z.boolean().optional().describe('Allow uploads'),
    allowDownload: z.boolean().default(true).optional().describe('Allow downloads'),
    showMetadata: z.boolean().default(true).optional().describe('Show metadata'),
  })
  .superRefine(({ type, albumId, assetIds }, ctx) => {
    switch (type) {
      case SharedLinkType.Album: {
        if (!albumId) {
          ctx.addIssue(`albumId is required for type ${SharedLinkType.Album}`);
        }
        if (assetIds && assetIds.length > 0) {
          ctx.addIssue(`assetIds can only be used with type ${SharedLinkType.Individual}`);
        }
        return;
      }
      case SharedLinkType.Individual: {
        if (!assetIds || assetIds.length === 0) {
          ctx.addIssue(`assetIds are required for type ${SharedLinkType.Individual}`);
        }

        if (albumId) {
          ctx.addIssue(`albumId can only be used with type ${SharedLinkType.Album}`);
        }
        return;
      }
    }
  })
  .meta({ id: 'SharedLinkCreateDto' });

const SharedLinkEditSchema = z
  .object({
    description: z.string().nullable().optional().describe('Link description'),
    password: z.string().nullable().optional().describe('Link password'),
    slug: z.string().nullable().optional().describe('Custom URL slug'),
    expiresAt: isoDatetimeToDate.nullish().describe('Expiration date'),
    allowUpload: z.boolean().optional().describe('Allow uploads'),
    allowDownload: z.boolean().optional().describe('Allow downloads'),
    showMetadata: z.boolean().optional().describe('Show metadata'),
  })
  .meta({ id: 'SharedLinkEditDto' });

/** FL-788: which size a direct image link serves; the preview unless the full-size copy is asked for. */
const SharedLinkDirectImageSchema = z
  .object({
    size: z
      .enum(['preview', 'fullsize'])
      .optional()
      .describe('Image size: preview (default) or fullsize')
      .meta({ id: 'SharedLinkDirectImageSize' }),
  })
  .meta({ id: 'SharedLinkDirectImageDto' });

const SharedLinkLoginSchema = z
  .object({
    password: z.string().describe('Shared link password').meta({ example: 'password' }),
  })
  .meta({ id: 'SharedLinkLoginDto' });

/**
 * What a shared link's viewers learn about the person who shared it: the display name and nothing
 * else (FL-83, prototype "Shared by …"). No email, no user id beyond the link's existing `userId`, and
 * no profile image, which an anonymous viewer could not fetch anyway.
 */
const SharedLinkOwnerResponseSchema = z
  .object({
    name: z.string().describe('Display name of the user who created the link'),
  })
  .describe('Public details of the shared link owner')
  .meta({ id: 'SharedLinkOwnerResponseDto' });

const SharedLinkResponseSchema = z
  .object({
    id: z.uuidv4().describe('Shared link ID'),
    description: z.string().nullable().describe('Link description'),
    password: z
      .string()
      .nullable()
      .describe('Has password: a fixed mask when the link has one, never the password itself'),
    userId: z.uuidv4().describe('Owner user ID'),
    key: z.string().describe('Encryption key (base64url)'),
    type: SharedLinkTypeSchema,
    createdAt: isoDatetimeToDate.describe('Creation date'),
    expiresAt: isoDatetimeToDate.nullable().describe('Expiration date'),
    assets: z.array(AssetResponseSchema),
    assetCount: z
      .int()
      .min(0)
      .describe("Number of assets the link shares: its own for an individual link, the album's for an album link"),
    coverAssetIds: z
      .array(z.uuidv4())
      .describe(
        "Up to four assets for a cover: an album's chosen cover and then its newest, or an individual link's first",
      ),
    album: AlbumResponseSchema.optional(),
    allowUpload: z.boolean().describe('Allow uploads'),
    allowDownload: z.boolean().describe('Allow downloads'),
    showMetadata: z.boolean().describe('Show metadata'),
    slug: z.string().nullable().describe('Custom URL slug'),
    url: z
      .string()
      .nullable()
      .describe(
        "The link's public address: the server's external domain, then /s/<slug> (URL-encoded) or /share/<key>. Null when no external domain is set; a client then puts the same path after the address it uses.",
      ),
    owner: SharedLinkOwnerResponseSchema.optional().describe(
      'Display name of the user who created the link, for "Shared by" on the public page',
    ),
    directUrl: z
      .string()
      .nullable()
      .describe(
        "FL-788: an address that serves the link's photo as an image file, for embedding in forums and websites. Set only for a link to exactly one photo with downloads allowed, no password and no expiry passed; null otherwise. On the server's external domain when one is set, otherwise a path from the server's root: /api/shared-links/direct/s/<slug>.jpg for a link with a slug, /api/shared-links/direct/key/<key>.jpg otherwise.",
      )
      .meta(new HistoryBuilder().added('v3.4.0').getExtensions()),
  })
  .describe('Shared link response')
  .meta({ id: 'SharedLinkResponseDto' });

export class SharedLinkSearchDto extends createZodDto(SharedLinkSearchSchema) {}
export class SharedLinkCreateDto extends createZodDto(SharedLinkCreateSchema) {}
export class SharedLinkEditDto extends createZodDto(SharedLinkEditSchema) {}
export class SharedLinkDirectImageDto extends createZodDto(SharedLinkDirectImageSchema) {}
export class SharedLinkLoginDto extends createZodDto(SharedLinkLoginSchema) {}
export class SharedLinkResponseDto extends createZodDto(SharedLinkResponseSchema) {}

/**
 * FL-161: what a response carries in place of a shared link's password. Passwords are stored hashed,
 * so there is nothing to show; an edit that sends this value back leaves the password unchanged.
 */
export const SHARED_LINK_PASSWORD_MASK = '********';

/**
 * FL-305: a link's public address, as the web shows it. Only the configured external domain makes it
 * absolute: an address from the request (its Host header) could be spoofed or name an internal host.
 */
export const sharedLinkUrl = (
  sharedLink: Pick<SharedLink, 'key' | 'slug'>,
  externalDomain: string | undefined,
): string | null => {
  const base = externalDomain?.trim().replace(/\/+$/, '');
  if (!base) {
    return null;
  }
  const path = sharedLink.slug
    ? `/s/${encodeURIComponent(sharedLink.slug)}`
    : `/share/${sharedLink.key.toString('base64url')}`;
  return `${base}${path}`;
};

/**
 * FL-788: whether a link may serve its photo at a direct image address. Only a link to exactly one
 * photo qualifies, and only while anyone holding the link could already download it: no password,
 * downloads allowed (which a link that hides metadata never does) and not expired. Album links and
 * videos never qualify. Locked and deleted items are already left out of a link's assets.
 */
export const isDirectImageLink = (
  sharedLink: Pick<SharedLink, 'type' | 'password' | 'allowDownload' | 'expiresAt' | 'assets' | 'assetCount'>,
  now = new Date(),
): boolean => {
  if (
    sharedLink.type !== SharedLinkType.Individual ||
    sharedLink.password ||
    !sharedLink.allowDownload ||
    (sharedLink.expiresAt && new Date(sharedLink.expiresAt) <= now)
  ) {
    return false;
  }
  const assets = sharedLink.assets ?? [];
  const count = sharedLink.assetCount ?? assets.length;
  return count === 1 && assets.length === 1 && assets[0].type === AssetType.Image;
};

/**
 * FL-788: the path of a link's direct image: `/s/<slug>.jpg` when it has a slug, otherwise
 * `/key/<key>.jpg`. The two forms never share a path, so a slug that happens to spell another link's
 * key can only ever name the link that holds the slug (as `/s/` and `/share/` do for the pages).
 */
export const sharedLinkDirectPath = (sharedLink: Pick<SharedLink, 'key' | 'slug'>) =>
  sharedLink.slug
    ? `/api/shared-links/direct/s/${encodeURIComponent(sharedLink.slug)}.jpg`
    : `/api/shared-links/direct/key/${sharedLink.key.toString('base64url')}.jpg`;

const sharedLinkDirectUrl = (sharedLink: SharedLink, externalDomain: string | undefined): string | null => {
  if (!isDirectImageLink(sharedLink)) {
    return null;
  }
  const base = externalDomain?.trim().replace(/\/+$/, '') ?? '';
  return `${base}${sharedLinkDirectPath(sharedLink)}`;
};

const SHARED_LINK_COVER_ASSETS = 4;

/** An album's cover items from its loaded assets (oldest first): the cover its owner chose, then the newest. */
const albumCoverAssets = (album: SharedLink['album']): { id: string }[] => {
  const newest = (album?.assets ?? []).toReversed();
  const chosen = newest.find(({ id }) => id === album?.albumThumbnailAssetId);
  return chosen ? [chosen, ...newest.filter((asset) => asset !== chosen)] : newest;
};

export function mapSharedLink(
  sharedLink: SharedLink,
  options: { stripAssetMetadata: boolean; externalDomain?: string; visitor?: boolean },
): SharedLinkResponseDto {
  const assets = sharedLink.assets || [];
  const isAlbum = sharedLink.type === SharedLinkType.Album;
  // The list of links loads the count and an album's cover on their own; one link read alone carries everything.
  const assetCount = sharedLink.assetCount ?? (isAlbum ? (sharedLink.album?.assets.length ?? 0) : assets.length);
  const coverAssets = isAlbum ? (sharedLink.coverAssets ?? albumCoverAssets(sharedLink.album)) : assets;

  const response = {
    id: sharedLink.id,
    description: sharedLink.description,
    password: sharedLink.password ? SHARED_LINK_PASSWORD_MASK : null,
    userId: sharedLink.userId,
    key: sharedLink.key.toString('base64url'),
    type: sharedLink.type,
    createdAt: sharedLink.createdAt,
    expiresAt: sharedLink.expiresAt,
    assets: assets.map((asset) => {
      const response = mapAsset(asset, { stripMetadata: options.stripAssetMetadata });
      if (options.visitor && response.exifInfo) delete response.exifInfo.artist;
      return response;
    }),
    assetCount,
    coverAssetIds: coverAssets.slice(0, SHARED_LINK_COVER_ASSETS).map(({ id }) => id),
    album: sharedLink.album ? mapAlbum(sharedLink.album) : undefined,
    allowUpload: sharedLink.allowUpload,
    allowDownload: sharedLink.allowDownload,
    showMetadata: sharedLink.showExif,
    slug: sharedLink.slug,
    url: sharedLinkUrl(sharedLink, options.externalDomain),
    directUrl: sharedLinkDirectUrl(sharedLink, options.externalDomain),
    // pick the name explicitly so nothing else about the owner can ride along
    owner: sharedLink.owner ? { name: sharedLink.owner.name } : undefined,
  };

  // unless we select sharedLink.album.sharedLinks this will be wrong
  if (response.album) {
    response.album.hasSharedLink = true;
    response.album.shared = true;
    // the list of links does not load the album's assets, which is where mapAlbum counts them
    response.album.assetCount = assetCount;
  }

  return response;
}
