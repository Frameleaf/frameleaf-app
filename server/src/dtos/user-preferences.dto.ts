import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import { HistoryBuilder } from 'src/decorators.js';
import { AssetOrderSchema, UserAvatarColorSchema } from 'src/enum.js';
import { NotificationLocalePreferencesSchema } from 'src/utils/notification-locale.js';
import {
  type FrameleafUserPreferences,
  getPreferencesRevision,
  withoutLockedSavedSearches,
} from 'src/utils/preferences.js';

const AlbumsUpdateSchema = z
  .object({
    defaultAssetOrder: AssetOrderSchema.optional(),
    showPartnerAlbums: z.boolean().optional().describe('Whether albums a partner shared appear in the album list'),
    cleanupBannerDismissed: z.boolean().optional().describe('The Magic Albums cleanup banner has been dismissed'),
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

// Clients (the photography-studio suite) is opt-in: off, it sits under Tools; on, it joins the top bar.
const ClientsUpdateSchema = z
  .object({
    enabled: z.boolean().optional().describe('Whether Clients is in use and shown in the top bar'),
  })
  .optional()
  .meta({ id: 'ClientsUpdate' });

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

// FL-1484: whether AI work on this person's own photos may use Frameleaf Cloud. Only the person changes it.
const CloudProcessingUpdateSchema = z
  .object({
    enabled: z
      .boolean()
      .optional()
      .describe('Whether AI work on your photos may use Frameleaf Cloud (false: only at home)'),
  })
  .optional()
  .meta({ id: 'CloudProcessingUpdate' });

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
    suggestInSpaces: z
      .boolean()
      .optional()
      .describe('Whether a shared Space suggests which of my named people appear in it')
      .meta(new HistoryBuilder().added('v3').getExtensions()),
    includeArchived: z
      .boolean()
      .optional()
      .describe(
        "Whether archived photos appear on person pages and count in People. Off by default: People shows only photos on the timeline. Pages and counts follow each viewer's own choice, partners included; clients apply it on the person page by naming no visibility. The featured photo picked automatically for a person follows the person owner's choice",
      )
      .meta(new HistoryBuilder().added('v3.4.0').getExtensions()),
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
    newSignIn: z.boolean().optional().describe('Whether to receive email when a new device signs in'),
  })
  .optional()
  .meta({ id: 'EmailNotificationsUpdate' });

const DownloadUpdateSchema = z
  .object({
    archiveSize: z.int().min(1).optional().describe('Maximum archive size in bytes'),
    includeEmbeddedVideos: z.boolean().optional().describe('Whether to include embedded videos in downloads'),
    includeSidecar: z
      .boolean()
      .optional()
      .describe("Whether an archive download puts each photo's details file (XMP sidecar) beside it")
      .meta(new HistoryBuilder().added('v3').getExtensions()),
  })
  .optional()
  .meta({ id: 'DownloadUpdate' });

const DateFormatSchema = z
  .enum(['auto', 'iso', 'dmy', 'mdy'])
  .describe('FL-783: date order. auto follows the region; iso is 2026-11-01, dmy 01/11/2026, mdy 11/01/2026')
  .meta({ id: 'DisplayDateFormat' });
const HourCycleSchema = z
  .enum(['auto', 'h12', 'h23'])
  .describe('FL-783: clock. auto follows the region; h12 is 2:30 PM, h23 is 14:30')
  .meta({ id: 'DisplayHourCycle' });

const DisplayUpdateSchema = z
  .object({
    dateFormat: DateFormatSchema.optional(),
    hourCycle: HourCycleSchema.optional(),
  })
  .optional()
  .describe('FL-783: how dates and times appear, independent of the language')
  .meta({ id: 'DisplayPreferencesUpdate' });

const SearchPreferencesUpdateSchema = z
  .object({
    includeArchived: z
      .boolean()
      .optional()
      .describe(
        'Whether the search screens show archived photos. Clients apply it by sending a visibility; the server does not change a search that names none',
      ),
    classic: z
      .boolean()
      .optional()
      .describe('FL-918: whether search questions use classic search instead of the Library Assistant'),
  })
  .optional()
  .meta({ id: 'SearchPreferencesUpdate' });

const PurchaseUpdateSchema = z
  .object({
    showSupportBadge: z.boolean().optional().describe('Whether to show support badge'),
    hideBuyButtonUntil: z.string().optional().describe('Date until which to hide buy button'),
  })
  .optional()
  .meta({ id: 'PurchaseUpdate' });

