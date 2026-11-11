import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { MEDIA_SECTIONS } from 'src/utils/media-import.js';
import { stringToBool } from 'src/validation.js';

const mediaUrl = z
  .url()
  .max(8192)
  .refine((value) => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Use an HTTP or HTTPS URL without credentials');
const key = z.string().min(1).max(128);
const history = z
  .object({
    mode: z.enum(['all', 'since', 'new']).meta({ id: 'MediaHistoryMode' }),
    since: z.iso.datetime().optional(),
  })
  .strict()
  .refine((value) => (value.mode === 'since') === !!value.since, 'Choose a date only for since-date history');
/** How far back a subscription reaches. `recent` takes the latest `count` (20 if left out), then everything new. */
const reach = z
  .object({
    mode: z.enum(['recent', 'all', 'since', 'new']).meta({ id: 'MediaReachMode' }),
    since: z.iso.datetime().optional(),
    count: z.number().int().min(1).max(200).optional(),
  })
  .strict()
  .refine((value) => (value.mode === 'since') === !!value.since, 'Choose a date only for since-date history')
  .refine((value) => value.mode === 'recent' || value.count === undefined, 'Choose a count only for recent history')
  .meta({ id: 'MediaReach' });
const quality = z.enum(['best', '1080', '720', 'audio']).meta({ id: 'MediaQuality' });
const saves = z
  .object({
    videos: z.boolean().optional(),
    shorts: z.boolean().optional(),
    live: z.boolean().optional(),
    images: z.boolean().optional(),
    replies: z.boolean().optional(),
    reposts: z.boolean().optional(),
    pins: z.boolean().optional(),
    photos: z.boolean().optional(),
    reels: z.boolean().optional(),
  })
  .strict()
  .meta({ id: 'MediaSaves' });
const section = z.enum(MEDIA_SECTIONS).meta({ id: 'MediaSection' });
const itemKind = z.enum(['image', 'video', 'audio']).meta({ id: 'MediaItemKind' });
const subscriptionState = z
  .enum(['active', 'paused', 'attention', 'unsubscribed'])
  .meta({ id: 'MediaSubscriptionState' });
const intervals = z.union([
  z.literal(15).meta({ type: 'integer', format: 'int32' }),
  z.literal(60).meta({ type: 'integer', format: 'int32' }),
  z.literal(360).meta({ type: 'integer', format: 'int32' }),
  z.literal(1440).meta({ type: 'integer', format: 'int32' }),
]);

export class MediaInspectDto extends createZodDto(
  z
    .object({
      urls: z.array(mediaUrl).min(1).max(20),
      connectionId: z.uuid().optional(),
    })
    .strict(),
) {}
export class MediaImportCreateDto extends createZodDto(
  z
    .object({
      inspectionId: z.uuid(),
      itemIds: z.array(z.uuid()).min(1).max(500),
      albumId: z.uuid().optional().describe('Left out, the items are filed into their creator’s own collection'),
      tagIds: z.array(z.uuid()).max(500).default([]),
      quality: quality.default('best'),
      streamMp4: z.boolean().default(false),
      overrideSuppression: z.boolean().default(false),
      idempotencyKey: key,
    })
    .strict(),
) {}
export class MediaRetryDto extends createZodDto(z.object({ idempotencyKey: key }).strict()) {}

export const MediaEntrySchema = z
  .object({
    id: z.uuid(),
    provider: z.string(),
    creatorId: z.string().nullable(),
    postId: z.string(),
    attachmentId: z.string(),
    pageUrl: z.string(),
    title: z.string(),
    description: z.string(),
    creator: z.string().nullable(),
    publishedAt: z.string().nullable(),
    kind: itemKind,
    section: section.nullable(),
    tags: z.array(z.string()),
    playlistId: z.string().nullable(),
    playlistTitle: z.string().nullable(),
    duration: z.number().meta({ format: 'double' }).nullable(),
    state: z
      .enum(['discovered', 'downloading', 'assembling', 'importing', 'saved', 'skipped', 'failed'])
      .meta({ id: 'MediaImportItemState' }),
    assetId: z.uuid().nullable(),
    error: z.string().nullable(),
    bytes: z.number().int().nonnegative(),
  })
  .meta({ id: 'MediaImportItemResponse' });
export class MediaImportResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      state: z
        .enum([
          'inspecting',
          'ready',
          'queued',
          'downloading',
          'assembling',
          'importing',
          'saved',
          'partial',
          'failed',
          'cancelled',
          'paused',
        ])
        .meta({ id: 'MediaImportState' }),
      albumId: z.uuid().nullable(),
      subscriptionId: z.uuid().nullable(),
      mediaCreatorId: z.uuid().nullable(),
      quality,
      connectionId: z.uuid().nullable(),
      createdAt: z.string(),
      updatedAt: z.string(),
      error: z.string().nullable(),
      kind: z.enum(['item', 'feed']).meta({ id: 'MediaInspectionKind' }).nullable(),
      provider: z.string().nullable(),
      creatorId: z.string().nullable(),
      creator: z.string().nullable(),
      complete: z.boolean(),
      limitation: z.string().nullable(),
      items: z.array(MediaEntrySchema),
      discovered: z.number().int().nonnegative(),
      saved: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .meta({ id: 'MediaImportResponseDto' }),
) {}
export class MediaImportListDto extends createZodDto(z.object({ imports: z.array(MediaImportResponseDto.schema) })) {}
export class MediaCapabilitiesDto extends createZodDto(
  z
    .object({
      version: z.literal(1).meta({ id: 'MediaProtocolVersion', type: 'integer', format: 'int32' }),
      available: z.boolean(),
      reason: z.string().nullable(),
      ytDlpVersion: z.string().nullable(),
      galleryDlVersion: z.string().nullable(),
      individualMedia: z.literal('installed-extractors').meta({ id: 'MediaIndividualSupport' }),
      creatorFeeds: z.literal('per-url').meta({ id: 'MediaFeedSupport' }),
      authentication: z.array(z.enum(['cookies', 'credentials', 'token']).meta({ id: 'MediaAuthenticationMethod' })),
      qualifiedProviders: z.array(z.string()),
    })
    .meta({ id: 'MediaCapabilitiesDto' }),
) {}

