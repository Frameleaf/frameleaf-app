import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { AssetOrderSchema, UserAvatarColorSchema } from 'src/enum.js';
import { type FrameleafUserPreferences, getPreferencesRevision } from 'src/utils/preferences.js';

const AlbumsUpdateSchema = z
  .object({
    defaultAssetOrder: AssetOrderSchema.optional(),
  })
  .optional()
  .describe('Album preferences')
  .meta({ id: 'AlbumsUpdate' });

const AvatarUpdateSchema = z
  .object({
    color: UserAvatarColorSchema.optional(),
  })
  .optional()
  .meta({ id: 'AvatarUpdate' });

const MemoriesUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether memories are enabled'),
    duration: z.int().min(1).optional().describe('Memory duration in seconds'),
    sidebarWeb: z.boolean().optional().describe('Whether memories appear in web sidebar'),
  })
  .optional()
  .meta({ id: 'MemoriesUpdate' });

const RatingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether ratings are enabled'),
  })
  .optional()
  .meta({ id: 'RatingsUpdate' });

const FoldersUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether folders are enabled'),
    sidebarWeb: z.boolean().optional().describe('Whether folders appear in web sidebar'),
  })
  .optional()
  .meta({ id: 'FoldersUpdate' });

const PeopleUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether people are enabled'),
    sidebarWeb: z.boolean().optional().describe('Whether people appear in web sidebar'),
    minimumFaces: z.int().min(1).optional().describe('People face threshold'),
  })
  .optional()
  .meta({ id: 'PeopleUpdate' });

const SharedLinksUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether shared links are enabled'),
    sidebarWeb: z.boolean().optional().describe('Whether shared links appear in web sidebar'),
  })
  .optional()
  .meta({ id: 'SharedLinksUpdate' });

const TagsUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether tags are enabled'),
    sidebarWeb: z.boolean().optional().describe('Whether tags appear in web sidebar'),
  })
  .optional()
  .meta({ id: 'TagsUpdate' });

const EmailNotificationsUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether email notifications are enabled'),
    albumInvite: z.boolean().optional().describe('Whether to receive email notifications for album invites'),
    albumUpdate: z.boolean().optional().describe('Whether to receive email notifications for album updates'),
  })
  .optional()
  .meta({ id: 'EmailNotificationsUpdate' });

const DownloadUpdateSchema = z
  .object({
    archiveSize: z.int().min(1).optional().describe('Maximum archive size in bytes'),
    includeEmbeddedVideos: z.boolean().optional().describe('Whether to include embedded videos in downloads'),
  })
  .optional()
  .meta({ id: 'DownloadUpdate' });

const PurchaseUpdateSchema = z
  .object({
    showSupportBadge: z.boolean().optional().describe('Whether to show support badge'),
    hideBuyButtonUntil: z.string().optional().describe('Date until which to hide buy button'),
  })
  .optional()
  .meta({ id: 'PurchaseUpdate' });

const CastUpdateSchema = z
  .object({
    gCastEnabled: z.boolean().optional().describe('Whether Google Cast is enabled'),
    adminDisabled: z
      .boolean()
      .optional()
      .describe(
        'Administrator only: turn casting off for this user. Accepted only by the admin user preferences endpoint; ignored when a user updates their own preferences',
      ),
  })
  .optional()
  .meta({ id: 'CastUpdate' });

const SuppressionScopeSchema = z.enum(['owned', 'visible']).meta({ id: 'SuppressionScope' });

const SuppressionUpdateSchema = z
  .object({
    tagIds: z.array(z.uuidv4()).optional().describe('Tag IDs to suppress from locked browsing sessions'),
    personIds: z.array(z.uuidv4()).optional().describe('Person IDs to suppress from locked browsing sessions'),
    petIds: z.array(z.uuidv4()).optional().describe('Pet IDs to suppress from locked browsing sessions'),
    scope: SuppressionScopeSchema.optional().describe(
      'Whether suppression applies only to owned assets or all visible assets',
    ),
  })
  .optional()
  .meta({ id: 'SuppressionUpdate' });

const PrivacyUpdateSchema = z
  .object({
    suppression: SuppressionUpdateSchema,
  })
  .optional()
  .describe('Privacy preferences')
  .meta({ id: 'PrivacyUpdate' });
const RecentlyAddedUpdateSchema = z
  .object({
    sidebarWeb: z.boolean().optional().describe('Whether the recently added page appears in the web sidebar'),
  })
  .optional()
  .meta({ id: 'RecentlyAddedUpdate' });

const UserPreferencesUpdateSchema = z
  .object({
    albums: AlbumsUpdateSchema,
    avatar: AvatarUpdateSchema,
    cast: CastUpdateSchema,
    download: DownloadUpdateSchema,
    emailNotifications: EmailNotificationsUpdateSchema,
    folders: FoldersUpdateSchema,
    memories: MemoriesUpdateSchema,
    people: PeopleUpdateSchema,
    privacy: PrivacyUpdateSchema,
    purchase: PurchaseUpdateSchema,
    ratings: RatingsUpdateSchema,
    sharedLinks: SharedLinksUpdateSchema,
    tags: TagsUpdateSchema,
    recentlyAdded: RecentlyAddedUpdateSchema,
    expectedRevision: z
      .string()
      .optional()
      .describe(
        'The revision these changes were made against. When it no longer matches the stored preferences the update is rejected with 409 and nothing is changed',
      ),
  })
  .meta({ id: 'UserPreferencesUpdateDto' });