const TrashUpdateSchema = z
  .object({
    reuploadUntil: z
      .string()
      .optional()
      .describe(
        'Until when uploading a photo that is in the Trash brings it back instead of reporting a duplicate (empty to turn off; at most 24 hours ahead)',
      ),
  })
  .optional()
  .meta({ id: 'TrashPreferencesUpdate' });

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

const LockedPinUpdateSchema = z
  .object({
    relockMinutes: z
      .int()
      .min(5)
      .max(60)
      .refine((minutes) => [5, 15, 60].includes(minutes), { message: 'relockMinutes must be 5, 15 or 60' })
      .optional()
      .describe('How long Locked photos stay open after the PIN unlocks them: 5, 15 or 60 minutes'),
  })
  .optional()
  .describe('Locked PIN preferences (FL-517). Only the account itself can change them')
  .meta({ id: 'LockedPinUpdate' });

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

/** FL-541: a draft of the Locked rules, counted before it is saved. */
const LockedRulesDraftSchema = z
  .object({
    tagIds: z.array(z.uuidv4()).max(1000).describe('Tag IDs the draft locks'),
    personIds: z.array(z.uuidv4()).max(1000).describe('Person IDs the draft locks'),
    petIds: z.array(z.uuidv4()).max(1000).describe('Pet IDs the draft locks'),
  })
  .meta({ id: 'LockedRulesDraftDto' });

export class LockedRulesDraftDto extends createZodDto(LockedRulesDraftSchema) {}

const LockedRulesCountResponseSchema = z
  .object({
    photos: z.int().min(0).describe('Your photos the draft would keep Locked'),
    videos: z.int().min(0).describe('Your videos the draft would keep Locked'),
  })
  .meta({ id: 'LockedRulesCountResponseDto' });

export class LockedRulesCountResponseDto extends createZodDto(LockedRulesCountResponseSchema) {}

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
const PetsUpdateSchema = z
  .object({
    sidebarWeb: z.boolean().optional().describe('Whether pets appear in web sidebar'),
  })
  .optional()
  .meta({ id: 'PetsUpdate' });

const LIBRARY_VIEW_GROUPS = new Set(['none', 'day', 'month', 'year']);

/** FL-1398: the Library View menu's choices. Stored only; every client applies them itself. */
const LibraryViewUpdateSchema = z
  .object({
    scrubber: z.boolean().optional().describe('Whether the Timeline shows the year scrubber'),
    crop: z
      .boolean()
      .optional()
      .describe('Whether Browse and Work crop each photo to fill its tile; off shows the whole photo'),
    // validated here, but a plain string in the API like the response's: no enum for a client to pin
    groupBy: z
      .string()
      .refine((value) => LIBRARY_VIEW_GROUPS.has(value), { message: 'groupBy must be none, day, month or year' })
      .optional()
      .describe('How Browse and Work group photos into sections: none, day, month or year'),
    stacksTogether: z
      .boolean()
      .optional()
      .describe('Whether a stack shows as one photo with a count; off shows every photo in it'),
    partnerPhotos: z.boolean().optional().describe('Whether the Library also shows photos a partner shares'),
    archived: z.boolean().optional().describe('Whether the Library also shows archived items'),
    ratings: z.boolean().optional().describe('Whether photos show their rating'),
    favorites: z.boolean().optional().describe('Whether favorite photos show a heart'),
    badges: z.boolean().optional().describe('Whether photos show video length and badges'),
    timelineTime: z.boolean().optional().describe('Timeline: whether photos show the time taken'),
    timelineNames: z.boolean().optional().describe('Timeline: whether photos show the file name'),
    browseTime: z.boolean().optional().describe('Browse: whether photos show the time taken'),
    browseNames: z.boolean().optional().describe('Browse: whether photos show the file name'),
    workTime: z.boolean().optional().describe('Work: whether photos show the time taken'),
    workNames: z.boolean().optional().describe('Work: whether photos show the file name'),
  })
  .optional()
  .describe('Library View menu choices')
  .meta({ id: 'LibraryViewUpdate' });

/** FL-49: limits for saved searches, kept small because every preferences read carries them */
export const SAVED_SEARCH_MAX_COUNT = 50;
export const SAVED_SEARCH_NAME_MAX_LENGTH = 100;
export const SAVED_SEARCH_QUERY_MAX_BYTES = 8192;

