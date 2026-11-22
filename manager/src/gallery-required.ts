// FL-1752: what the importer requires of a Noodle Gallery source, for Manager's check before anything is stopped.
//
// A copy of the frozen sources in server/src/immich-import (fixtures, CONTENT_TABLES, verifyReadableStructure), which
// Manager cannot import: it reviews the source before the Frameleaf server image is on the host. Each step is one
// frozen migration ledger, oldest first, holding the migrations and required tables that changed from the step before.
// The server's gallery.spec.ts fails when this differs. This file imports nothing, so that spec can load it.

type RequiredColumns = Record<string, Record<string, string>>;

// prettier-ignore
export const GALLERY_SHAPES: { release: string; migrations: string[]; tables: RequiredColumns }[] = [
  {
    release: "2.0.0",
    migrations: [
      "1744910873969-InitialMigration",
      "1744991379464-AddNotificationsTable",
      "1745244781846-AddUserAvatarColorColumn",
      "1745902563899-AddAssetVisibilityColumn",
      "1746636476623-DropExtraIndexes",
      "1746768490606-AddUserPincode",
      "1746844028242-AddLockedVisibilityEnum",
      "1746987967923-AddPinExpiresAtColumn",
      "1747329504572-AddNewSessionColumns",
      "1747338664832-SessionRename",
      "1747664684909-AddAlbumAuditTables",
      "1749067526135-UserOnboardingDefault",
      "1750107668827-PartnerCreateId",
      "1750189909087-AddAlbumUserCreateFields",
      "1750323941566-UnsetPrewarmDimParameter",
      "1750676477029-AlbumAssetUpdateId",
      "1750694237564-AlbumAssetAuditTable",
      "1750780093818-AddAlbumToAssetDeleteTrigger",
      "1751035357937-MemorySyncChanges",
      "1751304834247-StackSyncChanges",
      "1751924596408-AddOverrides",
      "1752004072340-UpdateIndexOverrides",
      "1752152941084-PeopleAuditTable",
      "1752161055253-RenameGeodataPKConstraint",
      "1752161055254-AddActivityAssetFk",
      "1752169992364-AddIsPendingSyncReset",
      "1752250924342-UserMetadataSync",
      "1752267649968-StandardizeNames",
      "1752759108283-ConvertToAbsolutePaths",
      "1753104909784-AssetFaceUpdateIdAndAuditTable",
      "1753464178233-RenameApiKeyPermissions",
      "1753471866748-AddSharedLinkSlug",
      "1753800911775-ProfileImageCheckpointRemoval",
      "1754389095885-ResetAlbumAssetSync",
      "1756318797207-AssetMetadataTables",
    ],
    tables: {
      user: {"avatarColor":"character varying","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","email":"character varying","id":"uuid","isAdmin":"boolean","name":"character varying","oauthId":"character varying","password":"character varying","pinCode":"character varying","profileChangedAt":"timestamp with time zone","profileImagePath":"character varying","quotaSizeInBytes":"bigint","quotaUsageInBytes":"bigint","shouldChangePassword":"boolean","status":"character varying","storageLabel":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      library: {"createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","exclusionPatterns":"text[]","id":"uuid","importPaths":"text[]","name":"character varying","ownerId":"uuid","refreshedAt":"timestamp with time zone","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset: {"checksum":"bytea","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","deviceAssetId":"character varying","deviceId":"character varying","duplicateId":"uuid","duration":"character varying","encodedVideoPath":"character varying","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","id":"uuid","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","sidecarPath":"character varying","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum"},
      stack: {"createdAt":"timestamp with time zone","id":"uuid","ownerId":"uuid","primaryAssetId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
      person: {"birthDate":"date","color":"character varying","createdAt":"timestamp with time zone","faceAssetId":"uuid","id":"uuid","isFavorite":"boolean","isHidden":"boolean","name":"character varying","ownerId":"uuid","thumbnailPath":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_face: {"assetId":"uuid","boundingBoxX1":"integer","boundingBoxX2":"integer","boundingBoxY1":"integer","boundingBoxY2":"integer","deletedAt":"timestamp with time zone","id":"uuid","imageHeight":"integer","imageWidth":"integer","personId":"uuid","sourceType":"sourcetype","updateId":"uuid","updatedAt":"timestamp with time zone"},
      album: {"albumName":"character varying","albumThumbnailAssetId":"uuid","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","description":"text","id":"uuid","isActivityEnabled":"boolean","order":"character varying","ownerId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
      album_user: {"albumsId":"uuid","createId":"uuid","createdAt":"timestamp with time zone","role":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","usersId":"uuid"},
      album_asset: {"albumsId":"uuid","assetsId":"uuid","createdAt":"timestamp with time zone","updateId":"uuid","updatedAt":"timestamp with time zone"},
      partner: {"createId":"uuid","createdAt":"timestamp with time zone","inTimeline":"boolean","sharedById":"uuid","sharedWithId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
      shared_link: {"albumId":"uuid","allowDownload":"boolean","allowUpload":"boolean","createdAt":"timestamp with time zone","description":"character varying","expiresAt":"timestamp with time zone","id":"uuid","key":"bytea","password":"character varying","showExif":"boolean","slug":"character varying","type":"character varying","userId":"uuid"},
      shared_link_asset: {"assetsId":"uuid","sharedLinksId":"uuid"},
      tag: {"color":"character varying","createdAt":"timestamp with time zone","id":"uuid","parentId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone","userId":"uuid","value":"character varying"},
      tag_closure: {"id_ancestor":"uuid","id_descendant":"uuid"},
      tag_asset: {"assetsId":"uuid","tagsId":"uuid"},
      memory: {"createdAt":"timestamp with time zone","data":"jsonb","deletedAt":"timestamp with time zone","hideAt":"timestamp with time zone","id":"uuid","isSaved":"boolean","memoryAt":"timestamp with time zone","ownerId":"uuid","seenAt":"timestamp with time zone","showAt":"timestamp with time zone","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      memory_asset: {"assetsId":"uuid","createdAt":"timestamp with time zone","memoriesId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
      activity: {"albumId":"uuid","assetId":"uuid","comment":"text","createdAt":"timestamp with time zone","id":"uuid","isLiked":"boolean","updateId":"uuid","updatedAt":"timestamp with time zone","userId":"uuid"},
      user_metadata: {"key":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","userId":"uuid","value":"jsonb"},
      asset_exif: {"assetId":"uuid","autoStackId":"character varying","bitsPerSample":"integer","city":"character varying","colorspace":"character varying","country":"character varying","dateTimeOriginal":"timestamp with time zone","description":"text","exifImageHeight":"integer","exifImageWidth":"integer","exposureTime":"character varying","fNumber":"double precision","fileSizeInByte":"bigint","focalLength":"double precision","fps":"double precision","iso":"integer","latitude":"double precision","lensModel":"character varying","livePhotoCID":"character varying","longitude":"double precision","make":"character varying","model":"character varying","modifyDate":"timestamp with time zone","orientation":"character varying","profileDescription":"character varying","projectionType":"character varying","rating":"integer","state":"character varying","timeZone":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_metadata: {"assetId":"uuid","key":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","value":"jsonb"},
      asset_file: {"assetId":"uuid","createdAt":"timestamp with time zone","id":"uuid","path":"character varying","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      smart_search: {"assetId":"uuid","embedding":"vector(configurable)"},
      face_search: {"embedding":"vector(512)","faceId":"uuid"},
    },
  },
  {
    release: "2.2.0",
    migrations: [
      "1758705774125-CreateAssetOCRTable",
      "1758705789125-CreateOCRSearchTable",
      "1758705804128-UpsertOcrAssetJobStatus",
      "1761078763279-AddAppVersionColumnToSession",
    ],
    tables: {
      asset_ocr: {"assetId":"uuid","boxScore":"real","id":"uuid","text":"text","textScore":"real","x1":"real","x2":"real","x3":"real","x4":"real","y1":"real","y2":"real","y3":"real","y4":"real"},
      ocr_search: {"assetId":"uuid","text":"text"},
    },
  },
  {
    release: "2.3.0",
    migrations: [
      "1761755618862-FixColumnNames",
      "1762297277677-AddPluginAndWorkflowTables",
    ],
    tables: {
      album_user: {"albumId":"uuid","createId":"uuid","createdAt":"timestamp with time zone","role":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","userId":"uuid"},
      album_asset: {"albumId":"uuid","assetId":"uuid","createdAt":"timestamp with time zone","updateId":"uuid","updatedAt":"timestamp with time zone"},
      shared_link_asset: {"assetId":"uuid","sharedLinkId":"uuid"},
      tag_asset: {"assetId":"uuid","tagId":"uuid"},
      memory_asset: {"assetId":"uuid","createdAt":"timestamp with time zone","memoriesId":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
    },
  },
  {
    release: "2.4.0",
    migrations: [
      "1764483051488-OCRBigramsForCJK",
      "1764698859174-SidecarInAssetFile",
      "1764705680041-ChangeWorkflowTableColumnsName",
      "1764957138636-AddLockedPropertiesToAssetExif",
    ],
    tables: {
      asset: {"checksum":"bytea","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","deviceAssetId":"character varying","deviceId":"character varying","duplicateId":"uuid","duration":"character varying","encodedVideoPath":"character varying","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","id":"uuid","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum"},
      asset_exif: {"assetId":"uuid","autoStackId":"character varying","bitsPerSample":"integer","city":"character varying","colorspace":"character varying","country":"character varying","dateTimeOriginal":"timestamp with time zone","description":"text","exifImageHeight":"integer","exifImageWidth":"integer","exposureTime":"character varying","fNumber":"double precision","fileSizeInByte":"bigint","focalLength":"double precision","fps":"double precision","iso":"integer","latitude":"double precision","lensModel":"character varying","livePhotoCID":"character varying","lockedProperties":"character varying[]","longitude":"double precision","make":"character varying","model":"character varying","modifyDate":"timestamp with time zone","orientation":"character varying","profileDescription":"character varying","projectionType":"character varying","rating":"integer","state":"character varying","timeZone":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
    },
  },
  {
    release: "2.5.0",
    migrations: [
      "1768336661963-AddAssetWidthHeight",
      "1768336671610-CreateAssetEditTable",
      "1768336694315-CreateIsVisibleColumns",
      "1768587436457-AddEditCountToAsset",
      "1768757482271-SwitchToIsEdited",
      "1768828334807-AddIsEditedToAssetFile",
      "1768847456553-AddTagsToExif",
      "1769105700133-AddAssetEditSequence",
      "1769441657564-AddIsProgressiveColumn",
    ],
    tables: {
      asset: {"checksum":"bytea","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","deviceAssetId":"character varying","deviceId":"character varying","duplicateId":"uuid","duration":"character varying","encodedVideoPath":"character varying","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","height":"integer","id":"uuid","isEdited":"boolean","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum","width":"integer"},
      asset_face: {"assetId":"uuid","boundingBoxX1":"integer","boundingBoxX2":"integer","boundingBoxY1":"integer","boundingBoxY2":"integer","deletedAt":"timestamp with time zone","id":"uuid","imageHeight":"integer","imageWidth":"integer","isVisible":"boolean","personId":"uuid","sourceType":"sourcetype","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_exif: {"assetId":"uuid","autoStackId":"character varying","bitsPerSample":"integer","city":"character varying","colorspace":"character varying","country":"character varying","dateTimeOriginal":"timestamp with time zone","description":"text","exifImageHeight":"integer","exifImageWidth":"integer","exposureTime":"character varying","fNumber":"double precision","fileSizeInByte":"bigint","focalLength":"double precision","fps":"double precision","iso":"integer","latitude":"double precision","lensModel":"character varying","livePhotoCID":"character varying","lockedProperties":"character varying[]","longitude":"double precision","make":"character varying","model":"character varying","modifyDate":"timestamp with time zone","orientation":"character varying","profileDescription":"character varying","projectionType":"character varying","rating":"integer","state":"character varying","tags":"character varying[]","timeZone":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_edit: {"action":"character varying","assetId":"uuid","id":"uuid","parameters":"jsonb","sequence":"integer"},
      asset_file: {"assetId":"uuid","createdAt":"timestamp with time zone","id":"uuid","isEdited":"boolean","isProgressive":"boolean","path":"character varying","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_ocr: {"assetId":"uuid","boxScore":"real","id":"uuid","isVisible":"boolean","text":"text","textScore":"real","x1":"real","x2":"real","x3":"real","x4":"real","y1":"real","y2":"real","y3":"real","y4":"real"},
    },
  },
  {
    release: "2.5.2",
    migrations: [
      "1769635093204-DropThumbnailJobStatusColumns",
    ],
    tables: {

    },
  },
  {
    release: "2.6.0",
    migrations: [
      "1771478781948-PeopleSearchIndex",
      "1771535611395-ConvertRating0ToNull",
      "1771639515206-AddIsTransparentColumn",
      "1771873044511-ChangesTokensToBuffers",
      "1771873813973-AssetEditSync",
      "1772121424533-AddAssetExifGistEarthcoord",
      "1772129818245-FixStupidWhiteSpace",
      "1772609167000-UpdateOpusCodecName",
      "1773242919341-EncodedVideoAssetFiles",
    ],
    tables: {
      asset: {"checksum":"bytea","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","deviceAssetId":"character varying","deviceId":"character varying","duplicateId":"uuid","duration":"character varying","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","height":"integer","id":"uuid","isEdited":"boolean","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum","width":"integer"},
      asset_edit: {"action":"character varying","assetId":"uuid","id":"uuid","parameters":"jsonb","sequence":"integer","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_file: {"assetId":"uuid","createdAt":"timestamp with time zone","id":"uuid","isEdited":"boolean","isProgressive":"boolean","isTransparent":"boolean","path":"character varying","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
    },
  },
  {
    release: "2.6.2",
    migrations: [
      "1773956345315-DuplicateSharedLinkAssets",
    ],
    tables: {

    },
  },
  {
    release: "2.6.3",
    migrations: [
      "1774393726320-AssetFaceSyncReset",
    ],
    tables: {

    },
  },
  {
    release: "2.7.0",
    migrations: [
      "1774548649115-AddChecksumAlgorithm.ts",
      "1775165531374-AddPersonNameTrigramIndex",
    ],
    tables: {
      asset: {"checksum":"bytea","checksumAlgorithm":"asset_checksum_algorithm_enum","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","deviceAssetId":"character varying","deviceId":"character varying","duplicateId":"uuid","duration":"character varying","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","height":"integer","id":"uuid","isEdited":"boolean","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum","width":"integer"},
    },
  },
  {
    release: "3.0.0",
    migrations: [
      "1776217577402-DropAuditTable",
      "1776263790468-DropDeviceIdAndDeviceAssetId",
      "1776332807985-SetOAuthAllowInsecureRequests",
      "1776442031775-AddOauthSidToSession",
      "1776792304485-ReconcileSqlToolsUpgradeChanges",
      "1776848612954-MigrateAlbumOwnerIdToAlbumUser",
      "1777415973792-AddVideoStreamTables",
      "1777654048096-CreateAudioVideoTables",
      "1777667825574-ChangeDurationToInteger",
      "1777897107000-PartnerAssetSyncReset",
      "1778614946174-UpdateWorkflowTables",
      "1779806699547-AddPluginTemplates",
      "1780435471692-DeleteMismatchedAssetFaces",
      "1780592070031-ConvertNegativeRatingToNull",
      "1780592071031-AssetOcrSync",
      "1781089983296-CreateIntegrityReportTable",
      "1782414436633-AddPluginMethodAllowedHosts",
    ],
    tables: {
      asset: {"checksum":"bytea","checksumAlgorithm":"asset_checksum_algorithm_enum","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","duplicateId":"uuid","duration":"integer","fileCreatedAt":"timestamp with time zone","fileModifiedAt":"timestamp with time zone","height":"integer","id":"uuid","isEdited":"boolean","isExternal":"boolean","isFavorite":"boolean","isOffline":"boolean","libraryId":"uuid","livePhotoVideoId":"uuid","localDateTime":"timestamp with time zone","originalFileName":"character varying","originalPath":"character varying","ownerId":"uuid","stackId":"uuid","status":"assets_status_enum","thumbhash":"bytea","type":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone","visibility":"asset_visibility_enum","width":"integer"},
      album: {"albumName":"character varying","albumThumbnailAssetId":"uuid","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","description":"text","id":"uuid","isActivityEnabled":"boolean","order":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      album_user: {"albumId":"uuid","createId":"uuid","createdAt":"timestamp with time zone","role":"album_user_role_enum","updateId":"uuid","updatedAt":"timestamp with time zone","userId":"uuid"},
      asset_audio: {"assetId":"uuid","bitrate":"integer","codecName":"text","index":"smallint","profile":"smallint"},
      asset_video: {"assetId":"uuid","bitrate":"integer","codecName":"text","colorMatrix":"smallint","colorPrimaries":"smallint","colorTransfer":"smallint","dvBlSignalCompatibilityId":"smallint","dvLevel":"smallint","dvProfile":"smallint","formatLongName":"text","formatName":"text","frameCount":"integer","index":"smallint","level":"smallint","pixelFormat":"text","profile":"smallint","timeBase":"integer"},
      asset_keyframe: {"accDuration":"integer[]","assetId":"uuid","outputFrames":"integer","ownDuration":"integer[]","packetCount":"integer","pts":"integer[]","totalDuration":"integer"},
      asset_ocr: {"assetId":"uuid","boxScore":"real","id":"uuid","isVisible":"boolean","text":"text","textScore":"real","updateId":"uuid","x1":"real","x2":"real","x3":"real","x4":"real","y1":"real","y2":"real","y3":"real","y4":"real"},
    },
  },
  {
    release: "3.0.3",
    migrations: [
      "1782500000000-RestoreLivePhotoStillVisibility",
    ],
    tables: {

    },
  },
  {
    release: "3.1.0",
    migrations: [
      "1784647658615-AddOAuthBearerTokenToSession",
      "1784836013770-MinFacePreferenceMigration",
    ],
    tables: {

    },
  },
  {
    release: "3.2.0",
    migrations: [
      "1784986754473-ConvertUserPasswordEmptyStringToNull",
      "1784986754474-AlbumDescriptionNullable",
      "1786385711807-AlbumOwnerDeleteTrigger",
      "1786741078327-AddWorkflowLogsTable",
      "1786972746371-AssetOcrUpdatedAtTrigger",
      "1786972746372-AssetOcrSyncReset",
      "1787148183729-ClusterGroups",
      "1787148183730-DeleteMismatchedMemoryAssets",
    ],
    tables: {
      cluster_group: {"createdAt":"timestamp with time zone","id":"uuid","name":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      user: {"avatarColor":"character varying","clusterGroupId":"uuid","createdAt":"timestamp with time zone","deletedAt":"timestamp with time zone","email":"character varying","id":"uuid","isAdmin":"boolean","name":"character varying","oauthId":"character varying","password":"character varying","pinCode":"character varying","profileChangedAt":"timestamp with time zone","profileImagePath":"character varying","quotaSizeInBytes":"bigint","quotaUsageInBytes":"bigint","shouldChangePassword":"boolean","status":"character varying","storageLabel":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      person_group: {"clusterGroupId":"uuid","createId":"uuid","createdAt":"timestamp with time zone","id":"uuid","updateId":"uuid","updatedAt":"timestamp with time zone"},
      person: {"birthDate":"date","color":"character varying","createdAt":"timestamp with time zone","faceAssetId":"uuid","isFavorite":"boolean","isHidden":"boolean","name":"character varying","ownerId":"uuid","personGroupId":"uuid","thumbnailPath":"character varying","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_face: {"assetId":"uuid","boundingBoxX1":"integer","boundingBoxX2":"integer","boundingBoxY1":"integer","boundingBoxY2":"integer","deletedAt":"timestamp with time zone","id":"uuid","imageHeight":"integer","imageWidth":"integer","isVisible":"boolean","personGroupId":"uuid","sourceType":"sourcetype","updateId":"uuid","updatedAt":"timestamp with time zone"},
      asset_ocr: {"assetId":"uuid","boxScore":"real","id":"uuid","isVisible":"boolean","text":"text","textScore":"real","updateId":"uuid","updatedAt":"timestamp with time zone","x1":"real","x2":"real","x3":"real","x4":"real","y1":"real","y2":"real","y3":"real","y4":"real"},
    },
  },
];

/** The importer's comparison of a column type: a CLIP dimension is configurable and the schema prefix is ignored. */
export const galleryColumnType = (table: string, column: string, type: string): string =>
  table === 'smart_search' && column === 'embedding' && /^(?:(?:public|vectors)\.)?vector\([1-9]\d*\)$/u.test(type)
    ? 'vector(configurable)'
    : type.replace(/^(?:public|vectors)\./u, '');

/** The columns required of a source with this ledger: those of the newest frozen release it fully contains. */
export const galleryRequiredColumns = (ledger: readonly string[]): RequiredColumns | undefined => {
  const names = new Set(ledger);
  const migrations: string[] = [];
  let tables: RequiredColumns = {};
  let required: RequiredColumns | undefined;
  for (const step of GALLERY_SHAPES) {
    migrations.push(...step.migrations);
    tables = { ...tables, ...step.tables };
    if (migrations.every((name) => names.has(name))) required = tables;
  }
  return required;
};

/** Every table any frozen release requires. */
export const GALLERY_REQUIRED_TABLES = [...new Set(GALLERY_SHAPES.flatMap((step) => Object.keys(step.tables)))];
