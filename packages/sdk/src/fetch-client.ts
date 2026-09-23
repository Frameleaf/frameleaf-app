/**
 * Immich
 * 3.2.0
 * DO NOT MODIFY - This file has been generated using oazapfts.
 * See https://www.npmjs.com/package/oazapfts
 */
import * as Oazapfts from "@oazapfts/runtime";
import * as QS from "@oazapfts/runtime/query";
export const defaults: Oazapfts.Defaults<Oazapfts.CustomHeaders> = {
    headers: {},
    baseUrl: "/api"
};
const oazapfts = Oazapfts.runtime(defaults);
export const servers = {
    server1: "/api"
};
export type UserResponseDto = {
    avatarColor: UserAvatarColor;
    /** User email */
    email: string;
    /** User ID */
    id: string;
    /** User name */
    name: string;
    /** Profile change date */
    profileChangedAt: string;
    /** Profile image path */
    profileImagePath: string;
};
export type ActivityResponseDto = {
    /** Asset ID (if activity is for an asset) */
    assetId: string | null;
    /** Comment text (for comment activities) */
    comment?: string | null;
    /** Creation date */
    createdAt: string;
    /** Activity ID */
    id: string;
    "type": ReactionType;
    user: UserResponseDto;
};
export type ActivityCreateDto = {
    /** Album ID */
    albumId: string;
    /** Asset ID (if activity is for an asset) */
    assetId?: string;
    /** Comment text (required if type is comment) */
    comment?: string;
    "type": ReactionType;
};
export type ActivityStatisticsResponseDto = {
    /** Number of comments */
    comments: number;
    /** Number of likes */
    likes: number;
};
export type AdminConfigDatabaseBackupDto = {
    /** Cron expression */
    cronExpression: string;
    /** Enabled */
    enabled: boolean;
    /** Keep last amount */
    keepLastAmount: number;
};
export type AdminConfigBackupsDto = {
    database: AdminConfigDatabaseBackupDto;
};
export type AdminConfigFFmpegRealtimeDto = {
    /** Enable real-time HLS transcoding (alpha) */
    enabled: boolean;
    /** Resolutions to use for real-time HLS transcoding */
    resolutions: HlsVideoResolution[];
    /** Video codecs to use for real-time HLS transcoding */
    videoCodecs: VideoCodec[];
};
export type AdminConfigFFmpegDto = {
    accel: TranscodeHWAccel;
    /** Accelerated decode */
    accelDecode: boolean;
    /** Accepted audio codecs */
    acceptedAudioCodecs: AudioCodec[];
    /** Accepted containers */
    acceptedContainers: VideoContainer[];
    /** Accepted video codecs */
    acceptedVideoCodecs: VideoCodec[];
    /** B-frames */
    bframes: number;
    cqMode: CQMode;
    /** CRF */
    crf: number;
    /** GOP size */
    gopSize: number;
    /** Max bitrate */
    maxBitrate: string;
    /** Preferred hardware device */
    preferredHwDevice: string;
    /** Preset */
    preset: string;
    realtime: AdminConfigFFmpegRealtimeDto;
    /** References */
    refs: number;
    targetAudioCodec: AudioCodec;
    /** Target resolution */
    targetResolution: string;
    targetVideoCodec: VideoCodec;
    /** Temporal AQ */
    temporalAQ: boolean;
    /** Threads */
    threads: number;
    tonemap: ToneMapping;
    transcode: TranscodePolicy;
    /** Two pass */
    twoPass: boolean;
};
export type AdminConfigEnhancedRawImageDto = {
    /** Enhanced RAW rendering */
    enabled: boolean;
};
export type AdminConfigGeneratedFullsizeImageDto = {
    /** Enabled */
    enabled: boolean;
    format: ImageFormat;
    /** Progressive */
    progressive?: boolean;
    /** Quality */
    quality: number;
};
export type AdminConfigGeneratedImageDto = {
    format: ImageFormat;
    /** Progressive */
    progressive?: boolean;
    /** Quality */
    quality: number;
    /** Size */
    size: number;
};
export type AdminConfigImageDto = {
    colorspace: Colorspace;
    enhancedRaw?: AdminConfigEnhancedRawImageDto;
    /** Extract embedded */
    extractEmbedded: boolean;
    fullsize: AdminConfigGeneratedFullsizeImageDto;
    preview: AdminConfigGeneratedImageDto;
    thumbnail: AdminConfigGeneratedImageDto;
};
export type AdminConfigIntegrityChecksumJobDto = {
    /** Cron expression for when the integrity check should run */
    cronExpression: string;
    /** Enabled */
    enabled: boolean;
    /** Percentage limit of the integrity checksum job */
    percentageLimit: number;
    /** How long the integrity checksum job may run for */
    timeLimit: number;
};
export type AdminConfigIntegrityJobDto = {
    /** Cron expression for when the integrity check should run */
    cronExpression: string;
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigIntegrityChecksDto = {
    checksumFiles: AdminConfigIntegrityChecksumJobDto;
    missingFiles: AdminConfigIntegrityJobDto;
    untrackedFiles: AdminConfigIntegrityJobDto;
};
export type AdminConfigJobSettingsDto = {
    /** Concurrency */
    concurrency: number;
};
export type AdminConfigForkJobSettingsDto = {
    /** Concurrency */
    concurrency: number;
};
export type AdminConfigJobDto = {
    backgroundTask: AdminConfigJobSettingsDto;
    editor: AdminConfigJobSettingsDto;
    faceDetection: AdminConfigJobSettingsDto;
    imageDescription?: AdminConfigForkJobSettingsDto;
    imageEnrichment?: AdminConfigForkJobSettingsDto;
    integrityCheck: AdminConfigJobSettingsDto;
    library: AdminConfigJobSettingsDto;
    mediaHealth?: AdminConfigForkJobSettingsDto;
    metadataExtraction: AdminConfigJobSettingsDto;
    migration: AdminConfigJobSettingsDto;
    notifications: AdminConfigJobSettingsDto;
    nsfwDetection?: AdminConfigForkJobSettingsDto;
    ocr: AdminConfigJobSettingsDto;
    search: AdminConfigJobSettingsDto;
    sidecar: AdminConfigJobSettingsDto;
    smartSearch: AdminConfigJobSettingsDto;
    thumbnailGeneration: AdminConfigJobSettingsDto;
    videoConversion: AdminConfigJobSettingsDto;
    videoDuplicateDetection: AdminConfigJobSettingsDto;
    workflow: AdminConfigJobSettingsDto;
};
export type AdminConfigLibraryScanDto = {
    /** Cron expression */
    cronExpression: string;
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigLibraryWatchDto = {
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigLibraryDto = {
    scan: AdminConfigLibraryScanDto;
    watch: AdminConfigLibraryWatchDto;
};
export type AdminConfigAskSearchDto = {
    /** Enable local Ask Photos-style search */
    enabled: boolean;
    /** Maximum number of Ask Search results */
    maxResults: number;
};
export type AdminConfigLocalFeaturesDto = {
    askSearch: AdminConfigAskSearchDto;
};
export type AdminConfigLoggingDto = {
    /** Enabled */
    enabled: boolean;
    level: LogLevel;
};
export type AdminConfigMachineLearningAvailabilityChecksDto = {
    /** Enabled */
    enabled: boolean;
    interval: number;
    timeout: number;
};
export type AdminConfigZeroShotTaggingDto = {
    /** Whether zero-shot auto-tagging is enabled */
    enabled: boolean;
    /** Maximum number of zero-shot tags applied per asset */
    maxTags: number;
    /** Cosine similarity above which a label is applied as a tag */
    minSimilarity: number;
};
export type AdminConfigClipDto = {
    /** Whether the task is enabled */
    enabled: boolean;
    /** Name of the model to use */
    modelName: string;
    zeroShotTagging: AdminConfigZeroShotTaggingDto;
};
export type AdminConfigDuplicateDetectionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
    enhancedVideo: {
        /** Whether enhanced video duplicate detection is enabled */
        enabled: boolean;
        /** Number of video frames to sample for duplicate confirmation */
        frameCount: number;
        /** Maximum distance threshold for enhanced video duplicate frame matching */
        maxDistance: number;
        /** Minimum matching sampled frames required to confirm a video duplicate */
        minMatchingFrames: number;
    };
    /** Maximum distance threshold for duplicate detection */
    maxDistance: number;
    /** When suggesting which duplicate to keep, prefer native camera originals (RAW, then HEIC/HEIF) over re-encoded formats such as JPG, regardless of file size */
    preferOriginalFormat: boolean;
};
export type AdminConfigFacialRecognitionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
    /** Maximum distance threshold for face recognition */
    maxDistance: number;
    /** Minimum number of faces required for recognition */
    minFaces: number;
    /** Minimum confidence score for face detection */
    minScore: number;
    /** Name of the model to use */
    modelName: string;
};
export type AdminConfigAdvancedPromptDto = {
    /** Use a raw prompt template instead of the structured fields */
    enabled?: boolean;
    /** Whether missing {schema} placeholder fails save (strict) or warns (warn) */
    placeholderValidation?: PlaceholderValidation;
    /** Raw prompt template with {names}, {schema}, {vocabulary}, {style_hint} placeholders */
    rawPromptTemplate?: string;
};
export type AdminConfigIdentityInjectionDto = {
    /** Inject named-face data into description prompts */
    enabled?: boolean;
    /** Maximum named persons to inject into a single prompt */
    maxNames?: number;
    /** Minimum face-recognition confidence required to inject a name */
    minFaceConfidence?: number;
};
export type AdminConfigImageDescriptionPromptDto = {
    /** Advanced raw-prompt-editor configuration */
    advanced?: AdminConfigAdvancedPromptDto;
    /** Free-form additional natural-language instructions appended to the description prompt. Example: "If you see a car, identify the make and model. If people are playing a sport, name the sport." */
    customInstructions?: string;
    /** Tag values the model should prefer when applicable */
    customVocabulary?: string[];
    /** Categories the model must not infer (diagnoses, medications, etc.) */
    forbiddenInferences?: string[];
    /** Named-face injection configuration */
    identityInjection?: AdminConfigIdentityInjectionDto;
    /** Additional categories the model should note when visibly supported (brands, sports equipment, etc.) */
    lookFor?: string[];
    /** Allow-list of medical indicator terms permitted in the description */
    medicalIndicators?: string[];
    /** Allow-list of explicit NSFW indicator terms permitted in the description */
    nsfwIndicators?: string[];
    /** Target number of sentences in the description */
    sentenceCountTarget?: number;
    /** Description verbosity preset */
    style?: Style;
};
export type AdminConfigImageDescriptionDto = {
    /** Hardware acceleration backend to use */
    acceleration?: MachineLearningHardwareAcceleration;
    /** Hardware device to use */
    device: string;
    /** Whether the task is enabled */
    enabled: boolean;
    /** Name of the fallback model to use */
    fallbackModelName: string;
    /** ISO timestamp of the last meaningful imageDescription config change. Set server-side; ignored on inbound writes (server is the source of truth). */
    lastConfigChangeAt?: string | null;
    /** Name of the model to use */
    modelName: string;
    /** ISO timestamp set when an admin defers a re-queue from the cost modal. Cleared when the re-queue actually dispatches. Drives the persistent "re-queue pending" banner. */
    pendingRequeueAt?: string | null;
    prompt?: AdminConfigImageDescriptionPromptDto;
};
export type AdminConfigNsfwDetectionDto = {
    /** Hardware device to use */
    device: string;
    /** Whether the task is enabled */
    enabled: boolean;
    /** Hide NSFW assets from library views unless the session has PIN-elevated access */
    hideFromLibrary: boolean;
    /** Name of the model to use */
    modelName: string;
    /** Minimum score required to mark an image as NSFW */
    threshold: number;
};
export type AdminConfigOcrDto = {
    /** Whether the task is enabled */
    enabled: boolean;
    /** Maximum resolution for OCR processing */
    maxResolution: number;
    /** Minimum confidence score for text detection */
    minDetectionScore: number;
    /** Minimum confidence score for text recognition */
    minRecognitionScore: number;
    /** Name of the model to use */
    modelName: string;
};
export type AdminConfigRunPodServerlessDto = {
    /** Max time per request (ms) */
    executionTimeoutMs: number;
    /** Ranked GPU pool IDs the endpoint can use (cheapest first). At least one required. */
    gpuTypeIds: string[];
    /** Seconds before an idle worker scales down */
    idleTimeoutSeconds: number;
    /** Worker autoscaler strategy */
    scalerType: ScalerType;
    /** Scaler threshold (queue seconds or request count) */
    scalerValue: number;
    /** Max concurrent workers */
    workersMax: number;
    /** Always-warm workers (0 = scale to zero) */
    workersMin: number;
};
export type AdminConfigRunPodDto = {
    /** RunPod API key (write-only; empty preserves the existing key) */
    apiKey: string;
    /** Read-only indicator that a key is currently stored. Set by the server; ignored on write. */
    apiKeyConfigured?: boolean;
    /** Auto-run ML backfill on pod ready (Pod mode) */
    autoBackfillOnLaunch: boolean;
    /** Auto-stop when idle (Pod mode) */
    autoStopEnabled: boolean;
    /** Idle minutes before auto-stop (Pod mode) */
    autoStopGraceMinutes: number;
    /** Container disk size (GB) (Pod mode) */
    containerDiskGb: number;
    /** User accepted that image previews leave the network */
    dataPrivacyAcknowledged: boolean;
    /** Preferred GPU type ID (Pod mode) */
    defaultGpuTypeId: string;
    /** Enabled */
    enabled: boolean;
    /** HuggingFace token forwarded to worker as HF_TOKEN (write-only; empty preserves the existing token) */
    hfToken?: string;
    /** Read-only indicator that an HF token is currently stored. Set by the server; ignored on write. */
    hfTokenConfigured?: boolean;
    /** Container image to launch */
    imageName: string;
    /** Hard runtime ceiling (hours) (Pod mode) */
    maxRuntimeHours: number;
    /** disabled = off, pod = manually launched dedicated GPU, serverless = auto-managed scale-to-zero endpoint. Optional for back-compat with legacy clients. */
    mode?: Mode;
    /** How long to wait for the pod to reach RUNNING + healthy /ping before giving up (Pod mode) */
    provisionTimeoutMinutes?: number;
    serverless?: AdminConfigRunPodServerlessDto;
    /** Persistent volume size (GB) (Pod mode) */
    volumeGb: number;
};
export type AdminConfigMachineLearningDto = {
    availabilityChecks: AdminConfigMachineLearningAvailabilityChecksDto;
    clip: AdminConfigClipDto;
    duplicateDetection: AdminConfigDuplicateDetectionDto;
    /** Enabled */
    enabled: boolean;
    facialRecognition: AdminConfigFacialRecognitionDto;
    imageDescription?: AdminConfigImageDescriptionDto;
    nsfwDetection?: AdminConfigNsfwDetectionDto;
    ocr: AdminConfigOcrDto;
    runpod?: AdminConfigRunPodDto;
    /** ML service URLs */
    urls: string[];
};
export type AdminConfigMapDto = {
    /** Dark map style URL */
    darkStyle: string;
    /** Enabled */
    enabled: boolean;
    /** Light map style URL */
    lightStyle: string;
};
export type AdminConfigFacesDto = {
    /** Import */
    "import": boolean;
};
export type AdminConfigMetadataDto = {
    faces: AdminConfigFacesDto;
};
export type AdminConfigNewVersionCheckDto = {
    channel: ReleaseChannel;
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigNightlyTasksDto = {
    /** Cluster new faces */
    clusterNewFaces: boolean;
    /** Database cleanup */
    databaseCleanup: boolean;
    /** Generate memories */
    generateMemories: boolean;
    /** Missing thumbnails */
    missingThumbnails: boolean;
    /** Start time (HH:MM) */
    startTime: string;
    /** Sync quota usage */
    syncQuotaUsage: boolean;
};
export type AdminConfigSmtpTransportDto = {
    /** SMTP server hostname */
    host: string;
    /** Whether to ignore SSL certificate errors */
    ignoreCert: boolean;
    /** SMTP password */
    password: string;
    /** SMTP server port */
    port: number;
    /** Whether to use secure connection (TLS/SSL) */
    secure: boolean;
    /** SMTP username */
    username: string;
};
export type AdminConfigSmtpDto = {
    /** Whether SMTP email notifications are enabled */
    enabled: boolean;
    /** Email address to send from */
    "from": string;
    /** Email address for replies */
    replyTo: string;
    transport: AdminConfigSmtpTransportDto;
};
export type AdminConfigNotificationsDto = {
    smtp: AdminConfigSmtpDto;
};
export type AdminConfigOAuthDto = {
    /** Account management URL */
    accountManagementUrl?: string;
    /** Allow insecure requests */
    allowInsecureRequests: boolean;
    /** Auto launch */
    autoLaunch: boolean;
    /** Auto register */
    autoRegister: boolean;
    /** Button text */
    buttonText: string;
    /** Client ID */
    clientId: string;
    /** Client secret */
    clientSecret: string;
    /** Default storage quota */
    defaultStorageQuota: number | null;
    /** Enabled */
    enabled: boolean;
    /** End session endpoint */
    endSessionEndpoint: string;
    /** Issuer URL */
    issuerUrl: string;
    /** Mobile override enabled */
    mobileOverrideEnabled: boolean;
    /** Mobile redirect URI (set to empty string to disable) */
    mobileRedirectUri: string;
    /** Profile signing algorithm */
    profileSigningAlgorithm: string;
    /** OAuth prompt parameter (e.g. select_account, login, consent) */
    prompt: string;
    /** Role claim */
    roleClaim: string;
    /** Scope */
    scope: string;
    /** Signing algorithm */
    signingAlgorithm: string;
    /** Storage label claim */
    storageLabelClaim: string;
    /** Storage quota claim */
    storageQuotaClaim: string;
    /** Timeout */
    timeout: number;
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod;
};
export type AdminConfigPasswordLoginDto = {
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigPhysicalDeduplicationDto = {
    /** Enabled */
    enabled: boolean;
    /** Master user ID */
    masterUserId: string | null;
};
export type AdminConfigReverseGeocodingDto = {
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigServerDto = {
    /** External domain */
    externalDomain: string;
    /** Login page message */
    loginPageMessage: string;
    /** Public users */
    publicUsers: boolean;
};
export type AdminConfigSmartAlbumKindDto = {
    /** CLIP query phrases used when no tag trigger matches */
    clipQueries: string[];
    /** Whether this smart album is active */
    enabled: boolean;
    /** User-visible album name */
    name: string;
    /** Tags that mark an asset as belonging to this album */
    tagTriggers: string[];
    /** CLIP similarity threshold */
    threshold: number;
};
export type AdminConfigSmartAlbumBuiltInDto = {
    documents: AdminConfigSmartAlbumKindDto;
    food: AdminConfigSmartAlbumKindDto;
    nature: AdminConfigSmartAlbumKindDto;
    pets: AdminConfigSmartAlbumKindDto;
    screenshots: AdminConfigSmartAlbumKindDto;
    travel: AdminConfigSmartAlbumKindDto;
};
export type AdminConfigSmartAlbumsDto = {
    builtIn: AdminConfigSmartAlbumBuiltInDto;
    /** Master smart-album enabled toggle */
    enabled: boolean;
};
export type AdminConfigStorageTemplateDto = {
    /** Enabled */
    enabled: boolean;
    /** Hash verification enabled */
    hashVerificationEnabled: boolean;
    /** Template */
    template: string;
};
export type AdminConfigTemplateEmailsDto = {
    /** Album invite template */
    albumInviteTemplate: string;
    /** Album update template */
    albumUpdateTemplate: string;
    /** Welcome template */
    welcomeTemplate: string;
};
export type AdminConfigTemplatesDto = {
    email: AdminConfigTemplateEmailsDto;
};
export type AdminConfigThemeDto = {
    /** Custom CSS for theming */
    customCss: string;
};
export type AdminConfigTrashDto = {
    /** Days */
    days: number;
    /** Enabled */
    enabled: boolean;
};
export type AdminConfigUserDto = {
    /** Delete delay */
    deleteDelay: number;
};
export type AdminConfigDto = {
    backup: AdminConfigBackupsDto;
    ffmpeg: AdminConfigFFmpegDto;
    image: AdminConfigImageDto;
    integrityChecks: AdminConfigIntegrityChecksDto;
    job: AdminConfigJobDto;
    library: AdminConfigLibraryDto;
    localFeatures?: AdminConfigLocalFeaturesDto;
    logging: AdminConfigLoggingDto;
    machineLearning: AdminConfigMachineLearningDto;
    map: AdminConfigMapDto;
    metadata: AdminConfigMetadataDto;
    newVersionCheck: AdminConfigNewVersionCheckDto;
    nightlyTasks: AdminConfigNightlyTasksDto;
    notifications: AdminConfigNotificationsDto;
    oauth: AdminConfigOAuthDto;
    passwordLogin: AdminConfigPasswordLoginDto;
    physicalDeduplication?: AdminConfigPhysicalDeduplicationDto;
    reverseGeocoding: AdminConfigReverseGeocodingDto;
    server: AdminConfigServerDto;
    smartAlbums?: AdminConfigSmartAlbumsDto;
    storageTemplate: AdminConfigStorageTemplateDto;
    templates: AdminConfigTemplatesDto;
    theme: AdminConfigThemeDto;
    trash: AdminConfigTrashDto;
    user: AdminConfigUserDto;
};
export type DatabaseBackupDeleteDto = {
    /** Backup filenames to delete */
    backups: string[];
};
export type DatabaseBackupDto = {
    /** Backup filename */
    filename: string;
    /** Backup file size */
    filesize: number;
    /** Backup timezone */
    timezone: string;
};
export type DatabaseBackupListResponseDto = {
    /** List of backups */
    backups: DatabaseBackupDto[];
};
export type DatabaseBackupUploadDto = {
    /** Database backup file */
    file?: Blob;
};
export type IntegrityReportResponseDto = {
    items: {
        /** Integrity report item id */
        id: string;
        /** Integrity report item path */
        path: string;
        "type": IntegrityReport;
    }[];
    nextCursor?: string;
};
export type IntegrityReportSummaryResponseDto = {
    checksum_mismatch: number;
    missing_file: number;
    untracked_file: number;
};
export type SetMaintenanceModeDto = {
    action: MaintenanceAction;
    /** Restore backup filename */
    restoreBackupFilename?: string;
};
export type MaintenanceDetectInstallStorageFolderDto = {
    /** Number of files in the folder */
    files: number;
    folder: StorageFolder;
    /** Whether the folder is readable */
    readable: boolean;
    /** Whether the folder is writable */
    writable: boolean;
};
export type MaintenanceDetectInstallResponseDto = {
    storage: MaintenanceDetectInstallStorageFolderDto[];
};
export type MaintenanceLoginDto = {
    /** Maintenance token */
    token?: string;
};
export type MaintenanceAuthDto = {
    /** Maintenance username */
    username: string;
};
export type MaintenanceStatusResponseDto = {
    action: MaintenanceAction;
    active: boolean;
    error?: string;
    progress?: number;
    task?: string;
};
export type NotificationCreateDto = {
    /** Additional notification data */
    data?: {
        [key: string]: any;
    };
    /** Notification description */
    description?: string | null;
    level?: NotificationLevel;
    /** Date when notification was read */
    readAt?: string | null;
    /** Notification title */
    title: string;
    "type"?: NotificationType;
    /** User ID to send notification to */
    userId: string;
};
export type NotificationDto = {
    /** Creation date */
    createdAt: string;
    /** Additional notification data */
    data?: {
        [key: string]: any;
    };
    /** Notification description */
    description?: string;
    /** Notification ID */
    id: string;
    level: NotificationLevel;
    /** Date when notification was read */
    readAt?: string;
    /** Notification title */
    title: string;
    "type": NotificationType;
};
export type TemplateDto = {
    /** Template name */
    template: string;
};
export type TemplateResponseDto = {
    /** Template HTML content */
    html: string;
    /** Template name */
    name: string;
};
export type TestEmailResponseDto = {
    /** Email message ID */
    messageId: string;
};
export type PhysicalDeduplicationRetainedDto = {
    /** Asset that keeps the original file */
    assetId: string;
    /** Whether the requesting administrator may view this asset and its thumbnail */
    canView: boolean;
    /** Hex-encoded SHA-1 checksum of the original file */
    checksum: string;
    originalFileName: string;
    /** Path of the retained original file */
    originalPath: string;
    /** Owner of the retained asset (the retained account) */
    ownerId: string;
    /** Display name of the retained account */
    ownerName: string;
    /** Assets that would reference this original after the plan is applied */
    referencesAfter: number;
    /** Assets that reference this original before the plan is applied (including the retained asset) */
    referencesBefore: number;
    sizeInBytes: number;
    "type": AssetTypeEnum;
};
export type PhysicalDeduplicationCopyDto = {
    /** Duplicate asset owned by a non-retained account */
    assetId: string;
    /** Whether the requesting administrator may view this asset and its thumbnail */
    canView: boolean;
    /** Hex-encoded SHA-1 checksum of the original file */
    checksum: string;
    /** Whether checksum and byte size match a retained original */
    checksumMatch: boolean;
    decision: PhysicalDeduplicationDecision;
    originalFileName: string;
    /** Path of the duplicate copy on disk */
    originalPath: string;
    ownerId: string;
    /** Display name of the copy owner */
    ownerName: string;
    /** Present when the decision is skip */
    reason: (PhysicalDeduplicationSkipReason) | null;
    /** Retained original this copy matches, if any */
    retainedAssetId: string | null;
    sizeInBytes: number;
    "type": AssetTypeEnum;
};
export type PhysicalDeduplicationPlanDto = {
    copies: PhysicalDeduplicationCopyDto[];
    /** True when more copies were reviewed than the stored preview keeps; totals still cover all of them */
    copiesTruncated: boolean;
    deletedBytes: number;
    eligibleAssets: number;
    linkedAssets: number;
    /** Account whose originals are retained by this plan */
    masterUserId: string;
    /** Display name of the retained account */
    masterUserName: string;
    mode: PhysicalDeduplicationPlanMode;
    /** When the plan was produced */
    ranAt: string;
    reclaimableBytes: number;
    retained: PhysicalDeduplicationRetainedDto[];
    /** When set, only copies owned by this account were reviewed; null means every account */
    scopeUserId: string | null;
    scopeUserName: string | null;
    skippedExternal: number;
    skippedMissingMaster: number;
};
export type PhysicalDeduplicationPreviewResponseDto = {
    /** The saved `physicalDeduplication.enabled` */
    enabled: boolean;
    /** The latest plan, or null when none has run */
    plan: (PhysicalDeduplicationPlanDto) | null;
    /** Whether a deduplication preview or apply job is queued or active */
    running: boolean;
    /** The saved `physicalDeduplication.masterUserId` */
    savedMasterUserId: string | null;
};
export type PhysicalDeduplicationPreviewRequestDto = {
    /** Account to retain originals in for this preview; defaults to the saved master account */
    masterUserId?: string;
    /** Limit the review to copies owned by this account */
    scopeUserId?: string;
};
export type UserLicense = {
    /** Activation date */
    activatedAt: string;
    /** Activation key */
    activationKey: string;
    /** License key (format: /^IM(SV|CL)(-[\dA-Za-z]{4}){8}$/) */
    licenseKey: string;
};
export type UserAdminResponseDto = {
    avatarColor: UserAvatarColor;
    /** Cluster group the user is a member of */
    clusterGroupId: string;
    /** Creation date */
    createdAt: string;
    /** Deletion date */
    deletedAt: string | null;
    /** User email */
    email: string;
    /** User ID */
    id: string;
    /** Is admin user */
    isAdmin: boolean;
    license: (UserLicense) | null;
    /** User name */
    name: string;
    /** OAuth ID */
    oauthId: string;
    /** Profile change date */
    profileChangedAt: string;
    /** Profile image path */
    profileImagePath: string;
    /** Storage quota in bytes */
    quotaSizeInBytes: number | null;
    /** Storage usage in bytes */
    quotaUsageInBytes: number | null;
    /** Require password change on next login */
    shouldChangePassword: boolean;
    status: UserStatus;
    /** Storage label */
    storageLabel: string | null;
    /** Last update date */
    updatedAt: string;
};
export type UserAdminCreateDto = {
    avatarColor?: (UserAvatarColor) | null;
    /** User email */
    email: string;
    /** Grant admin privileges */
    isAdmin?: boolean;
    /** User name */
    name: string;
    /** Send notification email */
    notify?: boolean;
    /** User password */
    password: string;
    /** PIN code */
    pinCode?: string | null;
    /** Storage quota in bytes */
    quotaSizeInBytes?: number | null;
    /** Require password change on next login */
    shouldChangePassword?: boolean;
    /** Storage label */
    storageLabel?: string | null;
};
export type UserAdminDeleteDto = {
    /** Force delete even if user has assets */
    force?: boolean;
};
export type UserAdminUpdateDto = {
    avatarColor?: (UserAvatarColor) | null;
    /** User email */
    email?: string;
    /** Grant admin privileges */
    isAdmin?: boolean;
    /** User name */
    name?: string;
    /** User password */
    password?: string;
    /** PIN code */
    pinCode?: string | null;
    /** Storage quota in bytes */
    quotaSizeInBytes?: number | null;
    /** Require password change on next login */
    shouldChangePassword?: boolean;
    /** Storage label */
    storageLabel?: string | null;
};
export type CalendarHeatmapResponseDto = {
    /** Start date in UTC */
    "from": string;
    series: {
        /** Activity count */
        count: number;
        /** Date in UTC */
        date: string;
    }[];
    /** End date in UTC */
    to: string;
    /** Total activity count over the period */
    totalCount: number;
};
export type AlbumsResponse = {
    defaultAssetOrder: AssetOrder;
};
export type CastResponse = {
    /** Whether an administrator has turned casting off for this user */
    adminDisabled: boolean;
    /** Whether Google Cast is enabled (always false while an administrator has turned casting off) */
    gCastEnabled: boolean;
};
export type DownloadResponse = {
    /** Maximum archive size in bytes */
    archiveSize: number;
    /** Whether to include embedded videos in downloads */
    includeEmbeddedVideos: boolean;
};
export type EmailNotificationsResponse = {
    /** Whether to receive email notifications for album invites */
    albumInvite: boolean;
    /** Whether to receive email notifications for album updates */
    albumUpdate: boolean;
    /** Whether email notifications are enabled */
    enabled: boolean;
};
export type FoldersResponse = {
    /** Whether folders are enabled */
    enabled: boolean;
    /** Whether folders appear in web sidebar */
    sidebarWeb: boolean;
};
export type MemoriesResponse = {
    /** Memory duration in seconds */
    duration: number;
    /** Whether memories are enabled */
    enabled: boolean;
    /** Whether memories appear in web sidebar */
    sidebarWeb: boolean;
};
export type PeopleResponse = {
    /** Whether people are enabled */
    enabled: boolean;
    /** People face threshold */
    minimumFaces?: number;
    /** Whether people appear in web sidebar */
    sidebarWeb: boolean;
};
export type SuppressionResponse = {
    /** Person IDs to suppress from locked browsing sessions */
    personIds: string[];
    /** Pet IDs to suppress from locked browsing sessions */
    petIds: string[];
    /** Whether suppression applies only to owned assets or all visible assets */
    scope: SuppressionScope;
    /** Tag IDs to suppress from locked browsing sessions */
    tagIds: string[];
};
export type PrivacyResponse = {
    suppression: SuppressionResponse;
};
export type PurchaseResponse = {
    /** Date until which to hide buy button */
    hideBuyButtonUntil: string;
    /** Whether to show support badge */
    showSupportBadge: boolean;
};
export type RatingsResponse = {
    /** Whether ratings are enabled */
    enabled: boolean;
};
export type RecentlyAddedResponse = {
    /** Whether the recently added page appears in the web sidebar */
    sidebarWeb: boolean;
};
export type SharedLinksResponse = {
    /** Whether shared links are enabled */
    enabled: boolean;
    /** Whether shared links appear in web sidebar */
    sidebarWeb: boolean;
};
export type TagsResponse = {
    /** Whether tags are enabled */
    enabled: boolean;
    /** Whether tags appear in web sidebar */
    sidebarWeb: boolean;
};
export type UserPreferencesResponseDto = {
    albums: AlbumsResponse;
    cast: CastResponse;
    download: DownloadResponse;
    emailNotifications: EmailNotificationsResponse;
    folders: FoldersResponse;
    memories: MemoriesResponse;
    people: PeopleResponse;
    privacy: PrivacyResponse;
    purchase: PurchaseResponse;
    ratings: RatingsResponse;
    recentlyAdded: RecentlyAddedResponse;
    /** Changes whenever the stored preferences change; send it back as expectedRevision to reject stale saves */
    revision: string;
    sharedLinks: SharedLinksResponse;
    tags: TagsResponse;
};
export type AlbumsUpdate = {
    defaultAssetOrder?: AssetOrder;
};
export type AvatarUpdate = {
    color?: UserAvatarColor;
};
export type CastUpdate = {
    /** Administrator only: turn casting off for this user. Accepted only by the admin user preferences endpoint; ignored when a user updates their own preferences */
    adminDisabled?: boolean;
    /** Whether Google Cast is enabled */
    gCastEnabled?: boolean;
};
export type DownloadUpdate = {
    /** Maximum archive size in bytes */
    archiveSize?: number;
    /** Whether to include embedded videos in downloads */
    includeEmbeddedVideos?: boolean;
};
export type EmailNotificationsUpdate = {
    /** Whether to receive email notifications for album invites */
    albumInvite?: boolean;
    /** Whether to receive email notifications for album updates */
    albumUpdate?: boolean;
    /** Whether email notifications are enabled */
    enabled?: boolean;
};
export type FoldersUpdate = {
    /** Whether folders are enabled */
    enabled?: boolean;
    /** Whether folders appear in web sidebar */
    sidebarWeb?: boolean;
};
export type MemoriesUpdate = {
    /** Memory duration in seconds */
    duration?: number;
    /** Whether memories are enabled */
    enabled?: boolean;
    /** Whether memories appear in web sidebar */
    sidebarWeb?: boolean;
};
export type PeopleUpdate = {
    /** Whether people are enabled */
    enabled?: boolean;
    /** People face threshold */
    minimumFaces?: number;
    /** Whether people appear in web sidebar */
    sidebarWeb?: boolean;
};
export type SuppressionUpdate = {
    /** Person IDs to suppress from locked browsing sessions */
    personIds?: string[];
    /** Pet IDs to suppress from locked browsing sessions */
    petIds?: string[];
    /** Whether suppression applies only to owned assets or all visible assets */
    scope?: SuppressionScope;
    /** Tag IDs to suppress from locked browsing sessions */
    tagIds?: string[];
};
export type PrivacyUpdate = {
    suppression?: SuppressionUpdate;
};
export type PurchaseUpdate = {
    /** Date until which to hide buy button */
    hideBuyButtonUntil?: string;
    /** Whether to show support badge */
    showSupportBadge?: boolean;
};
export type RatingsUpdate = {
    /** Whether ratings are enabled */
    enabled?: boolean;
};
export type RecentlyAddedUpdate = {
    /** Whether the recently added page appears in the web sidebar */
    sidebarWeb?: boolean;
};
export type SharedLinksUpdate = {
    /** Whether shared links are enabled */
    enabled?: boolean;
    /** Whether shared links appear in web sidebar */
    sidebarWeb?: boolean;
};
export type TagsUpdate = {
    /** Whether tags are enabled */
    enabled?: boolean;
    /** Whether tags appear in web sidebar */
    sidebarWeb?: boolean;
};
export type UserPreferencesUpdateDto = {
    albums?: AlbumsUpdate;
    avatar?: AvatarUpdate;
    cast?: CastUpdate;
    download?: DownloadUpdate;
    emailNotifications?: EmailNotificationsUpdate;
    /** The revision these changes were made against. When it no longer matches the stored preferences the update is rejected with 409 and nothing is changed */
    expectedRevision?: string;
    folders?: FoldersUpdate;
    memories?: MemoriesUpdate;
    people?: PeopleUpdate;
    privacy?: PrivacyUpdate;
    purchase?: PurchaseUpdate;
    ratings?: RatingsUpdate;
    recentlyAdded?: RecentlyAddedUpdate;
    sharedLinks?: SharedLinksUpdate;
    tags?: TagsUpdate;
};
export type SessionResponseDto = {
    /** App version */
    appVersion: string | null;
    /** Creation date */
    createdAt: string;
    /** Is current session */
    current: boolean;
    /** Device OS */
    deviceOS: string;
    /** Device type */
    deviceType: string;
    /** Expiration date */
    expiresAt?: string;
    /** Session ID */
    id: string;
    /** Is pending sync reset */
    isPendingSyncReset: boolean;
    /** Last update date */
    updatedAt: string;
};
export type AssetStatsResponseDto = {
    /** Number of images */
    images: number;
    /** Total number of assets */
    total: number;
    /** Number of videos */
    videos: number;
};
export type AlbumUserResponseDto = {
    role: AlbumUserRole;
    user: UserResponseDto;
};
export type ContributorCountResponseDto = {
    /** Number of assets contributed */
    assetCount: number;
    /** User ID */
    userId: string;
};
export type AlbumResponseDto = {
    /** Album name */
    albumName: string;
    /** Thumbnail asset ID */
    albumThumbnailAssetId: string | null;
    /** First entry is always the album owner. Second entry is the auth user, if it differs from the owner. The rest are ordered alphabetically. */
    albumUsers: AlbumUserResponseDto[];
    /** Number of assets */
    assetCount: number;
    contributorCounts?: ContributorCountResponseDto[];
    /** Creation date */
    createdAt: string;
    /** Album description */
    description: string;
    /** End date (latest asset) */
    endDate?: string;
    /** Has shared link */
    hasSharedLink: boolean;
    /** Icon: a Material Design Icons name or legacy key (null = default icon) */
    icon: string | null;
    /** Album ID */
    id: string;
    /** Activity feed enabled */
    isActivityEnabled: boolean;
    /** True when the album is filled by the smart album rules. Only populated by GET /albums/tree. */
    isSmart?: boolean;
    kind: AlbumKind;
    /** Last modified asset timestamp */
    lastModifiedAssetTimestamp?: string;
    order?: AssetOrder;
    /** Collection this album belongs to (null = top-level) */
    parentId: string | null;
    /** Is shared album */
    shared: boolean;
    /** Sibling display position. Lower values appear first. */
    sortOrder: number | null;
    /** Start date (earliest asset) */
    startDate?: string;
    /** Last update date */
    updatedAt: string;
};
export type AlbumUserCreateDto = {
    role: AlbumUserRole;
    /** User ID */
    userId: string;
};
export type CreateAlbumDto = {
    /** Album name */
    albumName: string;
    /** Album users */
    albumUsers?: AlbumUserCreateDto[];
    /** Initial asset IDs */
    assetIds?: string[];
    /** Album description */
    description?: string | null;
    /** Optional icon: any Material Design Icons name (see GET /albums/icons) */
    icon?: string;
    /** What to create: an album (default), a collection of albums or a shared space */
    kind?: AlbumKind;
    /** Collection to create the album inside (omit for top-level). Only albums nest, and only inside a collection. */
    parentId?: string;
};
export type AlbumsAddAssetsDto = {
    /** Album IDs */
    albumIds: string[];
    /** Asset IDs */
    assetIds: string[];
};
export type AlbumsAddAssetsResponseDto = {
    error?: BulkIdErrorReason;
    /** Operation success */
    success: boolean;
};
export type AlbumIconSuggestionResponseDto = {
    /** Human label for search and accessibility */
    label: string;
    /** Material Design Icons name, e.g. mdiCameraOutline */
    name: string;
};
export type AlbumIconGroupResponseDto = {
    /** Suggested icons in this category */
    icons: AlbumIconSuggestionResponseDto[];
    /** Category label */
    label: string;
};
export type AlbumIconCatalogueResponseDto = {
    /** Every valid icon name, sorted */
    names: string[];
    /** Categorised suggested set offered first */
    suggested: AlbumIconGroupResponseDto[];
    /** Material Design Icons catalogue version the names come from */
    version: string;
};
export type AlbumStatisticsResponseDto = {
    /** Number of non-shared albums */
    notShared: number;
    /** Number of owned albums */
    owned: number;
    /** Number of shared albums */
    shared: number;
};
export type AlbumCollectionResponseDto = {
    /** Number of albums inside the collection */
    albumCount: number;
    /** Albums inside the collection, in display order */
    albums: AlbumResponseDto[];
    /** Items in the collection and its albums (sum, not deduplicated) */
    assetCount: number;
    collection: AlbumResponseDto;
};
export type AlbumTreeResponseDto = {
    /** Albums that stand on their own (not inside a visible collection) */
    albums: AlbumResponseDto[];
    /** Collections visible to the user with their albums */
    collections: AlbumCollectionResponseDto[];
    /** Shared spaces, always top level */
    spaces: AlbumResponseDto[];
};
export type UpdateAlbumDto = {
    /** Album name */
    albumName?: string;
    /** Album thumbnail asset ID */
    albumThumbnailAssetId?: string;
    /** Album description */
    description?: string | null;
    /** Icon: any Material Design Icons name (null = clear / use default icon) */
    icon?: string | null;
    /** Enable activity feed */
    isActivityEnabled?: boolean;
    order?: AssetOrder;
    /** Collection to move the album into (null = move to top-level, omit = no change) */
    parentId?: string | null;
    /** Sibling display position. Lower values appear first. Computed by the client as a midpoint. */
    sortOrder?: number;
};
export type BulkIdsDto = {
    /** IDs to process */
    ids: string[];
};
export type BulkIdResponseDto = {
    error?: BulkIdErrorReason;
    errorMessage?: string;
    /** ID */
    id: string;
    /** Whether operation succeeded */
    success: boolean;
};
export type MoveAlbumDto = {
    /** Collection to move the album into, or null to take it out so it stands on its own */
    collectionId: string | null;
};
export type AlbumDescendantCountResponseDto = {
    /** Number of descendant albums (children, grandchildren, etc.) */
    count: number;
};
export type MapMarkerResponseDto = {
    /** City name */
    city: string | null;
    /** Country name */
    country: string | null;
    /** Asset ID */
    id: string;
    /** Latitude */
    lat: number;
    /** Longitude */
    lon: number;
    /** State/Province name */
    state: string | null;
};
export type UpdateAlbumUserDto = {
    role: AlbumUserRole;
};
export type AlbumUserAddDto = {
    /** Album user role */
    role?: AlbumUserRole;
    /** User ID */
    userId: string;
};
export type AddUsersDto = {
    /** Album users to add */
    albumUsers: AlbumUserAddDto[];
};
export type ApiKeyResponseDto = {
    /** Creation date */
    createdAt: string;
    /** API key ID */
    id: string;
    /** API key name */
    name: string;
    /** List of permissions */
    permissions: Permission[];
    /** Last update date */
    updatedAt: string;
};
export type ApiKeyCreateDto = {
    /** API key name */
    name?: string;
    /** List of permissions */
    permissions: Permission[];
};
export type ApiKeyCreateResponseDto = {
    apiKey: ApiKeyResponseDto;
    /** Creation date */
    createdAt: string;
    /** API key ID */
    id: string;
    /** API key name */
    name: string;
    /** List of permissions */
    permissions: Permission[];
    /** API key secret (only shown once) */
    secret: string;
    /** Last update date */
    updatedAt: string;
};
export type ApiKeyUpdateDto = {
    /** API key name */
    name?: string;
    /** List of permissions */
    permissions?: Permission[];
};
export type AssetFileResponseDto = {
    /** Creation date */
    createdAt: string;
    /** Asset file ID */
    id: string;
    /** The file was generated from an edit */
    isEdited: boolean;
    /** The file is a progressively encoded JPEG */
    isProgressive: boolean;
    /** The file is transparent */
    isTransparent: boolean;
    /** File path */
    path: string;
    "type": AssetFileType;
    /** Update date */
    updatedAt: string;
};
export type AssetBulkDeleteDto = {
    /** Force delete even if in use */
    force?: boolean;
    /** IDs to process */
    ids: string[];
};
export type AssetMetadataUpsertItemDto = {
    /** Metadata key */
    key: string;
    /** Metadata value (object) */
    value: {
        [key: string]: any;
    };
};
export type AssetMediaCreateDto = {
    /** Asset file data */
    assetData: Blob;
    /** Duration in milliseconds (for videos) */
    duration?: number;
    /** File creation date */
    fileCreatedAt: string;
    /** File modification date */
    fileModifiedAt: string;
    /** Filename */
    filename?: string;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Live photo video ID */
    livePhotoVideoId?: string;
    /** Asset metadata items */
    metadata?: AssetMetadataUpsertItemDto[];
    /** Sidecar file data */
    sidecarData?: Blob;
    visibility?: AssetVisibility;
};
export type AssetMediaResponseDto = {
    /** Asset media ID */
    id: string;
    status: AssetMediaStatus;
};
export type AssetBulkUpdateDto = {
    /** Original date and time */
    dateTimeOriginal?: string;
    /** Relative time offset in minutes */
    dateTimeRelative?: number;
    /** Asset description */
    description?: string;
    /** Duplicate ID */
    duplicateId?: string | null;
    /** Asset IDs to update */
    ids: string[];
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Latitude coordinate */
    latitude?: number;
    /** Longitude coordinate */
    longitude?: number;
    /** Rating in range [1-5] (starred), -1 (rejected), or null (unrated) */
    rating?: number | null;
    /** Time zone (IANA timezone) */
    timeZone?: string;
    visibility?: AssetVisibility;
};
export type AssetBulkUploadCheckItem = {
    /** Base64 or hex encoded checksum. SHA-256 (32 bytes / 64 hex / 44 base64) for new uploads; SHA-1 (20 bytes / 40 hex / 28 base64) accepted for legacy assets. */
    checksum: string;
    /** Client-side identifier echoed in the response to match results to inputs (e.g. filename) */
    id: string;
};
export type AssetBulkUploadCheckDto = {
    /** Assets to check */
    assets: AssetBulkUploadCheckItem[];
};
export type AssetBulkUploadCheckResult = {
    action: AssetUploadAction;
    /** Existing asset ID if duplicate */
    assetId?: string;
    /** Client-side identifier echoed from the request to match results to inputs */
    id: string;
    /** Whether existing asset is trashed */
    isTrashed?: boolean;
    reason?: AssetRejectReason;
};
export type AssetBulkUploadCheckResponseDto = {
    /** Upload check results */
    results: AssetBulkUploadCheckResult[];
};
export type AssetCopyDto = {
    /** Copy album associations */
    albums?: boolean;
    /** Copy favorite status */
    favorite?: boolean;
    /** Copy shared links */
    sharedLinks?: boolean;
    /** Copy sidecar file */
    sidecar?: boolean;
    /** Source asset ID */
    sourceId: string;
    /** Copy stack association */
    stack?: boolean;
    /** Target asset ID */
    targetId: string;
};
export type AssetJobsDto = {
    /** Asset IDs */
    assetIds: string[];
    name: AssetJobName;
};
export type AssetMetadataBulkDeleteItemDto = {
    /** Asset ID */
    assetId: string;
    /** Metadata key */
    key: string;
};
export type AssetMetadataBulkDeleteDto = {
    /** Metadata items to delete */
    items: AssetMetadataBulkDeleteItemDto[];
};
export type AssetMetadataBulkUpsertItemDto = {
    /** Asset ID */
    assetId: string;
    /** Metadata key */
    key: string;
    /** Metadata value (object) */
    value: {
        [key: string]: any;
    };
};
export type AssetMetadataBulkUpsertDto = {
    /** Metadata items to upsert */
    items: AssetMetadataBulkUpsertItemDto[];
};
export type AssetMetadataBulkResponseDto = {
    /** Asset ID */
    assetId: string;
    /** Metadata key */
    key: string;
    /** Last update date */
    updatedAt: string;
    /** Metadata value (object) */
    value: {
        [key: string]: any;
    };
};
export type ExifResponseDto = {
    /** City name */
    city?: string | null;
    /** Country name */
    country?: string | null;
    /** Original date/time */
    dateTimeOriginal?: string | null;
    /** Image description */
    description?: string | null;
    /** Image height in pixels */
    exifImageHeight?: number | null;
    /** Image width in pixels */
    exifImageWidth?: number | null;
    /** Exposure time */
    exposureTime?: string | null;
    /** F-number (aperture) */
    fNumber?: number | null;
    /** File size in bytes */
    fileSizeInByte?: number | null;
    /** Focal length in mm */
    focalLength?: number | null;
    /** ISO sensitivity */
    iso?: number | null;
    /** GPS latitude */
    latitude?: number | null;
    /** Lens model */
    lensModel?: string | null;
    /** GPS longitude */
    longitude?: number | null;
    /** Camera make */
    make?: string | null;
    /** Camera model */
    model?: string | null;
    /** Modification date/time */
    modifyDate?: string | null;
    /** Image orientation */
    orientation?: string | null;
    /** Projection type */
    projectionType?: string | null;
    /** Rating */
    rating?: number | null;
    /** State/province name */
    state?: string | null;
    /** Time zone */
    timeZone?: string | null;
};
export type PersonResponseDto = {
    /** Person date of birth */
    birthDate: string | null;
    /** Person color (hex) */
    color?: string;
    /** Person ID */
    id: string;
    /** Is favorite */
    isFavorite?: boolean;
    /** Is hidden */
    isHidden: boolean;
    /** Person name */
    name: string;
    /** Thumbnail path */
    thumbnailPath: string;
    /** Last update date */
    updatedAt?: string;
};
export type PersonMergeSuggestionDto = {
    /** Face embedding distance between the two people (lower is more similar) */
    distance: number;
    person: PersonResponseDto;
    suggestion: PersonResponseDto;
};
export type MergeSuggestionsResponseDto = {
    /** Suggested pairs of people that may be the same person */
    suggestions: PersonMergeSuggestionDto[];
};
export type PersonCorrectionDto = {
    /** Asset the corrected face belongs to */
    assetId: string;
    /** When the manual correction was made */
    correctedAt: string;
    /** Face ID */
    faceId: string;
};
export type PersonCorrectionsResponseDto = {
    /** Manual face corrections for this person, most recent first */
    corrections: PersonCorrectionDto[];
};
export type AssetStackResponseDto = {
    /** Number of assets in stack */
    assetCount: number;
    /** Stack ID */
    id: string;
    /** Primary asset ID */
    primaryAssetId: string;
};
export type TagResponseDto = {
    /** Tag color (hex) */
    color?: string;
    /** Creation date */
    createdAt: string;
    /** Tag ID */
    id: string;
    /** Tag name */
    name: string;
    /** Parent tag ID */
    parentId?: string;
    /** Last update date */
    updatedAt: string;
    /** Tag value (full path) */
    value: string;
};
export type AssetResponseDto = {
    /** Base64-encoded file checksum. SHA-256 (44 chars) for assets uploaded after the SHA-256 transition; SHA-1 (28 chars) for legacy assets. Use the asset `checksumAlgorithm` field to disambiguate when length-based detection is insufficient. */
    checksum: string;
    /** The UTC timestamp when the asset was originally uploaded to Immich. */
    createdAt: string;
    /** Duplicate group ID */
    duplicateId?: string | null;
    /** Video/gif duration in milliseconds (null for static images) */
    duration: number | null;
    exifInfo?: ExifResponseDto;
    /** The actual UTC timestamp when the file was created/captured, preserving timezone information. This is the authoritative timestamp for chronological sorting within timeline groups. Combined with timezone data, this can be used to determine the exact moment the photo was taken. */
    fileCreatedAt: string;
    /** The UTC timestamp when the file was last modified on the filesystem. This reflects the last time the physical file was changed, which may be different from when the photo was originally taken. */
    fileModifiedAt: string;
    /** Whether asset has metadata */
    hasMetadata: boolean;
    /** Asset height */
    height: number | null;
    /** Asset ID */
    id: string;
    /** Is archived */
    isArchived: boolean;
    /** Is edited */
    isEdited: boolean;
    /** Is favorite */
    isFavorite: boolean;
    /** Is offline */
    isOffline: boolean;
    /** Is trashed */
    isTrashed: boolean;
    /** Library ID */
    libraryId?: string | null;
    /** Live photo video ID */
    livePhotoVideoId?: string | null;
    /** The local date and time when the photo/video was taken, derived from EXIF metadata. This represents the photographer's local time regardless of timezone, stored as a timezone-agnostic timestamp. Used for timeline grouping by "local" days and months. */
    localDateTime: string;
    /** Original file name */
    originalFileName: string;
    /** Original MIME type */
    originalMimeType?: string;
    /** Original file path */
    originalPath: string;
    owner?: UserResponseDto;
    /** Owner user ID */
    ownerId: string;
    people?: PersonResponseDto[];
    /** Is resized */
    resized?: boolean;
    stack?: (AssetStackResponseDto) | null;
    tags?: TagResponseDto[];
    /** Thumbhash for thumbnail generation (base64) also used as the c query param for thumbnail cache busting. */
    thumbhash: string | null;
    "type": AssetTypeEnum;
    /** The UTC timestamp when the asset record was last updated in the database. This is automatically maintained by the database and reflects when any field in the asset was last modified. */
    updatedAt: string;
    visibility: AssetVisibility;
    /** Asset width */
    width: number | null;
};
export type UpdateAssetDto = {
    /** Original date and time */
    dateTimeOriginal?: string;
    /** Asset description */
    description?: string;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Latitude coordinate */
    latitude?: number;
    /** Live photo video ID */
    livePhotoVideoId?: string | null;
    /** Longitude coordinate */
    longitude?: number;
    /** Rating in range [1-5] (starred), -1 (rejected), or null (unrated) */
    rating?: number | null;
    visibility?: AssetVisibility;
};
export type CropParameters = {
    /** Height of the crop */
    height: number;
    /** Width of the crop */
    width: number;
    /** Top-Left X coordinate of crop */
    x: number;
    /** Top-Left Y coordinate of crop */
    y: number;
};
export type RotateParameters = {
    /** Rotation angle in degrees */
    angle: number;
};
export type MirrorParameters = {
    axis: MirrorAxis;
};
export type TrimParameters = {
    /** Trim end time in milliseconds */
    endMs: number;
    /** Trim start time in milliseconds */
    startMs: number;
};
export type StraightenParameters = {
    /** Straighten angle in degrees */
    angle: number;
};
export type AdjustParameters = {
    blackPoint?: number;
    blueTone?: number;
    brightness?: number;
    contrast?: number;
    hdr?: number;
    highlights?: number;
    saturation?: number;
    shadows?: number;
    skinTone?: number;
    tint?: number;
    vignette?: number;
    warmth?: number;
    whitePoint?: number;
};
export type LookParameters = {
    /** Filter or effect intensity */
    intensity?: number;
    /** Filter or effect name */
    name: string;
};
export type ToggleParameters = {
    enabled?: boolean;
};
export type TextOverlayParameters = {
    /** Text color in hex format */
    color?: string;
    /** Overlay end time in milliseconds */
    endMs?: number;
    /** Font size as a percentage of video height */
    size?: number;
    /** Overlay start time in milliseconds */
    startMs?: number;
    text: string;
    /** Horizontal position as a percentage of video width */
    x: number;
    /** Vertical position as a percentage of video height */
    y: number;
};
export type AudioParameters = {
    muted?: boolean;
    /** Audio volume multiplier */
    volume?: number;
};
export type SpeedParameters = {
    /** Speed segment end time in milliseconds */
    endMs?: number;
    /** Playback speed multiplier */
    rate: number;
    /** Speed segment start time in milliseconds */
    startMs?: number;
};
export type AssetDevelopCrop = {
    /** Crop height as a fraction of the frame */
    h: number;
    /** Crop width as a fraction of the frame */
    w: number;
    /** Left edge of the crop as a fraction of the oriented frame width */
    x: number;
    /** Top edge of the crop as a fraction of the oriented frame height */
    y: number;
};
export type AssetDevelopRecipeDto = {
    /** Black point */
    blacks?: number;
    /** Local contrast in the midtones */
    clarity?: number;
    /** Contrast around middle grey */
    contrast?: number;
    crop?: AssetDevelopCrop;
    /** Haze removal (positive) or addition (negative) */
    dehaze?: number;
    /** Exposure in EV; each whole stop doubles the light */
    exposure?: number;
    /** Mirror left to right */
    flipHorizontal?: boolean;
    /** Mirror top to bottom */
    flipVertical?: boolean;
    /** Film grain amount */
    grain?: number;
    /** Highlight recovery (negative) or lift (positive) */
    highlights?: number;
    /** Luminance noise reduction amount */
    noiseReduction?: number;
    preset?: AssetDevelopPreset;
    /** How much of the preset is applied, as a percentage */
    presetStrength?: number;
    /** Quarter-turn rotation in degrees, clockwise */
    rotation?: number;
    /** Global saturation */
    saturation?: number;
    /** Shadow lift (positive) or deepening (negative) */
    shadows?: number;
    /** Detail sharpening amount */
    sharpen?: number;
    /** Straighten angle in degrees, applied before the crop */
    straighten?: number;
    /** Warm (positive) or cool (negative) white balance shift */
    temperature?: number;
    /** Magenta (positive) or green (negative) tint */
    tint?: number;
    /** Recipe contract version */
    version: 1;
    /** Saturation weighted towards muted colours */
    vibrance?: number;
    /** Darkened (positive) or lightened (negative) edges */
    vignette?: number;
    /** White point */
    whites?: number;
};
export type AssetDevelopRevisionResponseDto = {
    /** Asset this revision belongs to */
    assetId: string;
    /** When the version was saved */
    createdAt: string;
    /** Why the last render failed, when it did */
    error: string | null;
    /** True once the edited master file exists */
    hasMaster: boolean;
    /** True once the preview file exists */
    hasPreview: boolean;
    /** Height of the edited master in pixels */
    height: number | null;
    /** Develop revision ID */
    id: string;
    /** True for the version the asset currently shows */
    isCurrent: boolean;
    /** Name given when the version was saved */
    label: string | null;
    /** Render progress as a percentage */
    progress: number;
    recipe: AssetDevelopRecipeDto;
    /** When the render finished */
    renderedAt: string | null;
    /** Identity of the renderer that produced the files, for lineage */
    rendererVersion: string | null;
    /** Per-asset sequence number, 1 for the first saved version */
    revision: number;
    status: AssetDevelopRevisionStatus;
    /** When the revision last changed */
    updatedAt: string;
    /** Width of the edited master in pixels */
    width: number | null;
};
export type AssetDevelopResponseDto = {
    /** Asset ID these revisions belong to */
    assetId: string;
    /** The revision the asset currently shows; null means the original */
    currentRevisionId: string | null;
    /** Every saved version of the recipe, newest first */
    revisions: AssetDevelopRevisionResponseDto[];
};
export type AssetDevelopSaveDto = {
    /** Optional name for the saved version */
    label?: string;
    recipe: AssetDevelopRecipeDto;
    /** Queue the edited master render immediately after saving the recipe */
    render?: boolean;
};
export type AssetDevelopPreviewDto = {
    recipe: AssetDevelopRecipeDto;
    /** Longest edge of the preview in pixels; the original is never upscaled */
    size?: number;
};
export type AssetDevelopRevertDto = {
    /** Rendered revision to make current again; omitted, the original becomes current */
    revisionId?: string;
};
export type AssetRestorationRegionDto = {
    /** Preview area height as a fraction of the frame */
    h: number;
    /** Video only: where the preview clip starts. Ignored for stills. */
    startSeconds?: number;
    /** Preview area width as a fraction of the frame */
    w: number;
    /** Left edge of the preview area as a fraction of the frame width */
    x: number;
    /** Top edge of the preview area as a fraction of the frame height */
    y: number;
};
export type AssetRestorationRequestDto = {
    /** The processing destination this restoration runs on. Required; never inferred. */
    destinationId: string;
    /** Preserve fine film grain instead of smoothing it */
    keepGrain?: boolean;
    mode: AssetRestorationMode;
    region?: AssetRestorationRegionDto;
    /** Upscale factor. Output is additionally capped at 4K. */
    upscale?: 1 | 2 | 4;
};
export type AssetRestorationEstimateDto = {
    /** Measured upload throughput for this destination and workload, or null with no samples */
    bytesPerSecond: number | null;
    /** Approximate bytes the full render sends */
    fullBytes: number;
    /** Estimated full render time from measured throughput, or null when nothing is measured */
    fullSeconds: number | null;
    /** Approximate bytes the preview sends */
    previewBytes: number;
    /** Estimated preview time from measured throughput, or null when nothing is measured */
    previewSeconds: number | null;
    /** Successful requests the throughput was measured from */
    sampleCount: number;
    /** Length of the measurement window */
    windowDays: number;
};
export type AssetRestorationResponseDto = {
    /** The job currently running for this restoration, for cancel and retry; null when idle */
    activeOperationId: string | null;
    assetId: string;
    createdAt: string;
    /** The bound destination, or null once an administrator removed it */
    destinationId: string | null;
    destinationKind: MlDestinationKind;
    destinationName: string;
    error: string | null;
    estimate: (AssetRestorationEstimateDto) | null;
    /** The durable job that renders the full result */
    fullOperationId: string | null;
    /** Both preview files exist */
    hasPreview: boolean;
    /** The full-resolution result exists */
    hasResult: boolean;
    /** Restoration ID */
    id: string;
    /** The owner chose this result as the asset’s playback version */
    isCurrent: boolean;
    keepGrain: boolean;
    mode: AssetRestorationMode;
    /** Model the adapter reported, for provenance */
    modelName: string | null;
    modelVersion: string | null;
    outputHeight: number | null;
    outputWidth: number | null;
    previewExpiresAt: string | null;
    /** The durable job that rendered the preview */
    previewOperationId: string | null;
    previewReadyAt: string | null;
    previewRegion: AssetRestorationRegionDto;
    restoredAt: string | null;
    resultExpiresAt: string | null;
    reviewedAt: string | null;
    /** Per-asset sequence number, 1 for the first restoration */
    revision: number;
    sourceDurationSeconds: number | null;
    sourceHeight: number;
    sourceType: AssetRestorationSourceType;
    sourceWidth: number;
    status: AssetRestorationStatus;
    updatedAt: string;
    upscale: number;
    workload: MlWorkload;
};
export type AssetRestorationListResponseDto = {
    assetId: string;
    /** The restoration the owner chose as the playback version; null means the original */
    currentRestorationId: string | null;
    /** Every restoration of the asset, newest first */
    items: AssetRestorationResponseDto[];
};
export type AssetRestorationDestinationDto = {
    /** The server would admit this workload on this destination right now */
    available: boolean;
    /** True when no consent is needed or an administrator recorded it */
    consentGranted: boolean;
    consentRequired: boolean;
    estimate: AssetRestorationEstimateDto;
    health: MlDestinationHealth;
    id: string;
    kind: MlDestinationKind;
    /** Media sent to this destination leaves the network */
    leavesNetwork: boolean;
    name: string;
    /** Why the destination cannot be chosen, or null */
    refusal: (MlAdmissionRefusal) | null;
    refusalDetail: string | null;
};
export type AssetRestorationOptionsDto = {
    /** Always true since the restoration adapter ships with the server; whether a model can run is reported per destination. */
    adapterInstalled: boolean;
    assetId: string;
    destinations: AssetRestorationDestinationDto[];
    /** Video length; null for stills */
    durationSeconds: number | null;
    mode: AssetRestorationMode;
    /** Height the full render would produce after the 4K cap */
    outputHeight: number;
    /** Width the full render would produce after the 4K cap */
    outputWidth: number;
    /** Length of a video preview clip; null for stills */
    previewSeconds: number | null;
    sourceHeight: number;
    sourceType: AssetRestorationSourceType;
    sourceWidth: number;
    upscale: number;
    workload: MlWorkload;
};
export type AssetRestorationSelectDto = {
    /** Restored revision to use as the playback version; omitted, the original is used */
    restorationId?: string;
};
export type AssetEditActionItemResponseDto = {
    action: AssetEditAction;
    /** Asset edit ID */
    id: string;
    /** List of edit actions to apply */
    parameters: CropParameters | RotateParameters | MirrorParameters | TrimParameters | StraightenParameters | AdjustParameters | LookParameters | ToggleParameters | TextOverlayParameters | AudioParameters | SpeedParameters;
};
export type AssetEditsResponseDto = {
    /** Asset ID these edits belong to */
    assetId: string;
    /** List of edit actions applied to the asset */
    edits: AssetEditActionItemResponseDto[];
};
export type AssetEditActionItemDto = {
    action: AssetEditAction;
    /** List of edit actions to apply */
    parameters: CropParameters | RotateParameters | MirrorParameters | TrimParameters | StraightenParameters | AdjustParameters | LookParameters | ToggleParameters | TextOverlayParameters | AudioParameters | SpeedParameters;
};
export type AssetEditsCreateDto = {
    /** List of edit actions to apply */
    edits: AssetEditActionItemDto[];
};
export type ImageDescriptionEnrichmentResponseDto = {
    appliedDescription: boolean;
    appliedTags: boolean;
    context?: string;
    description?: string;
    environment?: string;
    error?: string;
    modelName?: string;
    objects?: string[];
    people?: {
        activity: string;
        apparent_age_group: string;
        confidence: string;
        count: number;
    }[];
    /** Machine-readable reason when status === "skipped" */
    skipReason?: string;
    status: Status;
    tags?: string[];
    updatedAt?: string;
    visibleText?: string[];
};
export type ImageEnrichmentReview = {
    action: Action;
    isNsfw: boolean;
    /** Review timestamp */
    reviewedAt: string;
    /** Reviewer user ID */
    reviewedBy: string;
};
export type NsfwDetectionEnrichmentResponseDto = {
    appliedTags: boolean;
    effectiveIsNsfw: boolean;
    error?: string;
    isNsfw?: boolean;
    labels?: {
        [key: string]: number;
    };
    modelName?: string;
    review?: ImageEnrichmentReview;
    score?: number;
    status: Status2;
    updatedAt?: string;
};
export type AssetImageEnrichmentResponseDto = {
    /** Asset ID */
    assetId: string;
    description: ImageDescriptionEnrichmentResponseDto;
    nsfwDetection: NsfwDetectionEnrichmentResponseDto;
};
export type AssetImageEnrichmentActionRequestDto = {
    action: AssetImageEnrichmentAction;
};
export type AssetMetadataResponseDto = {
    /** Metadata key */
    key: string;
    /** Last update date */
    updatedAt: string;
    /** Metadata value (object) */
    value: {
        [key: string]: any;
    };
};
export type AssetMetadataUpsertDto = {
    /** Metadata items to upsert */
    items: AssetMetadataUpsertItemDto[];
};
export type AssetOcrResponseDto = {
    assetId: string;
    /** Confidence score for text detection box */
    boxScore: number;
    id: string;
    /** Recognized text */
    text: string;
    /** Confidence score for text recognition */
    textScore: number;
    /** Normalized x coordinate of box corner 1 (0-1) */
    x1: number;
    /** Normalized x coordinate of box corner 2 (0-1) */
    x2: number;
    /** Normalized x coordinate of box corner 3 (0-1) */
    x3: number;
    /** Normalized x coordinate of box corner 4 (0-1) */
    x4: number;
    /** Normalized y coordinate of box corner 1 (0-1) */
    y1: number;
    /** Normalized y coordinate of box corner 2 (0-1) */
    y2: number;
    /** Normalized y coordinate of box corner 3 (0-1) */
    y3: number;
    /** Normalized y coordinate of box corner 4 (0-1) */
    y4: number;
};
export type SignUpDto = {
    /** User email */
    email: string;
    /** User name */
    name: string;
    /** User password */
    password: string;
};
export type ChangePasswordDto = {
    /** Invalidate all other sessions */
    invalidateSessions?: boolean;
    /** New password (min 8 characters) */
    newPassword: string;
    /** Current password */
    password: string;
};
export type LoginCredentialDto = {
    /** User email */
    email: string;
    /** User password */
    password: string;
};
export type LoginResponseDto = {
    /** Access token */
    accessToken: string;
    /** Is admin user */
    isAdmin: boolean;
    /** Is onboarded */
    isOnboarded: boolean;
    /** User name */
    name: string;
    /** Profile image path */
    profileImagePath: string;
    /** Should change password */
    shouldChangePassword: boolean;
    /** User email */
    userEmail: string;
    /** User ID */
    userId: string;
};
export type LogoutResponseDto = {
    /** Redirect URI */
    redirectUri: string;
    /** Logout successful */
    successful: boolean;
};
export type PinCodeResetDto = {
    /** User password (required if PIN code is not provided) */
    password?: string;
    /** New PIN code (4-6 digits) */
    pinCode?: string;
};
export type PinCodeSetupDto = {
    /** PIN code (4-6 digits) */
    pinCode: string;
};
export type PinCodeChangeDto = {
    /** New PIN code (4-6 digits) */
    newPinCode: string;
    /** User password (required if PIN code is not provided) */
    password?: string;
    /** New PIN code (4-6 digits) */
    pinCode?: string;
};
export type SessionUnlockDto = {
    /** User password (required if PIN code is not provided) */
    password?: string;
    /** New PIN code (4-6 digits) */
    pinCode?: string;
};
export type AuthStatusResponseDto = {
    /** Session expiration date */
    expiresAt?: string;
    /** Is elevated session */
    isElevated: boolean;
    /** Has password set */
    password: boolean;
    /** Has PIN code set */
    pinCode: boolean;
    /** PIN expiration date */
    pinExpiresAt?: string;
};
export type ValidateAccessTokenResponseDto = {
    /** Authentication status */
    authStatus: boolean;
};
export type BestPhotoScoreDto = {
    aestheticScore: number | null;
    bestFrameTimestampMs: number | null;
    computedAt: string;
    diversityScore: number | null;
    frameMetadata: {
        [key: string]: any;
    } | null;
    frameScore: number | null;
    metadata: {
        [key: string]: any;
    } | null;
    score: number;
    scoreVersion: number;
    subjectScore: number | null;
    technicalScore: number | null;
};
export type BestPhotoAssetResponseDto = {
    bestPhotoScore: BestPhotoScoreDto;
    /** Base64-encoded file checksum. SHA-256 (44 chars) for assets uploaded after the SHA-256 transition; SHA-1 (28 chars) for legacy assets. Use the asset `checksumAlgorithm` field to disambiguate when length-based detection is insufficient. */
    checksum: string;
    /** The UTC timestamp when the asset was originally uploaded to Immich. */
    createdAt: string;
    /** Duplicate group ID */
    duplicateId?: string | null;
    /** Video/gif duration in milliseconds (null for static images) */
    duration: number | null;
    exifInfo?: ExifResponseDto;
    /** The actual UTC timestamp when the file was created/captured, preserving timezone information. This is the authoritative timestamp for chronological sorting within timeline groups. Combined with timezone data, this can be used to determine the exact moment the photo was taken. */
    fileCreatedAt: string;
    /** The UTC timestamp when the file was last modified on the filesystem. This reflects the last time the physical file was changed, which may be different from when the photo was originally taken. */
    fileModifiedAt: string;
    /** Whether asset has metadata */
    hasMetadata: boolean;
    /** Asset height */
    height: number | null;
    /** Asset ID */
    id: string;
    /** Is archived */
    isArchived: boolean;
    /** Is edited */
    isEdited: boolean;
    /** Is favorite */
    isFavorite: boolean;
    /** Is offline */
    isOffline: boolean;
    /** Is trashed */
    isTrashed: boolean;
    /** Library ID */
    libraryId?: string | null;
    /** Live photo video ID */
    livePhotoVideoId?: string | null;
    /** The local date and time when the photo/video was taken, derived from EXIF metadata. This represents the photographer's local time regardless of timezone, stored as a timezone-agnostic timestamp. Used for timeline grouping by "local" days and months. */
    localDateTime: string;
    /** Original file name */
    originalFileName: string;
    /** Original MIME type */
    originalMimeType?: string;
    /** Original file path */
    originalPath: string;
    owner?: UserResponseDto;
    /** Owner user ID */
    ownerId: string;
    people?: PersonResponseDto[];
    /** Is resized */
    resized?: boolean;
    stack?: (AssetStackResponseDto) | null;
    tags?: TagResponseDto[];
    /** Thumbhash for thumbnail generation (base64) also used as the c query param for thumbnail cache busting. */
    thumbhash: string | null;
    "type": AssetTypeEnum;
    /** The UTC timestamp when the asset record was last updated in the database. This is automatically maintained by the database and reflects when any field in the asset was last modified. */
    updatedAt: string;
    visibility: AssetVisibility;
    /** Asset width */
    width: number | null;
};
export type BestPhotosResponseDto = {
    count: number;
    items: BestPhotoAssetResponseDto[];
    nextPage: string | null;
    total: number;
};
export type ClusterGroupRequestResponseDto = {
    /** Cluster group the user is invited to join */
    clusterGroupId: string;
    /** Creation date */
    createdAt: string;
    /** Request ID */
    id: string;
    /** User the request was created for */
    userId: string;
};
export type ClusterGroupRequestCreateDto = {
    /** User to invite into the cluster group */
    userId: string;
};
export type UserConfigFFmpegRealtimeDto = {
    /** Enable real-time HLS transcoding (alpha) */
    enabled: boolean;
    /** Resolutions to use for real-time HLS transcoding */
    resolutions: HlsVideoResolution[];
    /** Video codecs to use for real-time HLS transcoding */
    videoCodecs: VideoCodec[];
};
export type UserConfigFFmpegDto = {
    realtime: UserConfigFFmpegRealtimeDto;
};
export type UserConfigGeneratedFullsizeImageDto = {
    /** Enabled */
    enabled: boolean;
};
export type UserConfigGeneratedImageDto = {
    /** Size */
    size: number;
};
export type UserConfigImageDto = {
    fullsize: UserConfigGeneratedFullsizeImageDto;
    preview: UserConfigGeneratedImageDto;
    thumbnail: UserConfigGeneratedImageDto;
};
export type UserConfigClipDto = {
    /** Whether the task is enabled */
    enabled: boolean;
};
export type UserConfigDuplicateDetectionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
};
export type UserConfigFacialRecognitionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
    /** Minimum number of faces required for recognition */
    minFaces: number;
};
export type UserConfigOcrDto = {
    /** Whether the task is enabled */
    enabled: boolean;
};
export type UserConfigMachineLearningDto = {
    clip: UserConfigClipDto;
    duplicateDetection: UserConfigDuplicateDetectionDto;
    /** Enabled */
    enabled: boolean;
    facialRecognition: UserConfigFacialRecognitionDto;
    ocr: UserConfigOcrDto;
};
export type UserConfigMapDto = {
    /** Dark map style URL */
    darkStyle: string;
    /** Enabled */
    enabled: boolean;
    /** Light map style URL */
    lightStyle: string;
};
export type UserConfigOAuthDto = {
    /** Auto launch */
    autoLaunch: boolean;
    /** Button text */
    buttonText: string;
    /** Enabled */
    enabled: boolean;
};
export type UserConfigPasswordLoginDto = {
    /** Enabled */
    enabled: boolean;
};
export type UserConfigReverseGeocodingDto = {
    /** Enabled */
    enabled: boolean;
};
export type UserConfigServerDto = {
    /** External domain */
    externalDomain: string;
    /** Login page message */
    loginPageMessage: string;
    /** Public users */
    publicUsers: boolean;
};
export type UserConfigThemeDto = {
    /** Custom CSS for theming */
    customCss: string;
};
export type UserConfigTrashDto = {
    /** Days */
    days: number;
    /** Enabled */
    enabled: boolean;
};
export type UserConfigUserDto = {
    /** Delete delay */
    deleteDelay: number;
};
export type UserConfigDto = {
    ffmpeg: UserConfigFFmpegDto;
    image: UserConfigImageDto;
    machineLearning: UserConfigMachineLearningDto;
    map: UserConfigMapDto;
    oauth: UserConfigOAuthDto;
    passwordLogin: UserConfigPasswordLoginDto;
    reverseGeocoding: UserConfigReverseGeocodingDto;
    server: UserConfigServerDto;
    theme: UserConfigThemeDto;
    trash: UserConfigTrashDto;
    user: UserConfigUserDto;
};
export type DownloadArchiveDto = {
    /** The name of the archive to download, without extension */
    archiveName?: string;
    /** Asset IDs */
    assetIds: string[];
    /** Download edited asset if available */
    edited?: boolean;
};
export type DownloadInfoDto = {
    /** Album ID to download */
    albumId?: string;
    /** Archive size limit in bytes */
    archiveSize?: number;
    /** Asset IDs to download */
    assetIds?: string[];
    /** User ID to download assets from */
    userId?: string;
};
export type DownloadArchiveInfo = {
    /** Asset IDs in this archive */
    assetIds: string[];
    /** Archive size in bytes */
    size: number;
};
export type DownloadResponseDto = {
    /** Archive information */
    archives: DownloadArchiveInfo[];
    /** Total size in bytes */
    totalSize: number;
};
export type DuplicateResponseDto = {
    /** Duplicate assets */
    assets: AssetResponseDto[];
    /** Duplicate group ID */
    duplicateId: string;
    /** Suggested asset IDs to keep based on file size and EXIF data */
    suggestedKeepAssetIds: string[];
};
export type DuplicateResolveGroupDto = {
    duplicateId: string;
    /** Asset IDs to keep */
    keepAssetIds: string[];
    /** Asset IDs to trash or delete */
    trashAssetIds: string[];
};
export type DuplicateResolveDto = {
    /** List of duplicate groups to resolve */
    groups: DuplicateResolveGroupDto[];
};
export type AssetFaceResponseDto = {
    /** Bounding box X1 coordinate */
    boundingBoxX1: number;
    /** Bounding box X2 coordinate */
    boundingBoxX2: number;
    /** Bounding box Y1 coordinate */
    boundingBoxY1: number;
    /** Bounding box Y2 coordinate */
    boundingBoxY2: number;
    /** Face ID */
    id: string;
    /** Image height in pixels */
    imageHeight: number;
    /** Image width in pixels */
    imageWidth: number;
    person: (PersonResponseDto) | null;
    sourceType?: SourceType;
};
export type AssetFaceCreateDto = {
    /** Asset ID */
    assetId: string;
    /** Face bounding box height */
    height: number;
    /** Image height in pixels */
    imageHeight: number;
    /** Image width in pixels */
    imageWidth: number;
    /** Person ID */
    personId: string;
    /** Face bounding box width */
    width: number;
    /** Face bounding box X coordinate */
    x: number;
    /** Face bounding box Y coordinate */
    y: number;
};
export type AssetFaceDeleteDto = {
    /** Force delete even if person has other faces */
    force: boolean;
};
export type FaceDto = {
    /** Face ID */
    id: string;
};
export type ICloudConnectionResponseDto = {
    config: {
        albums: string[];
        concurrency: number;
        includeEdits: boolean;
        includeHidden: boolean;
        intervalHours: number;
        libraries: string[];
        recoverExternalAsManaged: boolean;
        stagingBytes: number;
    };
    counts: {
        [key: string]: number;
    };
    id: string;
    label: string;
    lastError: string | null;
    nextRunAt: string | null;
    state: string;
};
export type ICloudConnectionsResponseDto = {
    connections: ICloudConnectionResponseDto[];
    enabled: boolean;
};
export type ICloudConnectionCreateDto = {
    config?: {
        albums?: string[];
        concurrency?: number;
        includeEdits?: boolean;
        includeHidden?: boolean;
        intervalHours?: number;
        libraries?: string[];
        recoverExternalAsManaged?: boolean;
        stagingBytes?: number;
    };
    label: string;
};
export type ICloudConnectionUpdateDto = {
    config?: {
        albums?: string[];
        concurrency?: number;
        includeEdits?: boolean;
        includeHidden?: boolean;
        intervalHours?: number;
        libraries?: string[];
        recoverExternalAsManaged?: boolean;
        stagingBytes?: number;
    };
    label?: string;
};
export type ICloudAuthDto = {
    action: ICloudAuthAction;
    appleId?: string;
    code?: string;
    password?: string;
};
export type ICloudControlDto = {
    action: ICloudControlAction;
};
export type ICloudInventoryResponseDto = {
    albums: {
        id: string;
        libraryId: string;
        name: string;
        parentId: string | null;
    }[];
    complete: boolean;
    libraries: {
        id: string;
        name: string;
        supported: boolean;
    }[];
    recent?: {
        assetId: string;
        outcome: string;
        resourceId: string;
    }[];
};
export type QueueStatisticsDto = {
    /** Number of active jobs */
    active: number;
    /** Number of completed jobs */
    completed: number;
    /** Number of delayed jobs */
    delayed: number;
    /** Number of failed jobs */
    failed: number;
    /** Number of paused jobs */
    paused: number;
    /** Number of waiting jobs */
    waiting: number;
};
export type QueueStatusLegacyDto = {
    /** Whether the queue is currently active (has running jobs) */
    isActive: boolean;
    /** Whether the queue is paused */
    isPaused: boolean;
};
export type QueueResponseLegacyDto = {
    jobCounts: QueueStatisticsDto;
    queueStatus: QueueStatusLegacyDto;
};
export type QueuesResponseLegacyDto = {
    backgroundTask: QueueResponseLegacyDto;
    backupDatabase: QueueResponseLegacyDto;
    duplicateDetection: QueueResponseLegacyDto;
    editor: QueueResponseLegacyDto;
    faceDetection: QueueResponseLegacyDto;
    facialRecognition: QueueResponseLegacyDto;
    imageDescription: QueueResponseLegacyDto;
    imageEnrichment: QueueResponseLegacyDto;
    integrityCheck: QueueResponseLegacyDto;
    library: QueueResponseLegacyDto;
    mediaHealth: QueueResponseLegacyDto;
    metadataExtraction: QueueResponseLegacyDto;
    migration: QueueResponseLegacyDto;
    notifications: QueueResponseLegacyDto;
    nsfwDetection: QueueResponseLegacyDto;
    ocr: QueueResponseLegacyDto;
    search: QueueResponseLegacyDto;
    sidecar: QueueResponseLegacyDto;
    smartSearch: QueueResponseLegacyDto;
    storageTemplateMigration: QueueResponseLegacyDto;
    thumbnailGeneration: QueueResponseLegacyDto;
    videoConversion: QueueResponseLegacyDto;
    videoDuplicateDetection: QueueResponseLegacyDto;
    workflow: QueueResponseLegacyDto;
};
export type QueueRunDto = {
    /** Jobs running now */
    active: number;
    /** Whether this queue can be paused; background tasks cannot */
    canPause: boolean;
    /** Whether the queue is paused */
    isPaused: boolean;
    name: QueueName;
    /** Jobs finished, completed or failed, since this run started */
    processed: number;
    /** When this run was first seen with work */
    startedAt: string | null;
    /** processed + active + waiting */
    total: number;
    /** Jobs waiting to start, including those held by a paused queue */
    waiting: number;
};
export type RunningJobsResponseDto = {
    /** Whether the viewer may see and pause the server job queues */
    canManageQueues: boolean;
    memoryExports: MemoryExportResponseDto[];
    operations: MediaOperationDto[];
    /** Server job queues with work; always empty for non-administrators */
    queues: QueueRunDto[];
};
export type JobCreateDto = {
    name: ManualJobName;
};
export type QueueCommandDto = {
    command: QueueCommand;
    /** Force the command execution (if applicable) */
    force?: boolean;
};
export type LibraryResponseDto = {
    /** Number of assets */
    assetCount: number;
    /** Creation date */
    createdAt: string;
    /** Exclusion patterns */
    exclusionPatterns: string[];
    /** Library ID */
    id: string;
    /** Import paths */
    importPaths: string[];
    /** Library name */
    name: string;
    /** Owner user ID */
    ownerId: string;
    /** Last refresh date */
    refreshedAt: string | null;
    /** Last update date */
    updatedAt: string;
};
export type CreateLibraryDto = {
    /** Exclusion patterns (max 128) */
    exclusionPatterns?: string[];
    /** Import paths (max 128) */
    importPaths?: string[];
    /** Library name */
    name?: string;
    /** Owner user ID */
    ownerId: string;
};
export type UpdateLibraryDto = {
    /** Exclusion patterns (max 128) */
    exclusionPatterns?: string[];
    /** Import paths (max 128) */
    importPaths?: string[];
    /** Library name */
    name?: string;
};
export type LibraryStatsResponseDto = {
    /** Number of photos */
    photos: number;
    /** Total number of assets */
    total: number;
    /** Storage usage in bytes */
    usage: number;
    /** Number of videos */
    videos: number;
};
export type ValidateLibraryDto = {
    /** Exclusion patterns (max 128) */
    exclusionPatterns?: string[];
    /** Import paths to validate (max 128) */
    importPaths?: string[];
};
export type ValidateLibraryImportPathResponseDto = {
    /** Import path */
    importPath: string;
    /** Is valid */
    isValid: boolean;
    /** Validation message */
    message?: string;
};
export type ValidateLibraryResponseDto = {
    /** Validation results for import paths */
    importPaths?: ValidateLibraryImportPathResponseDto[];
};
export type LivePhotoCandidateDto = {
    confidence: LivePhotoMatchConfidence;
    /** Why these two assets are believed to be a separated live photo pair */
    matchReason: string;
    photo: AssetResponseDto;
    video: AssetResponseDto;
};
export type LivePhotoCandidatesResponseDto = {
    candidates: LivePhotoCandidateDto[];
    /** Total number of candidate pairs found */
    total: number;
};
export type LivePhotoRelinkItemDto = {
    /** Still image asset ID */
    photoId: string;
    /** Motion video asset ID */
    videoId: string;
};
export type LivePhotoRelinkDto = {
    pairs: LivePhotoRelinkItemDto[];
};
export type LivePhotoRelinkResultDto = {
    error?: string;
    photoId: string;
    success: boolean;
    videoId: string;
};
export type LivePhotoRelinkResponseDto = {
    results: LivePhotoRelinkResultDto[];
};
export type MapReverseGeocodeResponseDto = {
    /** City name */
    city: string | null;
    /** Country name */
    country: string | null;
    /** State/Province name */
    state: string | null;
};
export type MediaHealthCandidateDto = {
    /** Candidate file path */
    candidatePath: string;
    checkedAt: string;
    evidence: {
        [key: string]: any;
    };
    /** Media health finding ID */
    healthId: string;
    /** Candidate ID */
    id: string;
    resolution: {
        [key: string]: any;
    };
    status: MediaHealthStatus;
    /** Visual match score from 0 to 1 */
    visualMatchScore: number | null;
};
export type MediaHealthItemDto = {
    asset: AssetResponseDto;
    /** Asset ID */
    assetId: string;
    candidates: MediaHealthCandidateDto[];
    category: MediaHealthCategory;
    checkedAt: string;
    dismissedAt: string | null;
    evidence: {
        [key: string]: any;
    };
    /** Media health finding ID */
    id: string;
    /** Original media filename */
    originalFileName: string;
    /** Original media path */
    originalPath: string;
    resolution: {
        [key: string]: any;
    };
    resolvedAt: string | null;
    severity: MediaHealthSeverity;
    status: MediaHealthStatus;
};
export type MediaHealthBucketDto = {
    /** Number of findings in the bucket */
    count: number;
    items: MediaHealthItemDto[];
    /** Timeline bucket date */
    timeBucket: string;
};
export type MediaHealthRunResponseDto = {
    category: MediaHealthCategory;
    checkedAssets: number;
    error: string | null;
    finishedAt: string | null;
    foundAssets: number;
    /** Media health run ID */
    id: string;
    startedAt: string;
    /** Run status */
    status: string;
    totalAssets: number;
};
export type MediaHealthListResponseDto = {
    buckets: MediaHealthBucketDto[];
    run: (MediaHealthRunResponseDto) | null;
    total: number;
};
export type MediaHealthDeleteCorruptDto = {
    /** Typed confirmation text */
    confirmText: string;
    /** Media health finding IDs */
    ids: string[];
};
export type MediaHealthBulkResultDto = {
    error?: string;
    id: string;
    status?: MediaHealthStatus;
    success: boolean;
};
export type MediaHealthBulkResponseDto = {
    results: MediaHealthBulkResultDto[];
};
export type MediaHealthScanResponseDto = {
    runId: string;
};
export type MediaHealthBulkActionDto = {
    /** Media health finding IDs */
    ids: string[];
};
export type MediaOperationEstimateDto = {
    /** Configured cloud rate detail, when one applies */
    cloudCost: ({
        [key: string]: any;
    }) | null;
    /** Measured estimate of remaining work */
    seconds: number;
    /** Estimated output size */
    sizeBytes: string | null;
};
export type MediaOperationBulkSummaryDto = {
    action: MediaOperationBulkAction;
    /** Items the server attempted and could not apply; a retry covers these */
    failed: number;
    itemsTruncated: boolean;
    /** Items in the frozen set */
    requested: number;
    /** Items that failed and were given their one automatic retry */
    retried: number;
    /** Items refused before anything changed, e.g. no access */
    skipped: number;
    snapshotTruncated: boolean;
    succeeded: number;
};
export type MediaOperationDto = {
    /** Source asset, when the workload has exactly one */
    assetId: string | null;
    attempt: number;
    /** Automatic retries this job has used; every job gets one before a failure is reported */
    autoRetries: number;
    bulk: (MediaOperationBulkSummaryDto) | null;
    cancelAcknowledgedAt: string | null;
    cancelRequestedAt: string | null;
    createdAt: string;
    destination: MediaOperationDestination;
    /** Which worker or endpoint the destination resolved to */
    destinationDetail: string | null;
    /** Operator detail about a failure; on a queued job, the failure it is being retried after */
    error: string | null;
    /** Stable code the client turns into a message */
    errorCode: string | null;
    estimate: (MediaOperationEstimateDto) | null;
    finishedAt: string | null;
    /** Media operation ID */
    id: string;
    kind: MediaOperationKind;
    /** What the person sees in Activity */
    label: string;
    maxAttempts: number;
    /** Whether this kind of job can pause and carry on later; one-shot kinds cannot */
    pausable: boolean;
    /** When the owner asked to pause; a running job keeps working until its next checkpoint */
    pauseRequestedAt: string | null;
    processedUnits: string;
    /** Percent complete, from counted work */
    progress: number;
    projectId: string | null;
    /** The asset a completed job published */
    resultAssetId: string | null;
    /** When a job waiting for its automatic retry may run again */
    retryAt: string | null;
    /** The job this one retries */
    retryOfId: string | null;
    revisionId: string | null;
    /** User-visible render settings */
    settings: {
        [key: string]: any;
    };
    startedAt: string | null;
    status: MediaOperationStatus;
    totalUnits: string | null;
    updatedAt: string;
};
export type MediaOperationListResponseDto = {
    items: MediaOperationDto[];
    /** Matching jobs, before paging */
    total: number;
};
export type MediaOperationAggregateDto = {
    count: number;
    destination: MediaOperationDestination;
    kind: MediaOperationKind;
    oldestCreatedAt: string | null;
    status: MediaOperationStatus;
};
export type MediaOperationStatisticsDto = {
    /** Jobs the server is still working on */
    active: number;
    buckets: MediaOperationAggregateDto[];
    failed: number;
    /** Remote jobs whose cleanup has not been acknowledged */
    unreleasedRemote: number;
};
export type MediaOperationCheckpointDto = {
    /** Digest over every input to this chunk; the reuse key */
    chunkKey: string;
    completedAt: string | null;
    /** Chunk end, in ticks of the timebase */
    endTicks: string;
    /** Checkpoint ID */
    id: string;
    /** A render may not start inside this chunk */
    requiresSequentialContext: boolean;
    /** Chunk order within the render */
    sequence: number;
    sizeInBytes: string | null;
    /** Chunk start, in ticks of the timebase */
    startTicks: string;
    state: MediaOperationCheckpointState;
    /** Rational timebase for the tick range, e.g. 30000/1001 */
    timebase: string;
};
export type MediaOperationBulkItemDto = {
    /** Asset ID */
    id: string;
    /** Operator detail from the server */
    message: string | null;
    /** Stable key the client turns into a message */
    reasonKey: string | null;
    status: MediaOperationItemStatus;
};
export type MediaOperationDetailDto = (MediaOperationDto) & {
    bulkItems: MediaOperationBulkItemDto[];
    /** Asset IDs waiting for their automatic retry */
    bulkRetryPending: string[];
    checkpoints: MediaOperationCheckpointDto[];
    /** The immutable binding the render was bound to */
    snapshot: {
        [key: string]: any;
    };
};
export type StudioPreviewTimeDto = {
    /** Time denominator; must be positive */
    denominator: string;
    /** Time numerator, in seconds over the denominator */
    numerator: string;
};
export type StudioPreviewDto = {
    contentType: string | null;
    /** Stable code the client turns into a message */
    errorCode: string | null;
    /** Revision-bound entity tag for the frame endpoint */
    etag: string;
    expiresAt: string | null;
    framePts: string | null;
    framePtsTimebase: string | null;
    /** Preview frame ID */
    id: string;
    /** The durable job rendering this frame, when one has been created */
    operationId: string | null;
    projectId: string;
    quality: StudioPreviewQuality;
    readyAt: string | null;
    requestedAt: string;
    /** The stored project revision this frame was rendered for */
    revision: number;
    /** Digest of the authorized resolution the frame is bound to; changes with the revision and whenever access is re-resolved */
    revisionDigest: string;
    /** The seek this frame answers */
    seekGeneration: string;
    sizeInBytes: string | null;
    status: StudioPreviewStatus;
    time: StudioPreviewTimeDto;
    /** The frame is an explicitly tone-mapped SDR rendering; never the colour authority */
    toneMapped: boolean;
    viewportHeight: number;
    viewportWidth: number;
};
export type StudioPreviewResponseDto = {
    /** The stored revision the project is on now */
    currentRevision: number;
    preview: StudioPreviewDto;
    /** Previews cancelled because the revision advanced */
    supersededPreviewIds: string[];
};
export type StudioPreviewRequestDto = {
    /** Studio project the frame belongs to */
    projectId: string;
    quality: StudioPreviewQuality;
    /** Stored project revision the frame is bound to; a superseded revision is refused */
    revision: number;
    /** The client's monotonic seek counter, echoed back on the result */
    seekGeneration?: number;
    time: StudioPreviewTimeDto;
    viewportHeight: number;
    viewportWidth: number;
};
export type MediaOperationLivePhotoPairDto = {
    /** Still image asset ID */
    photoId: string;
    /** Motion video asset ID */
    videoId: string;
};
export type MediaOperationBulkPayloadDto = {
    albumId?: string;
    dateMode?: DateMode;
    dateTimeOriginal?: string;
    description?: string;
    latitude?: number;
    longitude?: number;
    /** Relative shift in minutes, for `dateMode: shift` */
    minutes?: number;
    pairs?: MediaOperationLivePhotoPairDto[];
    primaryId?: string;
    stackIds?: string[];
    tagIds?: string[];
    timeZone?: string;
};
export type MediaOperationBulkCreateDto = {
    action: MediaOperationBulkAction;
    /** The frozen matching set, in order */
    assetIds: string[];
    payload?: MediaOperationBulkPayloadDto;
    /** Client idempotency key; submitting the same key again returns the existing operation */
    requestId?: string;
    /** A record of the view the set came from; never re-resolved */
    scope?: {
        [key: string]: any;
    };
    /** The count shown to the person at submit */
    submittedTotal?: number | null;
    /** The client could not resolve the whole matching set */
    truncated?: boolean;
};
export type RenderWorkerDto = {
    /** Operations the worker currently holds */
    activeOperations: number;
    /** Oldest conformance evidence admission accepts, in milliseconds */
    conformanceMaxAgeMs: number;
    createdAt: string;
    destination: MediaOperationDestination;
    /** Engine and patch digest the worker must keep reporting */
    engineDigest: string | null;
    /** GPU memory the worker was qualified with, in bytes */
    gpuMemoryBytes: string | null;
    /** Render worker ID */
    id: string;
    /** Operation kinds this worker may claim */
    kinds: MediaOperationKind[];
    lastAdmittedAt: string | null;
    lastSeenAt: string | null;
    /** Operations this worker may hold at once */
    maxConcurrentOperations: number;
    /** Most output bytes one operation may produce here */
    maxOutputBytes: string | null;
    /** Longest one operation may run here, in milliseconds */
    maxWallClockMs: string | null;
    /** What the administrator calls this worker */
    name: string;
    revokedAt: string | null;
    status: RenderWorkerStatus;
    updatedAt: string;
};
export type RenderWorkerCreateDto = {
    conformanceMaxAgeMs?: number;
    destination: MediaOperationDestination;
    engineDigest?: string | null;
    gpuMemoryBytes?: string | null;
    /** Operation kinds this worker may claim */
    kinds: MediaOperationKind[];
    maxConcurrentOperations?: number;
    maxOutputBytes?: string | null;
    maxWallClockMs?: string | null;
    name: string;
};
export type RenderWorkerCreateResponseDto = {
    /** Shown once. Give it to the worker; the server keeps only its hash */
    enrolmentSecret: string;
    worker: RenderWorkerDto;
};
export type RenderWorkerAuditDto = {
    /** The administrator who acted, when one did */
    actorId: string | null;
    createdAt: string;
    /** Operator detail. Never a secret, never a path */
    detail: {
        [key: string]: any;
    } | null;
    event: RenderWorkerAuditEvent;
    id: string;
    operationId: string | null;
    reason: (RenderWorkerRefusalReason) | null;
    workerId: string | null;
};
export type RenderWorkerLimitDto = {
    /** Operations one account may have claimed at once */
    maxConcurrentOperations: number;
    maxOutputBytes: string | null;
    maxWallClockMs: string | null;
    /** `instance` for the default, otherwise a user ID */
    subject: string;
    updatedAt: string;
    userId: string | null;
};
export type RenderWorkerLimitsResponseDto = {
    instance: RenderWorkerLimitDto;
    users: RenderWorkerLimitDto[];
};
export type RenderWorkerLimitUpdateDto = {
    maxConcurrentOperations: number;
    maxOutputBytes: string | null;
    maxWallClockMs: string | null;
    /** Omit or null for the instance default */
    userId?: string | null;
};
export type RenderWorkerUpdateDto = {
    conformanceMaxAgeMs?: number;
    engineDigest?: string | null;
    gpuMemoryBytes?: string | null;
    kinds?: MediaOperationKind[];
    maxConcurrentOperations?: number;
    maxOutputBytes?: string | null;
    maxWallClockMs?: string | null;
    name?: string;
};
export type RenderWorkerAdmissionDto = {
    /** Encoder and decoder names the check verified */
    codecs?: string[];
    /** When the conformance check ran */
    conformanceReportedAt: string;
    /** Digest of the engine and patches actually loaded */
    engineDigest: string;
    enrolmentSecret: string;
    /** GPU memory measured by the conformance check */
    gpuMemoryBytes: string | null;
    /** True when the renderer is a software or fallback device */
    softwareRenderer: boolean;
    workerId: string;
};
export type RenderWorkerSessionDto = {
    expiresAt: string;
    /** How often the worker should heartbeat a held claim */
    heartbeatIntervalMs: number;
    /** How long a claim lasts without a heartbeat */
    leaseMs: number;
    scopes: MediaOperationKind[];
    /** Present as the x-frameleaf-worker-session header on every worker call */
    sessionToken: string;
    workerId: string;
};
export type RenderWorkerInputGrantDto = {
    /** Digest the manifest was resolved against, when known */
    checksum: string | null;
    expiresAt: string;
    /** FL-90 resource key, or `source` for a single-asset workload */
    inputId: string;
    /** Resource class: library-asset, edited-master, font, lut, … */
    kind: string;
    /** Asset or resource id. Never a path */
    resourceId: string;
    /** Relative URL, valid for this claim only and only until expiresAt */
    url: string;
};
export type RenderWorkerClaimLimitsDto = {
    maxOutputBytes: string | null;
    maxWallClockMs: string | null;
};
export type RenderWorkerClaimDto = {
    attempt: number;
    checkpoints: MediaOperationCheckpointDto[];
    /** Required on every write to this operation */
    claimToken: string;
    inputs: RenderWorkerInputGrantDto[];
    kind: MediaOperationKind;
    leaseMs: number;
    limits: RenderWorkerClaimLimitsDto;
    operationId: string;
    projectId: string | null;
    revisionId: string | null;
    settings: {
        [key: string]: any;
    };
    snapshot: {
        [key: string]: any;
    };
};
export type RenderWorkerClaimRequestDto = {
    /** Narrow the claim to these kinds */
    kinds?: MediaOperationKind[];
};
export type RenderWorkerWriteResultDto = {
    accepted: boolean;
    refusal: (RenderWorkerRefusalReason) | null;
};
export type RenderWorkerCancelAckDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    /** True when remote resources are confirmed gone */
    released: boolean;
};
export type RenderWorkerCheckpointPlanDto = {
    chunkKey: string;
    /** The claim token this operation was handed out with */
    claimToken: string;
    configDigest: string;
    endTicks: string;
    historyDigest: string;
    inputDigest: string;
    prerollTicks?: string;
    requiresSequentialContext?: boolean;
    seed: string | null;
    sequence: number;
    startTicks: string;
    timebase: string;
};
export type RenderWorkerCheckpointCompleteDto = {
    /** Must match the planned chunk; a re-planned chunk cannot be completed */
    chunkKey: string;
    /** The claim token this operation was handed out with */
    claimToken: string;
    outputChecksum: string;
    outputPath: string;
    sizeInBytes: string;
};
export type RenderWorkerCompleteDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    resultAssetId: string | null;
};
export type RenderWorkerFailDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    error: string;
    errorCode: string;
};
export type RenderWorkerHeartbeatResponseDto = {
    /** The owner asked to stop; acknowledge with cancel-ack */
    cancelRequested: boolean;
    leaseExtended: boolean;
    leaseMs: number;
    /** The owner paused the job and its claim has been handed back; stop without reporting a failure */
    pauseRequested: boolean;
    /** Set when a limit stopped the operation */
    refusal: (RenderWorkerRefusalReason) | null;
};
export type RenderWorkerHeartbeatDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    /** Total output bytes produced so far */
    outputBytes?: string;
};
export type RenderWorkerProgressDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    outputBytes?: string;
    processedUnits: number;
    status: "preparing" | "rendering";
    totalUnits: number | null;
};
export type OnThisDayDto = {
    /** Year for on this day memory */
    year: number;
};
export type MemoryStoryPlaceDto = {
    /** City */
    city: string | null;
    /** Country */
    country: string | null;
    /** State or region */
    state: string | null;
};
export type EventStoryDto = {
    /** Number of assets the event held before the diversity pass */
    assetCount: number;
    /** Number of distinct local days the event covers */
    dayCount: number;
    /** Last local day of the event, 'yyyy-MM-dd' */
    endDate: string;
    /** Discriminator for an event story */
    kind: "event_story";
    place?: MemoryStoryPlaceDto;
    /** First local day of the event, 'yyyy-MM-dd' */
    startDate: string;
    /** Place label for the event, when it has one */
    title?: string;
    /** Year the event started */
    year: number;
};
export type YearInReviewDto = {
    /** Number of assets captured that year */
    assetCount: number;
    /** Discriminator for a year in review recap */
    kind: "year_in_review";
    /** Number of distinct months represented */
    monthCount: number;
    /** Calendar year being recapped */
    year: number;
};
export type MemoryData = EventStoryDto | YearInReviewDto | OnThisDayDto;
export type MemoryExportResponseDto = {
    /** Number of assets in the export */
    assetCount: number;
    /** When the export was requested */
    createdAt: string;
    /** Failure reason, when the export failed */
    error: string | null;
    /** When the archive is deleted */
    expiresAt: string | null;
    /** When the export reached a terminal state */
    finishedAt: string | null;
    format: MemoryExportFormat;
    /** Export ID */
    id: string;
    /** Whether the archive can be downloaded right now */
    isDownloadable: boolean;
    /** Memory the export was requested for */
    memoryId: string;
    /** Owner user ID */
    ownerId: string;
    /** Number of assets written so far */
    processedAssets: number;
    /** Size of the finished archive */
    sizeInBytes: number | null;
    /** When the worker picked the export up */
    startedAt: string | null;
    status: MemoryExportStatus;
    /** The memory's title when the export was requested */
    title: string;
    /** Last update date */
    updatedAt: string;
};
export type MemoryExportCreateDto = {
    format?: MemoryExportFormat;
};
export type MemoryResponseDto = {
    assets: AssetResponseDto[];
    /** Creation date */
    createdAt: string;
    data: MemoryData;
    /** Deletion date */
    deletedAt?: string;
    /** Date when memory should be hidden */
    hideAt?: string;
    /** Memory ID */
    id: string;
    /** Is memory saved */
    isSaved: boolean;
    /** Memory date */
    memoryAt: string;
    /** Owner user ID */
    ownerId: string;
    /** Date when memory was seen */
    seenAt?: string;
    /** Date when memory should be shown */
    showAt?: string;
    "type": MemoryType;
    /** Last update date */
    updatedAt: string;
};
export type MemoryCreateDto = {
    /** Asset IDs to associate with memory */
    assetIds?: string[];
    data: MemoryData;
    /** Date when memory should be hidden */
    hideAt?: string;
    /** Is memory saved */
    isSaved?: boolean;
    /** Memory date */
    memoryAt: string;
    /** Date when memory was seen */
    seenAt?: string;
    /** Date when memory should be shown */
    showAt?: string;
    "type": MemoryType;
};
export type MemoryStatisticsResponseDto = {
    /** Total number of memories */
    total: number;
};
export type MemoryUpdateDto = {
    /** Is memory saved */
    isSaved?: boolean;
    /** Memory date */
    memoryAt?: string;
    /** Date when memory was seen */
    seenAt?: string;
};
export type MlDestinationConsentDto = {
    /** When an administrator recorded consent, or null */
    acknowledgedAt: string | null;
    /** Administrator who recorded consent, or null */
    acknowledgedBy: string | null;
    /** Whether this destination sends media off the network and needs consent */
    required: boolean;
};
export type MlDestinationCostControlsDto = {
    /** Spend ceiling over the rolling budget window, or null for no ceiling */
    budgetLimitUsd: number | null;
    /** Length of the rolling window `spentUsd` covers */
    budgetWindowDays: number;
    /** Longest single job this destination may run, or null */
    maxRuntimeMinutes: number | null;
    /** Largest upload one job may send to this destination, or null */
    maxUploadBytes: number | null;
    /** Attributed spend inside the budget window; 0 when no cost has been attributed yet */
    spentUsd: number;
};
export type MlDestinationHealthStateDto = {
    /** When the destination was last probed, or null */
    probedAt: string | null;
    /** Workloads the worker itself reported on the last probe, or null when it never answered */
    servedWorkloads: MlWorkload[] | null;
    status: MlDestinationHealth;
    /** Human-readable probe result, or null */
    summary: string | null;
};
export type MlDestinationResponseDto = {
    /** Whether a bearer token is stored for this destination */
    authTokenConfigured: boolean;
    consent: MlDestinationConsentDto;
    costControls: MlDestinationCostControlsDto;
    createdAt: string;
    enabled: boolean;
    health: MlDestinationHealthStateDto;
    id: string;
    kind: MlDestinationKind;
    name: string;
    updatedAt: string;
    /** Endpoint URL; null for a RunPod destination with no ready worker */
    url: string | null;
    /** Workloads the administrator allows on this destination */
    workloads: MlWorkload[];
};
export type MlDestinationCreateDto = {
    /** Bearer token for a LAN worker (write-only) */
    authToken?: string;
    budgetLimitUsd?: number | null;
    enabled?: boolean;
    kind: MlDestinationKind;
    maxRuntimeMinutes?: number | null;
    maxUploadBytes?: number | null;
    name: string;
    /** Required for a LAN destination, optional for a local one, forbidden for RunPod */
    url?: string;
    workloads?: MlWorkload[];
};
export type MlCapabilityDestinationDto = {
    /** Enabled, healthy on the last probe, consented and reporting this workload */
    available: boolean;
    /** True when the destination needs no consent or consent is recorded */
    consentGranted: boolean;
    health: MlDestinationHealth;
    id: string;
    kind: MlDestinationKind;
    name: string;
};
export type MlWorkloadCapabilityDto = {
    /** At least one destination can serve this workload right now */
    available: boolean;
    destinations: MlCapabilityDestinationDto[];
    /** Destination library jobs use for this workload, or null */
    routedDestinationId: string | null;
    workload: MlWorkload;
};
export type StudioCapabilitiesDto = {
    /** False until the Studio render worker admission (FL-95, FL-104) reports one */
    gpuWorker: boolean;
    /** False until the Studio render worker admission (FL-95, FL-104) reports one */
    renderWorker: boolean;
    /** A destination can serve a restoration workload right now */
    restorationWorker: boolean;
    /** A destination can serve the Studio AI workload right now */
    transcriptionWorker: boolean;
};
export type MlCapabilitiesResponseDto = {
    /** When this snapshot was assembled */
    probedAt: string;
    studio: StudioCapabilitiesDto;
    workloads: MlWorkloadCapabilityDto[];
};
export type MlWorkloadRouteDto = {
    /** Destination the workload is routed to, or null when unrouted */
    destinationId: string | null;
    workload: MlWorkload;
};
export type MlWorkloadRoutesResponseDto = {
    routes: MlWorkloadRouteDto[];
};
export type MlWorkloadRouteUpdateDto = {
    /** Destination to route the workload to; null removes the route */
    destinationId: string | null;
};
export type MlDestinationUpdateDto = {
    /** New bearer token; null clears it; omitted keeps the stored token */
    authToken?: string | null;
    budgetLimitUsd?: number | null;
    enabled?: boolean;
    maxRuntimeMinutes?: number | null;
    maxUploadBytes?: number | null;
    name?: string;
    url?: string | null;
    workloads?: MlWorkload[];
};
export type MlThroughputEstimateDto = {
    /** Measured throughput for this destination and workload, or null with no samples */
    bytesPerSecond: number | null;
    /** Successful requests the estimate is measured from */
    sampleCount: number;
    windowDays: number;
};
export type MlAdmissionResponseDto = {
    destinationId: string;
    estimate: MlThroughputEstimateDto;
    health: MlDestinationHealthStateDto;
    kind: MlDestinationKind;
    workload: MlWorkload;
};
export type MlAdmissionRequestDto = {
    /** Job the admission is for, recorded with the accounting row */
    jobId?: string;
    workload: MlWorkload;
};
export type MlDestinationConsentRequestDto = {
    /** The administrator confirms that media sent to this destination leaves the network */
    acknowledgeMediaLeavesNetwork: true;
};
export type RestorationGpuDto = {
    driverVersion: string;
    memoryTotalBytes: number;
    name: string;
};
export type RestorationMeasuredThroughputDto = {
    frames: number;
    /** Measured frames restored per second */
    framesPerSecond: number;
    /** GPU the measurement was made on, as nvidia-smi names it */
    gpu: string;
    inputHeight: number;
    inputWidth: number;
    /** Measured peak GPU memory */
    peakVramBytes: number;
};
export type RestorationModelCapabilityDto = {
    displayName: string;
    /** Source dynamic ranges the model accepts */
    dynamicRanges: RestorationDynamicRange[];
    /** Model family, for example realbasicvsr or seedvr2 */
    family: string;
    /** Identity of the model and its verified weights, or null until the weights are verified */
    fingerprint: string | null;
    id: string;
    /** Largest number of frames one inference may restore */
    maxFrames: number;
    /** Largest source long edge the model is qualified for */
    maxInputLongEdge: number;
    /** Throughput measured during qualification; estimates come from these */
    measured: RestorationMeasuredThroughputDto[];
    mode: AssetRestorationMode;
    /** Fixed enlargement the model restores at, or null */
    nativeScale: number | null;
    /** Qualification record covering this model, or null */
    qualificationId: string | null;
    /** Every reason the model is not available; empty when it is */
    reasons: string[];
    /** Pinned upstream commit */
    revision: string;
    state: RestorationModelState;
};
export type MlRestorationModelsResponseDto = {
    /** When the destination last verified its models, or null */
    checkedAt: string | null;
    /** Problems reading the model manifest or qualification evidence on the destination */
    configurationProblems: string[];
    destinationId: string;
    /** Why no report could be read, or null */
    error: string | null;
    gpus: RestorationGpuDto[];
    models: RestorationModelCapabilityDto[];
    /** Whether the destination answered with a restoration report */
    reachable: boolean;
    /** Restoration workloads the destination serves now; empty unless a model is available */
    workloads: MlWorkload[];
};
export type NotificationDeleteAllDto = {
    /** Notification IDs to delete */
    ids: string[];
};
export type NotificationUpdateAllDto = {
    /** Notification IDs to update */
    ids: string[];
    /** Date when notifications were read */
    readAt?: string | null;
};
export type NotificationUpdateDto = {
    /** Date when notification was read */
    readAt?: string | null;
};
export type OAuthConfigDto = {
    /** OAuth code challenge (PKCE) */
    codeChallenge?: string;
    /** OAuth redirect URI */
    redirectUri: string;
    /** OAuth state parameter */
    state?: string;
};
export type OAuthAuthorizeResponseDto = {
    /** OAuth authorization URL */
    url: string;
};
export type OAuthBackchannelLogoutDto = {
    /** OAuth logout token */
    logout_token: string;
};
export type OAuthCallbackDto = {
    /** OAuth code verifier (PKCE) */
    codeVerifier?: string;
    /** OAuth state parameter */
    state?: string;
    /** OAuth callback URL */
    url: string;
};
export type PartnerResponseDto = {
    avatarColor: UserAvatarColor;
    /** User email */
    email: string;
    /** User ID */
    id: string;
    /** Show in timeline */
    inTimeline?: boolean;
    /** User name */
    name: string;
    /** Profile change date */
    profileChangedAt: string;
    /** Profile image path */
    profileImagePath: string;
    /** Sharer allows this partner to see asset locations */
    shareLocation?: boolean;
};
export type PartnerCreateDto = {
    /** User ID to share with */
    sharedWithId: string;
};
export type PartnerUpdateDto = {
    /** Show partner assets in timeline */
    inTimeline?: boolean;
    /** Share asset locations with this partner; only the sharing user can change it */
    shareLocation?: boolean;
};
export type PeopleResponseDto = {
    /** Whether there are more pages */
    hasNextPage?: boolean;
    /** Number of hidden people */
    hidden: number;
    people: PersonResponseDto[];
    /** Total number of people */
    total: number;
};
export type PersonCreateDto = {
    /** Person date of birth */
    birthDate?: string | null;
    /** Person color (hex) */
    color?: string | null;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Person visibility (hidden) */
    isHidden?: boolean;
    /** Person name */
    name?: string;
};
export type PeopleUpdateItem = {
    /** Person date of birth */
    birthDate?: string | null;
    /** Person color (hex) */
    color?: string | null;
    /** Asset ID used for feature face thumbnail */
    featureFaceAssetId?: string;
    /** Person ID */
    id: string;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Person visibility (hidden) */
    isHidden?: boolean;
    /** Person name */
    name?: string;
};
export type PeopleUpdateDto = {
    /** People to update */
    people: PeopleUpdateItem[];
};
export type MergePersonDto = {
    /** Person IDs to merge */
    ids: string[];
};
export type PersonUpdateDto = {
    /** Person date of birth */
    birthDate?: string | null;
    /** Person color (hex) */
    color?: string | null;
    /** Asset ID used for feature face thumbnail */
    featureFaceAssetId?: string;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Person visibility (hidden) */
    isHidden?: boolean;
    /** Person name */
    name?: string;
};
export type AssetFaceUpdateItem = {
    /** Asset ID */
    assetId: string;
    /** Person ID */
    personId: string;
};
export type AssetFaceUpdateDto = {
    /** Face update items */
    data: AssetFaceUpdateItem[];
};
export type PersonStatisticsResponseDto = {
    /** Number of assets */
    assets: number;
};
export type PetResponseDto = {
    /** Number of assets with a confirmed observation of this pet */
    assetCount: number;
    /** Pet date of birth */
    birthDate: string | null;
    /** Creation date */
    createdAt: string;
    /** Asset used as the pet thumbnail */
    featuredAssetId: string | null;
    /** Pet ID */
    id: string;
    /** Is favorite */
    isFavorite: boolean;
    /** Is hidden */
    isHidden: boolean;
    /** Pet name */
    name: string;
    species: PetSpecies;
    /** Last update date */
    updatedAt: string;
};
export type PetCreateDto = {
    /** Pet date of birth */
    birthDate?: string | null;
    /** Asset used as the pet thumbnail */
    featuredAssetId?: string | null;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Pet visibility (hidden) */
    isHidden?: boolean;
    /** Pet name */
    name?: string;
    species: PetSpecies;
};
export type PetUpdateDto = {
    /** Pet date of birth */
    birthDate?: string | null;
    /** Asset used as the pet thumbnail */
    featuredAssetId?: string | null;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Pet visibility (hidden) */
    isHidden?: boolean;
    /** Pet name */
    name?: string;
    species?: PetSpecies;
};
export type PetMergeDto = {
    /** Pet IDs to merge into this pet */
    ids: string[];
};
export type PetObservationResponseDto = {
    /** Asset ID */
    assetId: string;
    /** Region X1, in source pixels */
    boundingBoxX1: number | null;
    /** Region X2, in source pixels */
    boundingBoxX2: number | null;
    /** Region Y1, in source pixels */
    boundingBoxY1: number | null;
    /** Region Y2, in source pixels */
    boundingBoxY2: number | null;
    /** Creation date */
    createdAt: string;
    /** Observation ID */
    id: string;
    /** Height of the image the region was drawn on */
    imageHeight: number | null;
    /** Width of the image the region was drawn on */
    imageWidth: number | null;
    /** Pet ID */
    petId: string;
    source: PetObservationSource;
    state: PetObservationState;
    /** Last update date */
    updatedAt: string;
};
export type PetObservationCreateDto = {
    /** Asset the pet appears in */
    assetId: string;
    /** Region X1, in source pixels */
    boundingBoxX1?: number;
    /** Region X2, in source pixels */
    boundingBoxX2?: number;
    /** Region Y1, in source pixels */
    boundingBoxY1?: number;
    /** Region Y2, in source pixels */
    boundingBoxY2?: number;
    /** Height of the image the region was drawn on */
    imageHeight?: number;
    /** Width of the image the region was drawn on */
    imageWidth?: number;
};
export type PetCandidateResponseDto = {
    /** Asset the proposal is about */
    assetId: string;
    /** Region X1, in source pixels */
    boundingBoxX1: number;
    /** Region X2, in source pixels */
    boundingBoxX2: number;
    /** Region Y1, in source pixels */
    boundingBoxY1: number;
    /** Region Y2, in source pixels */
    boundingBoxY2: number;
    /** The detector’s species guess, which is never the pet’s species */
    detectedSpecies: string | null;
    /** Candidate ID */
    id: string;
    /** Height of the image the region was found on */
    imageHeight: number;
    /** Width of the image the region was found on */
    imageWidth: number;
    /** Model that produced the detection */
    modelName: string;
    /** Revision of the model that produced the detection */
    modelRevision: string;
    /** Proposed pet ID */
    petId: string;
    /** Model confidence, 0 to 1 */
    score: number;
};
export type PetCandidateListResponseDto = {
    /** Proposals awaiting review */
    candidates: PetCandidateResponseDto[];
    /** Whether a pet recognition model is configured and available */
    recognitionAvailable: boolean;
    /** Why recognition is unavailable, for display; null when it is available */
    recognitionUnavailableReason: string | null;
};
export type PetCandidateReviewDto = {
    /** Pet to assign instead of the proposed one */
    petId?: string;
};
export type PluginMethodResponseDto = {
    /** Description */
    description: string;
    hostFunctions: boolean;
    /** Key */
    key: string;
    /** Name */
    name: string;
    schema?: {};
    /** Title */
    title: string;
    /** Workflow types */
    types: WorkflowType[];
    /** Ui hints */
    uiHints: string[];
};
export type PluginResponseDto = {
    /** Plugin author */
    author: string;
    /** Creation date */
    createdAt: string;
    /** Plugin description */
    description: string;
    /** Plugin ID */
    id: string;
    /** Plugin methods */
    methods: PluginMethodResponseDto[];
    /** Plugin name */
    name: string;
    /** Plugin title */
    title: string;
    /** Last update date */
    updatedAt: string;
    /** Plugin version */
    version: string;
};
export type PluginTemplateStepResponseDto = {
    /** Step configuration */
    config: {
        [key: string]: any;
    } | null;
    /** Whether the step is enabled */
    enabled?: boolean;
    /** Step plugin method */
    method: string;
};
export type PluginTemplateResponseDto = {
    /** Template description */
    description: string;
    /** Template key (unique across all templates) */
    key: string;
    /** Workflow steps */
    steps: PluginTemplateStepResponseDto[];
    /** Template title */
    title: string;
    /** Workflow trigger */
    trigger: WorkflowTrigger;
    /** Ui hints, for example "smart-album" */
    uiHints: string[];
};
export type PublicConfigOAuthDto = {
    /** Auto launch */
    autoLaunch: boolean;
    /** Button text */
    buttonText: string;
    /** Enabled */
    enabled: boolean;
};
export type PublicConfigPasswordLoginDto = {
    /** Enabled */
    enabled: boolean;
};
export type PublicConfigServerDto = {
    /** Login page message */
    loginPageMessage: string;
};
export type PublicConfigThemeDto = {
    /** Custom CSS for theming */
    customCss: string;
};
export type PublicConfigDto = {
    oauth: PublicConfigOAuthDto;
    passwordLogin: PublicConfigPasswordLoginDto;
    server: PublicConfigServerDto;
    theme: PublicConfigThemeDto;
};
export type QueueResponseDto = {
    /** Whether the queue is paused */
    isPaused: boolean;
    name: QueueName;
    statistics: QueueStatisticsDto;
};
export type QueueUpdateDto = {
    /** Whether to pause the queue */
    isPaused?: boolean;
};
export type QueueDeleteDto = {
    /** If true, will also remove failed jobs from the queue. */
    failed?: boolean;
};
export type QueueJobResponseDto = {
    /** Job data payload */
    data: {
        [key: string]: any;
    };
    /** Job ID */
    id?: string;
    name: JobName;
    /** Job creation timestamp */
    timestamp: number;
};
export type RunPodBackfillResultDto = {
    enqueued: string[];
    skipped: string[];
};
export type RunPodConnectionTestDto = {
    /** API key to verify (overrides the stored key for the test) */
    apiKey?: string;
};
export type RunPodConnectionResultDto = {
    message?: string;
    ok: boolean;
};
export type RunPodStateDto = {
    endpointId?: string;
    endpointUrl?: string;
    errorMessage?: string;
    estimatedCostUsd?: number;
    gpuTypeId?: string;
    /** Serverless idle timeout; may be null when not yet provisioned. */
    idleTimeoutSeconds?: number | null;
    imageName?: string;
    instanceTag?: string;
    lastBusyAt?: string;
    maxRuntimeHours?: number;
    mlUrl?: string;
    podCreatedAt?: string;
    podId?: string;
    pricePerHour?: number;
    runningSince?: string;
    status: Status3;
    stoppedAt?: string;
    templateId?: string;
    unhealthySince?: string;
    workerReady?: boolean;
    /** Serverless workersMax; may be null when not yet provisioned. */
    workersMax?: number | null;
    /** Serverless workersMin; may be null when not yet provisioned. */
    workersMin?: number | null;
};
export type RunPodGpuTypeDto = {
    communityCloud?: boolean;
    displayName: string;
    id: string;
    memoryInGb: number;
    pricePerHour?: number | null;
    secureCloud?: boolean;
};
export type RunPodProvisionDto = {
    /** User confirms image previews will be sent to RunPod (must be true to launch) */
    acknowledgeDataPrivacy: true;
    gpuCount?: number;
    /** RunPod GPU type ID, e.g. "NVIDIA RTX A5000" */
    gpuTypeId: string;
    /** Override the configured image */
    imageName?: string;
    maxRuntimeHours?: number;
};
export type AskSearchDto = {
    /** Search language code */
    language?: string;
    /** Page number */
    page?: number;
    /** Natural language Ask Search query */
    query: string;
    /** Number of results to return */
    size?: number;
};
export type IdsFilter = {
    all?: string[];
    "any"?: string[];
    none?: string[];
};
export type StringFilter = {
    eq?: string;
    "in"?: string[];
    ne?: string;
    notIn?: string[];
};
export type StringFilterNullable = {
    eq?: string | null;
    "in"?: string[];
    ne?: string | null;
    notIn?: string[];
};
export type DateFilter = {
    eq?: string;
    gt?: string;
    gte?: string;
    lt?: string;
    lte?: string;
    ne?: string;
};
export type StringPatternFilter = {
    endsWith?: string;
    eq?: string | null;
    "in"?: string[];
    like?: string;
    ne?: string | null;
    notIn?: string[];
    notLike?: string;
    startsWith?: string;
};
export type NumberFilter = {
    eq?: number;
    gt?: number;
    gte?: number;
    "in"?: number[];
    lt?: number;
    lte?: number;
    ne?: number;
    notIn?: number[];
};
export type BoolFilter = {
    eq: boolean;
};
export type IdFilter = {
    eq?: string;
    ne?: string;
};
export type IdFilterNullable = {
    eq?: string | null;
    ne?: string | null;
};
export type StringSimilarityFilter = {
    matches: string;
};
export type NumberFilterNullable = {
    eq?: number | null;
    gt?: number;
    gte?: number;
    "in"?: number[];
    lt?: number;
    lte?: number;
    ne?: number | null;
    notIn?: number[];
};
export type DateFilterNullable = {
    eq?: string | null;
    gt?: string;
    gte?: string;
    lt?: string;
    lte?: string;
    ne?: string | null;
};
export type EnumFilterAssetType = {
    eq?: AssetTypeEnum;
    "in"?: AssetTypeEnum[];
    ne?: AssetTypeEnum;
    notIn?: AssetTypeEnum[];
};
export type EnumFilterAssetVisibility = {
    eq?: AssetVisibility;
    "in"?: AssetVisibility[];
    ne?: AssetVisibility;
    notIn?: AssetVisibility[];
};
export type SearchFilterBranch = {
    albumIds?: IdsFilter;
    checksum?: StringFilter;
    city?: StringFilterNullable;
    country?: StringFilterNullable;
    createdAt?: DateFilter;
    description?: StringPatternFilter;
    encodedVideoPath?: StringFilter;
    fileSizeInBytes?: NumberFilter;
    hasAlbums?: BoolFilter;
    hasPeople?: BoolFilter;
    hasTags?: BoolFilter;
    id?: IdFilter;
    isEncoded?: BoolFilter;
    isFavorite?: BoolFilter;
    isMotion?: BoolFilter;
    isOffline?: BoolFilter;
    lensModel?: StringFilterNullable;
    libraryId?: IdFilterNullable;
    make?: StringFilterNullable;
    model?: StringFilterNullable;
    ocr?: StringSimilarityFilter;
    originalFileName?: StringPatternFilter;
    originalPath?: StringPatternFilter;
    personIds?: IdsFilter;
    petIds?: IdsFilter;
    rating?: NumberFilterNullable;
    state?: StringFilterNullable;
    tagIds?: IdsFilter;
    takenAt?: DateFilter;
    trashedAt?: DateFilterNullable;
    "type"?: EnumFilterAssetType;
    updatedAt?: DateFilter;
    visibility?: EnumFilterAssetVisibility;
};
export type SearchFilter = {
    albumIds?: IdsFilter;
    checksum?: StringFilter;
    city?: StringFilterNullable;
    country?: StringFilterNullable;
    createdAt?: DateFilter;
    description?: StringPatternFilter;
    encodedVideoPath?: StringFilter;
    fileSizeInBytes?: NumberFilter;
    hasAlbums?: BoolFilter;
    hasPeople?: BoolFilter;
    hasTags?: BoolFilter;
    id?: IdFilter;
    isEncoded?: BoolFilter;
    isFavorite?: BoolFilter;
    isMotion?: BoolFilter;
    isOffline?: BoolFilter;
    lensModel?: StringFilterNullable;
    libraryId?: IdFilterNullable;
    make?: StringFilterNullable;
    model?: StringFilterNullable;
    ocr?: StringSimilarityFilter;
    or?: SearchFilterBranch[];
    originalFileName?: StringPatternFilter;
    originalPath?: StringPatternFilter;
    personIds?: IdsFilter;
    petIds?: IdsFilter;
    rating?: NumberFilterNullable;
    state?: StringFilterNullable;
    tagIds?: IdsFilter;
    takenAt?: DateFilter;
    trashedAt?: DateFilterNullable;
    "type"?: EnumFilterAssetType;
    updatedAt?: DateFilter;
    visibility?: EnumFilterAssetVisibility;
};
export type SearchOrder = {
    direction?: AssetOrder;
    field?: SearchOrderField;
};
export type AskSearchPlanDto = {
    /** Structured filters applied to the search */
    filters: {
        /** Filter by album IDs */
        albumIds?: string[];
        /** Filter by file checksum */
        checksum?: string;
        /** Filter by city name */
        city?: string | null;
        /** Filter by country name */
        country?: string | null;
        /** Filter by creation date (after) */
        createdAfter?: string;
        /** Filter by creation date (before) */
        createdBefore?: string;
        /** Cursor for the next page of results */
        cursor?: string;
        /** Filter by description text */
        description?: string;
        /** Filter by encoded video file path */
        encodedVideoPath?: string;
        filter?: SearchFilter;
        /** Filter by asset ID */
        id?: string;
        imageEnrichment?: ImageEnrichmentFilter;
        /** Filter by encoded status */
        isEncoded?: boolean;
        /** Filter by favorite status */
        isFavorite?: boolean;
        /** Filter by motion photo status */
        isMotion?: boolean;
        /** Filter assets not in any album */
        isNotInAlbum?: boolean;
        /** Filter by offline status */
        isOffline?: boolean;
        /** Filter by lens model */
        lensModel?: string | null;
        /** Library ID to filter by */
        libraryId?: string | null;
        /** Filter by camera make */
        make?: string | null;
        /** Filter by camera model */
        model?: string | null;
        /** Filter by OCR text content */
        ocr?: string;
        /** Sort order */
        order?: AssetOrder;
        orderBy?: SearchOrder;
        /** Filter by original file name */
        originalFileName?: string;
        /** Filter by original file path */
        originalPath?: string;
        /** Page number */
        page?: number;
        /** Filter by person IDs */
        personIds?: string[];
        /** Filter by the caller's own pet IDs (confirmed pet observations only) */
        petIds?: string[];
        /** Filter by preview file path */
        previewPath?: string;
        /** Filter by rating [1-5], or null for unrated */
        rating?: number | null;
        /** Number of results to return */
        size?: number;
        /** Filter by state/province name */
        state?: string | null;
        /** Return only suppressed content. Requires an elevated session. */
        suppressedOnly?: boolean;
        /** Filter by tag IDs */
        tagIds?: string[] | null;
        /** Filter by taken date (after) */
        takenAfter?: string;
        /** Filter by taken date (before) */
        takenBefore?: string;
        /** Filter by thumbnail file path */
        thumbnailPath?: string;
        /** Filter by trash date (after) */
        trashedAfter?: string;
        /** Filter by trash date (before) */
        trashedBefore?: string;
        "type"?: AssetTypeEnum;
        /** Filter by update date (after) */
        updatedAfter?: string;
        /** Filter by update date (before) */
        updatedBefore?: string;
        visibility?: AssetVisibility;
        /** Include deleted assets */
        withDeleted?: boolean;
        /** Include EXIF data in response */
        withExif?: boolean;
        /** Include people data in response */
        withPeople?: boolean;
        /** Include stacked assets */
        withStacked?: boolean;
    };
    /** Search mode used to answer the query */
    mode: Mode2;
    /** Normalized query text */
    normalizedQuery: string;
};
export type SearchFacetCountResponseDto = {
    /** Number of assets with this facet value */
    count: number;
    /** Facet value */
    value: string;
};
export type SearchFacetResponseDto = {
    counts: SearchFacetCountResponseDto[];
    /** Facet field name */
    fieldName: string;
};
export type SearchAlbumResponseDto = {
    /** Number of albums in this page */
    count: number;
    facets: SearchFacetResponseDto[];
    items: AlbumResponseDto[];
    /** Total number of matching albums */
    total: number;
};
export type SearchAssetResponseDto = {
    /** Number of assets in this page */
    count: number;
    facets: SearchFacetResponseDto[];
    items: AssetResponseDto[];
    /** Cursor for the next page of results */
    nextCursor: string | null;
    /** Next page token */
    nextPage: string | null;
    /** Total number of matching assets */
    total: number;
};
export type SearchResponseDto = {
    albums: SearchAlbumResponseDto;
    assets: SearchAssetResponseDto;
};
export type AskSearchResponseDto = {
    /** Short explanation of how the query was interpreted */
    explanation: string;
    plan: AskSearchPlanDto;
    /** Original Ask Search query */
    query: string;
    results: SearchResponseDto;
    /** Unsupported or ambiguous parts of the query */
    warnings: string[];
};
export type SearchExploreItem = {
    data: AssetResponseDto;
    /** Explore value */
    value: string;
};
export type SearchExploreResponseDto = {
    /** Explore field name */
    fieldName: string;
    items: SearchExploreItem[];
};
export type MetadataSearchDto = {
    /** Filter by album IDs */
    albumIds?: string[];
    /** Filter by file checksum */
    checksum?: string;
    /** Filter by city name */
    city?: string | null;
    /** Filter by country name */
    country?: string | null;
    /** Filter by creation date (after) */
    createdAfter?: string;
    /** Filter by creation date (before) */
    createdBefore?: string;
    /** Cursor for the next page of results */
    cursor?: string;
    /** Filter by description text */
    description?: string;
    /** Filter by encoded video file path */
    encodedVideoPath?: string;
    filter?: SearchFilter;
    /** Filter by asset ID */
    id?: string;
    imageEnrichment?: ImageEnrichmentFilter;
    /** Filter by encoded status */
    isEncoded?: boolean;
    /** Filter by favorite status */
    isFavorite?: boolean;
    /** Filter by motion photo status */
    isMotion?: boolean;
    /** Filter assets not in any album */
    isNotInAlbum?: boolean;
    /** Filter by offline status */
    isOffline?: boolean;
    /** Filter by lens model */
    lensModel?: string | null;
    /** Library ID to filter by */
    libraryId?: string | null;
    /** Filter by camera make */
    make?: string | null;
    /** Filter by camera model */
    model?: string | null;
    /** Filter by OCR text content */
    ocr?: string;
    /** Sort order */
    order?: AssetOrder;
    orderBy?: SearchOrder;
    /** Filter by original file name */
    originalFileName?: string;
    /** Filter by original file path */
    originalPath?: string;
    /** Page number */
    page?: number;
    /** Filter by person IDs */
    personIds?: string[];
    /** Filter by the caller's own pet IDs (confirmed pet observations only) */
    petIds?: string[];
    /** Filter by preview file path */
    previewPath?: string;
    /** Filter by rating [1-5], or null for unrated */
    rating?: number | null;
    /** Number of results to return */
    size?: number;
    /** Filter by state/province name */
    state?: string | null;
    /** Return only suppressed content. Requires an elevated session. */
    suppressedOnly?: boolean;
    /** Filter by tag IDs */
    tagIds?: string[] | null;
    /** Filter by taken date (after) */
    takenAfter?: string;
    /** Filter by taken date (before) */
    takenBefore?: string;
    /** Filter by thumbnail file path */
    thumbnailPath?: string;
    /** Filter by trash date (after) */
    trashedAfter?: string;
    /** Filter by trash date (before) */
    trashedBefore?: string;
    "type"?: AssetTypeEnum;
    /** Filter by update date (after) */
    updatedAfter?: string;
    /** Filter by update date (before) */
    updatedBefore?: string;
    visibility?: AssetVisibility;
    /** Include deleted assets */
    withDeleted?: boolean;
    /** Include EXIF data in response */
    withExif?: boolean;
    /** Include people data in response */
    withPeople?: boolean;
    /** Include stacked assets */
    withStacked?: boolean;
};
export type PlacesResponseDto = {
    /** Administrative level 1 name (state/province) */
    admin1name?: string;
    /** Administrative level 2 name (county/district) */
    admin2name?: string;
    /** Latitude coordinate */
    latitude: number;
    /** Longitude coordinate */
    longitude: number;
    /** Place name */
    name: string;
};
export type RandomSearchDto = {
    /** Filter by album IDs */
    albumIds?: string[];
    /** Filter by city name */
    city?: string | null;
    /** Filter by country name */
    country?: string | null;
    /** Filter by creation date (after) */
    createdAfter?: string;
    /** Filter by creation date (before) */
    createdBefore?: string;
    filter?: SearchFilter;
    imageEnrichment?: ImageEnrichmentFilter;
    /** Filter by encoded status */
    isEncoded?: boolean;
    /** Filter by favorite status */
    isFavorite?: boolean;
    /** Filter by motion photo status */
    isMotion?: boolean;
    /** Filter assets not in any album */
    isNotInAlbum?: boolean;
    /** Filter by offline status */
    isOffline?: boolean;
    /** Filter by lens model */
    lensModel?: string | null;
    /** Library ID to filter by */
    libraryId?: string | null;
    /** Filter by camera make */
    make?: string | null;
    /** Filter by camera model */
    model?: string | null;
    /** Filter by OCR text content */
    ocr?: string;
    /** Filter by person IDs */
    personIds?: string[];
    /** Filter by the caller's own pet IDs (confirmed pet observations only) */
    petIds?: string[];
    /** Filter by rating [1-5], or null for unrated */
    rating?: number | null;
    /** Number of results to return */
    size?: number;
    /** Filter by state/province name */
    state?: string | null;
    /** Return only suppressed content. Requires an elevated session. */
    suppressedOnly?: boolean;
    /** Filter by tag IDs */
    tagIds?: string[] | null;
    /** Filter by taken date (after) */
    takenAfter?: string;
    /** Filter by taken date (before) */
    takenBefore?: string;
    /** Filter by trash date (after) */
    trashedAfter?: string;
    /** Filter by trash date (before) */
    trashedBefore?: string;
    "type"?: AssetTypeEnum;
    /** Filter by update date (after) */
    updatedAfter?: string;
    /** Filter by update date (before) */
    updatedBefore?: string;
    visibility?: AssetVisibility;
    /** Include deleted assets */
    withDeleted?: boolean;
    /** Include EXIF data in response */
    withExif?: boolean;
    /** Include people data in response */
    withPeople?: boolean;
    /** Include stacked assets */
    withStacked?: boolean;
};
export type SmartSearchDto = {
    /** Filter by album IDs */
    albumIds?: string[];
    /** Filter by city name */
    city?: string | null;
    /** Filter by country name */
    country?: string | null;
    /** Filter by creation date (after) */
    createdAfter?: string;
    /** Filter by creation date (before) */
    createdBefore?: string;
    filter?: SearchFilter;
    imageEnrichment?: ImageEnrichmentFilter;
    /** Filter by encoded status */
    isEncoded?: boolean;
    /** Filter by favorite status */
    isFavorite?: boolean;
    /** Filter by motion photo status */
    isMotion?: boolean;
    /** Filter assets not in any album */
    isNotInAlbum?: boolean;
    /** Filter by offline status */
    isOffline?: boolean;
    /** Search language code */
    language?: string;
    /** Filter by lens model */
    lensModel?: string | null;
    /** Library ID to filter by */
    libraryId?: string | null;
    /** Filter by camera make */
    make?: string | null;
    /** Filter by camera model */
    model?: string | null;
    /** Filter by OCR text content */
    ocr?: string;
    /** Page number */
    page?: number;
    /** Filter by person IDs */
    personIds?: string[];
    /** Filter by the caller's own pet IDs (confirmed pet observations only) */
    petIds?: string[];
    /** Natural language search query */
    query?: string;
    /** Asset ID to use as search reference */
    queryAssetId?: string;
    /** Filter by rating [1-5], or null for unrated */
    rating?: number | null;
    /** Number of results to return */
    size?: number;
    /** Filter by state/province name */
    state?: string | null;
    /** Return only suppressed content. Requires an elevated session. */
    suppressedOnly?: boolean;
    /** Filter by tag IDs */
    tagIds?: string[] | null;
    /** Filter by taken date (after) */
    takenAfter?: string;
    /** Filter by taken date (before) */
    takenBefore?: string;
    /** Filter by trash date (after) */
    trashedAfter?: string;
    /** Filter by trash date (before) */
    trashedBefore?: string;
    "type"?: AssetTypeEnum;
    /** Filter by update date (after) */
    updatedAfter?: string;
    /** Filter by update date (before) */
    updatedBefore?: string;
    visibility?: AssetVisibility;
    /** Include deleted assets */
    withDeleted?: boolean;
    /** Include EXIF data in response */
    withExif?: boolean;
};
export type StatisticsSearchDto = {
    /** Filter by album IDs */
    albumIds?: string[];
    /** Filter by city name */
    city?: string | null;
    /** Filter by country name */
    country?: string | null;
    /** Filter by creation date (after) */
    createdAfter?: string;
    /** Filter by creation date (before) */
    createdBefore?: string;
    /** Filter by description text */
    description?: string;
    filter?: SearchFilter;
    imageEnrichment?: ImageEnrichmentFilter;
    /** Filter by encoded status */
    isEncoded?: boolean;
    /** Filter by favorite status */
    isFavorite?: boolean;
    /** Filter by motion photo status */
    isMotion?: boolean;
    /** Filter assets not in any album */
    isNotInAlbum?: boolean;
    /** Filter by offline status */
    isOffline?: boolean;
    /** Filter by lens model */
    lensModel?: string | null;
    /** Library ID to filter by */
    libraryId?: string | null;
    /** Filter by camera make */
    make?: string | null;
    /** Filter by camera model */
    model?: string | null;
    /** Filter by OCR text content */
    ocr?: string;
    /** Filter by person IDs */
    personIds?: string[];
    /** Filter by the caller's own pet IDs (confirmed pet observations only) */
    petIds?: string[];
    /** Filter by rating [1-5], or null for unrated */
    rating?: number | null;
    /** Filter by state/province name */
    state?: string | null;
    /** Return only suppressed content. Requires an elevated session. */
    suppressedOnly?: boolean;
    /** Filter by tag IDs */
    tagIds?: string[] | null;
    /** Filter by taken date (after) */
    takenAfter?: string;
    /** Filter by taken date (before) */
    takenBefore?: string;
    /** Filter by trash date (after) */
    trashedAfter?: string;
    /** Filter by trash date (before) */
    trashedBefore?: string;
    "type"?: AssetTypeEnum;
    /** Filter by update date (after) */
    updatedAfter?: string;
    /** Filter by update date (before) */
    updatedBefore?: string;
    visibility?: AssetVisibility;
};
export type SearchStatisticsResponseDto = {
    /** Total number of matching assets */
    total: number;
};
export type ServerAboutResponseDto = {
    /** Build identifier */
    build?: string;
    /** Build image name */
    buildImage?: string;
    /** Build image URL */
    buildImageUrl?: string;
    /** Build URL */
    buildUrl?: string;
    /** ExifTool version */
    exiftool?: string;
    /** FFmpeg version */
    ffmpeg?: string;
    /** ImageMagick version */
    imagemagick?: string;
    /** LibRaw/dcraw_emu version */
    libraw?: string;
    /** libvips version */
    libvips?: string;
    /** Whether the server is licensed */
    licensed: boolean;
    /** Node.js version */
    nodejs?: string;
    /** Repository name */
    repository?: string;
    /** Repository URL */
    repositoryUrl?: string;
    /** Source commit hash */
    sourceCommit?: string;
    /** Source reference (branch/tag) */
    sourceRef?: string;
    /** Source URL */
    sourceUrl?: string;
    /** Third-party bug/feature URL */
    thirdPartyBugFeatureUrl?: string;
    /** Third-party documentation URL */
    thirdPartyDocumentationUrl?: string;
    /** Third-party source URL */
    thirdPartySourceUrl?: string;
    /** Third-party support URL */
    thirdPartySupportUrl?: string;
    /** Server version */
    version: string;
    /** URL to version information */
    versionUrl: string;
};
export type ServerApkLinksDto = {
    /** APK download link for ARM64 v8a architecture */
    arm64v8a: string;
    /** APK download link for ARM EABI v7a architecture */
    armeabiv7a: string;
    /** APK download link for universal architecture */
    universal: string;
    /** APK download link for x86_64 architecture */
    x86_64: string;
};
export type ServerConfigDto = {
    /** Canonical default for the image-description advanced raw prompt template */
    defaultImageDescriptionRawPromptTemplate: string;
    /** External domain URL */
    externalDomain: string;
    /** Whether the server has been initialized */
    isInitialized: boolean;
    /** Whether the admin has completed onboarding */
    isOnboarded: boolean;
    /** Login page message */
    loginPageMessage: string;
    /** Whether maintenance mode is active */
    maintenanceMode: boolean;
    /** Map dark style URL */
    mapDarkStyleUrl: string;
    /** Map light style URL */
    mapLightStyleUrl: string;
    /** People min faces server default */
    minFaces: number;
    /** OAuth account management URL */
    oauthAccountManagementUrl?: string;
    /** OAuth button text */
    oauthButtonText: string;
    /** Whether public user registration is enabled */
    publicUsers: boolean;
    /** Number of days before trashed assets are permanently deleted */
    trashDays: number;
    /** Delay in days before deleted users are permanently removed */
    userDeleteDelay: number;
};
export type ServerFeaturesDto = {
    /** Whether config file is available */
    configFile: boolean;
    /** Whether duplicate detection is enabled */
    duplicateDetection: boolean;
    /** Whether email notifications are enabled */
    email: boolean;
    /** Whether facial recognition is enabled */
    facialRecognition: boolean;
    /** Whether image description and tag generation is enabled */
    imageDescription: boolean;
    /** Whether face import is enabled */
    importFaces: boolean;
    /** Whether map feature is enabled */
    map: boolean;
    /** Whether NSFW detection is enabled */
    nsfwDetection: boolean;
    /** Whether NSFW-tagged assets are hidden from non-elevated library views */
    nsfwHiding: boolean;
    /** Whether OAuth is enabled */
    oauth: boolean;
    /** Whether OAuth auto-launch is enabled */
    oauthAutoLaunch: boolean;
    /** Whether OCR is enabled */
    ocr: boolean;
    /** Whether password login is enabled */
    passwordLogin: boolean;
    /** Whether physical file deduplication is enabled */
    physicalDeduplication: boolean;
    /** Whether real-time transcoding is enabled */
    realtimeTranscoding: boolean;
    /** Whether reverse geocoding is enabled */
    reverseGeocoding: boolean;
    /** Whether search is enabled */
    search: boolean;
    /** Whether sidecar files are supported */
    sidecar: boolean;
    /** Whether smart search is enabled */
    smartSearch: boolean;
    /** Whether trash feature is enabled */
    trash: boolean;
};
export type LicenseKeyDto = {
    /** Activation key */
    activationKey: string;
    /** License key (format: /^IM(SV|CL)(-[\dA-Za-z]{4}){8}$/) */
    licenseKey: string;
};
export type ServerMediaTypesResponseDto = {
    /** Supported image MIME types */
    image: string[];
    /** Supported sidecar MIME types */
    sidecar: string[];
    /** Supported video MIME types */
    video: string[];
};
export type ServerPingResponse = {
    res: string;
};
export type UsageByUserDto = {
    /** Number of photos */
    photos: number;
    /** User quota size in bytes (null if unlimited) */
    quotaSizeInBytes: number | null;
    /** Total storage usage in bytes */
    usage: number;
    /** Storage usage for photos in bytes */
    usagePhotos: number;
    /** Storage usage for videos in bytes */
    usageVideos: number;
    /** User ID */
    userId: string;
    /** User name */
    userName: string;
    /** Number of videos */
    videos: number;
};
export type ServerStatsResponseDto = {
    /** Total number of photos */
    photos: number;
    /** Total storage usage in bytes */
    usage: number;
    /** Array of usage for each user */
    usageByUser: UsageByUserDto[];
    /** Storage usage for photos in bytes */
    usagePhotos: number;
    /** Storage usage for videos in bytes */
    usageVideos: number;
    /** Total number of videos */
    videos: number;
};
export type ServerStorageResponseDto = {
    /** Available disk space (human-readable format) */
    diskAvailable: string;
    /** Available disk space in bytes */
    diskAvailableRaw: number;
    /** Total disk size (human-readable format) */
    diskSize: string;
    /** Total disk size in bytes */
    diskSizeRaw: number;
    /** Disk usage percentage (0-100) */
    diskUsagePercentage: number;
    /** Used disk space (human-readable format) */
    diskUse: string;
    /** Used disk space in bytes */
    diskUseRaw: number;
};
export type ServerVersionResponseDto = {
    /** Major version number */
    major: number;
    /** Minor version number */
    minor: number;
    /** Patch version number */
    patch: number;
    /** Pre-release version number */
    prerelease: number | null;
};
export type VersionCheckStateResponseDto = {
    /** Last check timestamp */
    checkedAt: string | null;
    /** Release version */
    releaseVersion: string | null;
};
export type ServerVersionHistoryResponseDto = {
    /** When this version was first seen */
    createdAt: string;
    /** Version history entry ID */
    id: string;
    /** Version string */
    version: string;
};
export type SessionCreateDto = {
    /** Device OS */
    deviceOS?: string;
    /** Device type */
    deviceType?: string;
    /** Session duration in seconds */
    duration?: number;
};
export type SessionCreateResponseDto = {
    /** App version */
    appVersion: string | null;
    /** Creation date */
    createdAt: string;
    /** Is current session */
    current: boolean;
    /** Device OS */
    deviceOS: string;
    /** Device type */
    deviceType: string;
    /** Expiration date */
    expiresAt?: string;
    /** Session ID */
    id: string;
    /** Is pending sync reset */
    isPendingSyncReset: boolean;
    /** Session token */
    token: string;
    /** Last update date */
    updatedAt: string;
};
export type SessionUpdateDto = {
    /** Reset pending sync state */
    isPendingSyncReset?: boolean;
};
export type SharedSpacePreviewResponseDto = {
    /** True once the recipient has joined the space */
    accepted: boolean;
    /** Shared space name */
    albumName: string;
    /** Items the recipient would see. Media marked sensitive, and Locked media, are not counted. */
    assetCount: number;
    /** Shared space description */
    description: string;
    /** Latest item date, sensitive and Locked media excluded */
    endDate?: string;
    /** Icon: a Material Design Icons name (null = default icon) */
    icon: string | null;
    /** Shared space ID */
    id: string;
    /** When the invitation was sent */
    invitedAt: string;
    /** Who sent the invitation */
    invitedBy: UserResponseDto | null;
    /** People already in the shared space, including its owner */
    memberCount: number;
    /** Who owns the shared space */
    owner: UserResponseDto;
    /** The role the recipient gets on accept */
    role: AlbumUserRole;
    /** Earliest item date, sensitive and Locked media excluded */
    startDate?: string;
};
export type SharedSpaceMemberResponseDto = {
    /** When a pending invitation was sent */
    invitedAt?: string;
    /** True while the invitation has not been accepted */
    pending: boolean;
    role: AlbumUserRole;
    user: UserResponseDto;
};
export type SharedSpaceMembersResponseDto = {
    /** Members and pending invitations, owner first */
    members: SharedSpaceMemberResponseDto[];
};
export type SharedSpaceEventResponseDto = {
    /** The comment or like this event announces, if any */
    activityId: string | null;
    /** Who did it; null once that account is gone */
    actor: UserResponseDto | null;
    /** How many of the items this event is about the reader may see */
    assetCount: number;
    /** The items this event is about that the reader may see and that are still in the shared space. Empty for a removal. */
    assetIds: string[];
    /** The comment text, for a comment or reply event. Mentions are @{userId} tokens. */
    comment: string | null;
    /** When it happened */
    createdAt: string;
    /** Event ID */
    id: string;
    /** Members named in the comment */
    mentions: UserResponseDto[];
    /** A linked album's or person's name as the space knew it, or the new role; null otherwise */
    subject: string | null;
    /** The member a member event is about, or the author of the comment a reply answers; null otherwise */
    targetUser: UserResponseDto | null;
    "type": SharedSpaceEventType;
};
export type SharedSpaceActivityResponseDto = {
    /** Newest first */
    events: SharedSpaceEventResponseDto[];
    /** True when older events exist beyond this page */
    hasMore: boolean;
    /** When this member last marked the shared space seen; null if they never have */
    lastVisitedAt: string | null;
    /** Events by other members since then that this member may see. Capped at 500. */
    unreadCount: number;
};
export type SharedSpaceAlbumResponseDto = {
    /** The linked album name */
    albumName: string;
    /** Items that are in both this album and the shared space. Media marked sensitive, and Locked media, are not counted. */
    assetCount: number;
    /** True when the caller may remove this link */
    canUnlink: boolean;
    /** Icon: a Material Design Icons name (null = default icon) */
    icon: string | null;
    /** The linked album ID */
    id: string;
    /** When the album was linked */
    linkedAt: string;
    /** The member who linked this album */
    linkedBy: UserResponseDto | null;
    /** An item that is already in the shared space, used as the tile picture */
    thumbnailAssetId: string | null;
};
export type SharedSpaceAlbumsResponseDto = {
    /** Albums linked into the shared space, by name */
    albums: SharedSpaceAlbumResponseDto[];
};
export type SharedSpaceCommentResponseDto = {
    /** The item commented on; null for a comment on the space itself */
    assetId: string | null;
    /** True when the caller may remove the comment */
    canDelete: boolean;
    /** True when the caller may change the text */
    canEdit: boolean;
    /** The text, with @{userId} mention tokens */
    comment: string;
    /** When it was written */
    createdAt: string;
    /** Comment ID */
    id: string;
    /** Members named in the comment */
    mentions: UserResponseDto[];
    /** The top-level comment this reply answers; null for a top-level comment */
    parentId: string | null;
    /** How many replies this comment has that the caller can see; always 0 for a reply */
    replyCount: number;
    /** When it was last edited */
    updatedAt: string;
    /** The author */
    user: UserResponseDto;
};
export type SharedSpaceCommentsResponseDto = {
    /** Oldest first */
    comments: SharedSpaceCommentResponseDto[];
};
export type SharedSpaceCommentCreateDto = {
    /** The item to comment on. Left out, the comment is on the space itself. */
    assetId?: string;
    /** The text. Mention a member with @{userId}; every mention must name a current member. */
    comment: string;
    /** Reply to this comment. Replying to a reply joins the same thread, under its top-level comment. A reply is on the same item as the comment it answers. */
    parentId?: string;
};
export type SharedSpaceCommentUpdateDto = {
    /** The text. Mention a member with @{userId}; every mention must name a current member. */
    comment: string;
};
export type SharedSpaceNewResponseDto = {
    /** Items other members added since then */
    assetCount: number;
    /** Up to 500 of those items, so the timeline can show exactly what is new */
    assetIds: string[];
    /** When this member last marked the shared space seen; null if they never have */
    lastVisitedAt: string | null;
};
export type SharedSpacePersonResponseDto = {
    /** Items in the shared space that show this person. Media marked sensitive, and Locked media, are not counted. */
    assetCount: number;
    /** True when the caller may remove this link */
    canUnlink: boolean;
    /** An item already in the shared space that shows this person, used as the tile picture */
    coverAssetId: string | null;
    /** The link ID. Not a person ID: a person is never disclosed across a space. */
    id: string;
    /** When the person was linked */
    linkedAt: string;
    /** The member who linked this person */
    linkedBy: UserResponseDto;
    /** The name this shared space uses, independent of the owner's own name for them */
    name: string;
};
export type SharedSpacePeopleResponseDto = {
    /** People of the caller's own that appear in the shared space and are not linked yet. Only the caller's own people are ever listed here. */
    candidates: PersonResponseDto[];
    /** People published into the shared space */
    linked: SharedSpacePersonResponseDto[];
};
export type SharedSpacePersonLinkDto = {
    /** The name the shared space will use. Defaults to the caller's own name for them. */
    name?: string;
    /** A person of the caller's own to publish into the shared space */
    personId: string;
};
export type SharedLinkResponseDto = {
    album?: AlbumResponseDto;
    /** Allow downloads */
    allowDownload: boolean;
    /** Allow uploads */
    allowUpload: boolean;
    assets: AssetResponseDto[];
    /** Creation date */
    createdAt: string;
    /** Link description */
    description: string | null;
    /** Expiration date */
    expiresAt: string | null;
    /** Shared link ID */
    id: string;
    /** Encryption key (base64url) */
    key: string;
    /** Has password */
    password: string | null;
    /** Show metadata */
    showMetadata: boolean;
    /** Custom URL slug */
    slug: string | null;
    "type": SharedLinkType;
    /** Owner user ID */
    userId: string;
};
export type SharedLinkCreateDto = {
    /** Album ID (for album sharing) */
    albumId?: string;
    /** Allow downloads */
    allowDownload?: boolean;
    /** Allow uploads */
    allowUpload?: boolean;
    /** Asset IDs (for individual assets) */
    assetIds?: string[];
    /** Link description */
    description?: string | null;
    /** Expiration date */
    expiresAt?: string | null;
    /** Link password */
    password?: string | null;
    /** Show metadata */
    showMetadata?: boolean;
    /** Custom URL slug */
    slug?: string | null;
    "type": SharedLinkType;
};
export type SharedLinkLoginDto = {
    /** Shared link password */
    password: string;
};
export type SharedLinkEditDto = {
    /** Allow downloads */
    allowDownload?: boolean;
    /** Allow uploads */
    allowUpload?: boolean;
    /** Link description */
    description?: string | null;
    /** Expiration date */
    expiresAt?: string | null;
    /** Link password */
    password?: string | null;
    /** Show metadata */
    showMetadata?: boolean;
    /** Custom URL slug */
    slug?: string | null;
};
export type AssetIdsDto = {
    /** Asset IDs */
    assetIds: string[];
};
export type AssetIdsResponseDto = {
    /** Asset ID */
    assetId: string;
    error?: AssetIdErrorReason;
    /** Whether operation succeeded */
    success: boolean;
};
export type StackResponseDto = {
    assets: AssetResponseDto[];
    /** Stack ID */
    id: string;
    /** Primary asset ID */
    primaryAssetId: string;
};
export type StackCreateDto = {
    /** Asset IDs (first becomes primary, min 2) */
    assetIds: string[];
};
export type StackUpdateDto = {
    /** Primary asset ID */
    primaryAssetId?: string;
};
export type StudioProjectLeaseDto = {
    /** Pause in editing after which the client saves */
    autosaveDebounceMs: number;
    /** When the current lease lapses */
    expiresAt: string | null;
    /** A live lease belongs to another editor instance */
    heldByAnother: boolean;
    /** This client holds the write lease */
    heldByYou: boolean;
    /** Lease length the server grants */
    leaseMs: number;
    /** How often the holder should renew */
    renewMs: number;
};
export type StudioProjectDto = {
    access: StudioProjectAccess;
    /** When the owner archived it */
    archivedAt: string | null;
    createdAt: string;
    /** When it was moved to the trash */
    deletedAt: string | null;
    /** The project this one was duplicated from; null for a reviewer */
    duplicatedFromId: string | null;
    /** Studio project ID */
    id: string;
    /** The project was read in from a portable bundle; always false for a reviewer */
    importedFromBundle: boolean;
    /** When an editor last opened it; null for a reviewer */
    lastOpenedAt: string | null;
    lease: StudioProjectLeaseDto;
    name: string;
    /** The only account that may write */
    ownerId: string;
    /** When a trashed project is deleted for good; its library media is never touched */
    purgeAfter: string | null;
    /** Head revision number; 0 until the first save */
    revision: number;
    shelf: StudioProjectShelf;
    /** Shared space whose members may review the project */
    spaceId: string | null;
    /** Library asset the owner chose as the poster; null for a reviewer */
    thumbnailAssetId: string | null;
    updatedAt: string;
};
export type StudioProjectListResponseDto = {
    items: StudioProjectDto[];
    /** Matching projects, before paging */
    total: number;
};
export type StudioProjectEnvelopeDto = {
    /** The engine that produced the graph; `freecut` */
    engine: string;
    /** Pinned engine revision the editor was built from */
    engineRevision: string;
    /** Opaque engine document, stored and returned byte for byte */
    graph: {
        [key: string]: any;
    };
    /** Envelope shape version; the server accepts exactly one */
    schemaVersion: number;
};
export type StudioProjectResourcesDto = {
    /** When the resolution ran */
    checkedAt: string;
    /** Every referenced source resolved for the acting account */
    complete: boolean;
    /** References that were refused for the acting account */
    refusedCount: number;
};
export type StudioProjectDetailDto = {
    access: StudioProjectAccess;
    /** When the owner archived it */
    archivedAt: string | null;
    createdAt: string;
    /** When it was moved to the trash */
    deletedAt: string | null;
    /** Key-sorted SHA-256 of the head envelope; null when withheld */
    digest: string | null;
    /** The project this one was duplicated from; null for a reviewer */
    duplicatedFromId: string | null;
    envelope: (StudioProjectEnvelopeDto) | null;
    /** Studio project ID */
    id: string;
    /** The project was read in from a portable bundle; always false for a reviewer */
    importedFromBundle: boolean;
    /** When an editor last opened it; null for a reviewer */
    lastOpenedAt: string | null;
    lease: StudioProjectLeaseDto;
    name: string;
    /** The only account that may write */
    ownerId: string;
    /** When a trashed project is deleted for good; its library media is never touched */
    purgeAfter: string | null;
    resources: (StudioProjectResourcesDto) | null;
    /** Head revision number; 0 until the first save */
    revision: number;
    shelf: StudioProjectShelf;
    /** Shared space whose members may review the project */
    spaceId: string | null;
    /** Library asset the owner chose as the poster; null for a reviewer */
    thumbnailAssetId: string | null;
    updatedAt: string;
    /** The graph was withheld because a source is unavailable to you */
    withheld: boolean;
};
export type StudioProjectCreateDto = {
    /** This editor instance; it receives the lease */
    clientId: string;
    /** An initial document, saved as revision 1 */
    envelope?: StudioProjectEnvelopeDto;
    name: string;
    /** Idempotency key for the initial save */
    requestKey?: string;
    /** Share the project with a shared space for review */
    spaceId?: string | null;
};
export type StudioProjectUpdateDto = {
    /** Archive (read-only, off the active shelf) or bring back */
    archived?: boolean;
    name?: string;
    /** Set or clear the reviewing shared space */
    spaceId?: string | null;
    /** A library asset you can read, shown as the poster; null clears it */
    thumbnailAssetId?: string | null;
};
export type StudioProjectDuplicateDto = {
    /** Name of the copy; the client supplies the translated default */
    name?: string;
};
export type StudioProjectTrashEmptyResponseDto = {
    /** Projects deleted for good */
    count: number;
};
export type StudioBundleExportCreateDto = {
    /** Copy the media you own into the bundle. Shared media always travels as a reference, and nothing Locked is ever copied. */
    includeMedia?: boolean;
    /** Idempotency key; a repeated submit answers with the first job */
    requestKey?: string;
};
export type StudioBundleUploadCreateDto = {
    /** A `.frameleaf-studio.zip` bundle */
    file: Blob;
};
export type StudioBundleSourceDto = {
    contentType: string | null;
    fileName: string | null;
    /** Identifier on the exporting server */
    id: string;
    /** Mapping key for the import request */
    key: string;
    /** `library-asset` or `edited-master` */
    kind: string;
    mode: StudioBundleSourceMode;
    resolution: StudioBundleSourceResolution;
    /** Size of the source file, when the exporting server knew it */
    sizeBytes: string | null;
    /** An asset of yours with the same content */
    suggestedAssetId: string | null;
};
export type StudioBundleUploadDto = {
    /** When an import first read it */
    consumedAt: string | null;
    /** SHA-256 of the whole file */
    digest: string;
    engineRevision: string;
    /** When the upload is discarded */
    expiresAt: string;
    exportedAt: string;
    /** The file name as uploaded */
    fileName: string;
    /** Upload ID, used to start an import */
    id: string;
    producerVersion: string;
    projectName: string;
    /** The revision the bundle was made from */
    revision: number;
    sizeBytes: string;
    sources: StudioBundleSourceDto[];
};
export type StudioBundleImportCreateDto = {
    /** Source key to an asset of yours to use in its place; every choice is checked for access */
    mapping?: {
        [key: string]: string;
    };
    /** Name of the new project; the bundle name when omitted */
    name?: string;
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    requestKey?: string;
    uploadId: string;
};
export type StudioBundleExportResultDto = {
    /** SHA-256 of the finished file */
    digest: string;
    /** The file can still be downloaded */
    downloadable: boolean;
    /** Sources copied into the bundle */
    embedded: number;
    expiresAt: string;
    fileName: string;
    /** Sources that travel as references */
    referenced: number;
    sizeBytes: string;
};
export type StudioBundleMissingSourceDto = {
    /** The bundle carries a verified copy that can be added to the library later */
    embedded: boolean;
    fileName: string | null;
    id: string;
    key: string;
    kind: string;
};
export type StudioBundleImportResultDto = {
    embeddedVerified: number;
    kept: number;
    missing: StudioBundleMissingSourceDto[];
    /** The project the import created */
    projectId: string | null;
    relinked: number;
};
export type StudioBundleOperationDto = {
    attempt: number;
    /** Automatic retries this job has used; every job gets one before a failure is reported */
    autoRetries: number;
    error: string | null;
    errorCode: string | null;
    "export": (StudioBundleExportResultDto) | null;
    "import": (StudioBundleImportResultDto) | null;
    kind: MediaOperationKind;
    maxAttempts: number;
    operationId: string;
    progress: number;
    /** The exported project, or the project an import created */
    projectId: string | null;
    /** When a job waiting for its automatic retry may run again */
    retryAt: string | null;
    status: MediaOperationStatus;
};
export type StudioProjectLeaseRequestDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    clientId: string;
    /** Take a live lease away from another of your editor instances; never implicit */
    takeover?: boolean;
};
export type StudioCommandSummaryDto = {
    /** Command id to how many times it appeared */
    counts: {
        [key: string]: number;
    };
    /** Commands in the batch */
    total: number;
};
export type StudioProjectSaveResponseDto = {
    /** Digest of the head envelope */
    digest: string;
    lease: StudioProjectLeaseDto;
    /** This request key was already accepted; the earlier result is returned */
    replayed: boolean;
    /** The head after this request */
    revision: number;
    /** The revision row; null when nothing was written */
    revisionId: string | null;
    /** The document equals the head, so no revision was written */
    unchanged: boolean;
};
export type StudioProjectSaveDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    clientId: string;
    envelope: StudioProjectEnvelopeDto;
    /** The head this document was built on */
    expectedRevision: number;
    /** Stable per attempt; a retry carries the same key */
    requestKey: string;
    summary?: StudioCommandSummaryDto;
};
export type StudioProjectRevisionDto = {
    authorId: string | null;
    createdAt: string;
    /** Null for a reviewer; the digest travels with the graph */
    digest: string | null;
    graphBytes: number;
    id: string;
    /** Set when this revision restored an earlier one */
    restoredFromRevision: number | null;
    revision: number;
    summary: StudioCommandSummaryDto;
};
export type StudioProjectHistoryResponseDto = {
    /** Newest first */
    items: StudioProjectRevisionDto[];
    total: number;
};
export type StudioProjectRestoreDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    clientId: string;
    /** The current head; the restore appends after it */
    expectedRevision: number;
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    requestKey: string;
    /** The historical revision to bring back */
    revision: number;
};
export type StudioProjectRevisionDetailDto = {
    authorId: string | null;
    createdAt: string;
    /** Null for a reviewer; the digest travels with the graph */
    digest: string | null;
    envelope: (StudioProjectEnvelopeDto) | null;
    graphBytes: number;
    id: string;
    resources: (StudioProjectResourcesDto) | null;
    /** Set when this revision restored an earlier one */
    restoredFromRevision: number | null;
    revision: number;
    summary: StudioCommandSummaryDto;
    withheld: boolean;
};
export type StudioProjectDiffDto = {
    added: number;
    /** Size change of the serialized graph */
    byteDelta: number;
    changed: number;
    /** Commands the saves between the two revisions reported */
    commands: StudioCommandSummaryDto;
    from: number;
    /** The two envelopes have the same digest */
    identical: boolean;
    /** Changed graph paths, aggregated and capped */
    paths: string[];
    removed: number;
    to: number;
    /** More paths changed than are listed */
    truncated: boolean;
};
export type StudioTimeDto = {
    /** Denominator */
    den: number;
    /** Numerator; zero is the start of the sequence */
    num: number;
};
export type StudioCommentDto = {
    authorId: string;
    createdAt: string;
    id: string;
    projectId: string;
    resolvedAt: string | null;
    resolvedById: string | null;
    /** The revision the reviewer was looking at */
    revision: number;
    text: string;
    time: StudioTimeDto;
    updatedAt: string;
};
export type StudioCommentListResponseDto = {
    /** Oldest first */
    items: StudioCommentDto[];
    total: number;
};
export type StudioCommentCreateDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    requestKey?: string;
    revision: number;
    text: string;
    time: StudioTimeDto;
};
export type StudioCommentUpdateDto = {
    resolved?: boolean;
    text?: string;
};
export type SyncAckDeleteDto = {
    /** Sync entity types to delete acks for */
    types?: SyncEntityType[];
};
export type SyncAckDto = {
    /** Acknowledgment ID */
    ack: string;
    "type": SyncEntityType;
};
export type SyncAckSetDto = {
    /** Acknowledgment IDs (max 1000) */
    acks: string[];
};
export type SyncStreamDto = {
    /** Reset sync state */
    reset?: boolean;
    /** Sync request types */
    types: SyncRequestType[];
};
export type ImageDescriptionRequeueResponseDto = {
    /** Whether the queue-all job was newly enqueued (false = already in-flight) */
    queued: boolean;
};
export type ImageDescriptionRequeueEstimateDto = {
    /** Configured hardware acceleration backend (e.g. "auto", "cuda") */
    activeBackend: string;
    /** Configured image description model name */
    activeModel: string;
    /** Estimated wall-clock time to re-describe every eligible asset (force mode: every asset is re-processed, not just those without descriptions). */
    estimatedTotalSeconds: number;
    /** Average seconds per asset, computed as a rolling mean of the most recent 100 completed image-description jobs. Falls back to a 1.5s default when no jobs have completed since the server started. */
    rollingAvgSeconds: number;
    /** Total eligible image assets */
    totalAssets: number;
    /** Number of eligible assets that currently have a description (will be re-run on force-requeue). */
    withDescription: number;
    /** Number of eligible assets that currently have no description. */
    withoutDescription: number;
};
export type MachineLearningHardwareResponseDto = {
    /** Available PyTorch CUDA device count */
    cudaDeviceCount: number;
    /** Available OpenVINO device IDs */
    openvinoDeviceIds: string[];
    /** Detected preferred hardware acceleration */
    preferredAcceleration: MachineLearningHardwareAcceleration;
    /** Available ONNX Runtime providers */
    providers: string[];
    /** Whether PyTorch CUDA is available */
    torchCudaAvailable: boolean;
};
export type SmartAlbumReevaluateRequestDto = {
    /** Optional built-in kind to scope the re-evaluation to. Omit to re-evaluate every enabled kind. */
    kind?: Kind;
};
export type SmartAlbumReevaluateResponseDto = {
    /** Whether the re-evaluate job was newly enqueued (false = already in-flight) */
    queued: boolean;
};
export type SmartAlbumReevaluateEstimateDto = {
    /** Total image assets that will be evaluated (currently equals withDescription) */
    totalAssets: number;
    /** Image assets with a successfully completed description */
    withDescription: number;
};
export type SystemConfigTemplateStorageOptionDto = {
    /** Available day format options for storage template */
    dayOptions: string[];
    /** Available hour format options for storage template */
    hourOptions: string[];
    /** Available minute format options for storage template */
    minuteOptions: string[];
    /** Available month format options for storage template */
    monthOptions: string[];
    /** Available preset template options */
    presetOptions: string[];
    /** Available second format options for storage template */
    secondOptions: string[];
    /** Available week format options for storage template */
    weekOptions: string[];
    /** Available year format options for storage template */
    yearOptions: string[];
};
export type AdminOnboardingUpdateDto = {
    /** Is admin onboarded */
    isOnboarded: boolean;
};
export type ReverseGeocodingStateResponseDto = {
    /** Last import file name */
    lastImportFileName: string | null;
    /** Last update timestamp */
    lastUpdate: string | null;
};
export type TagCreateDto = {
    /** Tag color (hex) */
    color?: string | null;
    /** Tag name */
    name: string;
    /** Parent tag ID */
    parentId?: string | null;
};
export type TagUpsertDto = {
    /** Tag names to upsert */
    tags: string[];
};
export type TagBulkAssetsDto = {
    /** Asset IDs */
    assetIds: string[];
    /** Tag IDs */
    tagIds: string[];
};
export type TagBulkAssetsResponseDto = {
    /** Number of assets tagged */
    count: number;
};
export type TagUpdateDto = {
    /** Tag color (hex) */
    color?: string | null;
    /** Tag name */
    name?: string;
};
export type TimeBucketAssetResponseDto = {
    /** Array of city names extracted from EXIF GPS data */
    city?: (string | null)[];
    /** Array of country names extracted from EXIF GPS data */
    country?: (string | null)[];
    /** Array of UTC timestamps when each asset was originally uploaded to Immich */
    createdAt: string[];
    /** Array of video/gif durations in milliseconds (null for static images) */
    duration: (number | null)[];
    /** Array of file creation timestamps in UTC */
    fileCreatedAt: string[];
    /** Array of asset IDs in the time bucket */
    id: string[];
    /** Array indicating whether each asset is favorited */
    isFavorite: boolean[];
    /** Array indicating whether each asset is an image (false for videos) */
    isImage: boolean[];
    /** Array indicating whether each asset is in the trash */
    isTrashed: boolean[];
    /** Array of latitude coordinates extracted from EXIF GPS data */
    latitude?: (number | null)[];
    /** Array of live photo video asset IDs (null for non-live photos) */
    livePhotoVideoId: (string | null)[];
    /** Array of UTC offset hours at the time each photo was taken. Positive values are east of UTC, negative values are west of UTC. Values may be fractional (e.g., 5.5 for +05:30, -9.75 for -09:45). Applying this offset to 'fileCreatedAt' will give you the time the photo was taken from the photographer's perspective. */
    localOffsetHours: number[];
    /** Why each asset is locked, or null when it is not. Returned with visibility LOCKED and for the timeline of an elevated owner, which reveals their marked and detected items */
    lockReason?: (AssetLockReason | null)[];
    /** Array of longitude coordinates extracted from EXIF GPS data */
    longitude?: (number | null)[];
    /** Array of owner IDs for each asset */
    ownerId: string[];
    /** Array of projection types for 360° content (e.g., "EQUIRECTANGULAR", "CUBEFACE", "CYLINDRICAL") */
    projectionType: (string | null)[];
    /** Array of aspect ratios (width/height) for each asset */
    ratio: number[];
    /** Array of stack information as [stackId, assetCount] tuples (null for non-stacked assets) */
    stack?: (string[] | null)[];
    /** Array of BlurHash strings for generating asset previews (base64 encoded) */
    thumbhash: (string | null)[];
    /** Array of visibility statuses for each asset (e.g., ARCHIVE, TIMELINE, HIDDEN, LOCKED) */
    visibility: AssetVisibility[];
};
export type TimeBucketsResponseDto = {
    /** Number of assets in this time bucket */
    count: number;
    /** Time bucket identifier in YYYY-MM-DD format representing the start of the time period */
    timeBucket: string;
};
export type TrashResponseDto = {
    /** Number of items in trash */
    count: number;
};
export type TrashApplyDto = {
    action: TrashReviewAction;
    /** The chosen items, for trash, restore and delete. Ignored by restore-all and empty. */
    ids?: string[];
    /** The token returned by the review */
    token: string;
};
export type TrashItemResponseDto = {
    /** Size of the original, in bytes, when known */
    fileSizeInByte: number | null;
    /** Asset ID */
    id: string;
    /** Locked media; only listed for its owner in an unlocked session */
    isLocked: boolean;
    /** The library scan found this external original missing and manages it; trash actions do not change it */
    isOffline: boolean;
    /** Original file name */
    originalFileName: string;
    /** When the item was moved to the trash */
    trashedAt: string | null;
    "type": AssetTypeEnum;
};
export type TrashItemsResponseDto = {
    items: TrashItemResponseDto[];
    /** The next page number, or null on the last page */
    nextPage: string | null;
    /** Items matching the filters */
    total: number;
};
export type TrashReviewDto = {
    action: TrashReviewAction;
    /** The chosen items, for trash, restore and delete. Ignored by restore-all and empty. */
    ids?: string[];
};
export type TrashReviewResponseDto = {
    action: TrashReviewAction;
    /** Combined size of their originals, in bytes */
    bytes: number;
    /** Items the action will change */
    count: number;
    /** The first file names, alphabetically */
    names: string[];
    /** Size of those shared originals, in bytes */
    retainedBytes: number;
    /** Items whose original another item still uses; deleting them does not free that file */
    retainedOriginals: number;
    /** Fingerprint of the reviewed set; apply refuses when the set has changed */
    token: string;
};
export type TrashSummaryResponseDto = {
    /** Combined size of their originals, in bytes. Not the space deleting them frees. */
    bytes: number;
    /** Items in your trash this session can see */
    count: number;
    /** Of those, external-library originals that went missing; the library scan manages them */
    offline: number;
    /** Items already permanently deleted whose files are still being removed from storage */
    pendingDeletion: number;
};
export type UserUpdateMeDto = {
    avatarColor?: (UserAvatarColor) | null;
    /** User email */
    email?: string;
    /** User name */
    name?: string;
    /** User password (deprecated, use change password endpoint) */
    password?: string;
};
export type OnboardingResponseDto = {
    /** Is user onboarded */
    isOnboarded: boolean;
};
export type OnboardingDto = {
    /** Is user onboarded */
    isOnboarded: boolean;
};
export type CreateProfileImageDto = {
    /** ID of the photo the image was copied from, if any. A Locked photo is refused. */
    assetId?: string;
    /** Profile image file */
    file: Blob;
};
export type CreateProfileImageResponseDto = {
    /** Profile image change date */
    profileChangedAt: string;
    /** Profile image file path */
    profileImagePath: string;
    /** User ID */
    userId: string;
};
export type WorkflowStepDto = {
    /** Step configuration */
    config: {
        [key: string]: any;
    } | null;
    /** Step is enabled */
    enabled?: boolean;
    /** Step plugin method */
    method: string;
};
export type WorkflowResponseDto = {
    /** Creation date */
    createdAt: string;
    /** Workflow description */
    description: string | null;
    /** Workflow enabled */
    enabled: boolean;
    /** Workflow ID */
    id: string;
    /** Workflow logs run results */
    logging: boolean;
    /** Workflow name */
    name: string | null;
    /** Workflow steps */
    steps: WorkflowStepDto[];
    /** Workflow trigger type */
    trigger: WorkflowTrigger;
    /** Update date */
    updatedAt: string;
};
export type WorkflowCreateDto = {
    /** Workflow description */
    description?: string | null;
    /** Workflow enabled */
    enabled?: boolean;
    /** Workflow logs run results */
    logging?: boolean;
    /** Workflow name */
    name?: string | null;
    steps?: WorkflowStepDto[];
    /** Workflow trigger type */
    trigger: WorkflowTrigger;
};
export type WorkflowTriggerResponseDto = {
    /** Trigger type */
    trigger: WorkflowTrigger;
    /** Workflow types */
    types: WorkflowType[];
};
export type WorkflowUpdateDto = {
    /** Workflow description */
    description?: string | null;
    /** Workflow enabled */
    enabled?: boolean;
    /** Workflow logs run results */
    logging?: boolean;
    /** Workflow name */
    name?: string | null;
    steps?: WorkflowStepDto[];
    /** Workflow trigger type */
    trigger?: WorkflowTrigger;
};
export type WorkflowLogEntryDto = {
    /** Workflow run date/time */
    at: string;
    /** Workflow log entry ID */
    id: string;
    /** Last step ran, if the workflow ended early */
    lastStep?: {
        /** Index of the step in the workflow */
        index: number;
        /** Method of the step */
        method: string;
    };
    result: WorkflowResult;
    /** Workflow trigger data ID */
    triggerDataId?: string;
};
export type WorkflowShareStepDto = {
    /** Step configuration */
    config: {
        [key: string]: any;
    } | null;
    /** Step is enabled */
    enabled?: boolean;
    /** Step plugin method */
    method: string;
};
export type WorkflowShareResponseDto = {
    /** Workflow description */
    description: string | null;
    /** Workflow name */
    name: string | null;
    /** Workflow steps */
    steps: WorkflowShareStepDto[];
    /** Workflow trigger type */
    trigger: WorkflowTrigger;
};
export type LicenseResponseDto = UserLicense;
export type ReleaseEventV1 = {
    /** When the server last checked for a latest version. As an ISO timestamp */
    checkedAt: string;
    /** Whether a new version is available */
    isAvailable: boolean;
    releaseVersion: ServerVersionResponseDto;
    serverVersion: ServerVersionResponseDto;
    /** Release type */
    "type": ReleaseType;
};
export type SyncAckV1 = {};
export type SyncAlbumDeleteV1 = {
    /** Album ID */
    albumId: string;
};
export type SyncAlbumToAssetDeleteV1 = {
    /** Album ID */
    albumId: string;
    /** Asset ID */
    assetId: string;
};
export type SyncAlbumToAssetV1 = {
    /** Album ID */
    albumId: string;
    /** Asset ID */
    assetId: string;
};
export type SyncAlbumUserDeleteV1 = {
    /** Album ID */
    albumId: string;
    /** User ID */
    userId: string;
};
export type SyncAlbumUserV1 = {
    /** Album ID */
    albumId: string;
    role: AlbumUserRole;
    /** User ID */
    userId: string;
};
export type SyncAlbumV1 = {
    /** Created at */
    createdAt: string;
    /** Album description */
    description: string;
    /** Album ID */
    id: string;
    /** Is activity enabled */
    isActivityEnabled: boolean;
    /** Album name */
    name: string;
    order: AssetOrder;
    /** Owner ID */
    ownerId: string;
    /** Thumbnail asset ID */
    thumbnailAssetId: string | null;
    /** Updated at */
    updatedAt: string;
};
export type SyncAlbumV2 = {
    /** Created at */
    createdAt: string;
    /** Album description */
    description: string;
    /** Album ID */
    id: string;
    /** Is activity enabled */
    isActivityEnabled: boolean;
    /** Album name */
    name: string;
    order: AssetOrder;
    /** Thumbnail asset ID */
    thumbnailAssetId: string | null;
    /** Updated at */
    updatedAt: string;
};
export type SyncAssetDeleteV1 = {
    /** Asset ID */
    assetId: string;
};
export type SyncAssetEditDeleteV1 = {
    /** Edit ID */
    editId: string;
};
export type SyncAssetEditV1 = {
    action: AssetEditAction;
    /** Asset ID */
    assetId: string;
    /** Edit ID */
    id: string;
    /** Edit parameters */
    parameters: {
        [key: string]: any;
    };
    /** Edit sequence */
    sequence: number;
};
export type SyncAssetExifV1 = {
    /** Asset ID */
    assetId: string;
    /** City */
    city: string | null;
    /** Country */
    country: string | null;
    /** Date time original */
    dateTimeOriginal: string | null;
    /** Description */
    description: string | null;
    /** Exif image height */
    exifImageHeight: number | null;
    /** Exif image width */
    exifImageWidth: number | null;
    /** Exposure time */
    exposureTime: string | null;
    /** F number */
    fNumber: number | null;
    /** File size in byte */
    fileSizeInByte: number | null;
    /** Focal length */
    focalLength: number | null;
    /** FPS */
    fps: number | null;
    /** ISO */
    iso: number | null;
    /** Latitude */
    latitude: number | null;
    /** Lens model */
    lensModel: string | null;
    /** Longitude */
    longitude: number | null;
    /** Make */
    make: string | null;
    /** Model */
    model: string | null;
    /** Modify date */
    modifyDate: string | null;
    /** Orientation */
    orientation: string | null;
    /** Profile description */
    profileDescription: string | null;
    /** Projection type */
    projectionType: string | null;
    /** Rating */
    rating: number | null;
    /** State */
    state: string | null;
    /** Time zone */
    timeZone: string | null;
};
export type SyncAssetFaceDeleteV1 = {
    /** Asset face ID */
    assetFaceId: string;
};
export type SyncAssetFaceV1 = {
    /** Asset ID */
    assetId: string;
    /** Bounding box X1 */
    boundingBoxX1: number;
    /** Bounding box X2 */
    boundingBoxX2: number;
    /** Bounding box Y1 */
    boundingBoxY1: number;
    /** Bounding box Y2 */
    boundingBoxY2: number;
    /** Asset face ID */
    id: string;
    /** Image height */
    imageHeight: number;
    /** Image width */
    imageWidth: number;
    /** Person ID */
    personId: string | null;
    /** Source type */
    sourceType: string;
};
export type SyncAssetFaceV3 = {
    /** Asset ID */
    assetId: string;
    /** Bounding box X1 */
    boundingBoxX1: number;
    /** Bounding box X2 */
    boundingBoxX2: number;
    /** Bounding box Y1 */
    boundingBoxY1: number;
    /** Bounding box Y2 */
    boundingBoxY2: number;
    /** Face deleted at */
    deletedAt: string | null;
    /** Asset face ID */
    id: string;
    /** Image height */
    imageHeight: number;
    /** Image width */
    imageWidth: number;
    /** Is the face visible in the asset */
    isVisible: boolean;
    /** Person ID */
    personId: string | null;
    /** Source type */
    sourceType: string;
};
export type SyncAssetFaceV2 = SyncAssetFaceV3;
export type SyncAssetMetadataDeleteV1 = {
    /** Asset ID */
    assetId: string;
    /** Key */
    key: string;
};
export type SyncAssetMetadataV1 = {
    /** Asset ID */
    assetId: string;
    /** Key */
    key: string;
    /** Value */
    value: {
        [key: string]: any;
    };
};
export type SyncAssetOcrDeleteV1 = {
    /** Original asset ID of the deleted OCR entry */
    assetId: string;
    /** Timestamp when the OCR entry was deleted */
    deletedAt: string;
    /** Audit row ID of the deleted OCR entry */
    id: string;
};
export type SyncAssetOcrV1 = {
    /** Asset ID */
    assetId: string;
    /** Confidence score of the bounding box */
    boxScore: number;
    /** OCR entry ID */
    id: string;
    /** Whether the OCR entry is visible */
    isVisible: boolean;
    /** Recognized text content */
    text: string;
    /** Confidence score of the recognized text */
    textScore: number;
    /** Top-left X coordinate (normalized 0–1) */
    x1: number;
    /** Top-right X coordinate (normalized 0–1) */
    x2: number;
    /** Bottom-right X coordinate (normalized 0–1) */
    x3: number;
    /** Bottom-left X coordinate (normalized 0–1) */
    x4: number;
    /** Top-left Y coordinate (normalized 0–1) */
    y1: number;
    /** Top-right Y coordinate (normalized 0–1) */
    y2: number;
    /** Bottom-right Y coordinate (normalized 0–1) */
    y3: number;
    /** Bottom-left Y coordinate (normalized 0–1) */
    y4: number;
};
export type SyncAssetV1 = {
    /** Checksum */
    checksum: string;
    /** Uploaded to Immich at */
    createdAt: string | null;
    /** Deleted at */
    deletedAt: string | null;
    /** Duration */
    duration: string | null;
    /** File created at */
    fileCreatedAt: string | null;
    /** File modified at */
    fileModifiedAt: string | null;
    /** Asset height */
    height: number | null;
    /** Asset ID */
    id: string;
    /** Is edited */
    isEdited: boolean;
    /** Is favorite */
    isFavorite: boolean;
    /** Library ID */
    libraryId: string | null;
    /** Live photo video ID */
    livePhotoVideoId: string | null;
    /** Local date time */
    localDateTime: string | null;
    /** Original file name */
    originalFileName: string;
    /** Owner ID */
    ownerId: string;
    /** Stack ID */
    stackId: string | null;
    /** Thumbhash */
    thumbhash: string | null;
    "type": AssetTypeEnum;
    visibility: AssetVisibility;
    /** Asset width */
    width: number | null;
};
export type SyncAssetV2 = {
    /** Checksum */
    checksum: string;
    /** Uploaded to Immich at */
    createdAt: string | null;
    /** Deleted at */
    deletedAt: string | null;
    /** Duration */
    duration: number | null;
    /** File created at */
    fileCreatedAt: string | null;
    /** File modified at */
    fileModifiedAt: string | null;
    /** Asset height */
    height: number | null;
    /** Asset ID */
    id: string;
    /** Is edited */
    isEdited: boolean;
    /** Is favorite */
    isFavorite: boolean;
    /** Library ID */
    libraryId: string | null;
    /** Live photo video ID */
    livePhotoVideoId: string | null;
    /** Local date time */
    localDateTime: string | null;
    /** Original file name */
    originalFileName: string;
    /** Owner ID */
    ownerId: string;
    /** Stack ID */
    stackId: string | null;
    /** Thumbhash */
    thumbhash: string | null;
    "type": AssetTypeEnum;
    visibility: AssetVisibility;
    /** Asset width */
    width: number | null;
};
export type SyncAuthUserV1 = {
    avatarColor?: (UserAvatarColor) | null;
    /** User deleted at */
    deletedAt: string | null;
    /** User email */
    email: string;
    /** User has profile image */
    hasProfileImage: boolean;
    /** User ID */
    id: string;
    /** User is admin */
    isAdmin: boolean;
    /** User name */
    name: string;
    /** User OAuth ID */
    oauthId: string;
    /** User pin code */
    pinCode: string | null;
    /** User profile changed at */
    profileChangedAt: string;
    /** Quota size in bytes */
    quotaSizeInBytes: number | null;
    /** Quota usage in bytes */
    quotaUsageInBytes: number;
    /** User storage label */
    storageLabel: string | null;
};
export type SyncAuthUserV2 = {
    avatarColor?: (UserAvatarColor) | null;
    /** User deleted at */
    deletedAt: string | null;
    /** User email */
    email: string;
    /** User has profile image */
    hasProfileImage: boolean;
    /** User ID */
    id: string;
    /** User is admin */
    isAdmin: boolean;
    /** User name */
    name: string;
    /** User OAuth ID */
    oauthId: string | null;
    /** User pin code */
    pinCode: string | null;
    /** User profile changed at */
    profileChangedAt: string;
    /** Quota size in bytes */
    quotaSizeInBytes: number | null;
    /** Quota usage in bytes */
    quotaUsageInBytes: number;
    /** User storage label */
    storageLabel: string | null;
};
export type SyncCompleteV1 = {};
export type SyncMemoryAssetDeleteV1 = {
    /** Asset ID */
    assetId: string;
    /** Memory ID */
    memoryId: string;
};
export type SyncMemoryAssetV1 = {
    /** Asset ID */
    assetId: string;
    /** Memory ID */
    memoryId: string;
};
export type SyncMemoryDeleteV1 = {
    /** Memory ID */
    memoryId: string;
};
export type SyncMemoryV1 = {
    /** Created at */
    createdAt: string;
    /** Data */
    data: {
        [key: string]: any;
    };
    /** Deleted at */
    deletedAt: string | null;
    /** Hide at */
    hideAt: string | null;
    /** Memory ID */
    id: string;
    /** Is saved */
    isSaved: boolean;
    /** Memory at */
    memoryAt: string;
    /** Owner ID */
    ownerId: string;
    /** Seen at */
    seenAt: string | null;
    /** Show at */
    showAt: string | null;
    "type": MemoryType;
    /** Updated at */
    updatedAt: string;
};
export type SyncPartnerDeleteV1 = {
    /** Shared by ID */
    sharedById: string;
    /** Shared with ID */
    sharedWithId: string;
};
export type SyncPartnerV1 = {
    /** In timeline */
    inTimeline: boolean;
    /** Shared by ID */
    sharedById: string;
    /** Shared with ID */
    sharedWithId: string;
};
export type SyncPersonDeleteV1 = {
    /** Person ID */
    personId: string;
};
export type SyncPersonV1 = {
    /** Birth date */
    birthDate: string | null;
    /** Color */
    color: string | null;
    /** Created at */
    createdAt: string;
    /** Face asset ID */
    faceAssetId: string | null;
    /** Person ID */
    id: string;
    /** Is favorite */
    isFavorite: boolean;
    /** Is hidden */
    isHidden: boolean;
    /** Person name */
    name: string;
    /** Owner ID */
    ownerId: string;
    /** Updated at */
    updatedAt: string;
};
export type SyncResetV1 = {};
export type SyncStackDeleteV1 = {
    /** Stack ID */
    stackId: string;
};
export type SyncStackV1 = {
    /** Created at */
    createdAt: string;
    /** Stack ID */
    id: string;
    /** Owner ID */
    ownerId: string;
    /** Primary asset ID */
    primaryAssetId: string;
    /** Updated at */
    updatedAt: string;
};
export type SyncUserDeleteV1 = {
    /** User ID */
    userId: string;
};
export type SyncUserMetadataDeleteV1 = {
    key: UserMetadataKey;
    /** User ID */
    userId: string;
};
export type SyncUserMetadataV1 = {
    key: UserMetadataKey;
    /** User ID */
    userId: string;
    /** User metadata value */
    value: {
        [key: string]: any;
    };
};
export type SyncUserV1 = {
    avatarColor?: (UserAvatarColor) | null;
    /** User deleted at */
    deletedAt: string | null;
    /** User email */
    email: string;
    /** User has profile image */
    hasProfileImage: boolean;
    /** User ID */
    id: string;
    /** User name */
    name: string;
    /** User profile changed at */
    profileChangedAt: string;
};
/**
 * List all activities
 */
export function getActivities({ albumId, assetId, level, $type, userId }: {
    albumId: string;
    assetId?: string;
    level?: ReactionLevel;
    $type?: ReactionType;
    userId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ActivityResponseDto[];
    }>(`/activities${QS.query(QS.explode({
        albumId,
        assetId,
        level,
        "type": $type,
        userId
    }))}`, {
        ...opts
    }));
}
/**
 * Create an activity
 */
export function createActivity({ activityCreateDto }: {
    activityCreateDto: ActivityCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ActivityResponseDto;
    }>("/activities", oazapfts.json({
        ...opts,
        method: "POST",
        body: activityCreateDto
    })));
}
/**
 * Retrieve activity statistics
 */
export function getActivityStatistics({ albumId, assetId }: {
    albumId: string;
    assetId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ActivityStatisticsResponseDto;
    }>(`/activities/statistics${QS.query(QS.explode({
        albumId,
        assetId
    }))}`, {
        ...opts
    }));
}
/**
 * Delete an activity
 */
export function deleteActivity({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/activities/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Unlink all OAuth accounts
 */
export function unlinkAllOAuthAccountsAdmin(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/auth/unlink-all", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Get the admin configuration
 */
export function getAdminConfig(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/admin/config", {
        ...opts
    }));
}
/**
 * Update the system configuration
 */
export function updateAdminConfig({ adminConfigDto }: {
    adminConfigDto: AdminConfigDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/admin/config", oazapfts.json({
        ...opts,
        method: "PUT",
        body: adminConfigDto
    })));
}
/**
 * Get the system configuration defaults
 */
export function getAdminConfigDefaults(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/admin/config/defaults", {
        ...opts
    }));
}
/**
 * Delete database backup
 */
export function deleteDatabaseBackup({ databaseBackupDeleteDto }: {
    databaseBackupDeleteDto: DatabaseBackupDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/database-backups", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: databaseBackupDeleteDto
    })));
}
/**
 * List database backups
 */
export function listDatabaseBackups(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DatabaseBackupListResponseDto;
    }>("/admin/database-backups", {
        ...opts
    }));
}
/**
 * Start database backup restore flow
 */
export function startDatabaseRestoreFlow(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/database-backups/start-restore", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Upload database backup
 */
export function uploadDatabaseBackup({ databaseBackupUploadDto }: {
    databaseBackupUploadDto: DatabaseBackupUploadDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/database-backups/upload", oazapfts.multipart({
        ...opts,
        method: "POST",
        body: databaseBackupUploadDto
    })));
}
/**
 * Download database backup
 */
export function downloadDatabaseBackup({ filename }: {
    filename: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/admin/database-backups/${encodeURIComponent(filename)}`, {
        ...opts
    }));
}
/**
 * Get integrity report by type
 */
export function getIntegrityReport({ cursor, limit, $type }: {
    cursor?: string;
    limit?: number;
    $type: IntegrityReport;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: IntegrityReportResponseDto;
    }>(`/admin/integrity/report${QS.query(QS.explode({
        cursor,
        limit,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Delete integrity report item
 */
export function deleteIntegrityReport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/admin/integrity/report/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Download flagged file
 */
export function getIntegrityReportFile({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/admin/integrity/report/${encodeURIComponent(id)}/file`, {
        ...opts
    }));
}
/**
 * Export integrity report by type as CSV
 */
export function getIntegrityReportCsv({ $type }: {
    $type: IntegrityReport;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/admin/integrity/report/${encodeURIComponent($type)}/csv`, {
        ...opts
    }));
}
/**
 * Get integrity report summary
 */
export function getIntegrityReportSummary(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: IntegrityReportSummaryResponseDto;
    }>("/admin/integrity/summary", {
        ...opts
    }));
}
/**
 * Set maintenance mode
 */
export function setMaintenanceMode({ setMaintenanceModeDto }: {
    setMaintenanceModeDto: SetMaintenanceModeDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/maintenance", oazapfts.json({
        ...opts,
        method: "POST",
        body: setMaintenanceModeDto
    })));
}
/**
 * Detect existing install
 */
export function detectPriorInstall(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MaintenanceDetectInstallResponseDto;
    }>("/admin/maintenance/detect-install", {
        ...opts
    }));
}
/**
 * Log into maintenance mode
 */
export function maintenanceLogin({ maintenanceLoginDto }: {
    maintenanceLoginDto: MaintenanceLoginDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MaintenanceAuthDto;
    }>("/admin/maintenance/login", oazapfts.json({
        ...opts,
        method: "POST",
        body: maintenanceLoginDto
    })));
}
/**
 * Get maintenance mode status
 */
export function getMaintenanceStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MaintenanceStatusResponseDto;
    }>("/admin/maintenance/status", {
        ...opts
    }));
}
/**
 * Create a notification
 */
export function createNotification({ notificationCreateDto }: {
    notificationCreateDto: NotificationCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: NotificationDto;
    }>("/admin/notifications", oazapfts.json({
        ...opts,
        method: "POST",
        body: notificationCreateDto
    })));
}
/**
 * Render email template
 */
export function getNotificationTemplateAdmin({ name, templateDto }: {
    name: string;
    templateDto: TemplateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TemplateResponseDto;
    }>(`/admin/notifications/templates/${encodeURIComponent(name)}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: templateDto
    })));
}
/**
 * Send test email
 */
export function sendTestEmailAdmin({ adminConfigSmtpDto }: {
    adminConfigSmtpDto: AdminConfigSmtpDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TestEmailResponseDto;
    }>("/admin/notifications/test-email", oazapfts.json({
        ...opts,
        method: "POST",
        body: adminConfigSmtpDto
    })));
}
/**
 * Get physical deduplication preview
 */
export function getPhysicalDeduplicationPreview(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PhysicalDeduplicationPreviewResponseDto;
    }>("/admin/physical-deduplication/preview", {
        ...opts
    }));
}
/**
 * Request physical deduplication preview
 */
export function requestPhysicalDeduplicationPreview({ physicalDeduplicationPreviewRequestDto }: {
    physicalDeduplicationPreviewRequestDto: PhysicalDeduplicationPreviewRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/physical-deduplication/preview", oazapfts.json({
        ...opts,
        method: "POST",
        body: physicalDeduplicationPreviewRequestDto
    })));
}
/**
 * List render workers
 */
export function listRenderWorkers(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerDto[];
    }>("/admin/render-workers", {
        ...opts
    }));
}
/**
 * Enrol a render worker
 */
export function createRenderWorker({ renderWorkerCreateDto }: {
    renderWorkerCreateDto: RenderWorkerCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: RenderWorkerCreateResponseDto;
    }>("/admin/render-workers", oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCreateDto
    })));
}
/**
 * Search the render worker audit trail
 */
export function searchRenderWorkerAudit({ take, workerId }: {
    take?: number;
    workerId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerAuditDto[];
    }>(`/admin/render-workers/audit${QS.query(QS.explode({
        take,
        workerId
    }))}`, {
        ...opts
    }));
}
/**
 * Get render limits
 */
export function getRenderWorkerLimits(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerLimitsResponseDto;
    }>("/admin/render-workers/limits", {
        ...opts
    }));
}
/**
 * Set render limits
 */
export function updateRenderWorkerLimits({ renderWorkerLimitUpdateDto }: {
    renderWorkerLimitUpdateDto: RenderWorkerLimitUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerLimitDto;
    }>("/admin/render-workers/limits", oazapfts.json({
        ...opts,
        method: "PUT",
        body: renderWorkerLimitUpdateDto
    })));
}
/**
 * Remove an account’s render limits
 */
export function deleteRenderWorkerUserLimit({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/admin/render-workers/limits/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Revoke a render worker
 */
export function revokeRenderWorker({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/admin/render-workers/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a render worker
 */
export function getRenderWorker({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerDto;
    }>(`/admin/render-workers/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a render worker
 */
export function updateRenderWorker({ id, renderWorkerUpdateDto }: {
    id: string;
    renderWorkerUpdateDto: RenderWorkerUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerDto;
    }>(`/admin/render-workers/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: renderWorkerUpdateDto
    })));
}
/**
 * Search users
 */
export function searchUsersAdmin({ id, withDeleted }: {
    id?: string;
    withDeleted?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto[];
    }>(`/admin/users${QS.query(QS.explode({
        id,
        withDeleted
    }))}`, {
        ...opts
    }));
}
/**
 * Create a user
 */
export function createUserAdmin({ userAdminCreateDto }: {
    userAdminCreateDto: UserAdminCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: UserAdminResponseDto;
    }>("/admin/users", oazapfts.json({
        ...opts,
        method: "POST",
        body: userAdminCreateDto
    })));
}
/**
 * Delete a user
 */
export function deleteUserAdmin({ id, userAdminDeleteDto }: {
    id: string;
    userAdminDeleteDto: UserAdminDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: userAdminDeleteDto
    })));
}
/**
 * Retrieve a user
 */
export function getUserAdmin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a user
 */
export function updateUserAdmin({ id, userAdminUpdateDto }: {
    id: string;
    userAdminUpdateDto: UserAdminUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: userAdminUpdateDto
    })));
}
/**
 * Retrieve calendar heatmap activity
 */
export function getUserCalendarHeatmapAdmin({ $from, id, to, $type }: {
    $from?: string;
    id: string;
    to?: string;
    $type?: CalendarHeatmapType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CalendarHeatmapResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/calendar-heatmap${QS.query(QS.explode({
        "from": $from,
        to,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve user preferences
 */
export function getUserPreferencesAdmin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserPreferencesResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/preferences`, {
        ...opts
    }));
}
/**
 * Update user preferences
 */
export function updateUserPreferencesAdmin({ id, userPreferencesUpdateDto }: {
    id: string;
    userPreferencesUpdateDto: UserPreferencesUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserPreferencesResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/preferences`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: userPreferencesUpdateDto
    })));
}
/**
 * Restore a deleted user
 */
export function restoreUserAdmin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/restore`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve user sessions
 */
export function getUserSessionsAdmin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SessionResponseDto[];
    }>(`/admin/users/${encodeURIComponent(id)}/sessions`, {
        ...opts
    }));
}
/**
 * Delete a user session
 */
export function deleteUserSessionAdmin({ id, sessionId }: {
    id: string;
    sessionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/admin/users/${encodeURIComponent(id)}/sessions/${encodeURIComponent(sessionId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve user statistics
 */
export function getUserStatisticsAdmin({ id, isFavorite, isTrashed, visibility }: {
    id: string;
    isFavorite?: boolean;
    isTrashed?: boolean;
    visibility?: AssetVisibility;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetStatsResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/statistics${QS.query(QS.explode({
        isFavorite,
        isTrashed,
        visibility
    }))}`, {
        ...opts
    }));
}
/**
 * List all albums
 */
export function getAllAlbums({ assetId, id, isOwned, isShared, name, suppressedOnly }: {
    assetId?: string;
    id?: string;
    isOwned?: boolean;
    isShared?: boolean;
    name?: string;
    suppressedOnly?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto[];
    }>(`/albums${QS.query(QS.explode({
        assetId,
        id,
        isOwned,
        isShared,
        name,
        suppressedOnly
    }))}`, {
        ...opts
    }));
}
/**
 * Create an album
 */
export function createAlbum({ createAlbumDto }: {
    createAlbumDto: CreateAlbumDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: AlbumResponseDto;
    }>("/albums", oazapfts.json({
        ...opts,
        method: "POST",
        body: createAlbumDto
    })));
}
/**
 * Add assets to albums
 */
export function addAssetsToAlbums({ albumsAddAssetsDto }: {
    albumsAddAssetsDto: AlbumsAddAssetsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumsAddAssetsResponseDto;
    }>("/albums/assets", oazapfts.json({
        ...opts,
        method: "PUT",
        body: albumsAddAssetsDto
    })));
}
/**
 * Retrieve the album icon catalogue
 */
export function getAlbumIconCatalogue(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumIconCatalogueResponseDto;
    }>("/albums/icons", {
        ...opts
    }));
}
/**
 * Retrieve album statistics
 */
export function getAlbumStatistics(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumStatisticsResponseDto;
    }>("/albums/statistics", {
        ...opts
    }));
}
/**
 * Retrieve the album directory
 */
export function getAlbumTree(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumTreeResponseDto;
    }>("/albums/tree", {
        ...opts
    }));
}
/**
 * Delete an album
 */
export function deleteAlbum({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/albums/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve an album
 */
export function getAlbumInfo({ id, key, slug, suppressedOnly }: {
    id: string;
    key?: string;
    slug?: string;
    suppressedOnly?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto;
    }>(`/albums/${encodeURIComponent(id)}${QS.query(QS.explode({
        key,
        slug,
        suppressedOnly
    }))}`, {
        ...opts
    }));
}
/**
 * Update an album
 */
export function updateAlbumInfo({ id, updateAlbumDto }: {
    id: string;
    updateAlbumDto: UpdateAlbumDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto;
    }>(`/albums/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: updateAlbumDto
    })));
}
/**
 * Remove assets from an album
 */
export function removeAssetFromAlbum({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/albums/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Add assets to an album
 */
export function addAssetsToAlbum({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/albums/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: bulkIdsDto
    })));
}
/**
 * Move an album into or out of a collection
 */
export function moveAlbumToCollection({ id, moveAlbumDto }: {
    id: string;
    moveAlbumDto: MoveAlbumDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto;
    }>(`/albums/${encodeURIComponent(id)}/collection`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: moveAlbumDto
    })));
}
/**
 * Count descendant albums
 */
export function getAlbumDescendantCount({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumDescendantCountResponseDto;
    }>(`/albums/${encodeURIComponent(id)}/descendant-count`, {
        ...opts
    }));
}
/**
 * Retrieve album map markers
 */
export function getAlbumMapMarkers({ id, key, slug }: {
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MapMarkerResponseDto[];
    }>(`/albums/${encodeURIComponent(id)}/map-markers${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * Remove user from album
 */
export function removeUserFromAlbum({ id, userId }: {
    id: string;
    userId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/albums/${encodeURIComponent(id)}/user/${encodeURIComponent(userId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Update user role
 */
export function updateAlbumUser({ id, userId, updateAlbumUserDto }: {
    id: string;
    userId: string;
    updateAlbumUserDto: UpdateAlbumUserDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/albums/${encodeURIComponent(id)}/user/${encodeURIComponent(userId)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: updateAlbumUserDto
    })));
}
/**
 * Share album with users
 */
export function addUsersToAlbum({ id, addUsersDto }: {
    id: string;
    addUsersDto: AddUsersDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto;
    }>(`/albums/${encodeURIComponent(id)}/users`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: addUsersDto
    })));
}
/**
 * List all API keys
 */
export function getApiKeys(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ApiKeyResponseDto[];
    }>("/api-keys", {
        ...opts
    }));
}
/**
 * Create an API key
 */
export function createApiKey({ apiKeyCreateDto }: {
    apiKeyCreateDto: ApiKeyCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ApiKeyCreateResponseDto;
    }>("/api-keys", oazapfts.json({
        ...opts,
        method: "POST",
        body: apiKeyCreateDto
    })));
}
/**
 * Retrieve the current API key
 */
export function getMyApiKey(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ApiKeyResponseDto;
    }>("/api-keys/me", {
        ...opts
    }));
}
/**
 * Delete an API key
 */
export function deleteApiKey({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/api-keys/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve an API key
 */
export function getApiKey({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ApiKeyResponseDto;
    }>(`/api-keys/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update an API key
 */
export function updateApiKey({ id, apiKeyUpdateDto }: {
    id: string;
    apiKeyUpdateDto: ApiKeyUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ApiKeyResponseDto;
    }>(`/api-keys/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: apiKeyUpdateDto
    })));
}
/**
 * Rotate an API key
 */
export function rotateApiKey({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ApiKeyCreateResponseDto;
    }>(`/api-keys/${encodeURIComponent(id)}/rotate`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Search asset files
 */
export function searchAssetFiles({ assetId, isEdited, isProgressive, isTransparent, $type }: {
    assetId: string;
    isEdited?: boolean;
    isProgressive?: boolean;
    isTransparent?: boolean;
    $type?: AssetFileType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFileResponseDto[];
    }>(`/asset-files${QS.query(QS.explode({
        assetId,
        isEdited,
        isProgressive,
        isTransparent,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Delete an asset file
 */
export function deleteAssetFile({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/asset-files/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve an asset file
 */
export function getAssetFile({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFileResponseDto;
    }>(`/asset-files/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Download an asset file
 */
export function downloadAssetFile({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/asset-files/${encodeURIComponent(id)}/download`, {
        ...opts
    }));
}
/**
 * Delete assets
 */
export function deleteAssets({ assetBulkDeleteDto }: {
    assetBulkDeleteDto: AssetBulkDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: assetBulkDeleteDto
    })));
}
/**
 * Upload asset
 */
export function uploadAsset({ key, slug, xImmichChecksum, assetMediaCreateDto }: {
    key?: string;
    slug?: string;
    xImmichChecksum?: string;
    assetMediaCreateDto: AssetMediaCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetMediaResponseDto;
    } | {
        status: 201;
        data: AssetMediaResponseDto;
    }>(`/assets${QS.query(QS.explode({
        key,
        slug
    }))}`, oazapfts.multipart({
        ...opts,
        method: "POST",
        body: assetMediaCreateDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-immich-checksum": xImmichChecksum
        })
    })));
}
/**
 * Update assets
 */
export function updateAssets({ assetBulkUpdateDto }: {
    assetBulkUpdateDto: AssetBulkUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets", oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetBulkUpdateDto
    })));
}
/**
 * Check bulk upload
 */
export function checkBulkUpload({ assetBulkUploadCheckDto }: {
    assetBulkUploadCheckDto: AssetBulkUploadCheckDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetBulkUploadCheckResponseDto;
    }>("/assets/bulk-upload-check", oazapfts.json({
        ...opts,
        method: "POST",
        body: assetBulkUploadCheckDto
    })));
}
/**
 * Copy asset
 */
export function copyAsset({ assetCopyDto }: {
    assetCopyDto: AssetCopyDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets/copy", oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetCopyDto
    })));
}
/**
 * Run an asset job
 */
export function runAssetJobs({ assetJobsDto }: {
    assetJobsDto: AssetJobsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets/jobs", oazapfts.json({
        ...opts,
        method: "POST",
        body: assetJobsDto
    })));
}
/**
 * Lock assets
 */
export function lockAssets({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets/lock", oazapfts.json({
        ...opts,
        method: "POST",
        body: bulkIdsDto
    })));
}
/**
 * Delete asset metadata
 */
export function deleteBulkAssetMetadata({ assetMetadataBulkDeleteDto }: {
    assetMetadataBulkDeleteDto: AssetMetadataBulkDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets/metadata", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: assetMetadataBulkDeleteDto
    })));
}
/**
 * Upsert asset metadata
 */
export function updateBulkAssetMetadata({ assetMetadataBulkUpsertDto }: {
    assetMetadataBulkUpsertDto: AssetMetadataBulkUpsertDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetMetadataBulkResponseDto[];
    }>("/assets/metadata", oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetMetadataBulkUpsertDto
    })));
}
/**
 * Get asset statistics
 */
export function getAssetStatistics({ isFavorite, isTrashed, visibility }: {
    isFavorite?: boolean;
    isTrashed?: boolean;
    visibility?: AssetVisibility;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetStatsResponseDto;
    }>(`/assets/statistics${QS.query(QS.explode({
        isFavorite,
        isTrashed,
        visibility
    }))}`, {
        ...opts
    }));
}
/**
 * Unlock assets
 */
export function unlockAssets({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/assets/unlock", oazapfts.json({
        ...opts,
        method: "POST",
        body: bulkIdsDto
    })));
}
/**
 * Retrieve an asset
 */
export function getAssetInfo({ id, key, slug }: {
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto;
    }>(`/assets/${encodeURIComponent(id)}${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * Update an asset
 */
export function updateAsset({ id, updateAssetDto }: {
    id: string;
    updateAssetDto: UpdateAssetDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto;
    }>(`/assets/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: updateAssetDto
    })));
}
/**
 * List develop versions of an asset
 */
export function getAssetDevelop({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetDevelopResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop`, {
        ...opts
    }));
}
/**
 * Save a develop recipe as a new version
 */
export function saveAssetDevelop({ id, assetDevelopSaveDto }: {
    id: string;
    assetDevelopSaveDto: AssetDevelopSaveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetDevelopRevisionResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetDevelopSaveDto
    })));
}
/**
 * Render a develop preview
 */
export function previewAssetDevelop({ id, assetDevelopPreviewDto }: {
    id: string;
    assetDevelopPreviewDto: AssetDevelopPreviewDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/develop/preview`, oazapfts.json({
        ...opts,
        method: "POST",
        body: assetDevelopPreviewDto
    })));
}
/**
 * Revert to the original or an earlier develop version
 */
export function revertAssetDevelop({ id, assetDevelopRevertDto }: {
    id: string;
    assetDevelopRevertDto: AssetDevelopRevertDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetDevelopResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop/revert`, oazapfts.json({
        ...opts,
        method: "POST",
        body: assetDevelopRevertDto
    })));
}
/**
 * View a rendered develop file
 */
export function viewAssetDevelopFile({ id, kind, revisionId }: {
    id: string;
    kind?: AssetDevelopFileKind;
    revisionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/develop/revisions/${encodeURIComponent(revisionId)}/file${QS.query(QS.explode({
        kind
    }))}`, {
        ...opts
    }));
}
/**
 * Cancel a develop render
 */
export function cancelAssetDevelopRender({ id, revisionId }: {
    id: string;
    revisionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetDevelopRevisionResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop/revisions/${encodeURIComponent(revisionId)}/render`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Render a develop version
 */
export function renderAssetDevelopRevision({ id, revisionId }: {
    id: string;
    revisionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetDevelopRevisionResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop/revisions/${encodeURIComponent(revisionId)}/render`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Remove edits from an existing asset
 */
export function removeAssetEdits({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/edits`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve edits for an existing asset
 */
export function getAssetEdits({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetEditsResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/edits`, {
        ...opts
    }));
}
/**
 * Apply edits to an existing asset
 */
export function editAsset({ id, assetEditsCreateDto }: {
    id: string;
    assetEditsCreateDto: AssetEditsCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetEditsResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/edits`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetEditsCreateDto
    })));
}
/**
 * Get image enrichment metadata
 */
export function getAssetImageEnrichment({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetImageEnrichmentResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/image-enrichment`, {
        ...opts
    }));
}
/**
 * Update image enrichment metadata
 */
export function updateAssetImageEnrichment({ id, assetImageEnrichmentActionRequestDto }: {
    id: string;
    assetImageEnrichmentActionRequestDto: AssetImageEnrichmentActionRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetImageEnrichmentResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/image-enrichment`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetImageEnrichmentActionRequestDto
    })));
}
/**
 * Get asset metadata
 */
export function getAssetMetadata({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetMetadataResponseDto[];
    }>(`/assets/${encodeURIComponent(id)}/metadata`, {
        ...opts
    }));
}
/**
 * Update asset metadata
 */
export function updateAssetMetadata({ id, assetMetadataUpsertDto }: {
    id: string;
    assetMetadataUpsertDto: AssetMetadataUpsertDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetMetadataResponseDto[];
    }>(`/assets/${encodeURIComponent(id)}/metadata`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetMetadataUpsertDto
    })));
}
/**
 * Delete asset metadata by key
 */
export function deleteAssetMetadata({ id, key }: {
    id: string;
    key: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/metadata/${encodeURIComponent(key)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve asset metadata by key
 */
export function getAssetMetadataByKey({ id, key }: {
    id: string;
    key: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetMetadataResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/metadata/${encodeURIComponent(key)}`, {
        ...opts
    }));
}
/**
 * Retrieve asset OCR data
 */
export function getAssetOcr({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetOcrResponseDto[];
    }>(`/assets/${encodeURIComponent(id)}/ocr`, {
        ...opts
    }));
}
/**
 * Download original asset
 */
export function downloadAsset({ edited, id, key, slug }: {
    edited?: boolean;
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/original${QS.query(QS.explode({
        edited,
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * List restorations of an asset
 */
export function getAssetRestorations({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetRestorationListResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations`, {
        ...opts
    }));
}
/**
 * Request a restoration preview
 */
export function requestAssetRestoration({ id, assetRestorationRequestDto }: {
    id: string;
    assetRestorationRequestDto: AssetRestorationRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: AssetRestorationResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations`, oazapfts.json({
        ...opts,
        method: "POST",
        body: assetRestorationRequestDto
    })));
}
/**
 * Choose the restoration used for playback
 */
export function setCurrentAssetRestoration({ id, assetRestorationSelectDto }: {
    id: string;
    assetRestorationSelectDto: AssetRestorationSelectDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetRestorationListResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations/current`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetRestorationSelectDto
    })));
}
/**
 * Get restoration options for an asset
 */
export function getAssetRestorationOptions({ id, mode, upscale }: {
    id: string;
    mode?: AssetRestorationMode;
    upscale?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetRestorationOptionsDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations/options${QS.query(QS.explode({
        mode,
        upscale
    }))}`, {
        ...opts
    }));
}
/**
 * Discard a restoration
 */
export function discardAssetRestoration({ id, restorationId }: {
    id: string;
    restorationId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/restorations/${encodeURIComponent(restorationId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Accept a restoration preview
 */
export function acceptAssetRestoration({ id, restorationId }: {
    id: string;
    restorationId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetRestorationResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations/${encodeURIComponent(restorationId)}/accept`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * View a restoration file
 */
export function viewAssetRestorationFile({ id, kind, restorationId }: {
    id: string;
    kind?: AssetRestorationFileKind;
    restorationId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/restorations/${encodeURIComponent(restorationId)}/file${QS.query(QS.explode({
        kind
    }))}`, {
        ...opts
    }));
}
/**
 * Reject a restoration preview
 */
export function rejectAssetRestoration({ id, restorationId }: {
    id: string;
    restorationId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetRestorationResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/restorations/${encodeURIComponent(restorationId)}/reject`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * View asset thumbnail
 */
export function viewAsset({ edited, id, key, size, slug }: {
    edited?: boolean;
    id: string;
    key?: string;
    size?: AssetMediaSize;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/thumbnail${QS.query(QS.explode({
        edited,
        key,
        size,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * Play asset video
 */
export function playAssetVideo({ id, key, slug }: {
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/video/playback${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * Get HLS main playlist
 */
export function getMainPlaylist({ id, key, slug }: {
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: string;
    }>(`/assets/${encodeURIComponent(id)}/video/stream/main.m3u8${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * End HLS streaming session
 */
export function endSession({ id, key, sessionId, slug }: {
    id: string;
    key?: string;
    sessionId: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/video/stream/${encodeURIComponent(sessionId)}${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get HLS media playlist
 */
export function getMediaPlaylist({ id, key, sessionId, slug, variantIndex, xImmichHlsPos }: {
    id: string;
    key?: string;
    sessionId: string;
    slug?: string;
    variantIndex: number;
    xImmichHlsPos?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: string;
    }>(`/assets/${encodeURIComponent(id)}/video/stream/${encodeURIComponent(sessionId)}/${encodeURIComponent(variantIndex)}/playlist.m3u8${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-immich-hls-pos": xImmichHlsPos
        })
    }));
}
/**
 * Get HLS segment or init file
 */
export function getSegment({ filename, id, key, sessionId, slug, variantIndex, xImmichHlsMsn }: {
    filename: string;
    id: string;
    key?: string;
    sessionId: string;
    slug?: string;
    variantIndex: number;
    xImmichHlsMsn?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/video/stream/${encodeURIComponent(sessionId)}/${encodeURIComponent(variantIndex)}/${encodeURIComponent(filename)}${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-immich-hls-msn": xImmichHlsMsn
        })
    }));
}
/**
 * Register admin
 */
export function signUpAdmin({ signUpDto }: {
    signUpDto: SignUpDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: UserAdminResponseDto;
    }>("/auth/admin-sign-up", oazapfts.json({
        ...opts,
        method: "POST",
        body: signUpDto
    })));
}
/**
 * Change password
 */
export function changePassword({ changePasswordDto }: {
    changePasswordDto: ChangePasswordDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/auth/change-password", oazapfts.json({
        ...opts,
        method: "POST",
        body: changePasswordDto
    })));
}
/**
 * Login
 */
export function login({ loginCredentialDto }: {
    loginCredentialDto: LoginCredentialDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LoginResponseDto;
    }>("/auth/login", oazapfts.json({
        ...opts,
        method: "POST",
        body: loginCredentialDto
    })));
}
/**
 * Logout
 */
export function logout(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LogoutResponseDto;
    }>("/auth/logout", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Reset pin code
 */
export function resetPinCode({ pinCodeResetDto }: {
    pinCodeResetDto: PinCodeResetDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/auth/pin-code", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: pinCodeResetDto
    })));
}
/**
 * Setup pin code
 */
export function setupPinCode({ pinCodeSetupDto }: {
    pinCodeSetupDto: PinCodeSetupDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/auth/pin-code", oazapfts.json({
        ...opts,
        method: "POST",
        body: pinCodeSetupDto
    })));
}
/**
 * Change pin code
 */
export function changePinCode({ pinCodeChangeDto }: {
    pinCodeChangeDto: PinCodeChangeDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/auth/pin-code", oazapfts.json({
        ...opts,
        method: "PUT",
        body: pinCodeChangeDto
    })));
}
/**
 * Lock auth session
 */
export function lockAuthSession(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/auth/session/lock", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Unlock auth session
 */
export function unlockAuthSession({ sessionUnlockDto }: {
    sessionUnlockDto: SessionUnlockDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/auth/session/unlock", oazapfts.json({
        ...opts,
        method: "POST",
        body: sessionUnlockDto
    })));
}
/**
 * Retrieve auth status
 */
export function getAuthStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AuthStatusResponseDto;
    }>("/auth/status", {
        ...opts
    }));
}
/**
 * Validate access token
 */
export function validateAccessToken(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ValidateAccessTokenResponseDto;
    }>("/auth/validateToken", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve best photos
 */
export function getBestPhotos({ includeArchived, limit, minScore, page }: {
    includeArchived?: boolean;
    limit?: number;
    minScore?: number;
    page?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BestPhotosResponseDto;
    }>(`/best-photos${QS.query(QS.explode({
        includeArchived,
        limit,
        minScore,
        page
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve cluster group requests
 */
export function getClusterGroupRequests(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClusterGroupRequestResponseDto[];
    }>("/cluster-groups/requests", {
        ...opts
    }));
}
/**
 * Decline a cluster group request
 */
export function deleteClusterGroupRequest({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/cluster-groups/requests/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Accept a cluster group request
 */
export function acceptClusterGroupRequest({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/cluster-groups/requests/${encodeURIComponent(id)}/accept`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Leave a cluster group
 */
export function leaveClusterGroup({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/cluster-groups/${encodeURIComponent(id)}/leave`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Regenerate people of users in cluster group
 */
export function clusterGroupRegeneratePeople({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/cluster-groups/${encodeURIComponent(id)}/regenerate-people`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve the requests sent by a cluster group
 */
export function getClusterGroupRequestsForGroup({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClusterGroupRequestResponseDto[];
    }>(`/cluster-groups/${encodeURIComponent(id)}/requests`, {
        ...opts
    }));
}
/**
 * Create a cluster group request
 */
export function createClusterGroupRequest({ id, clusterGroupRequestCreateDto }: {
    id: string;
    clusterGroupRequestCreateDto: ClusterGroupRequestCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClusterGroupRequestResponseDto;
    }>(`/cluster-groups/${encodeURIComponent(id)}/requests`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: clusterGroupRequestCreateDto
    })));
}
/**
 * Retrieve the users of a cluster group
 */
export function getClusterGroupUsers({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserResponseDto[];
    }>(`/cluster-groups/${encodeURIComponent(id)}/users`, {
        ...opts
    }));
}
/**
 * Get the configuration with user visibility
 */
export function getUserConfig(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserConfigDto;
    }>("/config", {
        ...opts
    }));
}
/**
 * Get the default configuration with user visibility
 */
export function getUserConfigDefaults(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserConfigDto;
    }>("/config/defaults", {
        ...opts
    }));
}
/**
 * Download asset archive
 */
export function downloadArchive({ key, slug, downloadArchiveDto }: {
    key?: string;
    slug?: string;
    downloadArchiveDto: DownloadArchiveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/download/archive${QS.query(QS.explode({
        key,
        slug
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: downloadArchiveDto
    })));
}
/**
 * Retrieve download information
 */
export function getDownloadInfo({ key, slug, downloadInfoDto }: {
    key?: string;
    slug?: string;
    downloadInfoDto: DownloadInfoDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: DownloadResponseDto;
    }>(`/download/info${QS.query(QS.explode({
        key,
        slug
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: downloadInfoDto
    })));
}
/**
 * Delete duplicates
 */
export function deleteDuplicates({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/duplicates", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Retrieve duplicates
 */
export function getAssetDuplicates(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DuplicateResponseDto[];
    }>("/duplicates", {
        ...opts
    }));
}
/**
 * Resolve duplicate groups
 */
export function resolveDuplicates({ duplicateResolveDto }: {
    duplicateResolveDto: DuplicateResolveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>("/duplicates/resolve", oazapfts.json({
        ...opts,
        method: "POST",
        body: duplicateResolveDto
    })));
}
/**
 * Dismiss a duplicate group
 */
export function deleteDuplicate({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/duplicates/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve faces for asset
 */
export function getFaces({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFaceResponseDto[];
    }>(`/faces${QS.query(QS.explode({
        id
    }))}`, {
        ...opts
    }));
}
/**
 * Create a face
 */
export function createFace({ assetFaceCreateDto }: {
    assetFaceCreateDto: AssetFaceCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/faces", oazapfts.json({
        ...opts,
        method: "POST",
        body: assetFaceCreateDto
    })));
}
/**
 * Delete a face
 */
export function deleteFace({ id, assetFaceDeleteDto }: {
    id: string;
    assetFaceDeleteDto: AssetFaceDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/faces/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: assetFaceDeleteDto
    })));
}
/**
 * Re-assign a face to another person
 */
export function reassignFacesById({ id, faceDto }: {
    id: string;
    faceDto: FaceDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonResponseDto;
    }>(`/faces/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: faceDto
    })));
}
export function listICloudConnections(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ICloudConnectionsResponseDto;
    }>("/icloud-sync/connections", {
        ...opts
    }));
}
export function createICloudConnection({ iCloudConnectionCreateDto }: {
    iCloudConnectionCreateDto: ICloudConnectionCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ICloudConnectionResponseDto;
    }>("/icloud-sync/connections", oazapfts.json({
        ...opts,
        method: "POST",
        body: iCloudConnectionCreateDto
    })));
}
export function disconnectICloudConnection({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/icloud-sync/connections/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
export function updateICloudConnection({ id, iCloudConnectionUpdateDto }: {
    id: string;
    iCloudConnectionUpdateDto: ICloudConnectionUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ICloudConnectionResponseDto;
    }>(`/icloud-sync/connections/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: iCloudConnectionUpdateDto
    })));
}
export function authenticateICloudConnection({ id, iCloudAuthDto }: {
    id: string;
    iCloudAuthDto: ICloudAuthDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ICloudConnectionResponseDto;
    }>(`/icloud-sync/connections/${encodeURIComponent(id)}/auth`, oazapfts.json({
        ...opts,
        method: "POST",
        body: iCloudAuthDto
    })));
}
export function controlICloudConnection({ id, iCloudControlDto }: {
    id: string;
    iCloudControlDto: ICloudControlDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ICloudConnectionResponseDto;
    }>(`/icloud-sync/connections/${encodeURIComponent(id)}/control`, oazapfts.json({
        ...opts,
        method: "POST",
        body: iCloudControlDto
    })));
}
export function getICloudInventory({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ICloudInventoryResponseDto;
    }>(`/icloud-sync/connections/${encodeURIComponent(id)}/inventory`, {
        ...opts
    }));
}
/**
 * Retrieve queue counts and status
 */
export function getQueuesLegacy(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueuesResponseLegacyDto;
    }>("/jobs", {
        ...opts
    }));
}
/**
 * Get running jobs
 */
export function getRunningJobs(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunningJobsResponseDto;
    }>("/jobs/running", {
        ...opts
    }));
}
/**
 * Create a manual job
 */
export function createJob({ jobCreateDto }: {
    jobCreateDto: JobCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/jobs", oazapfts.json({
        ...opts,
        method: "POST",
        body: jobCreateDto
    })));
}
/**
 * Run jobs
 */
export function runQueueCommandLegacy({ name, queueCommandDto }: {
    name: QueueName;
    queueCommandDto: QueueCommandDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueResponseLegacyDto;
    }>(`/jobs/${encodeURIComponent(name)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: queueCommandDto
    })));
}
/**
 * Retrieve libraries
 */
export function getAllLibraries(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryResponseDto[];
    }>("/libraries", {
        ...opts
    }));
}
/**
 * Create a library
 */
export function createLibrary({ createLibraryDto }: {
    createLibraryDto: CreateLibraryDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LibraryResponseDto;
    }>("/libraries", oazapfts.json({
        ...opts,
        method: "POST",
        body: createLibraryDto
    })));
}
/**
 * Delete a library
 */
export function deleteLibrary({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/libraries/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a library
 */
export function getLibrary({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryResponseDto;
    }>(`/libraries/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a library
 */
export function updateLibrary({ id, updateLibraryDto }: {
    id: string;
    updateLibraryDto: UpdateLibraryDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryResponseDto;
    }>(`/libraries/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: updateLibraryDto
    })));
}
/**
 * Scan a library
 */
export function scanLibrary({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/libraries/${encodeURIComponent(id)}/scan`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve library statistics
 */
export function getLibraryStatistics({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryStatsResponseDto;
    }>(`/libraries/${encodeURIComponent(id)}/statistics`, {
        ...opts
    }));
}
/**
 * Validate library settings
 */
export function validate({ id, validateLibraryDto }: {
    id: string;
    validateLibraryDto: ValidateLibraryDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ValidateLibraryResponseDto;
    }>(`/libraries/${encodeURIComponent(id)}/validate`, oazapfts.json({
        ...opts,
        method: "POST",
        body: validateLibraryDto
    })));
}
/**
 * List live photo relink candidates
 */
export function getLivePhotoCandidates(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LivePhotoCandidatesResponseDto;
    }>("/live-photo/candidates", {
        ...opts
    }));
}
/**
 * Relink live photos
 */
export function relinkLivePhotos({ livePhotoRelinkDto }: {
    livePhotoRelinkDto: LivePhotoRelinkDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LivePhotoRelinkResponseDto;
    }>("/live-photo/relink", oazapfts.json({
        ...opts,
        method: "POST",
        body: livePhotoRelinkDto
    })));
}
/**
 * Retrieve map markers
 */
export function getMapMarkers({ fileCreatedAfter, fileCreatedBefore, isArchived, isFavorite, withPartners, withSharedAlbums }: {
    fileCreatedAfter?: string;
    fileCreatedBefore?: string;
    isArchived?: boolean;
    isFavorite?: boolean;
    withPartners?: boolean;
    withSharedAlbums?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MapMarkerResponseDto[];
    }>(`/map/markers${QS.query(QS.explode({
        fileCreatedAfter,
        fileCreatedBefore,
        isArchived,
        isFavorite,
        withPartners,
        withSharedAlbums
    }))}`, {
        ...opts
    }));
}
/**
 * Reverse geocode coordinates
 */
export function reverseGeocode({ lat, lon }: {
    lat: number;
    lon: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MapReverseGeocodeResponseDto[];
    }>(`/map/reverse-geocode${QS.query(QS.explode({
        lat,
        lon
    }))}`, {
        ...opts
    }));
}
/**
 * List media health findings
 */
export function list({ category, size, status }: {
    category?: MediaHealthCategory;
    size?: number;
    status?: MediaHealthStatus;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaHealthListResponseDto;
    }>(`/media-health${QS.query(QS.explode({
        category,
        size,
        status
    }))}`, {
        ...opts
    }));
}
/**
 * Move confirmed corrupt media to trash
 */
export function deleteCorrupt({ mediaHealthDeleteCorruptDto }: {
    mediaHealthDeleteCorruptDto: MediaHealthDeleteCorruptDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaHealthBulkResponseDto;
    }>("/media-health/corrupt", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: mediaHealthDeleteCorruptDto
    })));
}
/**
 * Start corrupt media scan
 */
export function startCorruptScan(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthScanResponseDto;
    }>("/media-health/corrupt/scan", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Dismiss media health findings
 */
export function dismiss({ mediaHealthBulkActionDto }: {
    mediaHealthBulkActionDto: MediaHealthBulkActionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/media-health/dismiss", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthBulkActionDto
    })));
}
/**
 * Locate missing media
 */
export function locateMissing({ mediaHealthBulkActionDto }: {
    mediaHealthBulkActionDto: MediaHealthBulkActionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthScanResponseDto;
    }>("/media-health/missing/locate", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthBulkActionDto
    })));
}
/**
 * Relink missing media
 */
export function relinkMissing({ mediaHealthBulkActionDto }: {
    mediaHealthBulkActionDto: MediaHealthBulkActionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthBulkResponseDto;
    }>("/media-health/missing/relink", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthBulkActionDto
    })));
}
/**
 * Start missing media scan
 */
export function startMissingScan(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthScanResponseDto;
    }>("/media-health/missing/scan", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Admit a render worker
 */
export function admitRenderWorker({ renderWorkerAdmissionDto }: {
    renderWorkerAdmissionDto: RenderWorkerAdmissionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: RenderWorkerSessionDto;
    }>("/render-workers/admission", oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerAdmissionDto
    })));
}
/**
 * Claim the next admitted operation
 */
export function claimRenderOperation({ renderWorkerClaimRequestDto, xFrameleafWorkerSession }: {
    renderWorkerClaimRequestDto: RenderWorkerClaimRequestDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerClaimDto;
    }>("/render-workers/claims", oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerClaimRequestDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Acknowledge a cancellation
 */
export function acknowledgeRenderCancel({ id, renderWorkerCancelAckDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerCancelAckDto: RenderWorkerCancelAckDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/cancel-ack`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCancelAckDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Plan a render checkpoint
 */
export function planRenderCheckpoint({ id, renderWorkerCheckpointPlanDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerCheckpointPlanDto: RenderWorkerCheckpointPlanDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/checkpoints`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCheckpointPlanDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Complete a render checkpoint
 */
export function completeRenderCheckpoint({ id, sequence, renderWorkerCheckpointCompleteDto, xFrameleafWorkerSession }: {
    id: string;
    sequence: number;
    renderWorkerCheckpointCompleteDto: RenderWorkerCheckpointCompleteDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(sequence)}/complete`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCheckpointCompleteDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Complete a claimed operation
 */
export function completeRenderOperation({ id, renderWorkerCompleteDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerCompleteDto: RenderWorkerCompleteDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/complete`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCompleteDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Fail a claimed operation
 */
export function failRenderOperation({ id, renderWorkerFailDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerFailDto: RenderWorkerFailDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/fail`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerFailDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Heartbeat a claimed operation
 */
export function heartbeatRenderOperation({ id, renderWorkerHeartbeatDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerHeartbeatDto: RenderWorkerHeartbeatDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerHeartbeatResponseDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/heartbeat`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerHeartbeatDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Read an operation input
 */
export function readRenderOperationInput({ grant, id, xFrameleafWorkerSession }: {
    grant: string;
    id: string;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/inputs/${encodeURIComponent(grant)}`, {
        ...opts,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    }));
}
/**
 * Report progress on a claimed operation
 */
export function reportRenderOperationProgress({ id, renderWorkerProgressDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerProgressDto: RenderWorkerProgressDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/progress`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerProgressDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * Begin validating a claimed operation
 */
export function validateRenderOperation({ id, renderWorkerCompleteDto, xFrameleafWorkerSession }: {
    id: string;
    renderWorkerCompleteDto: RenderWorkerCompleteDto;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/operations/${encodeURIComponent(id)}/validate`, oazapfts.json({
        ...opts,
        method: "POST",
        body: renderWorkerCompleteDto,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    })));
}
/**
 * List your media operations
 */
export function searchMediaOperations({ includeDismissed, kind, skip, status, take }: {
    includeDismissed?: boolean;
    kind?: MediaOperationKind;
    skip?: number;
    status?: MediaOperationStatus;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationListResponseDto;
    }>(`/media-operations${QS.query(QS.explode({
        includeDismissed,
        kind,
        skip,
        status,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Queue a bulk operation
 */
export function createBulkMediaOperation({ mediaOperationBulkCreateDto }: {
    mediaOperationBulkCreateDto: MediaOperationBulkCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>("/media-operations/bulk", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaOperationBulkCreateDto
    })));
}
/**
 * Get media operation statistics
 */
export function getMediaOperationStatistics(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationStatisticsDto;
    }>("/media-operations/statistics", {
        ...opts
    }));
}
/**
 * Get a media operation
 */
export function getMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationDetailDto;
    }>(`/media-operations/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Clear a finished media operation
 */
export function dismissMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/media-operations/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Request a Studio preview frame
 */
export function requestStudioPreview({ studioPreviewRequestDto }: {
    studioPreviewRequestDto: StudioPreviewRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioPreviewResponseDto;
    }>("/studio/previews", oazapfts.json({
        ...opts,
        method: "POST",
        body: studioPreviewRequestDto
    })));
}
/**
 * Get a Studio preview
 */
export function getStudioPreview({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioPreviewDto;
    }>(`/studio/previews/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * View a Studio preview frame
 */
export function viewStudioPreviewFrame({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/studio/previews/${encodeURIComponent(id)}/frame`, {
        ...opts
    }));
}
/**
 * Cancel a Studio preview
 */
export function cancelStudioPreview({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioPreviewDto;
    }>(`/studio/previews/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Cancel a media operation
 */
export function cancelMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationDto;
    }>(`/media-operations/${encodeURIComponent(id)}/cancel`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Pause a media operation
 */
export function pauseMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationDto;
    }>(`/media-operations/${encodeURIComponent(id)}/pause`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Resume a media operation
 */
export function resumeMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaOperationDto;
    }>(`/media-operations/${encodeURIComponent(id)}/resume`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retry a media operation
 */
export function retryMediaOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>(`/media-operations/${encodeURIComponent(id)}/retry`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve memories
 */
export function searchMemories({ $for, id, isSaved, isTrashed, isUpcoming, order, page, size, $type }: {
    $for?: string;
    id?: string;
    isSaved?: boolean;
    isTrashed?: boolean;
    isUpcoming?: boolean;
    order?: MemorySearchOrder;
    page?: number;
    size?: number;
    $type?: MemoryType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryResponseDto[];
    }>(`/memories${QS.query(QS.explode({
        "for": $for,
        id,
        isSaved,
        isTrashed,
        isUpcoming,
        order,
        page,
        size,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Create a memory
 */
export function createMemory({ memoryCreateDto }: {
    memoryCreateDto: MemoryCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MemoryResponseDto;
    }>("/memories", oazapfts.json({
        ...opts,
        method: "POST",
        body: memoryCreateDto
    })));
}
/**
 * Retrieve memories statistics
 */
export function memoriesStatistics({ $for, id, isSaved, isTrashed, isUpcoming, order, page, size, $type }: {
    $for?: string;
    id?: string;
    isSaved?: boolean;
    isTrashed?: boolean;
    isUpcoming?: boolean;
    order?: MemorySearchOrder;
    page?: number;
    size?: number;
    $type?: MemoryType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryStatisticsResponseDto;
    }>(`/memories/statistics${QS.query(QS.explode({
        "for": $for,
        id,
        isSaved,
        isTrashed,
        isUpcoming,
        order,
        page,
        size,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve memory exports
 */
export function getMemoryExports({ memoryId }: {
    memoryId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryExportResponseDto[];
    }>(`/memories/exports${QS.query(QS.explode({
        memoryId
    }))}`, {
        ...opts
    }));
}
/**
 * Delete a memory export
 */
export function deleteMemoryExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/memories/exports/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a memory export
 */
export function getMemoryExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryExportResponseDto;
    }>(`/memories/exports/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Cancel a memory export
 */
export function cancelMemoryExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryExportResponseDto;
    }>(`/memories/exports/${encodeURIComponent(id)}/cancel`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Download a memory export
 */
export function downloadMemoryExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/memories/exports/${encodeURIComponent(id)}/download`, {
        ...opts
    }));
}
/**
 * Delete a memory
 */
export function deleteMemory({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/memories/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a memory
 */
export function getMemory({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryResponseDto;
    }>(`/memories/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a memory
 */
export function updateMemory({ id, memoryUpdateDto }: {
    id: string;
    memoryUpdateDto: MemoryUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryResponseDto;
    }>(`/memories/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: memoryUpdateDto
    })));
}
/**
 * Remove assets from a memory
 */
export function removeMemoryAssets({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/memories/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Export a memory
 */
export function createMemoryExport({ id, memoryExportCreateDto }: {
    id: string;
    memoryExportCreateDto: MemoryExportCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MemoryExportResponseDto;
    }>(`/memories/${encodeURIComponent(id)}/exports`, oazapfts.json({
        ...opts,
        method: "POST",
        body: memoryExportCreateDto
    })));
}
/**
 * Add assets to a memory
 */
export function addMemoryAssets({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/memories/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: bulkIdsDto
    })));
}
/**
 * List machine-learning destinations
 */
export function listMlDestinations(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationResponseDto[];
    }>("/ml-destinations", {
        ...opts
    }));
}
/**
 * Create a machine-learning destination
 */
export function createMlDestination({ mlDestinationCreateDto }: {
    mlDestinationCreateDto: MlDestinationCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MlDestinationResponseDto;
    }>("/ml-destinations", oazapfts.json({
        ...opts,
        method: "POST",
        body: mlDestinationCreateDto
    })));
}
/**
 * Get machine-learning capabilities
 */
export function getMlCapabilities(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlCapabilitiesResponseDto;
    }>("/ml-destinations/capabilities", {
        ...opts
    }));
}
/**
 * List workload routes
 */
export function getMlWorkloadRoutes(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlWorkloadRoutesResponseDto;
    }>("/ml-destinations/routes", {
        ...opts
    }));
}
/**
 * Route a workload
 */
export function setMlWorkloadRoute({ workload, mlWorkloadRouteUpdateDto }: {
    workload: MlWorkload;
    mlWorkloadRouteUpdateDto: MlWorkloadRouteUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlWorkloadRoutesResponseDto;
    }>(`/ml-destinations/routes/${encodeURIComponent(workload)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: mlWorkloadRouteUpdateDto
    })));
}
/**
 * Delete a machine-learning destination
 */
export function deleteMlDestination({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/ml-destinations/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a machine-learning destination
 */
export function getMlDestination({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a machine-learning destination
 */
export function updateMlDestination({ id, mlDestinationUpdateDto }: {
    id: string;
    mlDestinationUpdateDto: MlDestinationUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: mlDestinationUpdateDto
    })));
}
/**
 * Admit a workload on a destination
 */
export function admitMlWorkload({ id, mlAdmissionRequestDto }: {
    id: string;
    mlAdmissionRequestDto: MlAdmissionRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlAdmissionResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}/admission`, oazapfts.json({
        ...opts,
        method: "POST",
        body: mlAdmissionRequestDto
    })));
}
/**
 * Revoke consent for a cloud destination
 */
export function revokeMlDestinationConsent({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}/consent`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Record consent for a cloud destination
 */
export function grantMlDestinationConsent({ id, mlDestinationConsentRequestDto }: {
    id: string;
    mlDestinationConsentRequestDto: MlDestinationConsentRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}/consent`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: mlDestinationConsentRequestDto
    })));
}
/**
 * Probe a machine-learning destination
 */
export function probeMlDestination({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlDestinationHealthStateDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}/probe`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Get restoration models of a destination
 */
export function getMlDestinationRestorationModels({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MlRestorationModelsResponseDto;
    }>(`/ml-destinations/${encodeURIComponent(id)}/restoration-models`, {
        ...opts
    }));
}
/**
 * Delete notifications
 */
export function deleteNotifications({ notificationDeleteAllDto }: {
    notificationDeleteAllDto: NotificationDeleteAllDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/notifications", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: notificationDeleteAllDto
    })));
}
/**
 * Retrieve notifications
 */
export function getNotifications({ id, level, $type, unread }: {
    id?: string;
    level?: NotificationLevel;
    $type?: NotificationType;
    unread?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: NotificationDto[];
    }>(`/notifications${QS.query(QS.explode({
        id,
        level,
        "type": $type,
        unread
    }))}`, {
        ...opts
    }));
}
/**
 * Update notifications
 */
export function updateNotifications({ notificationUpdateAllDto }: {
    notificationUpdateAllDto: NotificationUpdateAllDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/notifications", oazapfts.json({
        ...opts,
        method: "PUT",
        body: notificationUpdateAllDto
    })));
}
/**
 * Delete a notification
 */
export function deleteNotification({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/notifications/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a notification
 */
export function getNotification({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: NotificationDto;
    }>(`/notifications/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a notification
 */
export function updateNotification({ id, notificationUpdateDto }: {
    id: string;
    notificationUpdateDto: NotificationUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: NotificationDto;
    }>(`/notifications/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: notificationUpdateDto
    })));
}
/**
 * Start OAuth
 */
export function startOAuth({ oAuthConfigDto }: {
    oAuthConfigDto: OAuthConfigDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: OAuthAuthorizeResponseDto;
    }>("/oauth/authorize", oazapfts.json({
        ...opts,
        method: "POST",
        body: oAuthConfigDto
    })));
}
/**
 * Backchannel OAuth logout
 */
export function logoutOAuth({ oAuthBackchannelLogoutDto }: {
    oAuthBackchannelLogoutDto: OAuthBackchannelLogoutDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/oauth/backchannel-logout", oazapfts.form({
        ...opts,
        method: "POST",
        body: oAuthBackchannelLogoutDto
    })));
}
/**
 * Finish OAuth
 */
export function finishOAuth({ oAuthCallbackDto }: {
    oAuthCallbackDto: OAuthCallbackDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LoginResponseDto;
    }>("/oauth/callback", oazapfts.json({
        ...opts,
        method: "POST",
        body: oAuthCallbackDto
    })));
}
/**
 * Link OAuth account
 */
export function linkOAuthAccount({ oAuthCallbackDto }: {
    oAuthCallbackDto: OAuthCallbackDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/oauth/link", oazapfts.json({
        ...opts,
        method: "POST",
        body: oAuthCallbackDto
    })));
}
/**
 * Redirect OAuth to mobile
 */
export function redirectOAuthToMobile(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/oauth/mobile-redirect", {
        ...opts
    }));
}
/**
 * Unlink OAuth account
 */
export function unlinkOAuthAccount(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/oauth/unlink", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve partners
 */
export function getPartners({ direction }: {
    direction: PartnerDirection;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PartnerResponseDto[];
    }>(`/partners${QS.query(QS.explode({
        direction
    }))}`, {
        ...opts
    }));
}
/**
 * Create a partner
 */
export function createPartner({ partnerCreateDto }: {
    partnerCreateDto: PartnerCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PartnerResponseDto;
    }>("/partners", oazapfts.json({
        ...opts,
        method: "POST",
        body: partnerCreateDto
    })));
}
/**
 * Remove a partner
 */
export function removePartner({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/partners/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Create a partner
 */
export function createPartnerDeprecated({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PartnerResponseDto;
    }>(`/partners/${encodeURIComponent(id)}`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Update a partner
 */
export function updatePartner({ id, partnerUpdateDto }: {
    id: string;
    partnerUpdateDto: PartnerUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PartnerResponseDto;
    }>(`/partners/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: partnerUpdateDto
    })));
}
/**
 * Delete people
 */
export function deletePeople({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/people", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Get all people
 */
export function getAllPeople({ closestAssetId, closestPersonId, page, size, withHidden }: {
    closestAssetId?: string;
    closestPersonId?: string;
    page?: number;
    size?: number;
    withHidden?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PeopleResponseDto;
    }>(`/people${QS.query(QS.explode({
        closestAssetId,
        closestPersonId,
        page,
        size,
        withHidden
    }))}`, {
        ...opts
    }));
}
/**
 * Create a person
 */
export function createPerson({ personCreateDto }: {
    personCreateDto: PersonCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PersonResponseDto;
    }>("/people", oazapfts.json({
        ...opts,
        method: "POST",
        body: personCreateDto
    })));
}
/**
 * Update people
 */
export function updatePeople({ peopleUpdateDto }: {
    peopleUpdateDto: PeopleUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>("/people", oazapfts.json({
        ...opts,
        method: "PUT",
        body: peopleUpdateDto
    })));
}
/**
 * Merge people
 */
export function mergePeople({ mergePersonDto }: {
    mergePersonDto: MergePersonDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>("/people/merge", oazapfts.json({
        ...opts,
        method: "POST",
        body: mergePersonDto
    })));
}
/**
 * Get merge suggestions
 */
export function getMergeSuggestions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MergeSuggestionsResponseDto;
    }>("/people/merge-suggestions", {
        ...opts
    }));
}
/**
 * Delete person
 */
export function deletePerson({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/people/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a person
 */
export function getPerson({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonResponseDto;
    }>(`/people/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update person
 */
export function updatePerson({ id, personUpdateDto }: {
    id: string;
    personUpdateDto: PersonUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonResponseDto;
    }>(`/people/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: personUpdateDto
    })));
}
/**
 * Merge people
 */
export function mergePersonLegacy({ id, mergePersonDto }: {
    id: string;
    mergePersonDto: MergePersonDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/people/${encodeURIComponent(id)}/merge`, oazapfts.json({
        ...opts,
        method: "POST",
        body: mergePersonDto
    })));
}
/**
 * Reassign faces
 */
export function reassignFaces({ id, assetFaceUpdateDto }: {
    id: string;
    assetFaceUpdateDto: AssetFaceUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonResponseDto[];
    }>(`/people/${encodeURIComponent(id)}/reassign`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetFaceUpdateDto
    })));
}
/**
 * Get correction history
 */
export function getCorrectionHistory({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonCorrectionsResponseDto;
    }>(`/people/${encodeURIComponent(id)}/corrections`, {
        ...opts
    }));
}
/**
 * Get person statistics
 */
export function getPersonStatistics({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonStatisticsResponseDto;
    }>(`/people/${encodeURIComponent(id)}/statistics`, {
        ...opts
    }));
}
/**
 * Get person thumbnail
 */
export function getPersonThumbnail({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/people/${encodeURIComponent(id)}/thumbnail`, {
        ...opts
    }));
}
/**
 * Retrieve pets
 */
export function getAllPets({ withHidden }: {
    withHidden?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetResponseDto[];
    }>(`/pets${QS.query(QS.explode({
        withHidden
    }))}`, {
        ...opts
    }));
}
/**
 * Create a pet
 */
export function createPet({ petCreateDto }: {
    petCreateDto: PetCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetResponseDto;
    }>("/pets", oazapfts.json({
        ...opts,
        method: "POST",
        body: petCreateDto
    })));
}
/**
 * Retrieve pet recognition candidates
 */
export function getPetCandidates({ size }: {
    size?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetCandidateListResponseDto;
    }>(`/pets/candidates${QS.query(QS.explode({
        size
    }))}`, {
        ...opts
    }));
}
/**
 * Accept a pet recognition candidate
 */
export function acceptPetCandidate({ id, petCandidateReviewDto }: {
    id: string;
    petCandidateReviewDto: PetCandidateReviewDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetObservationResponseDto;
    }>(`/pets/candidates/${encodeURIComponent(id)}/accept`, oazapfts.json({
        ...opts,
        method: "POST",
        body: petCandidateReviewDto
    })));
}
/**
 * Reject a pet recognition candidate
 */
export function rejectPetCandidate({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetObservationResponseDto;
    }>(`/pets/candidates/${encodeURIComponent(id)}/reject`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Remove a pet observation
 */
export function deletePetObservation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/pets/observations/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a pet
 */
export function getPet({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetResponseDto;
    }>(`/pets/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a pet
 */
export function updatePet({ id, petUpdateDto }: {
    id: string;
    petUpdateDto: PetUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetResponseDto;
    }>(`/pets/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: petUpdateDto
    })));
}
/**
 * Delete a pet
 */
export function deletePet({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/pets/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Merge pets
 */
export function mergePets({ id, petMergeDto }: {
    id: string;
    petMergeDto: PetMergeDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetResponseDto;
    }>(`/pets/${encodeURIComponent(id)}/merge`, oazapfts.json({
        ...opts,
        method: "POST",
        body: petMergeDto
    })));
}
/**
 * Retrieve pet observations
 */
export function getPetObservations({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetObservationResponseDto[];
    }>(`/pets/${encodeURIComponent(id)}/observations`, {
        ...opts
    }));
}
/**
 * Add a pet observation
 */
export function createPetObservation({ id, petObservationCreateDto }: {
    id: string;
    petObservationCreateDto: PetObservationCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetObservationResponseDto;
    }>(`/pets/${encodeURIComponent(id)}/observations`, oazapfts.json({
        ...opts,
        method: "POST",
        body: petObservationCreateDto
    })));
}
/**
 * List all plugins
 */
export function searchPlugins({ description, enabled, id, name, title, version }: {
    description?: string;
    enabled?: boolean;
    id?: string;
    name?: string;
    title?: string;
    version?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PluginResponseDto[];
    }>(`/plugins${QS.query(QS.explode({
        description,
        enabled,
        id,
        name,
        title,
        version
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve plugin methods
 */
export function searchPluginMethods({ description, enabled, id, name, pluginName, pluginVersion, title, trigger, $type }: {
    description?: string;
    enabled?: boolean;
    id?: string;
    name?: string;
    pluginName?: string;
    pluginVersion?: string;
    title?: string;
    trigger?: WorkflowTrigger;
    $type?: WorkflowType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PluginMethodResponseDto[];
    }>(`/plugins/methods${QS.query(QS.explode({
        description,
        enabled,
        id,
        name,
        pluginName,
        pluginVersion,
        title,
        trigger,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve workflow templates
 */
export function searchPluginTemplates(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PluginTemplateResponseDto[];
    }>("/plugins/templates", {
        ...opts
    }));
}
/**
 * Retrieve a plugin
 */
export function getPlugin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PluginResponseDto;
    }>(`/plugins/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Get the public configuration
 */
export function getPublicConfig(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PublicConfigDto;
    }>("/public/config", {
        ...opts
    }));
}
/**
 * Get the public configuration defaults
 */
export function getPublicConfigDefaults(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PublicConfigDto;
    }>("/public/config/defaults", {
        ...opts
    }));
}
/**
 * List all queues
 */
export function getQueues(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueResponseDto[];
    }>("/queues", {
        ...opts
    }));
}
/**
 * Retrieve a queue
 */
export function getQueue({ name }: {
    name: QueueName;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueResponseDto;
    }>(`/queues/${encodeURIComponent(name)}`, {
        ...opts
    }));
}
/**
 * Update a queue
 */
export function updateQueue({ name, queueUpdateDto }: {
    name: QueueName;
    queueUpdateDto: QueueUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueResponseDto;
    }>(`/queues/${encodeURIComponent(name)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: queueUpdateDto
    })));
}
/**
 * Empty a queue
 */
export function emptyQueue({ name, queueDeleteDto }: {
    name: QueueName;
    queueDeleteDto: QueueDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/queues/${encodeURIComponent(name)}/jobs`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: queueDeleteDto
    })));
}
/**
 * Retrieve queue jobs
 */
export function getQueueJobs({ name, status }: {
    name: QueueName;
    status?: QueueJobStatus[];
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueJobResponseDto[];
    }>(`/queues/${encodeURIComponent(name)}/jobs${QS.query(QS.explode({
        status
    }))}`, {
        ...opts
    }));
}
/**
 * Enqueue all ML backfill jobs
 */
export function backfill(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodBackfillResultDto;
    }>("/runpod/backfill", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Test RunPod connection
 */
export function testConnection({ runPodConnectionTestDto }: {
    runPodConnectionTestDto: RunPodConnectionTestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodConnectionResultDto;
    }>("/runpod/connect", oazapfts.json({
        ...opts,
        method: "POST",
        body: runPodConnectionTestDto
    })));
}
/**
 * Tear down the serverless endpoint
 */
export function teardownServerlessEndpoint(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/endpoint", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Set up (or verify) the serverless endpoint
 */
export function setupServerlessEndpoint(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/endpoint/setup", {
        ...opts,
        method: "POST"
    }));
}
/**
 * List RunPod GPU types
 */
export function listGpus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodGpuTypeDto[];
    }>("/runpod/gpus", {
        ...opts
    }));
}
/**
 * Provision a RunPod pod
 */
export function provision({ runPodProvisionDto }: {
    runPodProvisionDto: RunPodProvisionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: RunPodStateDto;
    }>("/runpod/pods", oazapfts.json({
        ...opts,
        method: "POST",
        body: runPodProvisionDto
    })));
}
/**
 * Terminate the current RunPod pod
 */
export function terminate(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/pods/current", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get current RunPod state
 */
export function getCurrent(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/pods/current", {
        ...opts
    }));
}
/**
 * Resume the current RunPod pod
 */
export function start(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/pods/current/start", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Stop the current RunPod pod
 */
export function stop(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RunPodStateDto;
    }>("/runpod/pods/current/stop", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Ask Search
 */
export function askSearch({ askSearchDto }: {
    askSearchDto: AskSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AskSearchResponseDto;
    }>("/search/ask", oazapfts.json({
        ...opts,
        method: "POST",
        body: askSearchDto
    })));
}
/**
 * Retrieve assets by city
 */
export function getAssetsByCity(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto[];
    }>("/search/cities", {
        ...opts
    }));
}
/**
 * Retrieve explore data
 */
export function getExploreData(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchExploreResponseDto[];
    }>("/search/explore", {
        ...opts
    }));
}
/**
 * Search large assets
 */
export function searchLargeAssets({ albumIds, city, country, createdAfter, createdBefore, imageEnrichment, isEncoded, isFavorite, isMotion, isNotInAlbum, isOffline, lensModel, libraryId, make, minFileSize, model, ocr, personIds, petIds, rating, size, state, suppressedOnly, tagIds, takenAfter, takenBefore, trashedAfter, trashedBefore, $type, updatedAfter, updatedBefore, visibility, withDeleted, withExif }: {
    albumIds?: string[];
    city?: string | null;
    country?: string | null;
    createdAfter?: string;
    createdBefore?: string;
    imageEnrichment?: ImageEnrichmentFilter;
    isEncoded?: boolean;
    isFavorite?: boolean;
    isMotion?: boolean;
    isNotInAlbum?: boolean;
    isOffline?: boolean;
    lensModel?: string | null;
    libraryId?: string | null;
    make?: string | null;
    minFileSize?: number;
    model?: string | null;
    ocr?: string;
    personIds?: string[];
    petIds?: string[];
    rating?: number | null;
    size?: number;
    state?: string | null;
    suppressedOnly?: boolean;
    tagIds?: string[] | null;
    takenAfter?: string;
    takenBefore?: string;
    trashedAfter?: string;
    trashedBefore?: string;
    $type?: AssetTypeEnum;
    updatedAfter?: string;
    updatedBefore?: string;
    visibility?: AssetVisibility;
    withDeleted?: boolean;
    withExif?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto[];
    }>(`/search/large-assets${QS.query(QS.explode({
        albumIds,
        city,
        country,
        createdAfter,
        createdBefore,
        imageEnrichment,
        isEncoded,
        isFavorite,
        isMotion,
        isNotInAlbum,
        isOffline,
        lensModel,
        libraryId,
        make,
        minFileSize,
        model,
        ocr,
        personIds,
        petIds,
        rating,
        size,
        state,
        suppressedOnly,
        tagIds,
        takenAfter,
        takenBefore,
        trashedAfter,
        trashedBefore,
        "type": $type,
        updatedAfter,
        updatedBefore,
        visibility,
        withDeleted,
        withExif
    }))}`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Search assets by metadata
 */
export function searchAssets({ key, slug, metadataSearchDto }: {
    key?: string;
    slug?: string;
    metadataSearchDto: MetadataSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchResponseDto;
    }>(`/search/metadata${QS.query(QS.explode({
        key,
        slug
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: metadataSearchDto
    })));
}
/**
 * Search people
 */
export function searchPerson({ name, withHidden }: {
    name: string;
    withHidden?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonResponseDto[];
    }>(`/search/person${QS.query(QS.explode({
        name,
        withHidden
    }))}`, {
        ...opts
    }));
}
/**
 * Search places
 */
export function searchPlaces({ name }: {
    name: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PlacesResponseDto[];
    }>(`/search/places${QS.query(QS.explode({
        name
    }))}`, {
        ...opts
    }));
}
/**
 * Search random assets
 */
export function searchRandom({ randomSearchDto }: {
    randomSearchDto: RandomSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto[];
    }>("/search/random", oazapfts.json({
        ...opts,
        method: "POST",
        body: randomSearchDto
    })));
}
/**
 * Smart asset search
 */
export function searchSmart({ smartSearchDto }: {
    smartSearchDto: SmartSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchResponseDto;
    }>("/search/smart", oazapfts.json({
        ...opts,
        method: "POST",
        body: smartSearchDto
    })));
}
/**
 * Search asset statistics
 */
export function searchAssetStatistics({ statisticsSearchDto }: {
    statisticsSearchDto: StatisticsSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchStatisticsResponseDto;
    }>("/search/statistics", oazapfts.json({
        ...opts,
        method: "POST",
        body: statisticsSearchDto
    })));
}
/**
 * Retrieve search suggestions
 */
export function getSearchSuggestions({ country, includeNull, lensModel, make, model, state, $type }: {
    country?: string;
    includeNull?: boolean;
    lensModel?: string;
    make?: string;
    model?: string;
    state?: string;
    $type: SearchSuggestionType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: string[];
    }>(`/search/suggestions${QS.query(QS.explode({
        country,
        includeNull,
        lensModel,
        make,
        model,
        state,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Get server information
 */
export function getAboutInfo(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerAboutResponseDto;
    }>("/server/about", {
        ...opts
    }));
}
/**
 * Get APK links
 */
export function getApkLinks(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerApkLinksDto;
    }>("/server/apk-links", {
        ...opts
    }));
}
/**
 * Get config
 */
export function getServerConfig(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerConfigDto;
    }>("/server/config", {
        ...opts
    }));
}
/**
 * Get features
 */
export function getServerFeatures(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerFeaturesDto;
    }>("/server/features", {
        ...opts
    }));
}
/**
 * Delete server product key
 */
export function deleteServerLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/server/license", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get product key
 */
export function getServerLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserLicense;
    } | {
        status: 404;
    }>("/server/license", {
        ...opts
    }));
}
/**
 * Set server product key
 */
export function setServerLicense({ licenseKeyDto }: {
    licenseKeyDto: LicenseKeyDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserLicense;
    }>("/server/license", oazapfts.json({
        ...opts,
        method: "PUT",
        body: licenseKeyDto
    })));
}
/**
 * Get supported media types
 */
export function getSupportedMediaTypes(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerMediaTypesResponseDto;
    }>("/server/media-types", {
        ...opts
    }));
}
/**
 * Ping
 */
export function pingServer(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerPingResponse;
    }>("/server/ping", {
        ...opts
    }));
}
/**
 * Get statistics
 */
export function getServerStatistics(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerStatsResponseDto;
    }>("/server/statistics", {
        ...opts
    }));
}
/**
 * Get storage
 */
export function getStorage(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerStorageResponseDto;
    }>("/server/storage", {
        ...opts
    }));
}
/**
 * Get server version
 */
export function getServerVersion(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerVersionResponseDto;
    }>("/server/version", {
        ...opts
    }));
}
/**
 * Get version check status
 */
export function getVersionCheck(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VersionCheckStateResponseDto;
    }>("/server/version-check", {
        ...opts
    }));
}
/**
 * Get version history
 */
export function getVersionHistory(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerVersionHistoryResponseDto[];
    }>("/server/version-history", {
        ...opts
    }));
}
/**
 * Delete all sessions
 */
export function deleteAllSessions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/sessions", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve sessions
 */
export function getSessions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SessionResponseDto[];
    }>("/sessions", {
        ...opts
    }));
}
/**
 * Create a session
 */
export function createSession({ sessionCreateDto }: {
    sessionCreateDto: SessionCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: SessionCreateResponseDto;
    }>("/sessions", oazapfts.json({
        ...opts,
        method: "POST",
        body: sessionCreateDto
    })));
}
/**
 * Delete a session
 */
export function deleteSession({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/sessions/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Update a session
 */
export function updateSession({ id, sessionUpdateDto }: {
    id: string;
    sessionUpdateDto: SessionUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SessionResponseDto;
    }>(`/sessions/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: sessionUpdateDto
    })));
}
/**
 * Lock a session
 */
export function lockSession({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/sessions/${encodeURIComponent(id)}/lock`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve all shared links
 */
export function getAllSharedLinks({ albumId, id }: {
    albumId?: string;
    id?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedLinkResponseDto[];
    }>(`/shared-links${QS.query(QS.explode({
        albumId,
        id
    }))}`, {
        ...opts
    }));
}
/**
 * Create a shared link
 */
export function createSharedLink({ sharedLinkCreateDto }: {
    sharedLinkCreateDto: SharedLinkCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: SharedLinkResponseDto;
    }>("/shared-links", oazapfts.json({
        ...opts,
        method: "POST",
        body: sharedLinkCreateDto
    })));
}
/**
 * Shared link login
 */
export function sharedLinkLogin({ key, slug, sharedLinkLoginDto }: {
    key?: string;
    slug?: string;
    sharedLinkLoginDto: SharedLinkLoginDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: SharedLinkResponseDto;
    }>(`/shared-links/login${QS.query(QS.explode({
        key,
        slug
    }))}`, oazapfts.json({
        ...opts,
        method: "POST",
        body: sharedLinkLoginDto
    })));
}
/**
 * Retrieve current shared link
 */
export function getMySharedLink({ key, slug }: {
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedLinkResponseDto;
    }>(`/shared-links/me${QS.query(QS.explode({
        key,
        slug
    }))}`, {
        ...opts
    }));
}
/**
 * Delete a shared link
 */
export function removeSharedLink({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-links/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a shared link
 */
export function getSharedLinkById({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedLinkResponseDto;
    }>(`/shared-links/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a shared link
 */
export function updateSharedLink({ id, sharedLinkEditDto }: {
    id: string;
    sharedLinkEditDto: SharedLinkEditDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedLinkResponseDto;
    }>(`/shared-links/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: sharedLinkEditDto
    })));
}
/**
 * Remove assets from a shared link
 */
export function removeSharedLinkAssets({ id, assetIdsDto }: {
    id: string;
    assetIdsDto: AssetIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetIdsResponseDto[];
    }>(`/shared-links/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: assetIdsDto
    })));
}
/**
 * Add assets to a shared link
 */
export function addSharedLinkAssets({ id, assetIdsDto }: {
    id: string;
    assetIdsDto: AssetIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetIdsResponseDto[];
    }>(`/shared-links/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: assetIdsDto
    })));
}
/**
 * List shared space invitations
 */
export function getSharedSpaceInvitations(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpacePreviewResponseDto[];
    }>("/shared-spaces/invitations", {
        ...opts
    }));
}
/**
 * Accept a shared space invitation
 */
export function acceptSharedSpaceInvitation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AlbumResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/accept`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * What happened in a shared space
 */
export function getSharedSpaceActivity({ id, before, take }: {
    id: string;
    before?: string;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceActivityResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/activity${QS.query(QS.explode({
        before,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * List albums linked into a shared space
 */
export function getSharedSpaceAlbums({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceAlbumsResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/albums`, {
        ...opts
    }));
}
/**
 * Unlink an album from a shared space
 */
export function unlinkSharedSpaceAlbum({ id, albumId }: {
    id: string;
    albumId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/albums/${encodeURIComponent(albumId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Link an album into a shared space
 */
export function linkSharedSpaceAlbum({ id, albumId }: {
    id: string;
    albumId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceAlbumsResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/albums/${encodeURIComponent(albumId)}`, {
        ...opts,
        method: "PUT"
    }));
}
/**
 * List comments in a shared space
 */
export function getSharedSpaceComments({ id, assetId }: {
    id: string;
    assetId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceCommentsResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/comments${QS.query(QS.explode({
        assetId
    }))}`, {
        ...opts
    }));
}
/**
 * Comment in a shared space
 */
export function createSharedSpaceComment({ id, sharedSpaceCommentCreateDto }: {
    id: string;
    sharedSpaceCommentCreateDto: SharedSpaceCommentCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: SharedSpaceCommentResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/comments`, oazapfts.json({
        ...opts,
        method: "POST",
        body: sharedSpaceCommentCreateDto
    })));
}
/**
 * Remove a shared space comment
 */
export function deleteSharedSpaceComment({ id, commentId }: {
    id: string;
    commentId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Edit a shared space comment
 */
export function updateSharedSpaceComment({ id, commentId, sharedSpaceCommentUpdateDto }: {
    id: string;
    commentId: string;
    sharedSpaceCommentUpdateDto: SharedSpaceCommentUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceCommentResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: sharedSpaceCommentUpdateDto
    })));
}
/**
 * Decline a shared space invitation
 */
export function declineSharedSpaceInvitation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/invitation`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Withdraw a shared space invitation
 */
export function removeSharedSpaceInvitation({ id, userId }: {
    id: string;
    userId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/invitations/${encodeURIComponent(userId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * List shared space members
 */
export function getSharedSpaceMembers({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceMembersResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/members`, {
        ...opts
    }));
}
/**
 * What is new in a shared space since your last visit
 */
export function getSharedSpaceNew({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceNewResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/new`, {
        ...opts
    }));
}
/**
 * People in a shared space
 */
export function getSharedSpacePeople({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpacePeopleResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/people`, {
        ...opts
    }));
}
/**
 * Link a person into a shared space
 */
export function linkSharedSpacePerson({ id, sharedSpacePersonLinkDto }: {
    id: string;
    sharedSpacePersonLinkDto: SharedSpacePersonLinkDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpacePeopleResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/people`, oazapfts.json({
        ...opts,
        method: "POST",
        body: sharedSpacePersonLinkDto
    })));
}
/**
 * Unlink a person from a shared space
 */
export function unlinkSharedSpacePerson({ id, linkId }: {
    id: string;
    linkId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/people/${encodeURIComponent(linkId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Preview a shared space
 */
export function getSharedSpacePreview({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpacePreviewResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/preview`, {
        ...opts
    }));
}
/**
 * Mark a shared space seen
 */
export function markSharedSpaceVisited({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SharedSpaceNewResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/visit`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Delete stacks
 */
export function deleteStacks({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/stacks", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Retrieve stacks
 */
export function searchStacks({ primaryAssetId }: {
    primaryAssetId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StackResponseDto[];
    }>(`/stacks${QS.query(QS.explode({
        primaryAssetId
    }))}`, {
        ...opts
    }));
}
/**
 * Create a stack
 */
export function createStack({ stackCreateDto }: {
    stackCreateDto: StackCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StackResponseDto;
    }>("/stacks", oazapfts.json({
        ...opts,
        method: "POST",
        body: stackCreateDto
    })));
}
/**
 * Delete a stack
 */
export function deleteStack({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/stacks/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a stack
 */
export function getStack({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StackResponseDto;
    }>(`/stacks/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a stack
 */
export function updateStack({ id, stackUpdateDto }: {
    id: string;
    stackUpdateDto: StackUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StackResponseDto;
    }>(`/stacks/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: stackUpdateDto
    })));
}
/**
 * Remove an asset from a stack
 */
export function removeAssetFromStack({ assetId, id }: {
    assetId: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/stacks/${encodeURIComponent(id)}/assets/${encodeURIComponent(assetId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Download a Studio bundle
 */
export function downloadStudioBundle({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/studio/bundles/exports/${encodeURIComponent(id)}/download`, {
        ...opts
    }));
}
/**
 * Import a Studio bundle
 */
export function importStudioBundle({ studioBundleImportCreateDto }: {
    studioBundleImportCreateDto: StudioBundleImportCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>("/studio/bundles/imports", oazapfts.json({
        ...opts,
        method: "POST",
        body: studioBundleImportCreateDto
    })));
}
/**
 * Get a Studio bundle job
 */
export function getStudioBundleOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioBundleOperationDto;
    }>(`/studio/bundles/operations/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Upload a Studio bundle
 */
export function uploadStudioBundle({ studioBundleUploadCreateDto }: {
    studioBundleUploadCreateDto: StudioBundleUploadCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioBundleUploadDto;
    }>("/studio/bundles/uploads", oazapfts.multipart({
        ...opts,
        method: "POST",
        body: studioBundleUploadCreateDto
    })));
}
/**
 * Discard an uploaded Studio bundle
 */
export function deleteStudioBundleUpload({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/studio/bundles/uploads/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get an uploaded Studio bundle
 */
export function getStudioBundleUpload({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioBundleUploadDto;
    }>(`/studio/bundles/uploads/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * List Studio projects
 */
export function searchStudioProjects({ query, shelf, skip, sort, take }: {
    query?: string;
    shelf?: StudioProjectShelf;
    skip?: number;
    sort?: StudioProjectSort;
    take?: number;
} = {}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectListResponseDto;
    }>(`/studio/projects${QS.query(QS.explode({
        query,
        shelf,
        skip,
        sort,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Create a Studio project
 */
export function createStudioProject({ studioProjectCreateDto }: {
    studioProjectCreateDto: StudioProjectCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioProjectDetailDto;
    }>("/studio/projects", oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectCreateDto
    })));
}
/**
 * Empty the Studio trash
 */
export function emptyStudioProjectTrash(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectTrashEmptyResponseDto;
    }>("/studio/projects/trash/empty", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Get a Studio project
 */
export function getStudioProject({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectDetailDto;
    }>(`/studio/projects/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a Studio project
 */
export function updateStudioProject({ id, studioProjectUpdateDto }: {
    id: string;
    studioProjectUpdateDto: StudioProjectUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectDto;
    }>(`/studio/projects/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: studioProjectUpdateDto
    })));
}
/**
 * Delete a Studio project
 */
export function deleteStudioProject({ id, permanent }: {
    id: string;
    permanent?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/studio/projects/${encodeURIComponent(id)}${QS.query(QS.explode({
        permanent
    }))}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Export a Studio project as a bundle
 */
export function exportStudioProjectBundle({ id, studioBundleExportCreateDto }: {
    id: string;
    studioBundleExportCreateDto: StudioBundleExportCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/bundle`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioBundleExportCreateDto
    })));
}
/**
 * List Studio review comments
 */
export function getStudioProjectComments({ id, skip, take }: {
    id: string;
    skip?: number;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioCommentListResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/comments${QS.query(QS.explode({
        skip,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Add a Studio review comment
 */
export function addStudioProjectComment({ id, studioCommentCreateDto }: {
    id: string;
    studioCommentCreateDto: StudioCommentCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioCommentDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/comments`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioCommentCreateDto
    })));
}
/**
 * Update a Studio review comment
 */
export function updateStudioProjectComment({ commentId, id, studioCommentUpdateDto }: {
    commentId: string;
    id: string;
    studioCommentUpdateDto: StudioCommentUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioCommentDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: studioCommentUpdateDto
    })));
}
/**
 * Remove a Studio review comment
 */
export function removeStudioProjectComment({ commentId, id }: {
    commentId: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/studio/projects/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Duplicate a Studio project
 */
export function duplicateStudioProject({ id, studioProjectDuplicateDto }: {
    id: string;
    studioProjectDuplicateDto: StudioProjectDuplicateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioProjectDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/duplicate`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectDuplicateDto
    })));
}
/**
 * Acquire or renew the write lease
 */
export function acquireStudioProjectLease({ id, studioProjectLeaseRequestDto }: {
    id: string;
    studioProjectLeaseRequestDto: StudioProjectLeaseRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectLeaseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/lease`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectLeaseRequestDto
    })));
}
/**
 * Release the write lease
 */
export function releaseStudioProjectLease({ id, studioProjectLeaseRequestDto }: {
    id: string;
    studioProjectLeaseRequestDto: StudioProjectLeaseRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/studio/projects/${encodeURIComponent(id)}/lease/release`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectLeaseRequestDto
    })));
}
/**
 * Restore a Studio project revision
 */
export function restoreStudioProjectRevision({ id, studioProjectRestoreDto }: {
    id: string;
    studioProjectRestoreDto: StudioProjectRestoreDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioProjectSaveResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/restore`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectRestoreDto
    })));
}
/**
 * Save a Studio project revision
 */
export function saveStudioProjectRevision({ id, studioProjectSaveDto }: {
    id: string;
    studioProjectSaveDto: StudioProjectSaveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioProjectSaveResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/revisions`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioProjectSaveDto
    })));
}
/**
 * List Studio project history
 */
export function getStudioProjectHistory({ id, skip, take }: {
    id: string;
    skip?: number;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectHistoryResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/revisions${QS.query(QS.explode({
        skip,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Get a Studio project revision
 */
export function getStudioProjectRevision({ id, revision }: {
    id: string;
    revision: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectRevisionDetailDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}`, {
        ...opts
    }));
}
/**
 * Compare two Studio project revisions
 */
export function diffStudioProjectRevision({ against, id, revision }: {
    against: number;
    id: string;
    revision: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectDiffDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revision)}/diff${QS.query(QS.explode({
        against
    }))}`, {
        ...opts
    }));
}
/**
 * Restore a Studio project from the trash
 */
export function restoreStudioProjectFromTrash({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioProjectDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/trash/restore`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Delete acknowledgements
 */
export function deleteSyncAck({ syncAckDeleteDto }: {
    syncAckDeleteDto: SyncAckDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/sync/ack", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: syncAckDeleteDto
    })));
}
/**
 * Retrieve acknowledgements
 */
export function getSyncAck(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SyncAckDto[];
    }>("/sync/ack", {
        ...opts
    }));
}
/**
 * Acknowledge changes
 */
export function sendSyncAck({ syncAckSetDto }: {
    syncAckSetDto: SyncAckSetDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/sync/ack", oazapfts.json({
        ...opts,
        method: "POST",
        body: syncAckSetDto
    })));
}
/**
 * Stream sync changes
 */
export function getSyncStream({ syncStreamDto }: {
    syncStreamDto: SyncStreamDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/sync/stream", oazapfts.json({
        ...opts,
        method: "POST",
        body: syncStreamDto
    })));
}
/**
 * Get system configuration
 */
export function getConfig(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/system-config", {
        ...opts
    }));
}
/**
 * Update system configuration
 */
export function updateConfig({ adminConfigDto }: {
    adminConfigDto: AdminConfigDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/system-config", oazapfts.json({
        ...opts,
        method: "PUT",
        body: adminConfigDto
    })));
}
/**
 * Get system configuration defaults
 */
export function getConfigDefaults(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigDto;
    }>("/system-config/defaults", {
        ...opts
    }));
}
/**
 * Defer image description re-queue
 */
export function deferImageDescriptionRequeue(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/system-config/image-description/defer-requeue", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Trigger image description re-queue
 */
export function triggerImageDescriptionRequeue(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ImageDescriptionRequeueResponseDto;
    } | {
        status: 400;
    }>("/system-config/image-description/requeue", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Estimate image description re-queue cost
 */
export function getImageDescriptionRequeueEstimate(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ImageDescriptionRequeueEstimateDto;
    }>("/system-config/image-description/requeue-estimate", {
        ...opts
    }));
}
/**
 * Get machine learning hardware
 */
export function getMachineLearningHardware({ destinationId }: {
    destinationId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MachineLearningHardwareResponseDto;
    }>(`/system-config/machine-learning/hardware${QS.query(QS.explode({
        destinationId
    }))}`, {
        ...opts
    }));
}
/**
 * Trigger smart-album re-evaluate
 */
export function triggerSmartAlbumReevaluate({ smartAlbumReevaluateRequestDto }: {
    smartAlbumReevaluateRequestDto?: SmartAlbumReevaluateRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: SmartAlbumReevaluateResponseDto;
    } | {
        status: 400;
    }>("/system-config/smart-albums/reevaluate", oazapfts.json({
        ...opts,
        method: "POST",
        body: smartAlbumReevaluateRequestDto
    })));
}
/**
 * Estimate smart-album re-evaluate cost
 */
export function getSmartAlbumReevaluateEstimate(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SmartAlbumReevaluateEstimateDto;
    }>("/system-config/smart-albums/reevaluate-estimate", {
        ...opts
    }));
}
/**
 * Get storage template options
 */
export function getStorageTemplateOptions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SystemConfigTemplateStorageOptionDto;
    }>("/system-config/storage-template-options", {
        ...opts
    }));
}
/**
 * Retrieve admin onboarding
 */
export function getAdminOnboarding(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminOnboardingUpdateDto;
    }>("/system-metadata/admin-onboarding", {
        ...opts
    }));
}
/**
 * Update admin onboarding
 */
export function updateAdminOnboarding({ adminOnboardingUpdateDto }: {
    adminOnboardingUpdateDto: AdminOnboardingUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/system-metadata/admin-onboarding", oazapfts.json({
        ...opts,
        method: "POST",
        body: adminOnboardingUpdateDto
    })));
}
/**
 * Retrieve reverse geocoding state
 */
export function getReverseGeocodingState(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ReverseGeocodingStateResponseDto;
    }>("/system-metadata/reverse-geocoding-state", {
        ...opts
    }));
}
/**
 * Retrieve version check state
 */
export function getVersionCheckState(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VersionCheckStateResponseDto;
    }>("/system-metadata/version-check-state", {
        ...opts
    }));
}
/**
 * Retrieve tags
 */
export function getAllTags(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagResponseDto[];
    }>("/tags", {
        ...opts
    }));
}
/**
 * Create a tag
 */
export function createTag({ tagCreateDto }: {
    tagCreateDto: TagCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: TagResponseDto;
    }>("/tags", oazapfts.json({
        ...opts,
        method: "POST",
        body: tagCreateDto
    })));
}
/**
 * Upsert tags
 */
export function upsertTags({ tagUpsertDto }: {
    tagUpsertDto: TagUpsertDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagResponseDto[];
    }>("/tags", oazapfts.json({
        ...opts,
        method: "PUT",
        body: tagUpsertDto
    })));
}
/**
 * Tag assets
 */
export function bulkTagAssets({ tagBulkAssetsDto }: {
    tagBulkAssetsDto: TagBulkAssetsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagBulkAssetsResponseDto;
    }>("/tags/assets", oazapfts.json({
        ...opts,
        method: "PUT",
        body: tagBulkAssetsDto
    })));
}
/**
 * Delete a tag
 */
export function deleteTag({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/tags/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a tag
 */
export function getTagById({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagResponseDto;
    }>(`/tags/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a tag
 */
export function updateTag({ id, tagUpdateDto }: {
    id: string;
    tagUpdateDto: TagUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagResponseDto;
    }>(`/tags/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: tagUpdateDto
    })));
}
/**
 * Untag assets
 */
export function untagAssets({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/tags/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "DELETE",
        body: bulkIdsDto
    })));
}
/**
 * Tag assets
 */
export function tagAssets({ id, bulkIdsDto }: {
    id: string;
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BulkIdResponseDto[];
    }>(`/tags/${encodeURIComponent(id)}/assets`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: bulkIdsDto
    })));
}
/**
 * Get time bucket
 */
export function getTimeBucket({ albumId, bbox, dateType, isFavorite, isTrashed, key, lockReason, order, orderBy, personId, petId, slug, suppressedOnly, tagId, timeBucket, userId, visibility, withCoordinates, withPartners, withStacked }: {
    albumId?: string;
    bbox?: string;
    dateType?: TimeBucketDateType;
    isFavorite?: boolean;
    isTrashed?: boolean;
    key?: string;
    lockReason?: AssetLockReason;
    order?: AssetOrder;
    orderBy?: AssetOrderBy;
    personId?: string;
    petId?: string;
    slug?: string;
    suppressedOnly?: boolean;
    tagId?: string;
    timeBucket: string;
    userId?: string;
    visibility?: AssetVisibility;
    withCoordinates?: boolean;
    withPartners?: boolean;
    withStacked?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TimeBucketAssetResponseDto;
    }>(`/timeline/bucket${QS.query(QS.explode({
        albumId,
        bbox,
        dateType,
        isFavorite,
        isTrashed,
        key,
        lockReason,
        order,
        orderBy,
        personId,
        petId,
        slug,
        suppressedOnly,
        tagId,
        timeBucket,
        userId,
        visibility,
        withCoordinates,
        withPartners,
        withStacked
    }))}`, {
        ...opts
    }));
}
/**
 * Get time buckets
 */
export function getTimeBuckets({ albumId, bbox, dateType, isFavorite, isTrashed, key, lockReason, order, orderBy, personId, petId, slug, suppressedOnly, tagId, userId, visibility, withCoordinates, withPartners, withStacked }: {
    albumId?: string;
    bbox?: string;
    dateType?: TimeBucketDateType;
    isFavorite?: boolean;
    isTrashed?: boolean;
    key?: string;
    lockReason?: AssetLockReason;
    order?: AssetOrder;
    orderBy?: AssetOrderBy;
    personId?: string;
    petId?: string;
    slug?: string;
    suppressedOnly?: boolean;
    tagId?: string;
    userId?: string;
    visibility?: AssetVisibility;
    withCoordinates?: boolean;
    withPartners?: boolean;
    withStacked?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TimeBucketsResponseDto[];
    }>(`/timeline/buckets${QS.query(QS.explode({
        albumId,
        bbox,
        dateType,
        isFavorite,
        isTrashed,
        key,
        lockReason,
        order,
        orderBy,
        personId,
        petId,
        slug,
        suppressedOnly,
        tagId,
        userId,
        visibility,
        withCoordinates,
        withPartners,
        withStacked
    }))}`, {
        ...opts
    }));
}
/**
 * Apply a reviewed trash change
 */
export function applyTrashReview({ trashApplyDto }: {
    trashApplyDto: TrashApplyDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashResponseDto;
    }>("/trash/apply", oazapfts.json({
        ...opts,
        method: "POST",
        body: trashApplyDto
    })));
}
/**
 * Empty trash
 */
export function emptyTrash(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashResponseDto;
    }>("/trash/empty", {
        ...opts,
        method: "POST"
    }));
}
/**
 * List trash items
 */
export function getTrashItems({ page, query, size, sort, $type }: {
    page?: number;
    query?: string;
    size?: number;
    sort?: TrashItemSort;
    $type?: AssetTypeEnum;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashItemsResponseDto;
    }>(`/trash/items${QS.query(QS.explode({
        page,
        query,
        size,
        sort,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Restore trash
 */
export function restoreTrash(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashResponseDto;
    }>("/trash/restore", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Restore assets
 */
export function restoreAssets({ bulkIdsDto }: {
    bulkIdsDto: BulkIdsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashResponseDto;
    }>("/trash/restore/assets", oazapfts.json({
        ...opts,
        method: "POST",
        body: bulkIdsDto
    })));
}
/**
 * Review a trash change
 */
export function reviewTrash({ trashReviewDto }: {
    trashReviewDto: TrashReviewDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashReviewResponseDto;
    }>("/trash/review", oazapfts.json({
        ...opts,
        method: "POST",
        body: trashReviewDto
    })));
}
/**
 * Get trash summary
 */
export function getTrashSummary(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TrashSummaryResponseDto;
    }>("/trash/summary", {
        ...opts
    }));
}
/**
 * Get all users
 */
export function searchUsers(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserResponseDto[];
    }>("/users", {
        ...opts
    }));
}
/**
 * Get current user
 */
export function getMyUser(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/users/me", {
        ...opts
    }));
}
/**
 * Update current user
 */
export function updateMyUser({ userUpdateMeDto }: {
    userUpdateMeDto: UserUpdateMeDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/users/me", oazapfts.json({
        ...opts,
        method: "PUT",
        body: userUpdateMeDto
    })));
}
/**
 * Retrieve calendar heatmap activity
 */
export function getMyCalendarHeatmap({ $from, to, $type }: {
    $from?: string;
    to?: string;
    $type?: CalendarHeatmapType;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CalendarHeatmapResponseDto;
    }>(`/users/me/calendar-heatmap${QS.query(QS.explode({
        "from": $from,
        to,
        "type": $type
    }))}`, {
        ...opts
    }));
}
/**
 * Delete user product key
 */
export function deleteUserLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/users/me/license", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve user product key
 */
export function getUserLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserLicense;
    }>("/users/me/license", {
        ...opts
    }));
}
/**
 * Set user product key
 */
export function setUserLicense({ licenseKeyDto }: {
    licenseKeyDto: LicenseKeyDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserLicense;
    }>("/users/me/license", oazapfts.json({
        ...opts,
        method: "PUT",
        body: licenseKeyDto
    })));
}
/**
 * Delete user onboarding
 */
export function deleteUserOnboarding(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/users/me/onboarding", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve user onboarding
 */
export function getUserOnboarding(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: OnboardingResponseDto;
    }>("/users/me/onboarding", {
        ...opts
    }));
}
/**
 * Update user onboarding
 */
export function setUserOnboarding({ onboardingDto }: {
    onboardingDto: OnboardingDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: OnboardingResponseDto;
    }>("/users/me/onboarding", oazapfts.json({
        ...opts,
        method: "PUT",
        body: onboardingDto
    })));
}
/**
 * Get my preferences
 */
export function getMyPreferences(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserPreferencesResponseDto;
    }>("/users/me/preferences", {
        ...opts
    }));
}
/**
 * Update my preferences
 */
export function updateMyPreferences({ userPreferencesUpdateDto }: {
    userPreferencesUpdateDto: UserPreferencesUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserPreferencesResponseDto;
    }>("/users/me/preferences", oazapfts.json({
        ...opts,
        method: "PUT",
        body: userPreferencesUpdateDto
    })));
}
/**
 * Delete user profile image
 */
export function deleteProfileImage(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/users/profile-image", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Create user profile image
 */
export function createProfileImage({ createProfileImageDto }: {
    createProfileImageDto: CreateProfileImageDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: CreateProfileImageResponseDto;
    }>("/users/profile-image", oazapfts.multipart({
        ...opts,
        method: "POST",
        body: createProfileImageDto
    })));
}
/**
 * Retrieve a user
 */
export function getUser({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserResponseDto;
    }>(`/users/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Retrieve user profile image
 */
export function getProfileImage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/users/${encodeURIComponent(id)}/profile-image`, {
        ...opts
    }));
}
/**
 * Retrieve assets by original path
 */
export function getAssetsByOriginalPath({ path }: {
    path: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetResponseDto[];
    }>(`/view/folder${QS.query(QS.explode({
        path
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve unique paths
 */
export function getUniqueOriginalPaths(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: string[];
    }>("/view/folder/unique-paths", {
        ...opts
    }));
}
/**
 * List all workflows
 */
export function searchWorkflows({ description, enabled, id, logging, name, trigger }: {
    description?: string;
    enabled?: boolean;
    id?: string;
    logging?: boolean;
    name?: string;
    trigger?: WorkflowTrigger;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowResponseDto[];
    }>(`/workflows${QS.query(QS.explode({
        description,
        enabled,
        id,
        logging,
        name,
        trigger
    }))}`, {
        ...opts
    }));
}
/**
 * Create a workflow
 */
export function createWorkflow({ workflowCreateDto }: {
    workflowCreateDto: WorkflowCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: WorkflowResponseDto;
    }>("/workflows", oazapfts.json({
        ...opts,
        method: "POST",
        body: workflowCreateDto
    })));
}
/**
 * List all workflow triggers
 */
export function getWorkflowTriggers(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowTriggerResponseDto[];
    }>("/workflows/triggers", {
        ...opts
    }));
}
/**
 * Delete a workflow
 */
export function deleteWorkflow({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/workflows/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a workflow
 */
export function getWorkflow({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowResponseDto;
    }>(`/workflows/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a workflow
 */
export function updateWorkflow({ id, workflowUpdateDto }: {
    id: string;
    workflowUpdateDto: WorkflowUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowResponseDto;
    }>(`/workflows/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: workflowUpdateDto
    })));
}
/**
 * Retrieve workflow logs
 */
export function getWorkflowLogs({ before, id, limit, result }: {
    before?: string;
    id: string;
    limit?: number;
    result?: WorkflowResult;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowLogEntryDto[];
    }>(`/workflows/${encodeURIComponent(id)}/logs${QS.query(QS.explode({
        before,
        limit,
        result
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve a workflow
 */
export function getWorkflowForShare({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkflowShareResponseDto;
    }>(`/workflows/${encodeURIComponent(id)}/share`, {
        ...opts
    }));
}
export enum ReactionLevel {
    Album = "album",
    Asset = "asset"
}
export enum ReactionType {
    Comment = "comment",
    Like = "like"
}
export enum SharedSpaceEventType {
    AssetsAdded = "AssetsAdded",
    AssetsRemoved = "AssetsRemoved",
    AlbumLinked = "AlbumLinked",
    AlbumUnlinked = "AlbumUnlinked",
    PersonLinked = "PersonLinked",
    PersonUnlinked = "PersonUnlinked",
    MemberJoined = "MemberJoined",
    MemberLeft = "MemberLeft",
    MemberRemoved = "MemberRemoved",
    MemberRoleChanged = "MemberRoleChanged",
    Comment = "Comment",
    Reply = "Reply",
    Like = "Like"
}
export enum UserAvatarColor {
    Primary = "primary",
    Pink = "pink",
    Red = "red",
    Yellow = "yellow",
    Blue = "blue",
    Green = "green",
    Purple = "purple",
    Orange = "orange",
    Gray = "gray",
    Amber = "amber"
}
export enum TranscodeHWAccel {
    Nvenc = "nvenc",
    Qsv = "qsv",
    Vaapi = "vaapi",
    Rkmpp = "rkmpp",
    Disabled = "disabled"
}
export enum AudioCodec {
    Mp3 = "mp3",
    Aac = "aac",
    Libopus = "libopus",
    Opus = "opus",
    PcmS16Le = "pcm_s16le"
}
export enum VideoContainer {
    Mov = "mov",
    Mp4 = "mp4",
    Ogg = "ogg",
    Webm = "webm"
}
export enum VideoCodec {
    H264 = "h264",
    Hevc = "hevc",
    Vp9 = "vp9",
    Av1 = "av1"
}
export enum CQMode {
    Auto = "auto",
    Cqp = "cqp",
    Icq = "icq"
}
export enum HlsVideoResolution {
    $480 = 480,
    $720 = 720,
    $1080 = 1080,
    $1440 = 1440,
    $2160 = 2160
}
export enum ToneMapping {
    Hable = "hable",
    Mobius = "mobius",
    Reinhard = "reinhard",
    Disabled = "disabled"
}
export enum TranscodePolicy {
    All = "all",
    Optimal = "optimal",
    Bitrate = "bitrate",
    Required = "required",
    Disabled = "disabled"
}
export enum Colorspace {
    Srgb = "srgb",
    P3 = "p3"
}
export enum ImageFormat {
    Jpeg = "jpeg",
    Webp = "webp"
}
export enum LogLevel {
    Verbose = "verbose",
    Debug = "debug",
    Log = "log",
    Warn = "warn",
    Error = "error",
    Fatal = "fatal"
}
export enum MachineLearningHardwareAcceleration {
    Auto = "auto",
    Openvino = "openvino",
    Cuda = "cuda"
}
export enum PlaceholderValidation {
    Strict = "strict",
    Warn = "warn"
}
export enum Style {
    Terse = "terse",
    Balanced = "balanced",
    Rich = "rich"
}
export enum Mode {
    Disabled = "disabled",
    Pod = "pod",
    Serverless = "serverless"
}
export enum ScalerType {
    QueueDelay = "QUEUE_DELAY",
    RequestCount = "REQUEST_COUNT"
}
export enum ReleaseChannel {
    Stable = "stable",
    ReleaseCandidate = "releaseCandidate"
}
export enum OAuthTokenEndpointAuthMethod {
    ClientSecretPost = "client_secret_post",
    ClientSecretBasic = "client_secret_basic"
}
export enum IntegrityReport {
    UntrackedFile = "untracked_file",
    MissingFile = "missing_file",
    ChecksumMismatch = "checksum_mismatch"
}
export enum MaintenanceAction {
    Start = "start",
    End = "end",
    SelectDatabaseRestore = "select_database_restore",
    RestoreDatabase = "restore_database"
}
export enum StorageFolder {
    EncodedVideo = "encoded-video",
    Library = "library",
    Upload = "upload",
    Profile = "profile",
    Thumbs = "thumbs",
    Backups = "backups",
    Exports = "exports"
}
export enum NotificationLevel {
    Success = "success",
    Error = "error",
    Warning = "warning",
    Info = "info"
}
export enum NotificationType {
    JobFailed = "JobFailed",
    BackupFailed = "BackupFailed",
    SystemMessage = "SystemMessage",
    AlbumInvite = "AlbumInvite",
    AlbumUpdate = "AlbumUpdate",
    ClusterGroupRequest = "ClusterGroupRequest",
    SharedSpaceMention = "SharedSpaceMention",
    SharedSpaceReply = "SharedSpaceReply",
    Custom = "Custom"
}
export enum UserStatus {
    Active = "active",
    Removing = "removing",
    Deleted = "deleted"
}
export enum CalendarHeatmapType {
    Upload = "Upload",
    Taken = "Taken"
}
export enum AssetOrder {
    Asc = "asc",
    Desc = "desc"
}
export enum SuppressionScope {
    Owned = "owned",
    Visible = "visible"
}
export enum AssetVisibility {
    Archive = "archive",
    Timeline = "timeline",
    Hidden = "hidden",
    Locked = "locked"
}
export enum AssetLockReason {
    Marked = "marked",
    Detected = "detected",
    ImmichLockedFolder = "immich-locked-folder"
}
export enum AlbumUserRole {
    Editor = "editor",
    Owner = "owner",
    Viewer = "viewer"
}
export enum AlbumKind {
    Album = "album",
    Collection = "collection",
    Space = "space"
}
export enum BulkIdErrorReason {
    Duplicate = "duplicate",
    NoPermission = "no_permission",
    NotFound = "not_found",
    Unknown = "unknown",
    Validation = "validation"
}
export enum Permission {
    All = "all",
    ActivityCreate = "activity.create",
    ActivityRead = "activity.read",
    ActivityUpdate = "activity.update",
    ActivityDelete = "activity.delete",
    ActivityStatistics = "activity.statistics",
    ApiKeyCreate = "apiKey.create",
    ApiKeyRead = "apiKey.read",
    ApiKeyUpdate = "apiKey.update",
    ApiKeyDelete = "apiKey.delete",
    ApiKeyRotate = "apiKey.rotate",
    AssetRead = "asset.read",
    AssetUpdate = "asset.update",
    AssetDelete = "asset.delete",
    AssetStatistics = "asset.statistics",
    AssetShare = "asset.share",
    AssetView = "asset.view",
    AssetDownload = "asset.download",
    AssetUpload = "asset.upload",
    AssetCopy = "asset.copy",
    AssetDerive = "asset.derive",
    AssetFileRead = "assetFile.read",
    AssetFileDelete = "assetFile.delete",
    AssetFileDownload = "assetFile.download",
    AssetEditGet = "asset.edit.get",
    AssetEditCreate = "asset.edit.create",
    AssetEditDelete = "asset.edit.delete",
    AlbumCreate = "album.create",
    AlbumRead = "album.read",
    AlbumUpdate = "album.update",
    AlbumDelete = "album.delete",
    AlbumStatistics = "album.statistics",
    AlbumShare = "album.share",
    AlbumDownload = "album.download",
    AlbumAssetCreate = "albumAsset.create",
    AlbumAssetDelete = "albumAsset.delete",
    AlbumUserCreate = "albumUser.create",
    AlbumUserUpdate = "albumUser.update",
    AlbumUserDelete = "albumUser.delete",
    AuthChangePassword = "auth.changePassword",
    AuthDeviceDelete = "authDevice.delete",
    ArchiveRead = "archive.read",
    BackupList = "backup.list",
    BackupDownload = "backup.download",
    BackupUpload = "backup.upload",
    BackupDelete = "backup.delete",
    ClusterGroupRead = "clusterGroup.read",
    ClusterGroupLeave = "clusterGroup.leave",
    ClusterGroupRequestCreate = "clusterGroupRequest.create",
    ClusterGroupRequestRead = "clusterGroupRequest.read",
    ClusterGroupRequestDelete = "clusterGroupRequest.delete",
    AdminConfigRead = "adminConfig.read",
    AdminConfigUpdate = "adminConfig.update",
    UserConfigRead = "userConfig.read",
    DuplicateRead = "duplicate.read",
    DuplicateDelete = "duplicate.delete",
    FaceCreate = "face.create",
    FaceRead = "face.read",
    FaceUpdate = "face.update",
    FaceDelete = "face.delete",
    FolderRead = "folder.read",
    JobCreate = "job.create",
    JobRead = "job.read",
    LibraryCreate = "library.create",
    LibraryRead = "library.read",
    LibraryUpdate = "library.update",
    LibraryDelete = "library.delete",
    LibraryStatistics = "library.statistics",
    TimelineRead = "timeline.read",
    TimelineDownload = "timeline.download",
    Maintenance = "maintenance",
    MapRead = "map.read",
    MapSearch = "map.search",
    MemoryCreate = "memory.create",
    MemoryRead = "memory.read",
    MemoryUpdate = "memory.update",
    MemoryDelete = "memory.delete",
    MemoryStatistics = "memory.statistics",
    MemoryAssetCreate = "memoryAsset.create",
    MemoryAssetDelete = "memoryAsset.delete",
    NotificationCreate = "notification.create",
    NotificationRead = "notification.read",
    NotificationUpdate = "notification.update",
    NotificationDelete = "notification.delete",
    PartnerCreate = "partner.create",
    PartnerRead = "partner.read",
    PartnerUpdate = "partner.update",
    PartnerDelete = "partner.delete",
    PersonCreate = "person.create",
    PersonRead = "person.read",
    PersonUpdate = "person.update",
    PersonDelete = "person.delete",
    PersonStatistics = "person.statistics",
    PersonMerge = "person.merge",
    PersonReassign = "person.reassign",
    PinCodeCreate = "pinCode.create",
    PinCodeUpdate = "pinCode.update",
    PinCodeDelete = "pinCode.delete",
    PluginCreate = "plugin.create",
    PluginRead = "plugin.read",
    PluginUpdate = "plugin.update",
    PluginDelete = "plugin.delete",
    ServerAbout = "server.about",
    ServerApkLinks = "server.apkLinks",
    ServerStorage = "server.storage",
    ServerStatistics = "server.statistics",
    ServerVersionCheck = "server.versionCheck",
    ServerLicenseRead = "serverLicense.read",
    ServerLicenseUpdate = "serverLicense.update",
    ServerLicenseDelete = "serverLicense.delete",
    SessionCreate = "session.create",
    SessionRead = "session.read",
    SessionUpdate = "session.update",
    SessionDelete = "session.delete",
    SessionLock = "session.lock",
    SharedLinkCreate = "sharedLink.create",
    SharedLinkRead = "sharedLink.read",
    SharedLinkUpdate = "sharedLink.update",
    SharedLinkDelete = "sharedLink.delete",
    StackCreate = "stack.create",
    StackRead = "stack.read",
    StackUpdate = "stack.update",
    StackDelete = "stack.delete",
    SyncStream = "sync.stream",
    SyncCheckpointRead = "syncCheckpoint.read",
    SyncCheckpointUpdate = "syncCheckpoint.update",
    SyncCheckpointDelete = "syncCheckpoint.delete",
    SystemConfigRead = "systemConfig.read",
    SystemConfigUpdate = "systemConfig.update",
    SystemMetadataRead = "systemMetadata.read",
    SystemMetadataUpdate = "systemMetadata.update",
    TagCreate = "tag.create",
    TagRead = "tag.read",
    TagUpdate = "tag.update",
    TagDelete = "tag.delete",
    TagAsset = "tag.asset",
    UserRead = "user.read",
    UserUpdate = "user.update",
    UserLicenseCreate = "userLicense.create",
    UserLicenseRead = "userLicense.read",
    UserLicenseUpdate = "userLicense.update",
    UserLicenseDelete = "userLicense.delete",
    UserOnboardingRead = "userOnboarding.read",
    UserOnboardingUpdate = "userOnboarding.update",
    UserOnboardingDelete = "userOnboarding.delete",
    UserPreferenceRead = "userPreference.read",
    UserPreferenceUpdate = "userPreference.update",
    UserProfileImageCreate = "userProfileImage.create",
    UserProfileImageRead = "userProfileImage.read",
    UserProfileImageUpdate = "userProfileImage.update",
    UserProfileImageDelete = "userProfileImage.delete",
    QueueRead = "queue.read",
    QueueUpdate = "queue.update",
    QueueJobCreate = "queueJob.create",
    QueueJobRead = "queueJob.read",
    QueueJobUpdate = "queueJob.update",
    QueueJobDelete = "queueJob.delete",
    WorkflowCreate = "workflow.create",
    WorkflowRead = "workflow.read",
    WorkflowUpdate = "workflow.update",
    WorkflowDelete = "workflow.delete",
    WorkflowLogs = "workflow.logs",
    AdminUserCreate = "adminUser.create",
    AdminUserRead = "adminUser.read",
    AdminUserUpdate = "adminUser.update",
    AdminUserDelete = "adminUser.delete",
    AdminSessionRead = "adminSession.read",
    AdminSessionDelete = "adminSession.delete",
    AdminAuthUnlinkAll = "adminAuth.unlinkAll"
}
export enum AssetFileType {
    Fullsize = "fullsize",
    Preview = "preview",
    Thumbnail = "thumbnail",
    Sidecar = "sidecar",
    EncodedVideo = "encoded_video"
}
export enum AssetMediaStatus {
    Created = "created",
    Duplicate = "duplicate"
}
export enum AssetUploadAction {
    Accept = "accept",
    Reject = "reject"
}
export enum AssetRejectReason {
    Duplicate = "duplicate",
    UnsupportedFormat = "unsupported-format"
}
export enum AssetJobName {
    RefreshFaces = "refresh-faces",
    RefreshMetadata = "refresh-metadata",
    RegenerateThumbnail = "regenerate-thumbnail",
    TranscodeVideo = "transcode-video"
}
export enum AssetTypeEnum {
    Image = "IMAGE",
    Video = "VIDEO",
    Audio = "AUDIO",
    Other = "OTHER"
}
export enum AssetDevelopRevisionStatus {
    Saved = "saved",
    Queued = "queued",
    Rendering = "rendering",
    Rendered = "rendered",
    Failed = "failed",
    Cancelled = "cancelled"
}
export enum AssetDevelopPreset {
    Original = "Original",
    Vivid = "Vivid",
    Natural = "Natural",
    Warm = "Warm",
    Cool = "Cool",
    Mono = "Mono",
    Silvertone = "Silvertone",
    Noir = "Noir",
    Fade = "Fade"
}
export enum AssetDevelopFileKind {
    Master = "master",
    Preview = "preview"
}
export enum AssetRestorationMode {
    Faithful = "faithful",
    Creative = "creative"
}
export enum AssetRestorationSourceType {
    Image = "image",
    Video = "video"
}
export enum AssetRestorationStatus {
    PreviewQueued = "preview_queued",
    PreviewRendering = "preview_rendering",
    PreviewReady = "preview_ready",
    PreviewFailed = "preview_failed",
    PreviewCancelled = "preview_cancelled",
    Accepted = "accepted",
    Restoring = "restoring",
    Restored = "restored",
    RestoreFailed = "restore_failed",
    RestoreCancelled = "restore_cancelled",
    Rejected = "rejected",
    Discarded = "discarded",
    Expired = "expired"
}
export enum AssetRestorationFileKind {
    Before = "before",
    After = "after",
    Result = "result",
    ResultPreview = "result_preview"
}
export enum AssetEditAction {
    Crop = "crop",
    Rotate = "rotate",
    Mirror = "mirror",
    Trim = "trim",
    Straighten = "straighten",
    Adjust = "adjust",
    Filter = "filter",
    Effect = "effect",
    AutoEnhance = "autoEnhance",
    Stabilize = "stabilize",
    TextOverlay = "textOverlay",
    Audio = "audio",
    Speed = "speed"
}
export enum MirrorAxis {
    Horizontal = "horizontal",
    Vertical = "vertical"
}
export enum Status {
    Missing = "missing",
    Success = "success",
    Failed = "failed",
    Skipped = "skipped"
}
export enum Action {
    Accepted = "accepted",
    MarkedSafe = "marked-safe",
    MarkedNsfw = "marked-nsfw"
}
export enum Status2 {
    Missing = "missing",
    Success = "success",
    Failed = "failed"
}
export enum AssetImageEnrichmentAction {
    RerunImageDescription = "rerun-image-description",
    RerunNsfwDetection = "rerun-nsfw-detection",
    AcceptNsfwResult = "accept-nsfw-result",
    MarkNsfw = "mark-nsfw",
    MarkSafe = "mark-safe",
    ClearGeneratedDescription = "clear-generated-description",
    ClearGeneratedTags = "clear-generated-tags"
}
export enum AssetMediaSize {
    Original = "original",
    Fullsize = "fullsize",
    Preview = "preview",
    Thumbnail = "thumbnail"
}
export enum SourceType {
    MachineLearning = "machine-learning",
    Exif = "exif",
    Manual = "manual"
}
export enum ICloudAuthAction {
    Login = "login",
    TwoFactor = "two-factor",
    DeviceApproval = "device-approval",
    Validate = "validate"
}
export enum ICloudControlAction {
    Run = "run",
    Pause = "pause",
    Resume = "resume",
    Cancel = "cancel",
    Rescan = "rescan",
    Retry = "retry"
}
export enum ManualJobName {
    PersonCleanup = "person-cleanup",
    TagCleanup = "tag-cleanup",
    UserCleanup = "user-cleanup",
    MemoryCleanup = "memory-cleanup",
    MemoryCreate = "memory-create",
    BackupDatabase = "backup-database",
    BestPhotosBackfill = "best-photos-backfill",
    PhysicalDeduplicationDryRun = "physical-deduplication-dry-run",
    PhysicalDeduplicationApply = "physical-deduplication-apply",
    IntegrityMissingFiles = "integrity-missing-files",
    IntegrityUntrackedFiles = "integrity-untracked-files",
    IntegrityChecksumMismatch = "integrity-checksum-mismatch",
    IntegrityMissingFilesRefresh = "integrity-missing-files-refresh",
    IntegrityUntrackedFilesRefresh = "integrity-untracked-files-refresh",
    IntegrityChecksumMismatchRefresh = "integrity-checksum-mismatch-refresh",
    IntegrityMissingFilesDeleteAll = "integrity-missing-files-delete-all",
    IntegrityUntrackedFilesDeleteAll = "integrity-untracked-files-delete-all",
    IntegrityChecksumMismatchDeleteAll = "integrity-checksum-mismatch-delete-all"
}
export enum PhysicalDeduplicationDecision {
    Share = "share",
    Skip = "skip"
}
export enum PhysicalDeduplicationSkipReason {
    ExternalLibrary = "external-library",
    MissingSize = "missing-size",
    NoRetainedMatch = "no-retained-match",
    AlreadyShared = "already-shared",
    RetainedFileMissing = "retained-file-missing"
}
export enum PhysicalDeduplicationPlanMode {
    DryRun = "dry-run",
    Apply = "apply"
}
export enum QueueName {
    ThumbnailGeneration = "thumbnailGeneration",
    MetadataExtraction = "metadataExtraction",
    VideoConversion = "videoConversion",
    FaceDetection = "faceDetection",
    FacialRecognition = "facialRecognition",
    SmartSearch = "smartSearch",
    DuplicateDetection = "duplicateDetection",
    VideoDuplicateDetection = "videoDuplicateDetection",
    BackgroundTask = "backgroundTask",
    StorageTemplateMigration = "storageTemplateMigration",
    Migration = "migration",
    Search = "search",
    Sidecar = "sidecar",
    Library = "library",
    Notifications = "notifications",
    BackupDatabase = "backupDatabase",
    Ocr = "ocr",
    ImageEnrichment = "imageEnrichment",
    ImageDescription = "imageDescription",
    NsfwDetection = "nsfwDetection",
    MediaHealth = "mediaHealth",
    Workflow = "workflow",
    IntegrityCheck = "integrityCheck",
    Editor = "editor"
}
export enum QueueCommand {
    Start = "start",
    Pause = "pause",
    Resume = "resume",
    Empty = "empty",
    ClearFailed = "clear-failed"
}
export enum LivePhotoMatchConfidence {
    High = "high",
    Low = "low"
}
export enum PetSpecies {
    Cat = "cat",
    Dog = "dog",
    Bird = "bird",
    Rabbit = "rabbit",
    Horse = "horse",
    Reptile = "reptile",
    Fish = "fish",
    SmallMammal = "small_mammal",
    Other = "other"
}
export enum PetObservationSource {
    Manual = "manual",
    Review = "review"
}
export enum PetObservationState {
    Confirmed = "confirmed",
    Rejected = "rejected"
}
export enum MediaHealthCategory {
    Missing = "missing",
    Corrupt = "corrupt"
}
export enum MediaHealthStatus {
    Found = "found",
    Missing = "missing",
    Candidate = "candidate",
    Relinked = "relinked",
    Dismissed = "dismissed",
    Resolved = "resolved",
    UnsupportedRaw = "unsupported_raw",
    CorruptSuspect = "corrupt_suspect",
    CorruptConfirmed = "corrupt_confirmed",
    TrashQueued = "trash_queued",
    Trashed = "trashed",
    DeleteQueued = "delete_queued",
    Deleted = "deleted"
}
export enum MediaHealthSeverity {
    Info = "info",
    Warning = "warning",
    Critical = "critical"
}
export enum MediaOperationKind {
    StudioExport = "studio_export",
    StudioPreview = "studio_preview",
    Restoration = "restoration",
    RestorationPreview = "restoration_preview",
    QuickEdit = "quick_edit",
    Bulk = "bulk",
    StudioBundleExport = "studio_bundle_export",
    StudioBundleImport = "studio_bundle_import"
}
export enum MediaOperationBulkAction {
    Favorite = "favorite",
    Unfavorite = "unfavorite",
    Archive = "archive",
    Unarchive = "unarchive",
    AddToAlbum = "add-to-album",
    RemoveFromAlbum = "remove-from-album",
    Tag = "tag",
    Untag = "untag",
    ChangeDate = "change-date",
    ChangeDescription = "change-description",
    ChangeLocation = "change-location",
    MarkSensitive = "mark-sensitive",
    UnmarkSensitive = "unmark-sensitive",
    Delete = "delete",
    DeletePermanently = "delete-permanently",
    Restore = "restore",
    Stack = "stack",
    Unstack = "unstack",
    RefreshThumbnails = "refresh-thumbnails",
    RefreshMetadata = "refresh-metadata",
    RefreshEncoded = "refresh-encoded",
    RefreshFaces = "refresh-faces",
    RelinkLivePhoto = "relink-live-photo"
}
export enum MediaOperationStatus {
    Queued = "queued",
    Preparing = "preparing",
    Rendering = "rendering",
    Validating = "validating",
    Completed = "completed",
    Cancelling = "cancelling",
    Cancelled = "cancelled",
    Failed = "failed",
    Paused = "paused"
}
export enum MediaOperationDestination {
    Local = "local",
    Lan = "lan",
    RunPod = "runpod"
}
export enum MediaOperationCheckpointState {
    Pending = "pending",
    Complete = "complete",
    Invalid = "invalid"
}
export enum StudioPreviewQuality {
    Draft = "draft",
    Standard = "standard",
    Full = "full"
}
export enum StudioPreviewStatus {
    Pending = "pending",
    Rendering = "rendering",
    Ready = "ready",
    Superseded = "superseded",
    Failed = "failed",
    Evicted = "evicted"
}
export enum MlDestinationKind {
    Local = "local",
    Lan = "lan",
    RunPod = "runpod"
}
export enum MlWorkload {
    Face = "face",
    Clip = "clip",
    Ocr = "ocr",
    Enrichment = "enrichment",
    RestorationFaithful = "restoration-faithful",
    RestorationCreative = "restoration-creative",
    StudioAi = "studio-ai"
}
export enum MlDestinationHealth {
    Healthy = "healthy",
    Unhealthy = "unhealthy",
    Unknown = "unknown"
}
export enum MlAdmissionRefusal {
    DestinationMissing = "destination-missing",
    DestinationDisabled = "destination-disabled",
    WorkloadNotRouted = "workload-not-routed",
    WorkloadNotAllowed = "workload-not-allowed",
    WorkloadNotServed = "workload-not-served",
    ConsentMissing = "consent-missing",
    BudgetExceeded = "budget-exceeded",
    EndpointUnresolved = "endpoint-unresolved",
    DestinationUnhealthy = "destination-unhealthy"
}
export enum RestorationDynamicRange {
    Sdr = "sdr",
    Hdr = "hdr"
}
export enum RestorationModelState {
    Available = "available",
    Verifying = "verifying",
    NotPinned = "not-pinned",
    RuntimeMissing = "runtime-missing",
    RuntimeDirty = "runtime-dirty",
    WeightsMissing = "weights-missing",
    WeightsMismatch = "weights-mismatch",
    Unqualified = "unqualified",
    LicenseUnreviewed = "license-unreviewed",
    NoGpu = "no-gpu",
    GpuUnqualified = "gpu-unqualified",
    InsufficientVram = "insufficient-vram"
}
export enum MediaOperationItemStatus {
    Ok = "ok",
    Skipped = "skipped",
    Failed = "failed"
}
export enum DateMode {
    Set = "set",
    Shift = "shift"
}
export enum RenderWorkerStatus {
    Active = "active",
    Revoked = "revoked"
}
export enum RenderWorkerAuditEvent {
    Enrolled = "enrolled",
    Admitted = "admitted",
    Refused = "refused",
    ClaimRefused = "claim_refused",
    LimitExceeded = "limit_exceeded",
    Revoked = "revoked",
    Updated = "updated"
}
export enum RenderWorkerRefusalReason {
    InvalidCredential = "invalid_credential",
    WorkerRevoked = "worker_revoked",
    SessionExpired = "session_expired",
    ConformanceStale = "conformance_stale",
    ConformanceReplayed = "conformance_replayed",
    EngineDigestMismatch = "engine_digest_mismatch",
    SoftwareRenderer = "software_renderer",
    DestinationMismatch = "destination_mismatch",
    WorkerMismatch = "worker_mismatch",
    ScopeExceeded = "scope_exceeded",
    WorkerConcurrencyExceeded = "worker_concurrency_exceeded",
    UserConcurrencyExceeded = "user_concurrency_exceeded",
    GpuMemoryInsufficient = "gpu_memory_insufficient",
    WallClockExceeded = "wall_clock_exceeded",
    OutputBytesExceeded = "output_bytes_exceeded",
    DestinationUnavailable = "destination_unavailable",
    ManifestIncomplete = "manifest_incomplete"
}
export enum MemorySearchOrder {
    Asc = "asc",
    Desc = "desc",
    Random = "random"
}
export enum MemoryType {
    OnThisDay = "on_this_day",
    EventStory = "event_story",
    YearInReview = "year_in_review"
}
export enum MemoryExportFormat {
    Archive = "archive"
}
export enum MemoryExportStatus {
    Pending = "pending",
    Running = "running",
    Ready = "ready",
    Failed = "failed",
    Cancelling = "cancelling",
    Cancelled = "cancelled"
}
export enum TrashReviewAction {
    Trash = "trash",
    Restore = "restore",
    RestoreAll = "restore-all",
    Delete = "delete",
    Empty = "empty"
}
export enum TrashItemSort {
    Recent = "recent",
    Size = "size",
    Name = "name"
}
export enum PartnerDirection {
    SharedBy = "shared-by",
    SharedWith = "shared-with"
}
export enum WorkflowType {
    AssetV1 = "AssetV1"
}
export enum WorkflowTrigger {
    AssetCreate = "AssetCreate",
    AssetMetadataExtraction = "AssetMetadataExtraction",
    AssetTagged = "AssetTagged"
}
export enum QueueJobStatus {
    Active = "active",
    Failed = "failed",
    Completed = "completed",
    Delayed = "delayed",
    Waiting = "waiting",
    Paused = "paused"
}
export enum JobName {
    ICloudSync = "ICloudSync",
    ForkSchemaBackfill = "ForkSchemaBackfill",
    AssetDelete = "AssetDelete",
    AssetDeleteCheck = "AssetDeleteCheck",
    AssetDetectFacesQueueAll = "AssetDetectFacesQueueAll",
    AssetDetectFaces = "AssetDetectFaces",
    AssetDetectDuplicatesQueueAll = "AssetDetectDuplicatesQueueAll",
    AssetDetectDuplicates = "AssetDetectDuplicates",
    AssetGenerateVideoDuplicateFramesQueueAll = "AssetGenerateVideoDuplicateFramesQueueAll",
    AssetGenerateVideoDuplicateFrames = "AssetGenerateVideoDuplicateFrames",
    AssetEditThumbnailGeneration = "AssetEditThumbnailGeneration",
    AssetVideoEditGeneration = "AssetVideoEditGeneration",
    AssetEncodeVideoQueueAll = "AssetEncodeVideoQueueAll",
    AssetEncodeVideo = "AssetEncodeVideo",
    AssetEmptyTrash = "AssetEmptyTrash",
    AssetExtractMetadataQueueAll = "AssetExtractMetadataQueueAll",
    AssetExtractMetadata = "AssetExtractMetadata",
    AssetFileMigration = "AssetFileMigration",
    AssetGenerateThumbnailsQueueAll = "AssetGenerateThumbnailsQueueAll",
    AssetGenerateThumbnails = "AssetGenerateThumbnails",
    BestPhotosScoreQueueAll = "BestPhotosScoreQueueAll",
    BestPhotosScore = "BestPhotosScore",
    MediaHealthScanMissing = "MediaHealthScanMissing",
    MediaHealthLocateMissing = "MediaHealthLocateMissing",
    MediaHealthScanCorrupt = "MediaHealthScanCorrupt",
    MediaHealthDeleteCorrupt = "MediaHealthDeleteCorrupt",
    AuditTableCleanup = "AuditTableCleanup",
    DatabaseBackup = "DatabaseBackup",
    FacialRecognitionQueueAll = "FacialRecognitionQueueAll",
    FacialRecognition = "FacialRecognition",
    FileDelete = "FileDelete",
    FileMigrationQueueAll = "FileMigrationQueueAll",
    LibraryDeleteCheck = "LibraryDeleteCheck",
    LibraryDelete = "LibraryDelete",
    LibraryRemoveAsset = "LibraryRemoveAsset",
    LibraryScanAssetsQueueAll = "LibraryScanAssetsQueueAll",
    LibrarySyncAssets = "LibrarySyncAssets",
    LibrarySyncFilesQueueAll = "LibrarySyncFilesQueueAll",
    LibrarySyncFiles = "LibrarySyncFiles",
    LibraryScanQueueAll = "LibraryScanQueueAll",
    HlsSessionCleanup = "HlsSessionCleanup",
    MemoryCleanup = "MemoryCleanup",
    MemoryGenerate = "MemoryGenerate",
    NotificationsCleanup = "NotificationsCleanup",
    NotifyUserSignup = "NotifyUserSignup",
    NotifyAlbumInvite = "NotifyAlbumInvite",
    NotifyAlbumUpdate = "NotifyAlbumUpdate",
    UserDelete = "UserDelete",
    UserDeleteCheck = "UserDeleteCheck",
    UserSyncUsage = "UserSyncUsage",
    PersonCleanup = "PersonCleanup",
    PersonFileMigration = "PersonFileMigration",
    PersonGenerateThumbnail = "PersonGenerateThumbnail",
    SessionCleanup = "SessionCleanup",
    SendMail = "SendMail",
    SidecarQueueAll = "SidecarQueueAll",
    SidecarCheck = "SidecarCheck",
    SidecarWrite = "SidecarWrite",
    SmartSearchQueueAll = "SmartSearchQueueAll",
    SmartSearch = "SmartSearch",
    StorageTemplateMigration = "StorageTemplateMigration",
    StorageTemplateMigrationSingle = "StorageTemplateMigrationSingle",
    PhysicalDeduplicationMigrationDryRun = "PhysicalDeduplicationMigrationDryRun",
    PhysicalDeduplicationMigrationApply = "PhysicalDeduplicationMigrationApply",
    TagCleanup = "TagCleanup",
    VersionCheck = "VersionCheck",
    OcrQueueAll = "OcrQueueAll",
    Ocr = "Ocr",
    ImageDescriptionQueueAll = "ImageDescriptionQueueAll",
    ImageDescription = "ImageDescription",
    NsfwDetectionQueueAll = "NsfwDetectionQueueAll",
    NsfwDetection = "NsfwDetection",
    SmartAlbumReevaluateAll = "SmartAlbumReevaluateAll",
    WorkflowAssetTrigger = "WorkflowAssetTrigger",
    IntegrityUntrackedFilesQueueAll = "IntegrityUntrackedFilesQueueAll",
    IntegrityUntrackedFiles = "IntegrityUntrackedFiles",
    IntegrityUntrackedRefresh = "IntegrityUntrackedRefresh",
    IntegrityMissingFilesQueueAll = "IntegrityMissingFilesQueueAll",
    IntegrityMissingFiles = "IntegrityMissingFiles",
    IntegrityMissingFilesRefresh = "IntegrityMissingFilesRefresh",
    IntegrityChecksumFiles = "IntegrityChecksumFiles",
    IntegrityChecksumFilesRefresh = "IntegrityChecksumFilesRefresh",
    IntegrityDeleteReportType = "IntegrityDeleteReportType",
    IntegrityDeleteReports = "IntegrityDeleteReports"
}
export enum Status3 {
    Idle = "idle",
    Provisioning = "provisioning",
    Starting = "starting",
    Running = "running",
    Stopping = "stopping",
    Stopped = "stopped",
    Error = "error",
    ServerlessProvisioning = "serverless-provisioning",
    ServerlessReady = "serverless-ready"
}
export enum ImageEnrichmentFilter {
    Nsfw = "nsfw",
    NsfwReview = "nsfw-review",
    NsfwReviewed = "nsfw-reviewed",
    NsfwOverridden = "nsfw-overridden",
    ImageDescriptionFailed = "image-description-failed",
    NsfwDetectionFailed = "nsfw-detection-failed",
    MissingImageDescription = "missing-image-description",
    MissingNsfwDetection = "missing-nsfw-detection"
}
export enum SearchOrderField {
    FileCreatedAt = "fileCreatedAt",
    LocalDateTime = "localDateTime",
    FileSizeInBytes = "fileSizeInBytes",
    Rating = "rating"
}
export enum Mode2 {
    Smart = "smart",
    Metadata = "metadata"
}
export enum SearchSuggestionType {
    Country = "country",
    State = "state",
    City = "city",
    CameraMake = "camera-make",
    CameraModel = "camera-model",
    CameraLensModel = "camera-lens-model"
}
export enum SharedLinkType {
    Album = "ALBUM",
    Individual = "INDIVIDUAL"
}
export enum AssetIdErrorReason {
    Duplicate = "duplicate",
    NoPermission = "no_permission",
    NotFound = "not_found"
}
export enum StudioProjectAccess {
    Owner = "owner",
    Reviewer = "reviewer"
}
export enum StudioProjectShelf {
    Active = "active",
    Archived = "archived",
    Trashed = "trashed"
}
export enum StudioProjectSort {
    Updated = "updated",
    Recent = "recent",
    Name = "name"
}
export enum StudioBundleSourceMode {
    Embedded = "embedded",
    Reference = "reference"
}
export enum StudioBundleSourceResolution {
    Kept = "kept",
    Suggested = "suggested",
    Missing = "missing"
}
export enum SyncEntityType {
    AuthUserV1 = "AuthUserV1",
    AuthUserV2 = "AuthUserV2",
    UserV1 = "UserV1",
    UserDeleteV1 = "UserDeleteV1",
    AssetV1 = "AssetV1",
    AssetV2 = "AssetV2",
    AssetDeleteV1 = "AssetDeleteV1",
    AssetExifV1 = "AssetExifV1",
    AssetEditV1 = "AssetEditV1",
    AssetEditDeleteV1 = "AssetEditDeleteV1",
    AssetMetadataV1 = "AssetMetadataV1",
    AssetMetadataDeleteV1 = "AssetMetadataDeleteV1",
    AssetOcrV1 = "AssetOcrV1",
    AssetOcrDeleteV1 = "AssetOcrDeleteV1",
    PartnerV1 = "PartnerV1",
    PartnerDeleteV1 = "PartnerDeleteV1",
    PartnerAssetV1 = "PartnerAssetV1",
    PartnerAssetV2 = "PartnerAssetV2",
    PartnerAssetBackfillV1 = "PartnerAssetBackfillV1",
    PartnerAssetBackfillV2 = "PartnerAssetBackfillV2",
    PartnerAssetDeleteV1 = "PartnerAssetDeleteV1",
    PartnerAssetExifV1 = "PartnerAssetExifV1",
    PartnerAssetExifBackfillV1 = "PartnerAssetExifBackfillV1",
    PartnerStackBackfillV1 = "PartnerStackBackfillV1",
    PartnerStackDeleteV1 = "PartnerStackDeleteV1",
    PartnerStackV1 = "PartnerStackV1",
    AlbumV1 = "AlbumV1",
    AlbumV2 = "AlbumV2",
    AlbumDeleteV1 = "AlbumDeleteV1",
    AlbumUserV1 = "AlbumUserV1",
    AlbumUserBackfillV1 = "AlbumUserBackfillV1",
    AlbumUserDeleteV1 = "AlbumUserDeleteV1",
    AlbumAssetCreateV1 = "AlbumAssetCreateV1",
    AlbumAssetCreateV2 = "AlbumAssetCreateV2",
    AlbumAssetUpdateV1 = "AlbumAssetUpdateV1",
    AlbumAssetUpdateV2 = "AlbumAssetUpdateV2",
    AlbumAssetBackfillV1 = "AlbumAssetBackfillV1",
    AlbumAssetBackfillV2 = "AlbumAssetBackfillV2",
    AlbumAssetExifCreateV1 = "AlbumAssetExifCreateV1",
    AlbumAssetExifUpdateV1 = "AlbumAssetExifUpdateV1",
    AlbumAssetExifBackfillV1 = "AlbumAssetExifBackfillV1",
    AlbumToAssetV1 = "AlbumToAssetV1",
    AlbumToAssetDeleteV1 = "AlbumToAssetDeleteV1",
    AlbumToAssetBackfillV1 = "AlbumToAssetBackfillV1",
    MemoryV1 = "MemoryV1",
    MemoryDeleteV1 = "MemoryDeleteV1",
    MemoryToAssetV1 = "MemoryToAssetV1",
    MemoryToAssetDeleteV1 = "MemoryToAssetDeleteV1",
    StackV1 = "StackV1",
    StackDeleteV1 = "StackDeleteV1",
    PersonV1 = "PersonV1",
    PersonDeleteV1 = "PersonDeleteV1",
    AssetFaceV1 = "AssetFaceV1",
    AssetFaceV2 = "AssetFaceV2",
    AssetFaceV3 = "AssetFaceV3",
    AssetFaceDeleteV1 = "AssetFaceDeleteV1",
    UserMetadataV1 = "UserMetadataV1",
    UserMetadataDeleteV1 = "UserMetadataDeleteV1",
    SyncAckV1 = "SyncAckV1",
    SyncResetV1 = "SyncResetV1",
    SyncCompleteV1 = "SyncCompleteV1"
}
export enum SyncRequestType {
    AlbumsV1 = "AlbumsV1",
    AlbumsV2 = "AlbumsV2",
    AlbumUsersV1 = "AlbumUsersV1",
    AlbumToAssetsV1 = "AlbumToAssetsV1",
    AlbumAssetsV1 = "AlbumAssetsV1",
    AlbumAssetsV2 = "AlbumAssetsV2",
    AlbumAssetExifsV1 = "AlbumAssetExifsV1",
    AssetsV1 = "AssetsV1",
    AssetsV2 = "AssetsV2",
    AssetExifsV1 = "AssetExifsV1",
    AssetEditsV1 = "AssetEditsV1",
    AssetMetadataV1 = "AssetMetadataV1",
    AssetOcrV1 = "AssetOcrV1",
    AuthUsersV1 = "AuthUsersV1",
    AuthUsersV2 = "AuthUsersV2",
    MemoriesV1 = "MemoriesV1",
    MemoryToAssetsV1 = "MemoryToAssetsV1",
    PartnersV1 = "PartnersV1",
    PartnerAssetsV1 = "PartnerAssetsV1",
    PartnerAssetsV2 = "PartnerAssetsV2",
    PartnerAssetExifsV1 = "PartnerAssetExifsV1",
    PartnerStacksV1 = "PartnerStacksV1",
    StacksV1 = "StacksV1",
    UsersV1 = "UsersV1",
    PeopleV1 = "PeopleV1",
    AssetFacesV1 = "AssetFacesV1",
    AssetFacesV2 = "AssetFacesV2",
    AssetFacesV3 = "AssetFacesV3",
    UserMetadataV1 = "UserMetadataV1"
}
export enum Kind {
    Travel = "travel",
    Documents = "documents",
    Screenshots = "screenshots",
    Food = "food",
    Pets = "pets",
    Nature = "nature"
}
export enum TimeBucketDateType {
    Added = "added",
    Taken = "taken"
}
export enum AssetOrderBy {
    TakenAt = "takenAt",
    CreatedAt = "createdAt"
}
export enum WorkflowResult {
    Completed = "completed",
    Halted = "halted",
    Error = "error"
}
export enum ReleaseType {
    Major = "major",
    Premajor = "premajor",
    Minor = "minor",
    Preminor = "preminor",
    Patch = "patch",
    Prepatch = "prepatch",
    Prerelease = "prerelease"
}
export enum UserMetadataKey {
    Preferences = "preferences",
    License = "license",
    Onboarding = "onboarding"
}