const SavedSearchSchema = z
  .object({
    name: z.string().trim().min(1).max(SAVED_SEARCH_NAME_MAX_LENGTH).describe('Name shown in the search palette'),
    query: z
      .record(z.string(), z.unknown())
      .refine((query) => Buffer.byteLength(JSON.stringify(query)) <= SAVED_SEARCH_QUERY_MAX_BYTES, {
        message: `Saved search query must be at most ${SAVED_SEARCH_QUERY_MAX_BYTES} bytes of JSON`,
      })
      .describe('The search body to run, as the client sends it to the search endpoints'),
  })
  .meta({ id: 'SavedSearch' });

const SavedSearchesUpdateSchema = z
  .array(SavedSearchSchema)
  .max(SAVED_SEARCH_MAX_COUNT)
  .refine((items) => new Set(items.map(({ name }) => name.toLocaleLowerCase())).size === items.length, {
    message: 'Saved search names must be unique',
  })
  .optional()
  .describe(
    `Saved searches, replacing the whole list (at most ${SAVED_SEARCH_MAX_COUNT}). Only the account itself can change them`,
  );

const UserPreferencesUpdateSchema = z
  .object({
    notifications: NotificationLocalePreferencesSchema.optional().describe(
      'Origin-server system notification language: account locale and optional session-specific device overrides. Save devices as a whole list with expectedRevision.',
    ),
    albums: AlbumsUpdateSchema,
    avatar: AvatarUpdateSchema,
    cast: CastUpdateSchema,
    download: DownloadUpdateSchema,
    emailNotifications: EmailNotificationsUpdateSchema,
    folders: FoldersUpdateSchema,
    clients: ClientsUpdateSchema,
    memories: MemoriesUpdateSchema,
    people: PeopleUpdateSchema,
    privacy: PrivacyUpdateSchema,
    purchase: PurchaseUpdateSchema,
    trash: TrashUpdateSchema,
    ratings: RatingsUpdateSchema,
    cloudProcessing: CloudProcessingUpdateSchema,
    search: SearchPreferencesUpdateSchema,
    display: DisplayUpdateSchema,
    sharedLinks: SharedLinksUpdateSchema,
    tags: TagsUpdateSchema,
    recentlyAdded: RecentlyAddedUpdateSchema,
    libraryView: LibraryViewUpdateSchema.meta(new HistoryBuilder().added('v3.5.0').getExtensions()),
    pets: PetsUpdateSchema,
    lockedPin: LockedPinUpdateSchema,
    savedSearches: SavedSearchesUpdateSchema.meta(new HistoryBuilder().added('v3.2.0').getExtensions()),
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
    showPartnerAlbums: z.boolean().describe('Whether albums a partner shared appear in the album list'),
    cleanupBannerDismissed: z.boolean().describe('The Magic Albums cleanup banner has been dismissed'),
  })
  .meta({ id: 'AlbumsResponse' });

const FoldersResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether folders are enabled'),
    sidebarWeb: z.boolean().describe('Whether folders appear in web sidebar'),
  })
  .meta({ id: 'FoldersResponse' });

const ClientsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether Clients is in use and shown in the top bar'),
  })
  .meta({ id: 'ClientsResponse' });

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
    suggestInSpaces: z
      .boolean()
      .describe('Whether a shared Space suggests which of my named people appear in it')
      .meta(new HistoryBuilder().added('v3').getExtensions()),
    includeArchived: z
      .boolean()
      .describe(
        "Whether archived photos appear on person pages and count in People. Off by default: People shows only photos on the timeline. Pages and counts follow each viewer's own choice, partners included; clients apply it on the person page by naming no visibility. The featured photo picked automatically for a person follows the person owner's choice",
      )
      .meta(new HistoryBuilder().added('v3.4.0').getExtensions()),
  })
  .meta({ id: 'PeopleResponse' });

const RatingsResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether ratings are enabled'),
  })
  .meta({ id: 'RatingsResponse' });

const CloudProcessingResponseSchema = z
  .object({
    enabled: z.boolean().describe('Whether AI work on your photos may use Frameleaf Cloud (false: only at home)'),
  })
  .meta({ id: 'CloudProcessingResponse' });

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
    newSignIn: z.boolean().optional().describe('Whether to receive email when a new device signs in'),
  })
  .meta({ id: 'EmailNotificationsResponse' });