const AlbumsResponseSchema = z
  .object({
    defaultAssetOrder: AssetOrderSchema,
  })
  .meta({ id: 'AlbumsResponse' });

const FoldersResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether folders are enabled'),
    sidebarWeb: z.boolean().describe('Whether folders appear in web sidebar'),
  })
  .meta({ id: 'FoldersResponse' });

const MemoriesResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether memories are enabled'),
    duration: z.int().describe('Memory duration in seconds'),
    sidebarWeb: z.boolean().describe('Whether memories appear in web sidebar'),
  })
  .meta({ id: 'MemoriesResponse' });

const PeopleResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether people are enabled'),
    sidebarWeb: z.boolean().describe('Whether people appear in web sidebar'),
    minimumFaces: z.int().min(1).optional().describe('People face threshold'),
  })
  .meta({ id: 'PeopleResponse' });

const RatingsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether ratings are enabled'),
  })
  .meta({ id: 'RatingsResponse' });

const SharedLinksResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether shared links are enabled'),
    sidebarWeb: z.boolean().describe('Whether shared links appear in web sidebar'),
  })
  .meta({ id: 'SharedLinksResponse' });

const TagsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether tags are enabled'),
    sidebarWeb: z.boolean().describe('Whether tags appear in web sidebar'),
  })
  .meta({ id: 'TagsResponse' });

const EmailNotificationsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether email notifications are enabled'),
    albumInvite: z.boolean().describe('Whether to receive email notifications for album invites'),
    albumUpdate: z.boolean().describe('Whether to receive email notifications for album updates'),
  })
  .meta({ id: 'EmailNotificationsResponse' });

const DownloadResponseSchema = z
  .object({
    archiveSize: z.int().describe('Maximum archive size in bytes'),
    includeEmbeddedVideos: z.boolean().describe('Whether to include embedded videos in downloads'),
  })
  .meta({ id: 'DownloadResponse' });

const PurchaseResponseSchema = z
  .object({
    showSupportBadge: z.boolean().describe('Whether to show support badge'),
    hideBuyButtonUntil: z.string().describe('Date until which to hide buy button'),
  })
  .meta({ id: 'PurchaseResponse' });

const CastResponseSchema = z
  .object({
    gCastEnabled: z
      .boolean()
      .describe('Whether Google Cast is enabled (always false while an administrator has turned casting off)'),
    adminDisabled: z.boolean().describe('Whether an administrator has turned casting off for this user'),
  })
  .meta({ id: 'CastResponse' });

const SuppressionResponseSchema = z
  .object({
    tagIds: z.array(z.string()).describe('Tag IDs to suppress from locked browsing sessions'),
    personIds: z.array(z.string()).describe('Person IDs to suppress from locked browsing sessions'),
    petIds: z.array(z.string()).describe('Pet IDs to suppress from locked browsing sessions'),
    scope: SuppressionScopeSchema.describe('Whether suppression applies only to owned assets or all visible assets'),
  })
  .meta({ id: 'SuppressionResponse' });

const PrivacyResponseSchema = z
  .object({
    suppression: SuppressionResponseSchema,
  })
  .describe('Privacy preferences')
  .meta({ id: 'PrivacyResponse' });
const RecentlyAddedResponseSchema = z
  .object({
    sidebarWeb: z.boolean().describe('Whether the recently added page appears in the web sidebar'),
  })
  .meta({ id: 'RecentlyAddedResponse' });

const UserPreferencesResponseSchema = z
  .object({
    albums: AlbumsResponseSchema,
    folders: FoldersResponseSchema,
    memories: MemoriesResponseSchema,
    people: PeopleResponseSchema,
    privacy: PrivacyResponseSchema,
    ratings: RatingsResponseSchema,
    sharedLinks: SharedLinksResponseSchema,
    tags: TagsResponseSchema,
    emailNotifications: EmailNotificationsResponseSchema,
    download: DownloadResponseSchema,
    purchase: PurchaseResponseSchema,
    cast: CastResponseSchema,
    recentlyAdded: RecentlyAddedResponseSchema,
    revision: z
      .string()
      .describe('Changes whenever the stored preferences change; send it back as expectedRevision to reject stale saves'),
  })
  .meta({ id: 'UserPreferencesResponseDto' });

export class UserPreferencesUpdateDto extends createZodDto(UserPreferencesUpdateSchema) {}
export class UserPreferencesResponseDto extends createZodDto(UserPreferencesResponseSchema) {}

/**
 * Who a preferences response is for: the account itself, or an administrator editing it.
 * An administrator never sees the account's private Locked choices (FL-77).
 */
export type PreferencesAudience = 'self' | 'admin';

export const mapPreferences = (
  preferences: FrameleafUserPreferences,
  audience: PreferencesAudience = 'self',
): UserPreferencesResponseDto => {
  // FL-77: an administrator's decision wins over the user's own casting choice, which stays
  // stored so it applies again once casting is allowed.
  const { gCastEnabled, adminDisabled } = preferences.cast;
  const { suppression } = preferences.privacy;
  return {
    ...preferences,
    cast: { gCastEnabled: gCastEnabled && !adminDisabled, adminDisabled },
    privacy:
      audience === 'admin'
        ? { suppression: { tagIds: [], personIds: [], petIds: [], scope: suppression.scope } }
        : preferences.privacy,
    revision: getPreferencesRevision(preferences),
  };
};
