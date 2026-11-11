import {
  AssetOrder,
  DisplayDateFormat,
  DisplayHourCycle,
  SuppressionScope,
  type UserPreferencesResponseDto,
} from '@frameleaf/sdk';
import { Sync } from 'factory.ts';

export const preferencesFactory = Sync.makeFactory<UserPreferencesResponseDto>({
  albums: {
    defaultAssetOrder: AssetOrder.Desc,
    showPartnerAlbums: true,
    cleanupBannerDismissed: false,
  },
  cast: {
    adminDisabled: false,
    gCastEnabled: false,
  },
  download: {
    archiveSize: 0,
    includeEmbeddedVideos: false,
    includeSidecar: true,
  },
  emailNotifications: {
    albumInvite: false,
    albumUpdate: false,
    enabled: false,
  },
  folders: {
    enabled: false,
    sidebarWeb: false,
  },
  memories: {
    enabled: false,
    duration: 5,
    sidebarWeb: false,
  },
  people: {
    enabled: false,
    sidebarWeb: false,
    suggestInSpaces: false,
    includeArchived: false,
  },
  search: {
    includeArchived: false,
    classic: false,
  },
  display: {
    dateFormat: DisplayDateFormat.Auto,
    hourCycle: DisplayHourCycle.Auto,
  },
  privacy: {
    suppression: {
      personIds: [],
      petIds: [],
      scope: SuppressionScope.Owned,
      tagIds: [],
    },
  },
  purchase: {
    hideBuyButtonUntil: '',
    showSupportBadge: false,
  },
  trash: {
    reuploadUntil: '',
  },
  ratings: {
    enabled: false,
  },
  sharedLinks: {
    enabled: false,
    sidebarWeb: false,
  },
  tags: {
    enabled: false,
    sidebarWeb: false,
  },
  recentlyAdded: {
    sidebarWeb: false,
  },
  pets: {
    sidebarWeb: true,
  },
  revision: 'revision-1',
  lockedRulesRevealed: true,
});