const DownloadResponseSchema = z
  .object({
    archiveSize: z.int().describe('Maximum archive size in bytes'),
    includeEmbeddedVideos: z.boolean().describe('Whether to include embedded videos in downloads'),
    includeSidecar: z
      .boolean()
      .describe("Whether an archive download puts each photo's details file (XMP sidecar) beside it")
      .meta(new HistoryBuilder().added('v3').getExtensions()),
  })
  .meta({ id: 'DownloadResponse' });

const DisplayPreferencesResponseSchema = z
  .object({
    dateFormat: DateFormatSchema,
    hourCycle: HourCycleSchema,
  })
  .meta({ id: 'DisplayPreferencesResponse' });

const SearchPreferencesResponseSchema = z
  .object({
    includeArchived: z
      .boolean()
      .describe(
        'Whether the search screens show archived photos. Clients apply it by sending a visibility; the server does not change a search that names none',
      ),
    classic: z
      .boolean()
      .describe('FL-918: whether search questions use classic search instead of the Library Assistant'),
  })
  .meta({ id: 'SearchPreferencesResponse' });

const PurchaseResponseSchema = z
  .object({
    showSupportBadge: z.boolean().describe('Whether to show support badge'),
    hideBuyButtonUntil: z.string().describe('Date until which to hide buy button'),
  })
  .meta({ id: 'PurchaseResponse' });

const TrashResponseSchema = z
  .object({
    reuploadUntil: z
      .string()
      .describe('Until when uploading a photo that is in the Trash brings it back (empty when off)'),
  })
  .meta({ id: 'TrashPreferencesResponse' });

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
const PetsResponseSchema = z
  .object({
    sidebarWeb: z.boolean().describe('Whether pets appear in web sidebar'),
  })
  .meta({ id: 'PetsResponse' });

const LibraryViewResponseSchema = z
  .object({
    scrubber: z.boolean().describe('Whether the Timeline shows the year scrubber'),
    crop: z.boolean().describe('Whether Browse and Work crop each photo to fill its tile; off shows the whole photo'),
    // a plain string, not an enum: a response enum can never gain a value without breaking the native apps
    groupBy: z.string().describe('How Browse and Work group photos into sections: none, day, month or year'),
    stacksTogether: z
      .boolean()
      .describe('Whether a stack shows as one photo with a count; off shows every photo in it'),
    partnerPhotos: z.boolean().describe('Whether the Library also shows photos a partner shares'),
    archived: z.boolean().describe('Whether the Library also shows archived items'),
    ratings: z.boolean().describe('Whether photos show their rating'),
    favorites: z.boolean().describe('Whether favorite photos show a heart'),
    badges: z.boolean().describe('Whether photos show video length and badges'),
    timelineTime: z.boolean().describe('Timeline: whether photos show the time taken'),
    timelineNames: z.boolean().describe('Timeline: whether photos show the file name'),
    browseTime: z.boolean().describe('Browse: whether photos show the time taken'),
    browseNames: z.boolean().describe('Browse: whether photos show the file name'),
    workTime: z.boolean().describe('Work: whether photos show the time taken'),
    workNames: z.boolean().describe('Work: whether photos show the file name'),
  })
  .describe('Library View menu choices')
  .meta({ id: 'LibraryViewResponse' });

const LockedPinResponseSchema = z
  .object({
    relockMinutes: z.int().describe('How long Locked photos stay open after the PIN unlocks them, in minutes'),
  })
  .meta({ id: 'LockedPinResponse' });

