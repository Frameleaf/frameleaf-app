import type {
  AlbumResponseDto,
  AlbumUserRole,
  ApiKeyResponseDto,
  AssetResponseDto,
  IntegrityReport,
  JobCreateDto,
  LoginResponseDto,
  PersonResponseDto,
  QueueResponseDto,
  ReleaseEventV1,
  SharedLinkResponseDto,
  AdminConfigDto,
  TagResponseDto,
  UserAdminResponseDto,
} from '@immich/sdk';
import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
import { BaseEventManager } from '$lib/utils/base-event-manager.svelte';
import type { TreeNode } from '$lib/utils/tree-utils';

export type Events = {
  AppInit: [];
  AppNavigate: [];

  AuthLogin: [LoginResponseDto];
  AuthLogout: [];
  AuthUserLoaded: [UserAdminResponseDto];

  LanguageChange: [{ name: string; code: string; rtl?: boolean }];

  ApiKeyCreate: [ApiKeyResponseDto];
  ApiKeyUpdate: [ApiKeyResponseDto];
  ApiKeyDelete: [ApiKeyResponseDto];

  AssetUpdate: [AssetResponseDto];
  AssetsArchive: [string[]];
  AssetsUnarchive: [TimelineAsset[]];
  AssetsUndoArchive: [TimelineAsset[]];
  AssetsDelete: [string[]];
  AssetsMarkNsfw: [string[]];
  AssetEditsApplied: [string];
  AssetsTag: [string[]];

  AlbumAddAssets: [{ assetIds: string[]; albumIds: string[] }];
  AlbumRemoveAssets: [{ assetIds: string[]; albumIds: string[] }];
  AlbumCreate: [AlbumResponseDto];
  AlbumUpdate: [AlbumResponseDto];
  AlbumDelete: [AlbumResponseDto];
  AlbumShare: [];
  AlbumUserUpdate: [{ albumId: string; userId: string; role: AlbumUserRole }];
  AlbumUserDelete: [{ albumId: string; userId: string }];

  /** FL-54: `sharedById` stopped sharing their library with `sharedWithId`, here or elsewhere. */
  PartnerRevoke: [{ sharedById: string; sharedWithId: string }];

  PersonUpdate: [PersonResponseDto];
  PersonThumbnailReady: [{ id: string }];
  PersonAssetDelete: [{ id: string; assetId: string }];
  /**
   * FL-37: faces moved between people (a merge, Fix incorrect match, a face reassigned or removed).
   * `personIds` names the people known to have changed; `removedPersonIds` those that no longer
   * exist (merged away). Listeners re-read the faces and names they show rather than patching them.
   */
  PersonFacesChange: [{ personIds: string[]; removedPersonIds?: string[] }];

  BackupDeleteStatus: [{ filename: string; isDeleting: boolean }];
  BackupDeleted: [{ filename: string }];
  BackupUpload: [{ progress: number; isComplete: boolean }];

  QueueUpdate: [QueueResponseDto];

  SharedLinkCreate: [SharedLinkResponseDto];
  SharedLinkUpdate: [SharedLinkResponseDto];
  SharedLinkDelete: [SharedLinkResponseDto];

  TagCreate: [TagResponseDto];
  TagUpdate: [TagResponseDto];
  TagDelete: [TreeNode];

  UserPinCodeReset: [];
  /** FL-67: the signed-in account created its first PIN. */
  UserPinCodeCreated: [];

  UserAdminCreate: [UserAdminResponseDto];
  UserAdminUpdate: [UserAdminResponseDto];
  UserAdminRestore: [UserAdminResponseDto];
  // soft deleted
  UserAdminDelete: [UserAdminResponseDto];
  // confirmed permanently deleted from server
  UserAdminDeleted: [{ id: string }];

  SessionLocked: [];
  /**
   * FL-34: the server revoked elevated access for this session or account (`on_session_lock`), from
   * this tab or elsewhere. Distinct from `SessionLocked` (this tab's own lock): a non-elevated tab has
   * nothing to give up, so only the session privacy guard acts on it, and only while elevated.
   */
  SessionLockedRemote: [];
  SessionAccessChanged: [{ isElevated: boolean }];
  SessionDelete: [];

  SystemConfigUpdate: [AdminConfigDto];

  IntegrityReportDeleteStatus: [{ type?: IntegrityReport; id?: string; isDeleting: boolean }];
  IntegrityReportDeleted: [{ type?: IntegrityReport; id?: string }];

  JobCreate: [{ dto: JobCreateDto }];

  ReleaseEvent: [ReleaseEventV1];

  WebsocketConnect: [];
};

export const eventManager = new BaseEventManager<Events>();