export const MediaCookieSchema = z
  .object({
    name: z.string().max(4096),
    value: z.string().max(16_384),
    domain: z.string().max(255),
    path: z.string().max(4096),
    secure: z.boolean(),
    httpOnly: z.boolean(),
    hostOnly: z.boolean(),
    expires: z.number().meta({ format: 'double' }).optional(),
    storeId: z.string().max(128).optional(),
    partitionKey: z
      .object({ topLevelSite: z.string(), hasCrossSiteAncestor: z.boolean().optional() })
      .strict()
      .optional(),
  })
  .strict();
export const MediaSessionSchema = z
  .object({
    domains: z.array(z.string().max(255)).min(1).max(20),
    cookies: z.array(MediaCookieSchema).max(500).optional(),
    username: z.string().max(1024).optional(),
    password: z.string().max(8192).optional(),
    accessToken: z.string().max(16_384).optional(),
    refreshToken: z.string().max(16_384).optional(),
    clientId: z.string().max(1024).optional(),
    clientSecret: z.string().max(8192).optional(),
  })
  .strict();
export class MediaConnectionCreateDto extends createZodDto(
  z
    .object({
      provider: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
      label: z.string().trim().min(1).max(255),
      session: MediaSessionSchema,
    })
    .strict(),
) {}
export class MediaConnectionRefreshDto extends createZodDto(z.object({ session: MediaSessionSchema }).strict()) {}
export class MediaConnectionResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      provider: z.string(),
      label: z.string(),
      domains: z.array(z.string()),
      status: z.enum(['connected', 'expired', 'disconnected']).meta({ id: 'MediaConnectionStatus' }),
      revision: z.number().int().positive(),
      updatedAt: z.string(),
    })
    .meta({ id: 'MediaConnectionResponseDto' }),
) {}
export class MediaConnectionListDto extends createZodDto(
  z.object({ connections: z.array(MediaConnectionResponseDto.schema) }),
) {}

export class MediaSubscriptionCreateDto extends createZodDto(
  z
    .object({
      inspectionId: z.uuid(),
      parentId: z.uuid().optional(),
      history: reach,
      saves: saves.default({}),
      quality: quality.default('best'),
      intervalMinutes: intervals.default(60),
      idempotencyKey: key,
    })
    .strict(),
) {}
export class MediaSubscriptionUpdateDto extends createZodDto(
  z
    .object({
      intervalMinutes: intervals.optional(),
      history: reach.optional(),
      saves: saves.optional(),
      quality: quality.optional(),
      connectionId: z.uuid().nullable().optional(),
      action: z.enum(['pause', 'resume', 'check', 'unsubscribe']).meta({ id: 'MediaSubscriptionAction' }).optional(),
    })
    .strict(),
) {}
export class MediaSubscriptionResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      provider: z.string(),
      creatorId: z.string(),
      creator: z.string(),
      url: z.string(),
      albumId: z.uuid().nullable(),
      connectionId: z.uuid().nullable(),
      mediaCreatorId: z.uuid().nullable(),
      history: history.describe('Kept for older clients, which read a recent reach as new; use reach'),
      reach,
      saves,
      quality,
      intervalMinutes: z.number().int().positive(),
      status: subscriptionState,
      lastSuccessAt: z.string().nullable(),
      nextCheckAt: z.string(),
      historyComplete: z.boolean(),
      limitation: z.string().nullable(),
      error: z.string().nullable(),
      discovered: z.number().int().nonnegative(),
      saved: z.number().int().nonnegative(),
      skipped: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .meta({ id: 'MediaSubscriptionResponseDto' }),
) {}
export class MediaSubscriptionListDto extends createZodDto(
  z.object({ subscriptions: z.array(MediaSubscriptionResponseDto.schema) }),
) {}