const UserPreferencesResponseSchema = z
  .object({
    notifications: NotificationLocalePreferencesSchema.optional(),
    albums: AlbumsResponseSchema,
    folders: FoldersResponseSchema,
    // always sent; optional in the schema so clients built before Clients existed keep compiling
    clients: ClientsResponseSchema.optional(),
    memories: MemoriesResponseSchema,
    people: PeopleResponseSchema,
    privacy: PrivacyResponseSchema,
    ratings: RatingsResponseSchema,
    // always sent; optional in the schema so clients built before FL-1484 keep compiling
    cloudProcessing: CloudProcessingResponseSchema.optional(),
    search: SearchPreferencesResponseSchema,
    // always sent; optional in the schema so clients built before FL-783 keep compiling
    display: DisplayPreferencesResponseSchema.optional(),
    sharedLinks: SharedLinksResponseSchema,
    tags: TagsResponseSchema,
    emailNotifications: EmailNotificationsResponseSchema,
    download: DownloadResponseSchema,
    purchase: PurchaseResponseSchema,
    trash: TrashResponseSchema,
    cast: CastResponseSchema,
    recentlyAdded: RecentlyAddedResponseSchema,
    // always sent; optional in the schema so clients built before FL-1398 keep compiling
    libraryView: LibraryViewResponseSchema.optional().meta(new HistoryBuilder().added('v3.5.0').getExtensions()),
    // always sent; optional in the schema so clients built before it existed keep compiling
    pets: PetsResponseSchema.optional(),
    // always sent; optional in the schema so older clients keep compiling (FL-517)
    lockedPin: LockedPinResponseSchema.optional(),
    // always sent; optional in the schema so clients built before FL-49 keep compiling
    savedSearches: z
      .array(SavedSearchSchema)
      .optional()
      .describe(
        'Saved searches (always present). Empty for an administrator, and without any that names a Locked person, pet or tag while the session is locked',
      )
      .meta(new HistoryBuilder().added('v3.2.0').getExtensions()),
    revision: z
      .string()
      .describe(
        'Changes whenever the stored preferences change; send it back as expectedRevision to reject stale saves',
      ),
    lockedRulesRevealed: z
      .boolean()
      .describe(
        "Whether privacy.suppression names the account's Locked people, pets and tags. False when they were blanked (a session that is not unlocked, or an administrator); such rules must never be edited and saved back (FL-67)",
      ),
  })
  .meta({ id: 'UserPreferencesResponseDto' });

export class UserPreferencesUpdateDto extends createZodDto(UserPreferencesUpdateSchema) {}
export class UserPreferencesResponseDto extends createZodDto(UserPreferencesResponseSchema) {}

/**
 * Who a preferences response is for: the account itself in an unlocked session (`self`), the
 * account in a session that is not unlocked (`locked`, FL-67), or an administrator editing it
 * (`admin`). Only `self` sees the account's Locked people, pets and tags; the others see where the
 * rules apply but not what they name (FL-77, FL-67). The revision always covers the stored rules.
 */
export type PreferencesAudience = 'self' | 'locked' | 'admin';

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
      audience === 'self'
        ? preferences.privacy
        : { suppression: { tagIds: [], personIds: [], petIds: [], scope: suppression.scope } },
    savedSearches:
      audience === 'admin'
        ? []
        : audience === 'locked'
          ? withoutLockedSavedSearches(preferences.savedSearches, suppression)
          : preferences.savedSearches,
    revision: getPreferencesRevision(preferences),
    lockedRulesRevealed: audience === 'self',
  };
};

/**
 * FL-71 (CC-10): an account's own preference history, the Change history area for accounts that
 * are not administrators (`CommandCenter.jsx` `ChangeHistory`). Values are redacted like the
 * settings history; Locked-content rules and saved searches that name Locked items are recorded
 * only as changed (`protected`), never with their values.
 */
const UserPreferenceHistoryChangeSchema = z
  .object({
    path: z.string().describe('The changed preference, as a dotted path such as memories.enabled'),
    before: z.string().nullable().describe('The value before, JSON encoded; null when protected'),
    after: z.string().nullable().describe('The value after, JSON encoded; null when protected'),
    protected: z.boolean().optional().describe('Changed, but its values are not recorded (Locked content)'),
  })
  .meta({ id: 'UserPreferenceHistoryChangeDto' });

const UserPreferenceHistoryEntrySchema = z
  .object({
    id: z.string().describe('Entry ID'),
    createdAt: z.string().meta({ format: 'date-time' }).describe('When the change was saved'),
    deviceLabel: z.string().nullable().describe('The device that saved it, such as "macOS · Web"'),
    changes: z.array(UserPreferenceHistoryChangeSchema).describe('Every changed preference'),
    omittedChanges: z.int().min(0).describe('Changed preferences left out because the entry reached its limit'),
  })
  .meta({ id: 'UserPreferenceHistoryEntryDto' });

const UserPreferenceHistoryResponseSchema = z
  .object({
    entries: z.array(UserPreferenceHistoryEntrySchema).describe('The newest preference changes first'),
  })
  .meta({ id: 'UserPreferenceHistoryResponseDto' });

export class UserPreferenceHistoryResponseDto extends createZodDto(UserPreferenceHistoryResponseSchema) {}