const creatorSubscription = z
  .object({
    id: z.uuid(),
    status: subscriptionState,
    intervalMinutes: z.number().int().positive(),
    history: reach,
    saves,
    quality,
    connectionId: z.uuid().nullable(),
    lastSuccessAt: z.string().nullable(),
    nextCheckAt: z.string(),
    historyComplete: z.boolean(),
    limitation: z.string().nullable(),
    error: z.string().nullable(),
  })
  .meta({ id: 'MediaCreatorSubscription' });
export class MediaCreatorResponseDto extends createZodDto(
  z
    .object({
      id: z.uuid(),
      provider: z.string(),
      creatorId: z.string().describe('The site’s own identifier for this account'),
      name: z.string(),
      handle: z.string().nullable(),
      about: z.string().nullable(),
      url: z.string().nullable(),
      hasAvatar: z.boolean(),
      hasBanner: z.boolean(),
      albumId: z.uuid().nullable(),
      parentAlbumId: z.uuid().nullable(),
      following: z.boolean().describe('False for a creator added by saving one of their posts'),
      subscription: creatorSubscription.nullable(),
      savedCount: z.number().int().nonnegative(),
      newCount: z.number().int().nonnegative().describe('Items saved since this account last opened the creator'),
      seenAt: z.string(),
      createdAt: z.string(),
    })
    .meta({ id: 'MediaCreatorResponseDto' }),
) {}
export class MediaCreatorListDto extends createZodDto(
  z.object({ creators: z.array(MediaCreatorResponseDto.schema) }),
) {}
export class MediaCreatorUpdateDto extends createZodDto(
  z
    .object({ parentAlbumId: z.uuid().nullable().describe('A private collection to file under, or null for none') })
    .strict(),
) {}
export class MediaCreatorItemsQueryDto extends createZodDto(
  z.object({
    section: section.optional(),
    kind: itemKind.optional(),
    unwatched: stringToBool.optional().describe('Only items not watched yet'),
    q: z.string().trim().max(200).optional().describe('Words to find in the title, text or tags'),
    sort: z.enum(['newest', 'oldest', 'longest']).meta({ id: 'MediaCreatorItemSort' }).default('newest'),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
  }),
) {}
export class MediaCreatorNewQueryDto extends createZodDto(
  z.object({ limit: z.coerce.number().int().min(1).max(100).default(24) }),
) {}
export const MediaCreatorItemSchema = z
  .object({
    assetId: z.uuid(),
    creatorId: z.uuid().describe('The creator record this item belongs to'),
    kind: itemKind,
    section: section.nullable(),
    title: z.string(),
    description: z.string(),
    tags: z.array(z.string()),
    publishedAt: z.string().nullable(),
    savedAt: z.string(),
    duration: z.number().meta({ format: 'double' }).nullable().describe('Seconds'),
    postId: z.string().nullable().describe('Attachments of one post share it'),
    playlistId: z.string().nullable(),
    playlistTitle: z.string().nullable(),
    pageUrl: z.string().nullable(),
    savedBy: z.enum(['subscription', 'download']).meta({ id: 'MediaSavedBy' }),
    hasPoster: z.boolean(),
    watched: z.boolean(),
    position: z.number().meta({ format: 'double' }).nonnegative().describe('Seconds'),
  })
  .meta({ id: 'MediaCreatorItemResponse' });
export class MediaCreatorItemsDto extends createZodDto(
  z.object({
    items: z.array(MediaCreatorItemSchema),
    page: z.number().int().positive(),
    hasNextPage: z.boolean(),
  }),
) {}
export class MediaCreatorFeedDto extends createZodDto(z.object({ items: z.array(MediaCreatorItemSchema) })) {}
export class MediaWatchUpdateDto extends createZodDto(
  z
    .object({
      watched: z.boolean(),
      position: z.number().meta({ format: 'double' }).min(0).max(10_000_000).default(0).describe('Seconds'),
    })
    .strict(),
) {}
export class MediaWatchResponseDto extends createZodDto(
  z
    .object({
      assetId: z.uuid(),
      watched: z.boolean(),
      position: z.number().meta({ format: 'double' }).nonnegative(),
      updatedAt: z.string(),
    })
    .meta({ id: 'MediaWatchResponseDto' }),
) {}
