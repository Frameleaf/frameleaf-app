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
export type CloudLinkPendingDto = {
    expiresAt: string;
    /** How often this server asks whether the code was approved */
    intervalSeconds: number;
    /** The code to enter on the approval page, XXXX-XXXX */
    userCode: string;
    verificationUri: string;
    /** The approval page with the code filled in; shown as a QR code */
    verificationUriComplete: string;
};
export type CloudPermissionsDto = {
    /** Frameleaf Cloud may start a cloud backup run */
    allowBackupTrigger: boolean;
    /** Frameleaf Cloud may refresh the plan and rotate this server’s credentials */
    allowEntitlementRefresh: boolean;
    /** Frameleaf Cloud may turn remote access on or off */
    allowRemoteEnable: boolean;
};
export type CloudStatusResponseDto = {
    /** The linked Frameleaf account */
    account: {
        id: string | null;
        label: string | null;
    } | null;
    /** Originals, archives and database backups may be downloaded through the relay */
    allowOriginalsOverRelay: boolean;
    /** Password sign-in is allowed away from home */
    allowPasswordOverRelay: boolean;
    /** Frameleaf Cloud saw this server’s identity start from two places */
    cloneSuspected: boolean;
    /** Host of the configured Frameleaf Cloud address */
    cloudHost: string | null;
    /** FRAMELEAF_CLOUD_URL is set */
    configured: boolean;
    dataRegion: string | null;
    /** Check-ins that failed in a row */
    heartbeatFailures: number;
    /** Exactly the fields each check-in sends; the "What this server sends" panel lists them */
    heartbeatFields: CloudHeartbeatField[];
    /** This server’s instance ID, once its identity exists */
    instanceId: string | null;
    /** RFC 7638 thumbprint of this server’s key */
    keyFingerprint: string | null;
    lastContactAt: string | null;
    /** The last link or check-in problem, in plain words */
    lastError: string | null;
    /** Why Frameleaf Cloud refused the last link attempt, while unlinked; null when it gave no such reason */
    linkRefusal: (CloudLinkRefusal) | null;
    linkResult: (CloudLinkResult) | null;
    /** FRAMELEAF_LINK_TOKEN is set */
    linkTokenConfigured: boolean;
    linkedAt: string | null;
    pending: (CloudLinkPendingDto) | null;
    permissions: CloudPermissionsDto;
    /** Frameleaf Cloud asked an administrator to link again */
    relinkRequested: boolean;
    /** Remote access is switched on for this linked server */
    remoteAccessEnabled: boolean;
    revoked: {
        at: string;
        reason: string;
    } | null;
    /** The Sign in with Frameleaf button text */
    signInButtonText: string;
    /** The OpenID client ID for Sign in with Frameleaf */
    signInClientId: string | null;
    signInIssuer: string | null;
    /** Accounts here linked to a Frameleaf account */
    signInLinkedAccounts: number;
    /** Sign in with Frameleaf is offered at home too */
    signInShowOnLocalLogin: boolean;
    state: CloudLinkState;
};
export type CloudMlConsentFeaturesDto = {
    identityNames: boolean;
    medicalSignals: boolean;
    ocrAddon: boolean;
};
export type CloudMlConsentStateDto = {
    /** The version an administrator accepted on this server */
    acceptedVersion: string | null;
    /** The full consent text, when Frameleaf Cloud links one */
    documentUrl: string | null;
    /** The feature choices on record */
    features: CloudMlConsentFeaturesDto;
    /** Consent was given, but for an older version; processing is refused until renewed */
    outdated: boolean;
    /** The version Frameleaf Cloud has on record for this server */
    recordedVersion: string | null;
    /** The consent version Frameleaf Cloud requires now */
    requiredVersion: string;
    /** What the consent covers, as Frameleaf Cloud words it */
    summary: string;
};
export type MlDestinationCloudDto = {
    /** AI Wallet balance, USD */
    balanceUsd: number;
    /** Daily AI Wallet limit, USD, or null */
    dailyCapUsd: number | null;
    /** The Frameleaf account has the cloud processing entitlement */
    entitled: boolean;
    /** AI Wallet amount held by running jobs, USD */
    heldUsd: number;
    /** Why the last check refused, or null */
    refusal: (MlAdmissionRefusal) | null;
    refusalDetail: string | null;
    /** Frameleaf Cloud data region */
    region: string | null;
    /** AI Wallet spend today, USD */
    spentTodayUsd: number;
};
export type MlDestinationConsentDto = {
    /** When an administrator recorded consent, or null */
    acknowledgedAt: string | null;
    /** Administrator who recorded consent, or null */
    acknowledgedBy: string | null;
    /** Whether this destination sends media off the network and needs consent */
    required: boolean;
    /** Frameleaf Cloud: the consent version the cloud requires now, from the last check, or null */
    requiredVersion: string | null;
    /** Frameleaf Cloud: the consent version accepted, or null */
    version: string | null;
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
    /** Frameleaf Cloud facts from the last check; null for other kinds */
    cloud: (MlDestinationCloudDto) | null;
    consent: MlDestinationConsentDto;
    costControls: MlDestinationCostControlsDto;
    createdAt: string;
    enabled: boolean;
    health: MlDestinationHealthStateDto;
    id: string;
    kind: MlDestinationKind;
    name: string;
    role: MlWorkerRole;
    /** A restoration worker on the GPU library analysis uses; its full restorations wait for library work */
    sharesLibraryHardware: boolean;
    updatedAt: string;
    /** Endpoint URL; always null for Frameleaf Cloud */
    url: string | null;
    /** Workloads the administrator allows on this destination */
    workloads: MlWorkload[];
};
export type CloudMlWalletDto = {
    /** Automatic top-up with the payment method saved on the account */
    autoTopUp: boolean;
    /** Balance minus holds, USD */
    availableUsd: number;
    /** AI Wallet balance, USD */
    balanceUsd: number;
    /** Daily limit, USD, or null */
    dailyCapUsd: number | null;
    /** Held by running jobs, USD */
    heldUsd: number;
    /** Where the account owner raises the daily cap or turns on automatic top-up, when Frameleaf Cloud named it; this server can only lower the cap or turn automatic top-up off */
    settingsUrl: string | null;
    /** Spent today, USD */
    spentTodayUsd: number;
    /** Where to add credit; only when Frameleaf Cloud returned one */
    topUpUrl: string | null;
    /** When this balance was read */
    updatedAt: string;
};
export type CloudMlStatusResponseDto = {
    checkedAt: string;
    connection: CloudMlConnection;
    consent: (CloudMlConsentStateDto) | null;
    /** The Frameleaf Cloud destination, once added */
    destination: (MlDestinationResponseDto) | null;
    /** Why the connection is not ready, in plain words */
    detail: string | null;
    /** Frameleaf Cloud processing is turned on in settings */
    enabled: boolean;
    /** Cloud processing entitlement, when the cloud answered */
    entitled: boolean | null;
    /** The Frameleaf account's data region */
    region: string | null;
    /** The last AI Wallet read, or null */
    wallet: (CloudMlWalletDto) | null;
};
export type CloudMlModelDto = {
    description: string;
    fingerprint: string;
    /** The group this model is chosen for, or null for one this server does not know */
    group: (CloudMlModelGroup) | null;
    id: string;
    /** Frameleaf Cloud recommends this model for its workload (and restoration mode) in this region; work with no chosen model uses it */
    isDefault: boolean;
    name: string;
    /** Price per unit, USD */
    priceUsd: number | null;
    /** What one price unit is (for example an image or a video minute) */
    pricingUnit: string | null;
    /** Position on its workload's ladder, 1 = lightest */
    rank: number;
    /** The workload this model serves, or null for one this server does not know */
    workload: (MlWorkload) | null;
};
export type CloudMlCatalogResponseDto = {
    /** Models Frameleaf Cloud offers now; retired models are left out */
    models: CloudMlModelDto[];
};
export type CloudMlConsentRecordDto = {
    acceptedAt: string;
    acceptedBy: string;
    features: CloudMlConsentFeaturesDto;
    revokedAt: string | null;
    version: string;
};
export type CloudMlConsentHistoryResponseDto = {
    records: CloudMlConsentRecordDto[];
};
export type CloudMlDescriptionBatchCreateDto = {
    /** The estimate to queue; its model, photos and prices are read from the server, never sent */
    estimateId: string;
};
export type CloudMlDescriptionBatchesResponseDto = {
    /** Batches queued */
    batches: number;
    /** The queued batches; each shows in Activity */
    operationIds: string[];
    /** Photos in them */
    photos: number;
};
export type CloudMlDescriptionGuidanceDto = {
    /** The batch size below which the start fee makes up most of the cost with this model */
    minimumBatch: number;
    /** How many of the batches are smaller than that */
    smallBatches: number;
    /** A model of the 27B/35B class the catalogue offers for small batches, when there is one */
    suggestedModelId: string | null;
    /** Its catalogue name */
    suggestedModelName: string | null;
};
export type CloudMlDescriptionEstimateResponseDto = {
    /** AI Wallet balance minus holds, USD */
    availableUsd: number;
    /** measured: from the model's measured GPU time; modelled: from its expected GPU time */
    basis: string;
    /** Batches they would be sent in; each batch is one cloud job */
    batches: number;
    /** The daily AI Wallet limit, USD, or null */
    dailyCapUsd: number | null;
    /** The estimate the server keeps; queueing the backfill names only this, or null when there is nothing to queue */
    estimateId: string | null;
    /** Until when the estimate may be queued, or null */
    expiresAt: string | null;
    /** Set when the model is of the 72B class and some batches are too small for its start fee to pay off */
    guidance: (CloudMlDescriptionGuidanceDto) | null;
    /** What the AI Wallet would hold while the batches run, USD */
    holdUsd: number;
    /** The catalogue model SKU the batches would use */
    modelId: string;
    /** Its catalogue name */
    modelName: string;
    /** Likely cost of every batch together, USD */
    p50Usd: number;
    /** Cost at most, in nine cases out of ten, USD */
    p90Usd: number;
    /** Likely GPU time cost per photo, USD */
    perPhotoP50Usd: number;
    /** GPU time cost per photo at most, in nine cases out of ten, USD */
    perPhotoP90Usd: number;
    /** Photos that would be described */
    photos: number;
    /** Why the backfill cannot start now, or null when it can */
    refusal: string | null;
    /** Spent today, USD */
    spentTodayUsd: number;
    /** The start fee each batch pays, USD */
    startupUsd: number;
    /** More photos need a description than one backfill covers; run another afterwards for the rest */
    truncated: boolean;
};
export type CloudMlDestinationCreateDto = {
    budgetLimitUsd?: number | null;
    name?: string;
    /** The workloads Frameleaf Cloud may run; faces, search and text recognition are refused */
    workloads: MlWorkload[];
};
export type CloudMlModelChoiceDto = {
    group: CloudMlModelGroup;
    /** The chosen catalogue model SKU, or null when the group uses the catalogue default */
    modelId: string | null;
};
export type CloudMlModelChoicesResponseDto = {
    /** Every model group, in a fixed order */
    choices: CloudMlModelChoiceDto[];
};
export type CloudMlModelChoiceUpdateDto = {
    /** A catalogue model SKU of exactly this group; null uses the catalogue default */
    modelId: string | null;
};
export type CloudMlSettlementDto = {
    /** The job id Frameleaf Cloud settled */
    cloudJobId: string;
    /** The compute SKU the job ran on, when reported */
    computeSku: string | null;
    /** The settled charge, USD */
    costUsd: number;
    /** Credits the charge used, when reported */
    credits: number | null;
    /** The estimate shown before the job, USD */
    estimateUsd: number | null;
    finishedAt: string;
    /** Metered GPU time, seconds, when reported */
    gpuSeconds: number | null;
    /** The server job that sent the work, when recorded */
    jobName: string | null;
    /** The catalogue model SKU the job used, when reported */
    modelSku: string | null;
    /** The request finished successfully */
    succeeded: boolean;
    /** Workers the job ran on (each paid a start fee), when reported */
    workers: number | null;
    workload: MlWorkload;
};
export type CloudMlSettlementsResponseDto = {
    /** Settled charges, newest first (at most 50) */
    items: CloudMlSettlementDto[];
};
export type CloudMlWalletUpdateDto = {
    /** Top up automatically when available credit runs low */
    autoTopUp?: boolean;
    /** Daily spending cap, USD */
    dailyCapUsd?: number;
};
export type CloudPermissionsUpdateDto = {
    /** Frameleaf Cloud may start a cloud backup run */
    allowBackupTrigger?: boolean;
    /** Frameleaf Cloud may refresh the plan and rotate this server’s credentials */
    allowEntitlementRefresh?: boolean;
    /** Frameleaf Cloud may turn remote access on or off */
    allowRemoteEnable?: boolean;
};
export type CloudRemoteAccessUpdateDto = {
    /** Allow original downloads, archives and database backups through the relay */
    allowOriginalsOverRelay?: boolean;
    /** Allow password sign-in away from home */
    allowPasswordOverRelay?: boolean;
};
export type CloudSignInUpdateDto = {
    /** The Sign in with Frameleaf button text */
    buttonText?: string;
    /** Offer Sign in with Frameleaf on the login page at home */
    showOnLocalLogin?: boolean;
};
export type AdminConfigAnalyticsDto = {
    /** Collect local analytics history every night */
    enabled: boolean;
    /** Days of local analytics history to keep */
    historyDays: number;
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
export type AdminConfigFrameleafCloudAutoDescribeDto = {
    /** Daily budget for automatic descriptions, USD; counts toward the AI Wallet daily cap */
    dailyBudgetUsd: number;
    /** Describe new photos automatically on Frameleaf Cloud */
    enabled: boolean;
};
export type AdminConfigFrameleafCloudFacesDto = {
    /** Faces never run on Frameleaf Cloud */
    enabled: false;
};
export type AdminConfigFrameleafCloudRoutingDto = {
    descriptions: CloudRouteMode;
    interpolation: CloudRouteMode;
    restoration: CloudRouteMode;
    studio: CloudRouteMode;
    upscale: CloudRouteMode;
};
export type AdminConfigFrameleafCloudMlDto = {
    autoDescribe: AdminConfigFrameleafCloudAutoDescribeDto;
    /** Use Frameleaf Cloud for chosen jobs (each job still needs consent and confirmation) */
    enabled: boolean;
    faces: AdminConfigFrameleafCloudFacesDto;
    routing: AdminConfigFrameleafCloudRoutingDto;
    /** The destination a job preselects when its kind of work may run in both places */
    startWith: StartWith;
};
export type AdminConfigFrameleafRemoteAccessDto = {
    /** Allow original downloads, archives and database backups over the Frameleaf relay */
    allowOriginalsOverRelay: boolean;
    /** Allow password sign-in, and sessions it creates, over remote access */
    allowPasswordOverRelay: boolean;
};
export type AdminConfigFrameleafSignInDto = {
    /** Sign in with Frameleaf button text */
    buttonText: string;
    /** Show Sign in with Frameleaf on the local sign-in page too */
    showOnLocalLogin: boolean;
};
export type AdminConfigFrameleafCloudDto = {
    cloudMl: AdminConfigFrameleafCloudMlDto;
    remoteAccess?: AdminConfigFrameleafRemoteAccessDto;
    signIn?: AdminConfigFrameleafSignInDto;
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
    petRecognition?: AdminConfigForkJobSettingsDto;
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
export type AdminConfigLibraryCareDto = {
    /** Health scans verify each original against its recorded checksum */
    checksumScan: boolean;
    /** Group near-duplicates for review; deletion stays explicit */
    duplicateReview: boolean;
    /** Schedule incremental health scans of every account; each resumes from its recorded checkpoints */
    healthScan: boolean;
    /** When the scheduled health scan starts */
    healthScanCronExpression: string;
    /** A full description rerun reprocesses only results that are missing, failed or out of date */
    incrementalEnrichment: boolean;
    /** Run the scheduled database and file reference audits (missing and untracked files) */
    integrityAudit: boolean;
    /** Suggest Live Photo pairs to relink; ambiguous pairs stay in review */
    livePhotoRepair: boolean;
    /** A description rerun replaces only generated text and keeps manual text */
    manualMetadata: boolean;
    /** Search for recoverable copies of RAW originals when locating originals */
    rawRecovery: boolean;
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
    /** Suggest receipt and document fields (dates, totals, references) from recognized text */
    documentFields?: boolean;
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
    /** SMTP password (write-only; empty preserves the existing password) */
    password: string;
    /** Read-only indicator that an SMTP password is stored. Set by the server; ignored on write. */
    passwordConfigured?: boolean;
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
    /** Client secret (write-only; empty preserves the existing secret) */
    clientSecret: string;
    /** Read-only indicator that a client secret is stored. Set by the server; ignored on write. */
    clientSecretConfigured?: boolean;
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
    /** Server name shown in settings; empty uses the host name */
    name: string;
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
export type AdminConfigSmartAlbumRulesDto = {
    /** The action a new rule starts with */
    defaultAction: ClassificationRuleAction;
    /** Whether rules may match visual category phrases */
    visualCategories: boolean;
};
export type AdminConfigSmartAlbumsDto = {
    builtIn: AdminConfigSmartAlbumBuiltInDto;
    /** Master smart-album enabled toggle */
    enabled: boolean;
    rules?: AdminConfigSmartAlbumRulesDto;
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
    analytics?: AdminConfigAnalyticsDto;
    backup: AdminConfigBackupsDto;
    ffmpeg: AdminConfigFFmpegDto;
    frameleafCloud?: AdminConfigFrameleafCloudDto;
    image: AdminConfigImageDto;
    integrityChecks: AdminConfigIntegrityChecksDto;
    job: AdminConfigJobDto;
    library: AdminConfigLibraryDto;
    libraryCare?: AdminConfigLibraryCareDto;
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
export type ConfigCredentialResponseDto = {
    /** Whether a value is stored. The value itself is never returned */
    configured: boolean;
    name: ConfigCredential;
};
export type ConfigCredentialUpdateDto = {
    /** The new secret. Stored as sent and never returned */
    value: string;
};
export type SystemConfigHistoryChangeDto = {
    /** The value after the change, JSON encoded; null for a credential */
    after: string | null;
    /** The value before the change, JSON encoded; null for a credential */
    before: string | null;
    credential?: SystemConfigHistoryCredentialChange;
    /** The changed setting, as a dotted path such as trash.days */
    path: string;
};
export type SystemConfigHistoryEntryDto = {
    /** The administrator who saved the change */
    actorId: string | null;
    /** The administrator's name when the change was saved */
    actorName: string | null;
    /** Every changed setting */
    changes: SystemConfigHistoryChangeDto[];
    /** When the change was saved (ISO 8601) */
    createdAt: string;
    /** Entry ID */
    id: string;
    kind?: SystemConfigHistoryKind;
    /** Changed settings left out because the entry reached its limit */
    omittedChanges: number;
    /** The entry title, such as "Updated email server password"; absent for a settings save */
    title?: string | null;
};
export type SystemConfigHistoryResponseDto = {
    /** The newest settings changes first */
    entries: SystemConfigHistoryEntryDto[];
};
export type AdminConfigRevisionResponseDto = {
    config: AdminConfigDto;
    /** Changes whenever a saved setting changes; send it back as expectedRevision so a save made against older settings is refused */
    revision: string;
};
export type AdminConfigRevisionUpdateDto = {
    config: AdminConfigDto;
    /** The revision the changes were made against. When the saved settings no longer match it the update is refused with 409 and nothing is changed */
    expectedRevision: string;
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
export type BackupRestoreVerificationResponseDto = {
    /** When the next test is due; null when a part has never been proved */
    dueAt: string | null;
    /** How often a restore test is due */
    intervalDays: number;
    /** When restoring the database was last proved */
    metadataVerifiedAt: string | null;
    /** When restoring the original files was last proved */
    originalsVerifiedAt: string | null;
    /** Whether a restore test is due */
    overdue: boolean;
    /** The administrator who recorded the last test; null once that account is gone */
    verifiedBy: {
        id: string;
        name: string;
    } | null;
};
export type BackupRestoreVerificationRecordDto = {
    /** The database restored and was checked */
    metadata: boolean;
    /** Original files restored and their checksums were verified */
    originals: boolean;
};
export type DatabaseBackupUploadDto = {
    /** Database backup file */
    file?: Blob;
};
export type HardwareBenchmarkDto = {
    /** Median time of a search embedding */
    embeddingMs: number | null;
    /** Measured ÷ estimated time for AI work here (applied to the local estimates) */
    mlFactor: number | null;
    ranAt: string;
    /** Measured ÷ estimated time for video encoding here */
    serverFactor: number | null;
    /** 1080p test transcode, × real time */
    transcodeSpeed: number | null;
};
export type HardwareContainerTestDto = {
    /** What failed, as the container reported it */
    error: string | null;
    /** The test ran on the GPU */
    gpu: boolean;
    /** transcode: the server container; embedding: the ML container */
    kind: Kind;
    /** The test finished without falling back */
    ok: boolean;
    /** transcode: 1080p real-time multiple; embedding: milliseconds; null when it did not run */
    value: number | null;
};
export type HardwareContainerCheckDto = {
    backend: HardwareBackend;
    /** Driver and runtime, or what the driver reported instead */
    driver: string | null;
    model: string | null;
    /** The container answered the check */
    reachable: boolean;
    test: (HardwareContainerTestDto) | null;
    vendor: string | null;
    vramGb: number | null;
};
export type HardwareCheckResponseDto = {
    /** The last benchmark on this hardware, if any */
    benchmark: (HardwareBenchmarkDto) | null;
    checkedAt: string;
    /** Set-up problems the check found, by problem id */
    issues: string[];
    /** The ML container: search, faces, descriptions and restoration */
    ml: HardwareContainerCheckDto;
    /** The ML image flavour (cpu, cuda, rocm, openvino), when reported */
    mlImage: string | null;
    /** The server container: video playback and Studio export */
    server: HardwareContainerCheckDto;
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
export type IntegrityCheckRunsResponseDto = {
    /** When the checksum check last completed a full pass */
    checksum_mismatch: string | null;
    /** When the missing-file check last completed */
    missing_file: string | null;
    /** When the untracked-file check last completed */
    untracked_file: string | null;
};
export type IntegrityReportSummaryResponseDto = {
    checksum_mismatch: number;
    missing_file: number;
    untracked_file: number;
};
export type LicenseEntitlementsDto = {
    cloudBackup: boolean;
    cloudMl: boolean;
    frameleafCloud: boolean;
    remoteAccess: boolean;
    supporter: boolean;
};
export type LicenseSlotDto = {
    /** When this server received the certificate */
    activatedAt: string;
    /** When the certificate or its period ends; null for a lifetime key */
    expiresAt: string | null;
    graceUntil: string | null;
    /** Last four symbols of the key, for a key activation */
    keyHint: string | null;
    kind: LicenseKind;
    refreshedAt: string | null;
    /** Activated by key, installed from a file, or from the account */
    source: Source;
    state: LicenseState;
};
export type LicenseStatusResponseDto = {
    /** Frameleaf Cloud is set up on this server (FRAMELEAF_CLOUD_URL) */
    configured: boolean;
    entitlements: LicenseEntitlementsDto;
    expiresAt: string | null;
    /** What a licence is bound to: this server’s instance ID and key thumbprint */
    fingerprint: {
        instanceId: string | null;
        jkt: string | null;
    };
    graceUntil: string | null;
    /** The supporter key held by this server */
    key: (LicenseSlotDto) | null;
    keyHint: string | null;
    kind: (LicenseKind) | null;
    /** A supporter key or plan is active or in grace; plans then cost less by licensedDiscount on license/products */
    licensed: boolean;
    /** This server is linked to a Frameleaf account */
    linked: boolean;
    /** The licence came from a file and is not refreshed online */
    offline: boolean;
    /** The Frameleaf Cloud plan held by this server */
    plan: (LicenseSlotDto) | null;
    /** The daily certificate refresh */
    refresh: {
        lastError: string | null;
        nextRefreshAt: string | null;
        refreshedAt: string | null;
    };
    /** The overall state: the plan’s when there is one, else the key’s */
    state: LicenseState;
};
export type LicenseActivateDto = {
    /** A licence key, FL-KXXX-XXXX-XXXX */
    key: string;
};
export type LicenseCertificateDto = {
    /** The contents of a licence file: the signed certificate, or a JSON file holding it */
    certificate: string;
};
export type SetMaintenanceModeDto = {
    action: MaintenanceAction;
    /** Keep the safety backup of the current database that a restore makes first (default true); it is always kept when the restore fails */
    keepSafetyBackup?: boolean;
    /** Why the server is in maintenance, shown to everyone on the maintenance screen (max 200 characters). Omit to keep the current reason; null or an empty string clears it */
    reason?: string | null;
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
    /** Why the server is in maintenance, as set by the administrator (public) */
    reason?: string;
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
export type PhysicalDeduplicationRestoreRequestDto = {
    /** A copy of the applied plan whose own file is still on disk */
    assetId: string;
};
export type PhysicalDeduplicationVerificationItemDto = {
    assetId: string;
    /** Whether the requesting administrator may view this asset and its thumbnail */
    canView: boolean;
    copyFile: PhysicalDeduplicationCopyFile;
    /** Whether the asset still resolves to the retained original */
    linked: boolean;
    originalFileName: string;
    ownerName: string;
    /** Whether the asset can go back to its own file: it is linked and that file still holds the reviewed bytes */
    restorable: boolean;
    /** Whether the asset is back on its own former file */
    restored: boolean;
    retainedFile: PhysicalDeduplicationRetainedFile;
    "type": AssetTypeEnum;
};
export type PhysicalDeduplicationVerificationDto = {
    /** Copies the plan applied, listed or not */
    copies: number;
    /** Copies that are Locked media of another account; counted, never named */
    hiddenCopies: number;
    items: PhysicalDeduplicationVerificationItemDto[];
    /** Copies that no longer resolve to the retained original */
    notLinked: number;
    operationId: string;
    planId: string;
    /** Copies whose own file is gone: that cannot be undone */
    removed: number;
    restorable: number;
    restored: number;
    retainedChanged: number;
    retainedIntact: number;
    retainedMissing: number;
    retainedOriginals: number;
    /** Copies that resolve to a retained original still holding the reviewed bytes */
    verified: number;
    verifiedAt: string;
};
export type PhysicalDeduplicationApplyRequestDto = {
    /** `APPLY <planId>`, typed by the administrator */
    confirmation: string;
    /** Retained originals whose group the administrator decided to leave as they are */
    excludedRetainedAssetIds?: string[];
    /** The fingerprint of the plan on screen, from the preview */
    fingerprint: string;
    /** From the review of this plan */
    reviewToken: string;
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
export type MediaOperationEstimateDto = {
    /** Configured cloud rate detail, when one applies */
    cloudCost: {
        [key: string]: any;
    } | null;
    /** Measured estimate of remaining work */
    seconds: number;
    /** Estimated output size */
    sizeBytes: string | null;
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
    /** What the person sees in Activity; empty when withheld */
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
    /** The job is about a Locked item this session has not unlocked; its label and snapshot are withheld */
    withheld: boolean;
};
export type PhysicalDeduplicationReviewRequestDto = {
    /** Retained originals whose group the administrator decided to leave as they are */
    excludedRetainedAssetIds?: string[];
    /** The fingerprint of the plan on screen, from the preview */
    fingerprint: string;
};
export type PhysicalDeduplicationReviewResponseDto = {
    /** The phrase to type to apply this plan */
    confirmation: string;
    /** Copies the reviewed plan will share */
    copies: number;
    estimatedBytes: number;
    excludedRetainedAssetIds: string[];
    fingerprint: string;
    /** Copies in the reviewed plan that are Locked media of another account; counted, never named */
    hiddenCopies: number;
    planId: string;
    retainedOriginals: number;
    /** Binds the plan to these per-group decisions; applying must present it */
    reviewToken: string;
    reviewedAt: string;
};
export type PhysicalDeduplicationApplyDto = {
    alreadyApplied: number;
    applied: number;
    createdAt: string;
    error: string | null;
    estimatedBytes: number;
    failed: number;
    fingerprint: string;
    finishedAt: string | null;
    /** Whether the requesting administrator applied it */
    mine: boolean;
    /** The media operation applying the plan */
    operationId: string;
    pauseRequested: boolean;
    planId: string;
    processed: number;
    progress: number;
    /** Bytes actually removed from disk so far */
    reclaimedBytes: number;
    /** Administrator who applied the plan; the job is theirs to pause or cancel */
    requestedById: string;
    requestedByName: string;
    /** Waiting for its one automatic retry */
    retrying: boolean;
    /** Copies left alone because their evidence changed */
    skipped: number;
    status: MediaOperationStatus;
    /** Copies in the reviewed plan */
    total: number;
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
    /** Video length in milliseconds, when known */
    duration: number | null;
    /** Height in pixels, when known */
    height: number | null;
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
    /** Width in pixels, when known */
    width: number | null;
};
export type PhysicalDeduplicationRetainedDto = {
    /** Asset that keeps the original file */
    assetId: string;
    /** Whether the requesting administrator may view this asset and its thumbnail */
    canView: boolean;
    /** Hex-encoded SHA-1 checksum of the original file */
    checksum: string;
    /** Video length in milliseconds, when known */
    duration: number | null;
    /** Whether the retained original file is on disk now, checked on every read (FL-71 UT-24) */
    fileAvailable: boolean;
    /** Height in pixels, when known */
    height: number | null;
    /** Copies this retained original would share that are Locked media of another account; counted, never named (FL-73) */
    hiddenCopies: number;
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
    /** Width in pixels, when known */
    width: number | null;
};
export type PhysicalDeduplicationPlanDto = {
    /** Copies listed with a share decision: the most this plan can apply. Copies past the list limit wait for a later plan */
    applicableCopies: number;
    copies: PhysicalDeduplicationCopyDto[];
    /** True when more copies were reviewed than the stored preview keeps; totals still cover all of them */
    copiesTruncated: boolean;
    /** Measured: bytes actually removed from disk by applying this plan so far */
    deletedBytes: number;
    eligibleAssets: number;
    /** Digest over the plan evidence; changes with every preview (FL-73) */
    fingerprint: string;
    /** Copies left out of the rows because they are Locked media of another account; counted, never named */
    hiddenCopies: number;
    linkedAssets: number;
    /** Logical asset bytes (FL-73): the sizes of every asset that references a shared original once this plan is applied, counted once per asset */
    logicalBytes: number;
    /** Account whose originals are retained by this plan */
    masterUserId: string;
    /** Display name of the retained account */
    masterUserName: string;
    mode: PhysicalDeduplicationPlanMode;
    /** Short name of this plan, typed to confirm applying it (FL-73) */
    planId: string;
    /** When the plan was produced */
    ranAt: string;
    /** Estimate: bytes of the copies to share, with their generated files, that applying would free */
    reclaimableBytes: number;
    retained: PhysicalDeduplicationRetainedDto[];
    /** When set, only copies owned by this account were reviewed; null means every account */
    scopeUserId: string | null;
    scopeUserName: string | null;
    /** Physical shared-original bytes (FL-73): the retained originals those assets share, counted once per file */
    sharedOriginalBytes: number;
    skippedExternal: number;
    skippedMissingMaster: number;
};
export type PhysicalDeduplicationPreviewResponseDto = {
    /** Recently applied plans, newest first (FL-73) */
    applies: PhysicalDeduplicationApplyDto[];
    /** Whether a reviewed plan is being applied (FL-73) */
    applying: boolean;
    /** The saved `physicalDeduplication.enabled` */
    enabled: boolean;
    /** The latest plan, or null when none has run */
    plan: (PhysicalDeduplicationPlanDto) | null;
    /** Whether a deduplication preview is queued or active */
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
export type RenderWorkerCompatibilityResponseDto = {
    /** Render kinds a qualified worker can take now */
    qualified: MediaOperationKind[];
    /** Render kinds no qualified worker can take now */
    unavailable: MediaOperationKind[];
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
export type UserLicense = {
    /** Activation date */
    activatedAt: string;
    /** Last four symbols of the key */
    keyHint: string;
    /** Supporter key kind; personal keys are always individual */
    kind: Kind2;
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
export type UserAdminHistoryEventResponseDto = {
    action: AdminAuditAction;
    /** The administrator who did it; null once that account is gone */
    actorId: string | null;
    /** That administrator's name; null once that account is gone */
    actorName: string | null;
    /** When it happened */
    createdAt: string;
    /** What the action carries: a quota in bytes, a storage label, a recovery period in days, a device name or the changed preference sections; null otherwise */
    detail: string | null;
    /** Event ID */
    id: string;
    /** The library a library event is about; null for account events and once the library is gone */
    libraryId: string | null;
    /** The account's or library's name at the time */
    subject: string;
};
export type UserAdminHistoryResponseDto = {
    /** Newest first */
    events: UserAdminHistoryEventResponseDto[];
    /** True when older events exist beyond this page */
    hasMore: boolean;
};
export type UserAdminPinCodeStateResponseDto = {
    /** Whether the account has a PIN set */
    pinCode: boolean;
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
export type SavedSearch = {
    /** Name shown in the search palette */
    name: string;
    /** The search body to run, as the client sends it to the search endpoints */
    query: {
        [key: string]: any;
    };
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
    /** Whether privacy.suppression names the account's Locked people, pets and tags. False when they were blanked (a session that is not unlocked, or an administrator); such rules must never be edited and saved back (FL-67) */
    lockedRulesRevealed: boolean;
    memories: MemoriesResponse;
    people: PeopleResponse;
    privacy: PrivacyResponse;
    purchase: PurchaseResponse;
    ratings: RatingsResponse;
    recentlyAdded: RecentlyAddedResponse;
    /** Changes whenever the stored preferences change; send it back as expectedRevision to reject stale saves */
    revision: string;
    /** Saved searches (always present). Empty for an administrator, and without any that names a Locked person, pet or tag while the session is locked */
    savedSearches?: SavedSearch[];
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
    /** Saved searches, replacing the whole list (at most 50). Only the account itself can change them */
    savedSearches?: SavedSearch[];
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
export type WorkerWorkloadAdmissionDto = {
    /** Whether the last check would admit this workload here */
    admitted: boolean;
    /** Why it would be refused, or null */
    detail: string | null;
    refusal: (MlAdmissionRefusal) | null;
    workload: MlWorkload;
};
export type WorkerGpuDto = {
    memoryTotalBytes: number;
    name: string;
};
export type WorkerInventoryEntryDto = {
    acceleration: MlWorkerAcceleration;
    /** Jobs running here now */
    activeOperations: number;
    /** Per allowed workload, from the last check */
    admission: WorkerWorkloadAdmissionDto[];
    allowedWorkloads: MlWorkload[];
    /** Last check or check-in */
    checkedAt: string | null;
    /** For a local destination: its URL is still in the machine-learning URL list. Always true otherwise */
    configured: boolean;
    /** True when no consent is needed or it is recorded */
    consentGranted: boolean;
    credential: WorkerCredentialState;
    enabled: boolean;
    /** Largest GPU memory reported or qualified, or null when unknown */
    gpuMemoryBytes: number | null;
    /** GPUs the worker reported, with memory; empty when not reported */
    gpus: WorkerGpuDto[];
    /** ML destination ID or render worker ID */
    id: string;
    /** ML destination kind, or the render worker destination */
    kind: string;
    latencyMs: number | null;
    /** Work sent here leaves the network */
    leavesNetwork: boolean;
    /** Render workers: the most they may hold at once */
    maxConcurrentOperations: number | null;
    name: string;
    /** Jobs waiting for this worker */
    queuedOperations: number;
    readiness: MlWorkerReadiness;
    /** Operation kinds a render worker may claim */
    renderKinds: MediaOperationKind[];
    /** What an ML destination is for; null for a render worker */
    role: (MlWorkerRole) | null;
    /** Workloads whose route names this destination */
    routedWorkloads: MlWorkload[];
    /** Workloads the worker reported on its last check, or null when it never answered */
    servedWorkloads: MlWorkload[] | null;
    sharesLibraryHardware: boolean;
    source: WorkerInventorySource;
    summary: string | null;
    /** Endpoint URL, or null when there is none to show */
    url: string | null;
    /** Full restorations bound here are waiting because library analysis has work */
    waitingForLibraryAnalysis: boolean;
};
export type WorkerQueueBacklogDto = {
    active: number;
    paused: boolean;
    queue: QueueName;
    waiting: number;
};
export type WorkerLibraryRouteDto = {
    destinationId: string | null;
    /** Queues whose jobs run this workload */
    queues: QueueName[];
    workload: MlWorkload;
};
export type WorkerRunnerDto = {
    activeOperations: number;
    kinds: MediaOperationKind[];
    lastHeartbeatAt: string | null;
    /** The server process holding the claims */
    workerId: string;
};
export type WorkerInventoryResponseDto = {
    checkedAt: string;
    /** The machine-learning URL list, in order */
    configuredUrls: string[];
    entries: WorkerInventoryEntryDto[];
    /** Library-analysis jobs active or waiting, not counting paused queues */
    libraryBacklog: number;
    libraryQueues: WorkerQueueBacklogDto[];
    libraryRoutes: WorkerLibraryRouteDto[];
    machineLearningEnabled: boolean;
    /** Server processes running restorations now */
    runners: WorkerRunnerDto[];
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
    /** True when the album is filled by smart album rules. Populated by GET /albums/tree and GET /albums/{id}. */
    isSmart?: boolean;
    kind: AlbumKind;
    /** Last modified asset timestamp */
    lastModifiedAssetTimestamp?: string;
    order?: AssetOrder;
    /** Collection this album belongs to (null = top-level) */
    parentId: string | null;
    /** Is shared album */
    shared: boolean;
    /** Your classification rule behind this smart album, when it is one of yours */
    smartRuleId?: string | null;
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
export type AlbumOrderDto = {
    /** Every item of the group, in the order to show them. Must be exactly the group as it is now; a group that changed since the client loaded it is refused with 409. */
    albumIds: string[];
    /** Collection whose albums are ordered, or null for a top-level group (collections, albums on their own, or shared spaces) */
    parentId: string | null;
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
    /** Where the client last saw the album (its collection, or null for on its own). When given and the album has been moved since, the move is refused with 409 instead of undoing the other change. */
    expectedParentId?: string | null;
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
    /** UTC timestamp when the asset was captured */
    fileCreatedAt?: string;
    /** Asset ID */
    id: string;
    /** Latitude */
    lat: number;
    /** Capture date and time in the local time zone where it was taken, encoded as UTC */
    localDateTime?: string;
    /** Longitude */
    lon: number;
    /** Original file name */
    originalFileName?: string;
    /** State/Province name */
    state: string | null;
    "type"?: AssetTypeEnum;
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
export type AnalyticsAlbumDto = {
    id: string;
    name: string;
    owned: boolean;
    ownerName: string;
    shared: boolean;
};
export type AnalyticsAlbumsDto = {
    /** Albums the viewer owns or belongs to */
    albums: AnalyticsAlbumDto[];
    notShared: number;
    owned: number;
    ownedShared: number;
    shared: number;
    total: number;
    /** Albums counted but not listed, because the viewer neither owns nor belongs to them */
    unlisted: number;
};
export type AnalyticsCameraDto = {
    count: number;
    kind: AnalyticsCameraKind;
    /** Camera model; null for the other and unknown rows */
    name: string | null;
};
export type AnalyticsDayDto = {
    /** Items taken on this local date */
    captured: number;
    date: string;
    /** Items added on this UTC date */
    uploaded: number;
};
export type AnalyticsSeriesDefinitionDto = {
    /** Whether this report carries the series for the selected scope */
    available: boolean;
    /** Written by the local nightly collector rather than read live */
    collected: boolean;
    /** An estimate, never a charge */
    estimate: boolean;
    grain: AnalyticsGrain;
    id: AnalyticsSeriesId;
    measurementScope: AnalyticsMeasurementScope;
    owner: AnalyticsSeriesOwner;
    /** Selections the series can be read for */
    scopes: AnalyticsScopeKind[];
    /** Where the number comes from */
    source: string;
    unit: AnalyticsUnit;
};
export type AnalyticsHistoryDto = {
    dayRetentionDays: number;
    lastObservedAt: string | null;
    staleAfterHours: number;
    /** unknown: never collected; stale: last collection is too old */
    state: AnalyticsState;
    weekRetentionDays: number;
};
export type AnalyticsVolumeBreakdownDto = {
    /** This server database on disk (pg_database_size) */
    databaseBytes: number;
    /** Encoded video folder, from the nightly collector; null before its first reading */
    encodedVideoBytes: number | null;
    /** The measured parts add up to more than the volume used, for example a database on another disk; otherBytes is then 0 */
    exceedsUsed: boolean;
    /** When the generated folders were last measured */
    generatedObservedAt: string | null;
    /** Generated folders the collector found on another disk than the library; not part of volumeUsedBytes */
    onOtherDisk: AnalyticsVolumePart[];
    /** Uploaded original files on the volume, each shared file counted once (Locked excluded) */
    originalsBytes: number;
    /** volumeUsedBytes minus every measured part: other files on the volume, Locked originals and anything unmeasured */
    otherBytes: number;
    /** Thumbnail and preview folder, from the nightly collector; null before its first reading */
    previewsBytes: number | null;
};
export type AnalyticsHostDto = {
    breakdown?: (AnalyticsVolumeBreakdownDto) | null;
    /** Bytes */
    capacityBytes: number | null;
    /** Bytes */
    freeBytes: number | null;
    observedAt: string | null;
    state: AnalyticsState;
    /** Bytes */
    volumeUsedBytes: number | null;
};
export type AnalyticsYearCountDto = {
    count: number;
    year: number;
};
export type AnalyticsCoverageDto = {
    /** Items face detection has run on */
    facesChecked: number;
    /** Items with a smart-search embedding */
    searchIndexed: number;
};
export type AnalyticsFocalLengthDto = {
    count: number;
    key: AnalyticsFocalLengthDtoKey;
};
export type AnalyticsHdrDto = {
    dolbyVisionVideos: number;
    /** PQ or HLG transfer, or Dolby Vision */
    hdrVideos: number;
    /** Videos whose stream metadata has been read; the only ones HDR can be told for */
    probedVideos: number;
};
export type AnalyticsNamedCountDto = {
    count: number;
    kind: AnalyticsNamedCountKind;
    /** Null for the other and unknown rows */
    name: string | null;
};
export type AnalyticsOrientationDto = {
    count: number;
    key: AnalyticsOrientationDtoKey;
};
export type AnalyticsPersonCountDto = {
    /** Items showing them */
    count: number;
    /** Person id */
    id: string;
    name: string;
};
export type AnalyticsPeopleAndPlacesDto = {
    cities: number;
    countries: number;
    /** Visible faces on the items */
    faces: number;
    geotagged: number;
    itemsWithFaces: number;
    /** itemsWithFaces plus itemsWithoutFaces is summary.items minus hiddenItems */
    itemsWithoutFaces: number;
    /** Named, visible people of the owner seen on the items */
    namedPeople: number;
    /** The owner's visible pets confirmed on the items */
    pets: number;
    /** Items per city, then every other city, then no city */
    places: AnalyticsNamedCountDto[];
    /** Most photographed named people; overlapping, as one item can show several */
    topPeople: AnalyticsPersonCountDto[];
};
export type AnalyticsPhotoFormatDto = {
    count: number;
    key: AnalyticsPhotoFormatDtoKey;
};
export type AnalyticsPunchcardCellDto = {
    count: number;
    /** Hour of the local capture time */
    hour: number;
    /** ISO weekday of the local capture time, 1 = Monday */
    weekday: number;
};
export type AnalyticsLargestFileDto = {
    /** Bytes */
    bytes: number;
    /** File name; null unless the owner reads their own scope */
    name: string | null;
};
export type AnalyticsLongestVideoDto = {
    durationMs: number;
    /** File name; null unless the owner reads their own scope */
    name: string | null;
};
export type AnalyticsOldestCaptureDto = {
    date: string;
    /** File name; null unless the owner reads their own scope */
    name: string | null;
};
export type AnalyticsRecordsDto = {
    largestFile: (AnalyticsLargestFileDto) | null;
    longestVideo: (AnalyticsLongestVideoDto) | null;
    oldestCapture: (AnalyticsOldestCaptureDto) | null;
    /** All videos together */
    videoDurationMs: number;
    /** videoDurationMs in hours, one decimal */
    videoHours: number;
};
export type AnalyticsVideoResolutionDto = {
    count: number;
    key: AnalyticsVideoResolutionDtoKey;
};
export type AnalyticsInsightsDto = {
    /** Items per local capture year, all time */
    capturesByYear: AnalyticsYearCountDto[];
    coverage: AnalyticsCoverageDto;
    /** Every bucket, in order; adds up to summary.items */
    focalLengths: AnalyticsFocalLengthDto[];
    /** Null when no video stream has been read, so HDR cannot be told */
    hdr: (AnalyticsHdrDto) | null;
    /** Items this session keeps hidden (Locked people and tags, sensitive content). They are left out of every breakdown here, which adds up to summary.items minus hiddenItems (summary.photos and summary.videos likewise) */
    hiddenItems: number;
    /** Items per lens model, then every other lens, then no lens */
    lenses: AnalyticsNamedCountDto[];
    /** Photos with a Live Photo motion part */
    livePhotos: number;
    /** Every bucket; adds up to summary.items. Panorama is 2:1 or wider */
    orientation: AnalyticsOrientationDto[];
    peopleAndPlaces: (AnalyticsPeopleAndPlacesDto) | null;
    /** Every format; adds up to summary.photos, and RAW equals summary.raw */
    photoFormats: AnalyticsPhotoFormatDto[];
    /** All 168 weekday and hour cells of the local capture time */
    punchcard: AnalyticsPunchcardCellDto[];
    records: AnalyticsRecordsDto;
    /** Every bucket; adds up to summary.videos */
    videoResolutions: AnalyticsVideoResolutionDto[];
};
export type AnalyticsMetadataDto = {
    field: AnalyticsMetadataField;
    missing: number;
    present: number;
    total: number;
};
export type AnalyticsProcessingDto = {
    attempts: number;
    /** Processing is recorded for the whole server only */
    available: boolean;
    completed: number;
    costedAttempts: number;
    durationMs: number;
    /** Estimate from configured hourly rates; never a bill. Null when no attempt had a rate */
    estimatedCostUsd: number | null;
    failed: number;
    /** Attempts without a configured rate; not included in the estimate */
    uncostedAttempts: number;
};
export type AnalyticsBucketDto = {
    /** Completed processing attempts; null when not available for this scope */
    completed: number | null;
    /** Failed processing attempts; null when not available for this scope */
    failed: number | null;
    "from": string;
    /** Library items at the last observation in this period; null when none */
    items: number | null;
    /** YYYY-MM for a month, the Monday for a week */
    key: string;
    /** Bytes */
    logicalBytes: number | null;
    /** When the growth values were read; null for a gap */
    observedAt: string | null;
    /** Cut short by the edge of the selected dates */
    partial: boolean;
    /** Photos added in this period and still in the library */
    photos: number;
    /** Bytes */
    physicalBytes: number | null;
    through: string;
    /** Videos added in this period and still in the library */
    videos: number;
};
export type AnalyticsSummaryDto = {
    /** Items sharing an original file with another item in this selection */
    duplicateReferences: number;
    /** Originals in external libraries, usually outside the library volume */
    externalLogicalBytes: number;
    /** Bytes */
    externalPhysicalBytes: number;
    /** Original files, Live Photo motion parts included */
    files: number;
    /** Photos and videos, Trash included, Locked media and Live Photo motion parts excluded */
    items: number;
    /** Every original reference, before physical deduplication */
    logicalBytes: number;
    photos: number;
    /** Original files, each shared file counted once within this selection */
    physicalBytes: number;
    /** RAW photos; a subset of photos */
    raw: number;
    /** logicalBytes minus physicalBytes of this same selection */
    savedBytes: number;
    /** Original files whose size has not been read; excluded from byte totals */
    unmeasuredFiles: number;
    /** Bytes */
    uploadedLogicalBytes: number;
    /** Bytes */
    uploadedPhysicalBytes: number;
    videos: number;
};
export type AnalyticsViewDto = {
    /** Also counted in another view */
    overlaps: boolean;
    photos: number;
    total: number;
    videos: number;
    view: AnalyticsView;
};
export type AnalyticsReportResponseDto = {
    albums: AnalyticsAlbumsDto;
    cameras: AnalyticsCameraDto[];
    days: AnalyticsDayDto[];
    definitions: AnalyticsSeriesDefinitionDto[];
    "from": string;
    generatedAt: string;
    history: AnalyticsHistoryDto;
    host: AnalyticsHostDto;
    /** Dashboard breakdowns of the same items as summary. People, places and file names are only for the owner reading their own scope */
    insights?: AnalyticsInsightsDto;
    metadata: AnalyticsMetadataDto[];
    processing: AnalyticsProcessingDto;
    range: AnalyticsRange;
    scope: string;
    scopeKind: AnalyticsScopeKind;
    /** Account or library name; empty for the whole server */
    scopeLabel: string;
    series: AnalyticsBucketDto[];
    summary: AnalyticsSummaryDto;
    through: string;
    views: AnalyticsViewDto[];
};
export type AnalyticsScopeOptionDto = {
    kind: AnalyticsScopeKind;
    /** Account or library name; empty for the whole server */
    label: string;
    libraryId: string | null;
    /** The account or library has been removed; its items may still count until deleted */
    removed: boolean;
    /** The account, or the library owner */
    userId: string | null;
    /** The value to pass as `scope` */
    value: string;
};
export type AnalyticsScopesResponseDto = {
    scopes: AnalyticsScopeOptionDto[];
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
export type ArchiveOperationResponseDto = {
    /** The durable bulk job that archives the frozen set */
    archiveJobId: string | null;
    /** Archived by this operation and not undone */
    archived: number;
    /** Changed after the archive, so Undo left them as they are */
    conflict: number;
    /** Assets frozen into this operation */
    count: number;
    createdAt: string;
    /** The operation was submitted or confirmed from the session asking, so it may offer its Undo */
    currentSession: boolean;
    /** When an unconfirmed prepared selection stops being confirmable */
    expiresAt: string | null;
    /** Archive operation ID */
    id: string;
    /** Not reached yet */
    pending: number;
    /** Counted and frozen, waiting for the owner to confirm; nothing has changed yet */
    prepared: boolean;
    /** The request key the operation was created with */
    requestKey: string;
    scope: ArchiveOperationScope;
    /** Left as they were: no longer in the Timeline, or stopped before they were reached */
    skipped: number;
    /** The durable bulk job that undoes it, once requested */
    undoJobId: string | null;
    /** Undo is available for this operation */
    undoable: boolean;
    /** Restored by Undo */
    undone: number;
};
export type ArchiveOperationCreateDto = {
    /** The selection, in order */
    assetIds: string[];
    /** Client idempotency key; the same key answers with the same operation instead of starting another */
    requestKey: string;
};
export type ArchiveOperationPrepareDto = {
    /** Client idempotency key; the same key answers with the same operation instead of starting another */
    requestKey: string;
    scope: ArchiveOperationPrepareScope;
};
export type ArchiveOperationConfirmDto = {
    /** The request key the selection was prepared with */
    requestKey: string;
};
export type ArchiveOperationUndoDto = {
    /** Client idempotency key; the same key answers with the same operation instead of starting another */
    requestKey: string;
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
    /** Latitude coordinate; null together with a null longitude removes the location */
    latitude?: number | null;
    /** Longitude coordinate; null together with a null latitude removes the location */
    longitude?: number | null;
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
    /** Video frame rate (frames per second) */
    fps?: number | null;
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
    /** The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW) */
    featuredAssetId?: string | null;
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
    /** City name; kept over reverse geocoding until the item is moved again */
    city?: string | null;
    /** Country name; kept over reverse geocoding until the item is moved again */
    country?: string | null;
    /** Original date and time */
    dateTimeOriginal?: string;
    /** Asset description */
    description?: string;
    /** Mark as favorite */
    isFavorite?: boolean;
    /** Latitude coordinate; null together with a null longitude removes the location */
    latitude?: number | null;
    /** Live photo video ID */
    livePhotoVideoId?: string | null;
    /** Longitude coordinate; null together with a null latitude removes the location */
    longitude?: number | null;
    /** Rating in range [1-5] (starred), -1 (rejected), or null (unrated) */
    rating?: number | null;
    /** State or region name; kept over reverse geocoding until the item is moved again */
    state?: string | null;
    visibility?: AssetVisibility;
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
export type AssetDevelopMaskAdjustments = {
    /** Black point inside the mask */
    blacks?: number;
    /** Contrast inside the mask */
    contrast?: number;
    /** Dehaze inside the mask */
    dehaze?: number;
    /** Exposure in EV inside the mask */
    exposure?: number;
    /** Highlights inside the mask */
    highlights?: number;
    /** Saturation inside the mask */
    saturation?: number;
    /** Shadows inside the mask */
    shadows?: number;
    /** White balance shift inside the mask */
    temperature?: number;
    /** Tint inside the mask */
    tint?: number;
    /** Vibrance inside the mask */
    vibrance?: number;
    /** White point inside the mask */
    whites?: number;
};
export type AssetDevelopMask = {
    adjustments?: AssetDevelopMaskAdjustments;
    /** How much of the adjustment is applied, as a percentage */
    amount?: number;
    /** A disabled mask is kept but not rendered */
    enabled?: boolean;
    /** Where a linear mask has faded out, across the frame */
    endX?: number;
    /** Where a linear mask has faded out, down the frame */
    endY?: number;
    /** Softness of a radial edge as a percentage of the radius */
    feather?: number;
    /** Client-chosen identifier, unique within the recipe */
    id: string;
    /** Apply the adjustment outside the shape instead of inside */
    invert?: boolean;
    kind: AssetDevelopMaskKind;
    /** Optional name shown in the editor */
    name?: string | null;
    /** Horizontal radius of a radial mask as a fraction of the frame width */
    radiusX?: number;
    /** Vertical radius of a radial mask as a fraction of the frame height */
    radiusY?: number;
    /** Centre (radial) or start (linear) across the oriented frame */
    x: number;
    /** Centre (radial) or start (linear) down the oriented frame */
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
    /** Selective adjustments, applied in order after the global develop */
    masks?: AssetDevelopMask[];
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
    version: Version;
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
    /** Render attempts so far; one automatic retry follows a first failure */
    attempts: number;
    /** When the version was saved */
    createdAt: string;
    /** Why the last render failed, when it did */
    error: string | null;
    /** The export of the original an imported version was developed from */
    exportId: string | null;
    /** Name of the imported file, for a version developed elsewhere */
    fileName: string | null;
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
    kind: AssetDevelopRevisionKind;
    /** Name given when the version was saved */
    label: string | null;
    /** Render progress as a percentage */
    progress: number;
    recipe: AssetDevelopRecipeDto;
    /** When the render finished */
    renderedAt: string | null;
    /** Identity of the renderer that produced the files, for lineage */
    rendererVersion: string | null;
    /** SHA-256 (hex) of the edited master file, once it exists */
    renditionChecksum: string | null;
    /** Per-asset sequence number, 1 for the first saved version */
    revision: number;
    /** Application an imported version was developed with, when known */
    software: string | null;
    /** SHA-256 (hex) of the original this version was rendered or developed from */
    sourceChecksum: string | null;
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
export type DevelopExportResponseDto = {
    /** Asset whose original was exported */
    assetId: string;
    /** When the original was exported */
    createdAt: string;
    /** File name of the exported original */
    fileName: string;
    /** Export ID; quote it when bringing the developed file back */
    id: string;
    /** False once the asset original no longer matches the exported bytes; a return is then refused */
    isCurrentOriginal: boolean;
    /** SHA-256 (hex) of the original when it was exported */
    sourceChecksum: string;
};
export type AssetDevelopImportDto = {
    /** The export this file was developed from */
    exportId?: string;
    /** The developed file: JPEG, PNG, TIFF, WebP or HEIF */
    file: Blob;
    /** Optional name for the new version */
    label?: string;
    /** SHA-256 (hex) of the file as the client sent it; a transfer that does not match is refused */
    renditionChecksum?: string;
    /** Application the file was developed with */
    software?: string;
    /** SHA-256 (hex) of the original the file was developed from */
    sourceChecksum?: string;
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
    mode?: VideoTrimMode;
    /** Trim start time in milliseconds */
    startMs: number;
};
export type StraightenParameters = {
    /** Straighten angle in degrees */
    angle: number;
    /** Scale the straightened picture to fill its frame (the Frameleaf quick editor). Absent or false keeps the earlier behaviour: black corners, no zoom */
    fill?: boolean;
};
export type AdjustParameters = {
    blackPoint?: number;
    blacks?: number;
    blueTone?: number;
    brightness?: number;
    clarity?: number;
    contrast?: number;
    dehaze?: number;
    /** Exposure in EV (develop model) */
    exposure?: number;
    grain?: number;
    hdr?: number;
    highlights?: number;
    model?: VideoAdjustModel;
    noiseReduction?: number;
    preset?: VideoDevelopPreset;
    /** Strength of the preset, 0 to 100 */
    presetStrength?: number;
    saturation?: number;
    shadows?: number;
    sharpen?: number;
    skinTone?: number;
    temperature?: number;
    tint?: number;
    vibrance?: number;
    vignette?: number;
    warmth?: number;
    whitePoint?: number;
    whites?: number;
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
export type StabilizeParameters = {
    /** Crop the corrected edges 4% and scale back (the Frameleaf quick editor). Absent or false keeps the earlier uncropped render */
    cropEdges?: boolean;
    enabled?: boolean;
};
export type TextOverlayParameters = {
    /** Text color in hex format */
    color?: string;
    /** Overlay end time in milliseconds */
    endMs?: number;
    position?: TextOverlayPosition;
    /** Draw a soft drop shadow behind the text */
    shadow?: boolean;
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
    /** Limit a gain above 1 so it cannot clip (the Frameleaf quick editor). Absent or false keeps the earlier unlimited gain */
    limit?: boolean;
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
export type AssetEditActionItemDto = {
    action: AssetEditAction;
    /** List of edit actions to apply */
    parameters: CropParameters | RotateParameters | MirrorParameters | TrimParameters | StraightenParameters | AdjustParameters | LookParameters | ToggleParameters | StabilizeParameters | TextOverlayParameters | AudioParameters | SpeedParameters;
};
export type VideoEditVersionResponseDto = {
    /** Asset ID */
    assetId: string;
    /** When the version was saved */
    createdAt: string;
    /** The recipe rendered from the original */
    edits: AssetEditActionItemDto[];
    /** Video edit version ID */
    id: string;
    /** Whether this version is the one currently published for playback */
    isCurrent: boolean;
    /** Whether this version is the latest requested save or revert */
    isRequested: boolean;
    purpose: VideoEditVersionPurpose;
    status: VideoEditVersionStatus;
};
export type VideoEditExportDto = {
    profile: VideoEditExportProfile;
};
export type AssetEditActionItemResponseDto = {
    action: AssetEditAction;
    /** Asset edit ID */
    id: string;
    /** List of edit actions to apply */
    parameters: CropParameters | RotateParameters | MirrorParameters | TrimParameters | StraightenParameters | AdjustParameters | LookParameters | ToggleParameters | StabilizeParameters | TextOverlayParameters | AudioParameters | SpeedParameters;
};
export type AssetEditsOriginalVideoDto = {
    /** FL-113: what an edited version does with the original's colour. 'tone-map': an HDR original is rendered to SDR and kept as the reference; 'unsupported': this server cannot render an edited version (Dolby Vision profile 5), so saving is refused and the original stays unchanged */
    colorPolicy?: AssetEditsColorPolicy;
    /** Why, in plain words, for the person editing */
    colorReason?: string;
    /** Duration of the original in milliseconds */
    durationMs: number;
    /** Displayed height of the original, after its rotation */
    height: number;
    /** Displayed width of the original, after its rotation */
    width: number;
};
export type AssetEditsResponseDto = {
    /** Asset ID these edits belong to */
    assetId: string;
    /** List of edit actions applied to the asset */
    edits: AssetEditActionItemResponseDto[];
    /** Original video display raster and timeline, independent of the current edited version */
    originalVideo?: AssetEditsOriginalVideoDto;
};
export type AssetEditsCreateDto = {
    /** List of edit actions to apply */
    edits: AssetEditActionItemDto[];
};
export type AssetEditKeyframesResponseDto = {
    /** Times of the original's video keyframes in milliseconds from its start, ascending. A fast trim starts at the last one at or before its in point. */
    keyframesMs: number[];
};
export type ImageDescriptionEnrichmentResponseDto = {
    appliedDescription: boolean;
    appliedTags: boolean;
    /** The model's confidence in the description, 0 to 1, when the processing destination reported one; null otherwise */
    confidence?: number | null;
    context?: string;
    description?: string;
    /** The processing destination that generated the description */
    destinationId?: string;
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
    /** Set when the generated description is out of date: the original was replaced, confirmed names changed, or the saved prompt changed */
    staleReason?: EnrichmentStaleReason;
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
export type AssetRestorationSelectDto = {
    /** Restored revision to use as the playback version; omitted, the original is used */
    restorationId?: string;
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
    /** Persist authentication cookies across browser sessions (default true) */
    rememberMe?: boolean;
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
export type ClassificationTagDto = {
    id: string;
    name: string;
};
export type ClassificationContributionDto = {
    albumId: string;
    albumName: string;
    /** True when this rule archived the item */
    archived: boolean;
    decision: ClassificationMatchDecision;
    ruleId: string;
    score: number | null;
    /** The tag this rule added, when it added one */
    tag: (ClassificationTagDto) | null;
};
export type ClassificationPreviewDto = {
    mediaType?: ClassificationMediaType;
    /** Match any of these people */
    personIds?: string[];
    /** How many of the newest items a visual preview reads */
    sampleSize?: number;
    /** Match any of these tags, or a tag beneath one of them */
    tagIds?: string[];
    /** Taken on or after this day (YYYY-MM-DD) */
    takenAfter?: string | null;
    /** Taken on or before this day (YYYY-MM-DD) */
    takenBefore?: string | null;
    /** The confidence a visual phrase has to reach */
    threshold?: number;
    /** Visual category phrases compared with each item */
    visualQueries?: string[];
};
export type ClassificationScoredAssetDto = {
    assetId: string;
    score: number | null;
};
export type ClassificationPreviewResponseDto = {
    /** True when `matched` counts the whole library, false for a bounded sample */
    exact: boolean;
    /** The first matches, best first */
    items: ClassificationScoredAssetDto[];
    /** Items that match among those read */
    matched: number;
    /** Items read: the whole library when exact, otherwise the newest items */
    sampled: number;
    /** False when visual phrases cannot be compared right now */
    visualSearchAvailable: boolean;
};
export type ClassificationRuleCountsDto = {
    accepted: number;
    matched: number;
    rejected: number;
    suggested: number;
};
export type ClassificationRuleResponseDto = {
    action: ClassificationRuleAction;
    albumId: string;
    albumName: string;
    archive: boolean;
    archiveConsentAt: string | null;
    counts: ClassificationRuleCountsDto;
    createdAt: string;
    enabled: boolean;
    id: string;
    lastAppliedAt: string | null;
    mediaType: ClassificationMediaType;
    /** Match any of these people */
    personIds: string[];
    tag: (ClassificationTagDto) | null;
    /** Match any of these tags, or a tag beneath one of them */
    tagIds: string[];
    /** Taken on or after this day (YYYY-MM-DD) */
    takenAfter: string | null;
    /** Taken on or before this day (YYYY-MM-DD) */
    takenBefore: string | null;
    /** The confidence a visual phrase has to reach */
    threshold: number;
    updatedAt: string;
    /** Visual category phrases compared with each item */
    visualQueries: string[];
};
export type ClassificationRuleCreateDto = {
    /** Defaults to the server default rule action */
    action?: ClassificationRuleAction;
    /** Name of the smart album */
    albumName: string;
    /** Archive matches; requires archiveConsent */
    archive?: boolean;
    /** The owner explicitly agrees that matches are archived */
    archiveConsent?: boolean;
    /** Description of the smart album */
    description?: string | null;
    enabled?: boolean;
    /** Icon of the smart album */
    icon?: string;
    mediaType?: ClassificationMediaType;
    /** Collection to create the smart album inside */
    parentId?: string;
    /** Match any of these people */
    personIds?: string[];
    /** Match any of these tags, or a tag beneath one of them */
    tagIds?: string[];
    /** The rule-owned tag a match receives; null tags nothing */
    tagName?: string | null;
    /** Taken on or after this day (YYYY-MM-DD) */
    takenAfter?: string | null;
    /** Taken on or before this day (YYYY-MM-DD) */
    takenBefore?: string | null;
    /** The confidence a visual phrase has to reach */
    threshold?: number;
    /** Visual category phrases compared with each item */
    visualQueries?: string[];
};
export type ClassificationRuleUpdateDto = {
    action?: ClassificationRuleAction;
    /** Archive matches; turning it on requires archiveConsent */
    archive?: boolean;
    /** The owner explicitly agrees that matches are archived */
    archiveConsent?: boolean;
    /** A disabled rule keeps what it applied and stops changing anything */
    enabled?: boolean;
    mediaType?: ClassificationMediaType;
    /** Match any of these people */
    personIds?: string[];
    /** Match any of these tags, or a tag beneath one of them */
    tagIds?: string[];
    /** The rule-owned tag a match receives; null tags nothing */
    tagName?: string | null;
    /** Taken on or after this day (YYYY-MM-DD) */
    takenAfter?: string | null;
    /** Taken on or before this day (YYYY-MM-DD) */
    takenBefore?: string | null;
    /** The confidence a visual phrase has to reach */
    threshold?: number;
    /** Visual category phrases compared with each item */
    visualQueries?: string[];
};
export type ClassificationApplyDto = {
    /** Items from the plan; empty records the check when nothing changed */
    assetIds: string[];
};
export type ClassificationApplyResponseDto = {
    added: number;
    lastAppliedAt: string;
    removed: number;
    suggested: number;
    unchanged: number;
};
export type ClassificationDecisionDto = {
    assetIds: string[];
    decision: ClassificationReviewDecision;
};
export type ClassificationDecisionResponseDto = {
    skipped: number;
    updated: number;
};
export type ClassificationMatchDto = {
    archiveContributed: boolean;
    assetId: string;
    decision: ClassificationMatchDecision;
    score: number | null;
    tagContributed: boolean;
    updatedAt: string;
};
export type ClassificationMatchPageDto = {
    items: ClassificationMatchDto[];
    nextPage: number | null;
    total: number;
};
export type ClassificationPlanResponseDto = {
    /** Items that would be added or suggested */
    added: number;
    /** Every item applying would change, for the apply call or a bulk job */
    assetIds: string[];
    /** True when applying must run as a durable bulk job */
    durable: boolean;
    /** The first items that would be added */
    items: ClassificationScoredAssetDto[];
    /** Items the rule matches now */
    matched: number;
    /** Items the rule applied that no longer match */
    removed: number;
    /** True when there were more changes than one apply can carry */
    truncated: boolean;
    visualSearchAvailable: boolean;
};
export type ClassificationSettingsDto = {
    defaultAction: ClassificationRuleAction;
    /** Changes above this many run as a durable bulk job */
    inlineLimit: number;
    /** Whether rules may use visual category phrases */
    visualCategories: boolean;
    /** Whether visual phrases can be compared right now */
    visualSearchAvailable: boolean;
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
export type UserConfigFrameleafSignInDto = {
    /** Sign in with Frameleaf button text */
    buttonText: string;
    /** Show Sign in with Frameleaf on the local sign-in page too */
    showOnLocalLogin: boolean;
};
export type UserConfigFrameleafCloudDto = {
    signIn: UserConfigFrameleafSignInDto;
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
export type UserConfigImageDescriptionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
};
export type UserConfigNsfwDetectionDto = {
    /** Whether the task is enabled */
    enabled: boolean;
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
    imageDescription: UserConfigImageDescriptionDto;
    nsfwDetection: UserConfigNsfwDetectionDto;
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
    /** Server name shown in settings; empty uses the host name */
    name: string;
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
    frameleafCloud: UserConfigFrameleafCloudDto;
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
export type DevelopPresetSettingsDto = {
    /** Black point */
    blacks?: number;
    /** Local contrast in the midtones */
    clarity?: number;
    /** Contrast around middle grey */
    contrast?: number;
    /** Haze removal (positive) or addition (negative) */
    dehaze?: number;
    /** Exposure in EV; each whole stop doubles the light */
    exposure?: number;
    /** Film grain amount */
    grain?: number;
    /** Highlight recovery (negative) or lift (positive) */
    highlights?: number;
    /** Selective adjustments, applied in order after the global develop */
    masks?: AssetDevelopMask[];
    /** Luminance noise reduction amount */
    noiseReduction?: number;
    preset?: AssetDevelopPreset;
    /** How much of the preset is applied, as a percentage */
    presetStrength?: number;
    /** Global saturation */
    saturation?: number;
    /** Shadow lift (positive) or deepening (negative) */
    shadows?: number;
    /** Detail sharpening amount */
    sharpen?: number;
    /** Warm (positive) or cool (negative) white balance shift */
    temperature?: number;
    /** Magenta (positive) or green (negative) tint */
    tint?: number;
    /** Saturation weighted towards muted colours */
    vibrance?: number;
    /** Darkened (positive) or lightened (negative) edges */
    vignette?: number;
    /** White point */
    whites?: number;
};
export type DevelopPresetResponseDto = {
    /** When the preset was saved */
    createdAt: string;
    /** Preset ID */
    id: string;
    /** Preset name */
    name: string;
    settings: DevelopPresetSettingsDto;
    /** When the preset last changed */
    updatedAt: string;
};
export type DevelopPresetCreateDto = {
    /** Name shown in the presets list; unique per account */
    name: string;
    settings: DevelopPresetSettingsDto;
};
export type DevelopPresetUpdateDto = {
    /** Name shown in the presets list; unique per account */
    name?: string;
    /** Replaces every stored setting of the preset */
    settings?: DevelopPresetSettingsDto;
};
export type DocumentSearchResponseDto = {
    items: AssetResponseDto[];
    nextPage: string | null;
    total: number;
};
export type DocumentRegionDto = {
    /** Normalized x coordinate of corner 1 (0-1) */
    x1: number;
    /** Normalized x coordinate of corner 2 (0-1) */
    x2: number;
    /** Normalized x coordinate of corner 3 (0-1) */
    x3: number;
    /** Normalized x coordinate of corner 4 (0-1) */
    x4: number;
    /** Normalized y coordinate of corner 1 (0-1) */
    y1: number;
    /** Normalized y coordinate of corner 2 (0-1) */
    y2: number;
    /** Normalized y coordinate of corner 3 (0-1) */
    y3: number;
    /** Normalized y coordinate of corner 4 (0-1) */
    y4: number;
};
export type DocumentFieldCandidateDto = {
    /** Recognition confidence of that line; null for a corrected line */
    confidence: number | null;
    /** Recognized line the value was read from */
    lineId: string;
    region: DocumentRegionDto;
    /** The value as the text reads it */
    value: string;
};
export type DocumentFieldResponseDto = {
    /** Values the text suggests, most likely first */
    candidates: DocumentFieldCandidateDto[];
    /** Recognition confidence of the supporting line (0-1) */
    confidence: number | null;
    /** ID of the owner’s decision about this field */
    editId: string | null;
    /** The supporting text has since been read differently or is gone */
    evidenceChanged: boolean;
    field: DocumentField;
    /** Recognized line supporting the value */
    lineId: string | null;
    region: (DocumentRegionDto) | null;
    /** Revision of the owner’s decision */
    revision: number | null;
    status: DocumentFieldStatus;
    /** When the owner last decided */
    updatedAt: string | null;
    /** The suggested, confirmed or corrected value; null when dismissed */
    value: string | null;
};
export type DocumentLineDto = {
    /** Recognition confidence (0-1) */
    confidence: number | null;
    /** ID of the owner’s decision about this line */
    editId: string | null;
    /** The decision was made against text that has since been read differently */
    evidenceChanged: boolean;
    /** Recognized line ID, or the decision ID of a kept correction */
    id: string;
    /** Recognized line ID; null once the line is gone */
    ocrId: string | null;
    /** The recognized text, while the recognized line exists */
    recognizedText: string | null;
    region: (DocumentRegionDto) | null;
    /** Revision of the owner’s decision */
    revision: number | null;
    status: DocumentLineStatus;
    /** What the line reads: the owner’s correction or the recognized text */
    text: string;
};
export type DocumentRecognitionDto = {
    /** Text recognition is switched on */
    enabled: boolean;
    /** A processing destination is chosen for text recognition */
    routed: boolean;
};
export type DocumentResponseDto = {
    assetId: string;
    /** The caller owns the photo and may correct its text */
    canEdit: boolean;
    fields: DocumentFieldResponseDto[];
    /** Field suggestions are switched on */
    fieldsEnabled: boolean;
    lines: DocumentLineDto[];
    /** Whether the photo can be read again; owner only */
    recognition: (DocumentRecognitionDto) | null;
    /** When the text was last read */
    recognizedAt: string | null;
};
export type DocumentFieldEditDto = {
    action: DocumentEditAction;
    /** Recognized line supporting the value */
    lineId?: string | null;
    /** The recognized text of that line the caller read */
    recognizedText?: string;
    /** Revision of the existing decision, if there is one */
    revision?: number | null;
    /** The value, for confirm and correct */
    value?: string;
};
export type DocumentLineEditDto = {
    action: DocumentEditAction;
    /** Recognized line the decision is about */
    ocrId: string;
    /** The recognized text the caller read; refused when it changed */
    recognizedText: string;
    /** Revision of the existing decision, if there is one */
    revision?: number | null;
    /** The corrected text, for correct */
    value?: string;
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
export type DuplicateActiveGroupDto = {
    duplicateId: string;
    memberIds: string[];
};
export type DuplicateActiveOperationDto = {
    action: MediaOperationBulkAction;
    groups: DuplicateActiveGroupDto[];
    operationId: string;
};
export type DuplicateDecisionGroupDto = {
    applied: boolean;
    decision: DuplicateDecisionKind;
    decisionId: string;
    duplicateId: string;
    keepAssetIds: string[];
    memberIds: string[];
    trashAssetIds: string[];
    /** An undo job has started on this decision */
    undoing: boolean;
    undone: boolean;
};
export type DuplicateDecisionBatchDto = {
    createdAt: string;
    groups: DuplicateDecisionGroupDto[];
    /** The durable job that applied these decisions */
    operationId: string;
    /** Every decision of the job is applied and none has been undone */
    undoable: boolean;
};
export type DuplicateDecisionHistoryDto = {
    /** Decision and undo jobs still running */
    active: DuplicateActiveOperationDto[];
    /** The most recent decision jobs, newest first */
    recent: DuplicateDecisionBatchDto[];
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
export type DuplicateReviewQualityDto = {
    assetId: string;
    /** Evidence for or against keeping this copy */
    reasons: DuplicateQualityReason[];
};
export type DuplicateReviewGroupDto = {
    /** The photos of the group this session may see */
    assets: AssetResponseDto[];
    blockedReason: (DuplicateGroupBlock) | null;
    /** Duplicate group ID */
    duplicateId: string;
    /** Whether this session may decide the group */
    editable: boolean;
    /** Photos of the group this session does not see */
    hiddenMemberCount: number;
    kind: DuplicateGroupKind;
    qualities: DuplicateReviewQualityDto[];
    /** The suggested keeper, from resolution, format and original provenance. Never set for a burst */
    suggestedKeepAssetIds: string[];
    /** Size of the originals shown, in bytes */
    totalBytes: number;
};
export type VideoMomentSearchHitDto = {
    assetId: string;
    caption: string | null;
    frameId: string | null;
    match: VideoMomentMatch;
    momentId: string | null;
    /** Higher is closer */
    score: number;
    timestampMs: number;
};
export type VideoMomentSearchResponseDto = {
    hits: VideoMomentSearchHitDto[];
};
export type VideoMomentSearchDto = {
    limit?: number;
    query: string;
};
export type EnrichmentDestinationAdmissionDto = {
    admitted: boolean;
    /** Stable refusal code when it would not */
    refusal: string | null;
};
export type EnrichmentDestinationOptionDto = {
    /** Sends media off this network; needs recorded consent */
    cloud: boolean;
    enrichment: EnrichmentDestinationAdmissionDto;
    health: MlDestinationHealth;
    id: string;
    kind: MlDestinationKind;
    name: string;
    search: EnrichmentDestinationAdmissionDto;
};
export type EnrichmentOptionsResponseDto = {
    /** Stages a new plan starts with; never moment captions */
    defaultStages: EnrichmentStage[];
    descriptionEnabled: boolean;
    destinations: EnrichmentDestinationOptionDto[];
    framesPerVideo: number;
    lockedCheckEnabled: boolean;
    maxAssets: number;
    maxSamples: number;
    /** Saved description model */
    modelName: string;
    /** The destinations library work is routed to; a plan uses these unless another is chosen */
    routes: {
        enrichment: string | null;
        search: string | null;
    };
    searchEnabled: boolean;
    /** Saved search model */
    searchModelName: string;
};
export type EnrichmentPlanCreateDto = {
    /** The frozen set, in order; never re-resolved */
    assetIds: string[];
    /** Destination for descriptions, checks and captions */
    destinationId?: string;
    /** Client idempotency key; submitting the same key again returns the existing plan */
    requestKey?: string;
    /** Destination for search embeddings */
    searchDestinationId?: string;
    /** Chosen stages; the ones they need are added */
    stages: EnrichmentStage[];
};
export type EnrichmentPlanCountsDto = {
    cancelled: number;
    completed: number;
    failed: number;
    queued: number;
    running: number;
    skipped: number;
    total: number;
};
export type EnrichmentPlanDestinationDto = {
    cloud: boolean;
    id: string;
    name: string;
};
export type EnrichmentPlanStageOutcomeDto = {
    at: string | null;
    message: string | null;
    reasonKey: string | null;
    stage: EnrichmentStage;
    state: EnrichmentItemState;
};
export type EnrichmentPlanItemDto = {
    assetId: string;
    /** Waiting for its one automatic retry */
    retryPending: boolean;
    stages: EnrichmentPlanStageOutcomeDto[];
    state: EnrichmentItemState;
};
export type EnrichmentPlanResponseDto = {
    /** Stages run only because a chosen stage needs them */
    addedStages: EnrichmentStage[];
    configHash: string;
    counts: EnrichmentPlanCountsDto;
    enrichmentDestination: (EnrichmentPlanDestinationDto) | null;
    /** Locked items not listed because this session is not unlocked */
    hiddenCount: number;
    items: EnrichmentPlanItemDto[];
    modelName: string;
    operation: MediaOperationDto;
    requestedStages: EnrichmentStage[];
    searchDestination: (EnrichmentPlanDestinationDto) | null;
    searchModelName: string;
    stages: EnrichmentStage[];
};
export type EnrichmentPreviewRequestDto = {
    /** Samples to describe; run one at a time */
    assetIds: string[];
    /** Destination to run on; the routed one when omitted */
    destinationId?: string;
    fallbackModelName?: string;
    /** Draft model; the saved one when omitted */
    modelName?: string;
    /** Draft prompt; the saved one when omitted */
    prompt?: AdminConfigImageDescriptionPromptDto;
};
export type EnrichmentPreviewSampleDto = {
    ambiguousReferences: string[];
    assetId: string;
    /** What the draft produced; stored nowhere */
    candidate: string | null;
    /** The stored generated description, unchanged */
    current: string | null;
    durationMs: number;
    /** Video frames the draft saw; 0 for a photo */
    frameCount: number;
    hallucinatedNames: string[];
    message: string | null;
    reasonKey: string | null;
    status: EnrichmentPreviewStatus;
    tags: string[];
    warnings: string[];
};
export type EnrichmentPreviewResponseDto = {
    cloud: boolean;
    destinationId: string;
    destinationName: string;
    modelName: string;
    samples: EnrichmentPreviewSampleDto[];
};
export type VideoMomentCoverDto = {
    /** Time of the chosen frame; null returns to the best frame */
    timestampMs: number | null;
};
export type VideoMomentFrameDto = {
    frameIndex: number;
    height: number | null;
    id: string;
    /** Has a search embedding from the saved search model */
    indexed: boolean;
    isCover: boolean;
    /** 1 is the best frame */
    rank: number;
    score: number;
    timestampMs: number;
    width: number | null;
};
export type VideoMomentDto = {
    caption: string | null;
    createdAt: string;
    endMs: number | null;
    frameId: string | null;
    id: string;
    source: VideoMomentSource;
    staleReason: (EnrichmentStaleReason) | null;
    timestampMs: number;
    /** Typed by the owner; never generated */
    transcript: string | null;
    updatedAt: string;
};
export type VideoMomentsResponseDto = {
    assetId: string;
    captionModel: string | null;
    captionedAt: string | null;
    coverFrameId: string | null;
    /** The owner's chosen cover time; null means the best frame */
    coverTimestampMs: number | null;
    embeddingModel: string | null;
    extractorVersion: string | null;
    frames: VideoMomentFrameDto[];
    framesExtractedAt: string | null;
    indexedAt: string | null;
    moments: VideoMomentDto[];
    staleReason: (EnrichmentStaleReason) | null;
    state: VideoMomentIndexState;
};
export type VideoMomentCreateDto = {
    caption?: string | null;
    endMs?: number | null;
    timestampMs: number;
    transcript?: string | null;
};
export type VideoMomentUpdateDto = {
    caption?: string | null;
    endMs?: number | null;
    timestampMs?: number;
    transcript?: string | null;
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
    /** When a person last corrected this face (moved, resized, reassigned or unassigned it), or null */
    correctedAt: string | null;
    /** When the owner hid this face, or null. Hidden faces are only listed with withHidden */
    hiddenAt: string | null;
    /** Face ID */
    id: string;
    /** Image height in pixels */
    imageHeight: number;
    /** Image width in pixels */
    imageWidth: number;
    person: (PersonResponseDto) | null;
    /** Changes whenever this face changes; send it back as expectedRevision so a correction made against an older face is refused with 409 */
    revision: string;
    sourceType?: SourceType;
};
export type AssetFaceCreateDto = {
    /** Asset ID */
    assetId: string;
    /** The face source revision (GET /faces/source) the coordinates were drawn on. When the image, its orientation or its edits changed since, the request is refused with 409 */
    expectedSourceRevision?: string;
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
export type AssetFaceSourceResponseDto = {
    /** Asset ID */
    assetId: string;
    /** Changes when the image, its orientation or its edits change; send it back as expectedSourceRevision */
    revision: string;
};
export type AssetFaceDeleteDto = {
    /** The face revision the deletion was decided on; a different current revision is refused with 409 */
    expectedRevision?: string;
    /** Force delete even if person has other faces */
    force: boolean;
};
export type AssetFaceBoxDto = {
    /** Face bounding box height */
    height: number;
    /** Height in pixels of the image the box was drawn on */
    imageHeight: number;
    /** Width in pixels of the image the box was drawn on */
    imageWidth: number;
    /** Face bounding box width */
    width: number;
    /** Face bounding box X coordinate */
    x: number;
    /** Face bounding box Y coordinate */
    y: number;
};
export type AssetFaceCorrectionDto = {
    /** Move or resize the face, in the displayed (edited) image */
    box?: AssetFaceBoxDto;
    /** The person the face was assigned to when the correction was made (null when unassigned) */
    expectedPersonId?: string | null;
    /** The face revision this correction was made against; a different current revision is refused with 409 */
    expectedRevision: string;
    /** The face source revision (GET /faces/source) the coordinates were drawn on. When the image, its orientation or its edits changed since, the request is refused with 409 */
    expectedSourceRevision?: string;
    /** Hide the face, or show a hidden face again */
    hidden?: boolean;
    /** Assign the face to this person, or null to unassign it */
    personId?: string | null;
};
export type FaceDto = {
    /** Face ID */
    id: string;
};
export type ICloudSyncRunDto = {
    createdAt: string;
    /** Stable failure code, translated by the client */
    errorCode: string | null;
    finishedAt: string | null;
    /** Media operation ID of the run */
    id: string;
    /** A pause was asked for and the worker has not reached it yet */
    pauseRequested: boolean;
    /** Resources settled so far */
    processedUnits: number;
    /** 0 to 100, from resources settled out of those known so far */
    progress: number;
    /** Back in the queue for its automatic retry after a failure */
    retrying: boolean;
    startedAt: string | null;
    status: MediaOperationStatus;
    /** Resources known so far; null until the inventory is counted */
    totalUnits: number | null;
    /** Handed back to wait for the provider or a backed-off item */
    waiting: boolean;
};
export type ICloudConnectionResponseDto = {
    /** Whether an encrypted Apple session is stored; the session is never returned */
    authenticated: boolean;
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
    /** The current or most recent sync run */
    run: (ICloudSyncRunDto) | null;
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
        area: ICloudLibraryArea;
        id: string;
        name: string;
        supported: boolean;
    }[];
    recent?: {
        assetId: string;
        fileName: string;
        outcome: string;
        resourceId: string;
    }[];
    /** Reconciliation findings; private items only for an unlocked session */
    review: {
        assetId: string | null;
        fileName: string | null;
        kind: ICloudReviewKind;
        reason: string | null;
        resourceId: string;
        role: string;
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
    petRecognition: QueueResponseLegacyDto;
    search: QueueResponseLegacyDto;
    sidecar: QueueResponseLegacyDto;
    smartSearch: QueueResponseLegacyDto;
    storageTemplateMigration: QueueResponseLegacyDto;
    thumbnailGeneration: QueueResponseLegacyDto;
    videoConversion: QueueResponseLegacyDto;
    videoDuplicateDetection: QueueResponseLegacyDto;
    workflow: QueueResponseLegacyDto;
};
export type JobCreateDto = {
    name: ManualJobName;
};
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
export type QueueCommandDto = {
    command: QueueCommand;
    /** Force the command execution (if applicable) */
    force?: boolean;
};
export type LibraryScanResponseDto = {
    /** New items indexed */
    added: number;
    /** Indexed items checked against their folder */
    checked: number;
    /** When the scan was asked for */
    createdAt: string;
    /** Failure detail for the administrator */
    error: string | null;
    /** Stable failure code */
    errorCode: string | null;
    /** When the scan ended */
    finishedAt: string | null;
    /** Items whose file is missing, marked offline */
    offlined: number;
    /** Offline items whose file is back */
    onlined: number;
    /** The scan job, a media operation of kind library_scan */
    operationId: string;
    /** A pause was asked for and the scan has not reached it yet */
    pauseRequested: boolean;
    phase: LibraryScanPhase;
    /** Files and items handled so far */
    processedUnits: number;
    /** Progress, 0 to 100 */
    progress: number;
    /** The scan failed once and waits for its automatic retry */
    retrying: boolean;
    /** When the scan first started */
    startedAt: string | null;
    status: MediaOperationStatus;
    stopReason: (LibraryScanStopReason) | null;
    /** Files and items known so far; grows while the folders are read */
    totalUnits: number;
    /** Items whose file changed and are read again */
    updated: number;
};
export type LibraryResponseDto = {
    /** Number of assets */
    assetCount: number;
    /** Creation date */
    createdAt: string;
    /** When removal was confirmed; set while removal is in progress */
    deletedAt: string | null;
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
    /** The latest scan, or null if the library was never scanned */
    scan: (LibraryScanResponseDto) | null;
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
    /** Owner user ID. Fixed once the library exists. */
    ownerId: string;
};
export type ManagedUploadsStatsResponseDto = {
    /** Account whose uploads these are */
    ownerId: string;
    /** Number of photos */
    photos: number;
    /** Total number of assets */
    total: number;
    /** Storage usage in bytes */
    usage: number;
    /** Storage usage in bytes, counting each distinct original file once */
    usagePhysical: number;
    /** Number of videos */
    videos: number;
};
export type UpdateLibraryDto = {
    /** Exclusion patterns (max 128) */
    exclusionPatterns?: string[];
    /** Import paths (max 128) */
    importPaths?: string[];
    /** Library name */
    name?: string;
};
export type LibraryRemovalReviewDto = {
    /** Albums that lose items */
    albums: number;
    /** Detected faces that will be removed with their items */
    faces: number;
    /** Library ID */
    libraryId: string;
    /** Library name, to be typed to confirm */
    name: string;
    /** Items already offline */
    offline: number;
    /** Source files in the import folders are never deleted */
    originalsKept: boolean;
    /** Owner user ID */
    ownerId: string;
    /** Indexed photos that will be removed */
    photos: number;
    /** Present this to confirm the removal */
    reviewToken: string;
    /** A scan is running and will be stopped */
    scanActive: boolean;
    /** Shared links that lose items */
    sharedLinks: number;
    /** Indexed items that will be removed */
    total: number;
    /** Original bytes those items reference */
    usage: number;
    /** Indexed videos that will be removed */
    videos: number;
};
export type LibraryRemovalDto = {
    /** The library name, typed to confirm */
    confirmName: string;
    /** The token from the removal review */
    reviewToken: string;
};
export type LibraryStatsResponseDto = {
    /** Number of photos */
    photos: number;
    /** Total number of assets */
    total: number;
    /** Storage usage in bytes */
    usage: number;
    /** Storage usage in bytes, counting each distinct original file once */
    usagePhysical: number;
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
    reason: LibraryImportPathReason;
};
export type ValidateLibraryResponseDto = {
    /** Validation results for import paths */
    importPaths?: ValidateLibraryImportPathResponseDto[];
};
export type LicenseProductDto = {
    id: string;
    kind: Kind3;
    period: Period;
    priceUsd: number;
    /** Where to buy it; null when no store is configured */
    storeUrl: string | null;
};
export type LicenseProductsResponseDto = {
    /** Cloud backup a plan includes, and the blocks and monthly rate for more */
    backup: {
        blockTb: number;
        includedTb: number;
        usdPerTbMonth: number;
    };
    /** AI credit top-ups the store accepts; credit is never discounted */
    credit: {
        maximumUsd: number;
        minimumUsd: number;
    };
    currency: Currency;
    /** Share taken off plans on a licensed server: what Frameleaf Cloud last published, else the bundled share. Never AI credit or extra backup */
    licensedDiscount: number;
    /** Version of the plan prices in force: published by Frameleaf Cloud, else the bundled snapshot */
    pricesVersion: string;
    products: LicenseProductDto[];
    /** The store this server was deployed with; null when there is none */
    storeUrl: string | null;
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
    /** Library care suggests Live Photo pairs; when false no pairs are looked for */
    suggestionsEnabled: boolean;
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
export type MapStatisticsResponseDto = {
    /** The viewer's own located archived items */
    archived: number;
    /** Located timeline items of partners who share their locations with the viewer */
    partner: number;
    /** The viewer's own timeline items without a location */
    unlocated: number;
};
export type MediaHealthChecksumDto = {
    algorithm: MediaHealthChecksumAlgorithm;
    /** Checksum as lowercase hex */
    value: string;
};
export type MediaHealthCandidateDto = {
    /** Candidate file path */
    candidatePath: string;
    checkedAt: string;
    /** The candidate has exactly the checksum recorded for the original */
    checksumMatch: boolean;
    /** The checksums the candidate matched, as measured */
    checksums: MediaHealthChecksumDto[];
    /** The reviewer chose this candidate for the finding */
    chosen: boolean;
    /** The candidate decoded successfully; null when not checked */
    decodeValid: boolean | null;
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
    /** Search location the candidate was found in */
    rootId: string | null;
    rootKind: (MediaHealthRootKind) | null;
    status: MediaHealthStatus;
    /** Visual match score from 0 to 1 */
    visualMatchScore: number | null;
};
export type MediaHealthProvenanceDto = {
    action: MediaHealthProvenanceAction;
    /** When it was done */
    at: string | null;
    /** The path the original had before */
    previousPath: string | null;
    /** Search location the copy came from */
    rootId: string | null;
    rootKind: (MediaHealthRootKind) | null;
    /** Name of the search location */
    rootLabel: string | null;
    /** The verified copy that was used */
    sourcePath: string | null;
    /** The account that did it */
    userId: string | null;
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
    /** The checksums recorded for the original, which a copy must match exactly */
    expectedChecksums: MediaHealthChecksumDto[];
    /** Media health finding ID */
    id: string;
    /** Original media filename */
    originalFileName: string;
    /** Original media path */
    originalPath: string;
    provenance: (MediaHealthProvenanceDto) | null;
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
export type MediaHealthCandidateChoiceDto = {
    /** Candidate ID */
    candidateId: string;
    /** Media health finding ID */
    findingId: string;
};
export type MediaHealthChooseCandidatesDto = {
    choices: MediaHealthCandidateChoiceDto[];
};
export type MediaHealthBulkResultDto = {
    error?: string;
    id: string;
    status?: MediaHealthStatus;
    success: boolean;
};
export type MediaHealthBulkResponseDto = {
    /** The durable job applying the accepted findings, in Activity; null when none was accepted */
    operationId?: string | null;
    results: MediaHealthBulkResultDto[];
};
export type MediaHealthDeleteCorruptDto = {
    /** Typed confirmation text */
    confirmText: string;
    /** Media health finding IDs */
    ids: string[];
};
export type MediaHealthRecoverDto = {
    choices: MediaHealthCandidateChoiceDto[];
    /** Must be true: the reviewer checked the checksum and decode evidence and keeps the damaged source */
    confirmed: boolean;
};
export type MediaHealthScanResponseDto = {
    /** The durable job doing the work, in Activity */
    operationId?: string | null;
    runId: string;
};
export type MediaHealthBulkActionDto = {
    /** Media health finding IDs */
    ids: string[];
};
export type MediaHealthLocateDto = {
    /** Media health finding IDs */
    ids: string[];
    /** Search locations; library storage and external libraries when omitted */
    rootIds?: string[];
};
export type MediaHealthRootDto = {
    /** Search location ID */
    id: string;
    kind: MediaHealthRootKind;
    label: string;
    /** Folders searched, for review */
    paths: string[];
};
export type MediaHealthRootsResponseDto = {
    roots: MediaHealthRootDto[];
};
export type MediaHealthCareSettingsDto = {
    /** Health scans verify original checksums */
    checksumScan: boolean;
    /** Near-duplicates are grouped for review */
    duplicateReview: boolean;
    /** Incremental health scans run on a schedule */
    healthScan: boolean;
    /** Database and file reference audits run on their schedules */
    integrityAudit: boolean;
    /** Searches for originals include RAW originals */
    rawRecovery: boolean;
};
export type MediaHealthOperationDto = {
    autoRetries: number;
    cancelRequestedAt: string | null;
    createdAt: string;
    error: string | null;
    finishedAt: string | null;
    /** Media operation ID */
    id: string;
    mode: MediaHealthOperationMode;
    pauseRequestedAt: string | null;
    processedUnits: number;
    progress: number;
    status: MediaOperationStatus;
    totalUnits: number | null;
    updatedAt: string;
};
export type MediaHealthQueuesDto = {
    damagedConfirmed: number;
    damagedSuspected: number;
    /** Duplicate groups waiting for review */
    duplicates: number;
    /** Items whose metadata has not been read yet */
    enrichmentPending: number;
    /** Imported items that need review; null when unavailable */
    importReview: number | null;
    /** Missing originals that still need a decision */
    missing: number;
    /** Missing originals with a verified exact copy */
    missingVerified: number;
    /** Kept apart from damage: the decoder cannot read the format */
    unsupportedRaw: number;
};
export type MediaHealthActivityDto = {
    action: MediaHealthActivityAction;
    createdAt: string;
    finishedAt: string | null;
    /** Media operation ID */
    id: string;
    /** Items the job covered */
    items: number;
    status: MediaOperationStatus;
};
export type MediaHealthRunsDto = {
    corrupt: (MediaHealthRunResponseDto) | null;
    missing: (MediaHealthRunResponseDto) | null;
};
export type MediaHealthSummaryResponseDto = {
    care: MediaHealthCareSettingsDto;
    operation: (MediaHealthOperationDto) | null;
    queues: MediaHealthQueuesDto;
    recent: MediaHealthActivityDto[];
    /** At least one recovery location is configured for this reader */
    recoveryAvailable: boolean;
    runs: MediaHealthRunsDto;
};
export type MediaOperationListResponseDto = {
    items: MediaOperationDto[];
    /** Matching jobs, before paging */
    total: number;
};
export type MediaOperationDuplicateGroupDto = {
    decision: DuplicateDecisionKind;
    /** For `undo-duplicates`: the recorded decision to reverse */
    decisionId?: string;
    /** Duplicate group ID */
    duplicateId: string;
    /** Photos to keep; the first is a stack cover. Other members of a `keepers` group are trashed */
    keepAssetIds: string[];
    /** Every photo of the group, as reviewed */
    memberIds: string[];
};
export type MediaOperationMediaHealthEntryDto = {
    /** Asset ID */
    assetId: string;
    /** Reviewed candidate ID, for a relink or a recovery */
    candidateId?: string;
    /** Media health finding ID */
    findingId: string;
};
export type MediaOperationLivePhotoPairDto = {
    /** Still image asset ID */
    photoId: string;
    /** Motion video asset ID */
    videoId: string;
};
export type MediaOperationBulkPayloadDto = {
    albumId?: string;
    /** For `apply-classification-rule`: the rule to apply to the items (FL-60) */
    classificationRuleId?: string;
    dateMode?: DateMode;
    dateTimeOriginal?: string;
    description?: string;
    /** Duplicate review decisions, one complete group each (FL-61) */
    duplicateGroups?: MediaOperationDuplicateGroupDto[];
    latitude?: number;
    longitude?: number;
    mediaHealth?: MediaOperationMediaHealthEntryDto[];
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
export type MediaOperationBulkItemDto = {
    /** Asset ID */
    id: string;
    /** Operator detail from the server */
    message: string | null;
    /** Stable key the client turns into a message */
    reasonKey: string | null;
    status: MediaOperationItemStatus;
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
export type MediaOperationDetailDto = {
    /** Source asset, when the workload has exactly one */
    assetId: string | null;
    attempt: number;
    /** Automatic retries this job has used; every job gets one before a failure is reported */
    autoRetries: number;
    bulk: (MediaOperationBulkSummaryDto) | null;
    bulkItems: MediaOperationBulkItemDto[];
    /** Asset IDs waiting for their automatic retry */
    bulkRetryPending: string[];
    cancelAcknowledgedAt: string | null;
    cancelRequestedAt: string | null;
    checkpoints: MediaOperationCheckpointDto[];
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
    /** What the person sees in Activity; empty when withheld */
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
    snapshot: {
        [key: string]: any;
    };
    startedAt: string | null;
    status: MediaOperationStatus;
    totalUnits: string | null;
    updatedAt: string;
    /** The job is about a Locked item this session has not unlocked; its label and snapshot are withheld */
    withheld: boolean;
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
    kind: Kind4;
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
    kind: Kind5;
    /** Number of distinct months represented */
    monthCount: number;
    /** Calendar year being recapped */
    year: number;
};
export type PetStoryDto = {
    /** Confirmed photos of the pet that month, before the diversity pass */
    assetCount: number;
    /** Discriminator for a pet story */
    kind: Kind6;
    /** The owner's local month, 'yyyy-MM' */
    month: string;
    /** The pet name */
    name: string;
    /** The pet the story is about */
    petId: string;
    /** The pet species */
    species: string;
    /** Year of the month */
    year: number;
};
export type BirthdayMemoryDto = {
    /** Age reached on this birthday */
    age: number | null;
    /** The birthday this year, 'yyyy-MM-dd' */
    date: string;
    /** Discriminator for a birthday */
    kind: Kind7;
    /** Their name when the memory was made */
    name: string;
    /** Whether the birthday is a person's or a pet's */
    subject: Subject;
    /** The owner's person or pet whose birthday it is */
    subjectId: string;
    /** Year of this birthday */
    year: number;
};
export type PersonRecapDto = {
    /** Number of their photos and videos that year */
    assetCount: number;
    /** Discriminator for a person or pet recap */
    kind: Kind8;
    /** Their name when the memory was made */
    name: string;
    /** Whether the recap is about a person or a pet */
    subject: Subject;
    /** The owner's person or pet */
    subjectId: string;
    /** Calendar year being recapped */
    year: number;
};
export type OnThisDayDto = {
    /** Year for on this day memory */
    year: number;
};
export type MemoryData = EventStoryDto | YearInReviewDto | PetStoryDto | BirthdayMemoryDto | PersonRecapDto | OnThisDayDto;
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
    /** Hidden by the owner; shown only in the hidden memories list */
    isHidden: boolean;
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
    /** The owner's own title, when they set one */
    title: string | null;
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
export type MemoryShowLessDto = {
    kind: MemoryShowLessKind;
    /** A person or pet id, a date as 'MM-dd', or a memory type */
    value: string;
};
export type MemoryShowLessResponseDto = {
    /** When the rule was added */
    createdAt: string;
    kind: MemoryShowLessKind;
    /** The person's or pet's name, for person and pet rules */
    name: string | null;
    /** A person or pet id, a date as 'MM-dd', or a memory type */
    value: string;
};
export type MemoryStatisticsResponseDto = {
    /** Total number of memories */
    total: number;
};
export type MemoryUpdateDto = {
    /** The memory's items in the order the owner chose; items not listed follow in capture order */
    assetOrder?: string[];
    /** Hide the memory from the memories list; false restores it */
    isHidden?: boolean;
    /** Is memory saved */
    isSaved?: boolean;
    /** Memory date */
    memoryAt?: string;
    /** Date when memory was seen */
    seenAt?: string;
    /** The owner's own title for the memory; null returns to the generated one */
    title?: string | null;
};
export type MemoryExportCreateDto = {
    /** Export format, defaults to an archive of the originals */
    format?: MemoryExportFormat;
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
    /** Restoration workers only: full restorations wait while library analysis has work */
    sharesLibraryHardware?: boolean;
    /** Required for a LAN destination, optional for a local one; Frameleaf Cloud is added from its own endpoint */
    url?: string;
    workloads?: MlWorkload[];
};
export type StudioRenderEvidenceDto = {
    /** Encoders and decoders qualified sessions verified */
    codecs: string[];
    destination: MediaOperationDestination;
    /** A qualified session verified Dolby Vision output */
    dolbyVision: boolean;
    /** Largest GPU memory a qualified session verified, or null */
    gpuMemoryBytes: number | null;
    /** A qualified session verified HDR10 output */
    hdr10: boolean;
    /** Highest bit depth a qualified session verified (8 when none said more) */
    maxBitDepth: number;
    /** Qualified live render sessions for this destination */
    sessions: number;
};
export type StudioCapabilitiesDto = {
    /** False until the Studio render worker admission (FL-95, FL-104) reports one */
    gpuWorker: boolean;
    /** FL-42: per destination, what qualified render sessions verified (memory, codecs, colour precision) */
    render: StudioRenderEvidenceDto[];
    /** False until the Studio render worker admission (FL-95, FL-104) reports one */
    renderWorker: boolean;
    /** A destination can serve a restoration workload right now */
    restorationWorker: boolean;
    /** A destination can serve the Studio AI workload right now */
    transcriptionWorker: boolean;
};
export type MlCapabilityDestinationDto = {
    /** CPU or accelerator, from the last check; unknown without facts */
    acceleration: MlWorkerAcceleration;
    /** Enabled, healthy on a check that is not stale, consented and reporting this workload */
    available: boolean;
    /** When the destination was last checked, or null */
    checkedAt: string | null;
    /** True when the destination needs no consent or consent is recorded */
    consentGranted: boolean;
    /** Largest GPU memory the worker reported, or null */
    gpuMemoryBytes: number | null;
    health: MlDestinationHealth;
    id: string;
    kind: MlDestinationKind;
    /** Work sent here leaves this network (Frameleaf Cloud) */
    leavesNetwork: boolean;
    name: string;
    /** Frameleaf Cloud data region, or null */
    region: string | null;
    /** Workloads the last check verified, or null when it never answered */
    servedWorkloads: MlWorkload[] | null;
    /** The last check is too old to count as evidence; the destination is checked again first */
    stale: boolean;
};
export type MlWorkloadCapabilityDto = {
    /** At least one destination can serve this workload right now */
    available: boolean;
    destinations: MlCapabilityDestinationDto[];
    /** Destination library jobs use for this workload, or null */
    routedDestinationId: string | null;
    workload: MlWorkload;
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
    /** Restoration workers only: full restorations wait while library analysis has work */
    sharesLibraryHardware?: boolean;
    url?: string | null;
    workloads?: MlWorkload[];
};
export type MlAdmissionRequestDto = {
    /** Job the admission is for, recorded with the accounting row */
    jobId?: string;
    studioFeature?: MlStudioFeature;
    workload: MlWorkload;
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
export type MlDestinationConsentRequestDto = {
    /** The administrator confirms that media sent to this destination leaves the network */
    acknowledgeMediaLeavesNetwork: true;
    /** Frameleaf Cloud: per-feature choices; every feature is off unless chosen */
    features?: {
        /** Allow people names in cloud description prompts */
        identityNames?: boolean;
        /** Allow medical signals in cloud descriptions */
        medicalSignals?: boolean;
        /** Allow the cloud text-recognition add-on */
        ocrAddon?: boolean;
    };
    /** Frameleaf Cloud: the consent version being accepted; required for Frameleaf Cloud */
    version?: string;
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
    /** Persist authentication cookies across browser sessions (default true) */
    rememberMe?: boolean;
    /** OAuth state parameter */
    state?: string;
    /** OAuth callback URL */
    url: string;
};
export type FrameleafHandoffResponseDto = {
    /** A single-use code for signing in on another address of this server */
    code: string;
    expiresAt: string;
};
export type FrameleafHandoffRedeemDto = {
    /** The code from POST oauth/frameleaf/handoff */
    code: string;
    rememberMe?: boolean;
};
export type FrameleafAccountLinkResponseDto = {
    /** Sign in with Frameleaf is available on this server (it is linked) */
    available: boolean;
    /** The linked Frameleaf account’s email */
    email: string | null;
    lastSignInAt: string | null;
    linked: boolean;
    linkedAt: string | null;
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
export type PeopleListItemDto = {
    /** Number of timeline assets showing this person */
    assetCount: number;
    /** Person date of birth */
    birthDate: string | null;
    /** Person color (hex) */
    color?: string;
    /** The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW) */
    featuredAssetId?: string | null;
    /** Person ID */
    id: string;
    /** Is favorite */
    isFavorite?: boolean;
    /** Is hidden */
    isHidden: boolean;
    /** Capture date of the most recent timeline asset showing this person */
    lastSeenAt: string | null;
    /** Person name */
    name: string;
    /** Thumbnail path */
    thumbnailPath: string;
    /** Last update date */
    updatedAt?: string;
};
export type PeopleResponseDto = {
    /** Whether there are more pages */
    hasNextPage?: boolean;
    /** Number of hidden people */
    hidden: number;
    people: PeopleListItemDto[];
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
export type FaceEvidenceDto = {
    /** The complete photo the face is in */
    assetId: string;
    /** Where the face is in the photo */
    box: {
        /** Height, as a fraction of the photo height */
        height: number;
        /** Width, as a fraction of the photo width */
        width: number;
        /** Left edge, as a fraction of the photo width */
        x: number;
        /** Top edge, as a fraction of the photo height */
        y: number;
    } | null;
    /** The face, when it still exists */
    faceId: string | null;
};
export type PersonCorrectionPersonDto = {
    /** Whether the person still exists */
    exists: boolean;
    /** Person ID */
    id: string;
    /** The current name, or the name at the time when the person no longer exists */
    name: string;
};
export type PersonCorrectionDto = {
    action: PersonCorrectionAction;
    /** When the decision was made */
    createdAt: string;
    /** The photo and face, when it may still be shown */
    evidence: (FaceEvidenceDto) | null;
    /** True when the decision was about a photo that can no longer be shown (trashed, Locked, hidden) */
    evidenceRevoked: boolean;
    /** Who the face belonged to before */
    fromPerson: (PersonCorrectionPersonDto) | null;
    /** Correction ID */
    id: string;
    /** Who the face belongs to after */
    toPerson: (PersonCorrectionPersonDto) | null;
    /** Whether this kind of decision can be undone and has not been */
    undoable: boolean;
    /** When the decision was undone */
    undoneAt: string | null;
};
export type MergePersonDto = {
    /** Person IDs to merge */
    ids: string[];
};
export type PersonMergeSuggestionDto = {
    /** Face embedding distance between the two people (lower is more similar) */
    distance: number;
    /** The person being reviewed */
    person: PersonResponseDto;
    /** The reviewed person's reference face and its complete photo, or null when none may be shown */
    personEvidence: (FaceEvidenceDto) | null;
    /** The suggested match for that person */
    suggestion: PersonResponseDto;
    /** The suggested person's reference face and its complete photo, or null when none may be shown */
    suggestionEvidence: (FaceEvidenceDto) | null;
};
export type MergeSuggestionsResponseDto = {
    /** Suggested pairs of people that may be the same person */
    suggestions: PersonMergeSuggestionDto[];
};
export type PersonMergeVerdictDeleteDto = {
    /** One person of the suggested pair (the reviewed person, for "ignore") */
    personId: string;
    /** The other person of the suggested pair */
    suggestionId: string;
};
export type PersonMergeVerdictCreateDto = {
    /** One person of the suggested pair (the reviewed person, for "ignore") */
    personId: string;
    /** The other person of the suggested pair */
    suggestionId: string;
    verdict: PersonMergeVerdict;
};
export type PersonMergeVerdictResponseDto = {
    /** When the verdict was recorded */
    createdAt: string;
    /** The person of the pair whose id sorts first; the ignored person for "ignore"; the surviving person for "same" */
    personId: string;
    /** The other person of the pair; the ignored person again for "ignore"; the merged person for "same" */
    suggestionId: string;
    verdict: PersonMergeVerdict;
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
export type PersonCorrectionsResponseDto = {
    /** Manual face decisions for this person, most recent first */
    corrections: PersonCorrectionDto[];
    /** Whether there are more pages */
    hasNextPage: boolean;
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
    /** Number of photos among the assets */
    photos: number;
    /** Number of videos among the assets */
    videos: number;
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
    species?: PetSpecies;
};
export type PetCandidateResponseDto = {
    /** Checksum (base64) of the asset now; send it back as expectedChecksum */
    assetChecksum: string;
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
    /** The detector's species guess, which is never the pet's species */
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
export type PetRecognitionRunResponseDto = {
    /** Photos the run looks at */
    assetCount: number;
    /** When the run was started */
    createdAt: string;
    /** Kind of destination the run was started on */
    destinationKind: (MlDestinationKind) | null;
    /** Why the run stopped, when it failed */
    error: string | null;
    /** When the run finished */
    finishedAt: string | null;
    /** Run ID */
    id: string;
    /** Photos looked at so far */
    processedCount: number;
    /** Proposals made so far */
    proposalCount: number;
    status: PetRecognitionRunStatus;
};
export type PetRecognitionStatusResponseDto = {
    /** Whether recognition can run on the routed destination now */
    available: boolean;
    /** The destination pet recognition is routed to, if any */
    destination: {
        kind: MlDestinationKind;
        /** Destination name */
        name: string;
    } | null;
    /** The refusal in words, for display */
    detail: string | null;
    /** Whether any pet is confirmed in a photo, which recognition learns from */
    hasConfirmedPhotos: boolean;
    /** Why it cannot; null when it can */
    reason: (PetRecognitionUnavailableReason) | null;
    /** The latest run over this library */
    run: (PetRecognitionRunResponseDto) | null;
};
export type PetCandidateListResponseDto = {
    /** Proposals awaiting review */
    candidates: PetCandidateResponseDto[];
    recognition: PetRecognitionStatusResponseDto;
    /** Whether a pet recognition model is configured and available */
    recognitionAvailable: boolean;
    /** Why recognition is unavailable, for display; null when it is available */
    recognitionUnavailableReason: string | null;
};
export type PetCandidateReviewDto = {
    /** Checksum of the original the decision was made on (base64); refused with 409 when it changed */
    expectedChecksum?: string;
    /** Pet to assign instead of the proposed one */
    petId?: string;
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
    /** Checksum (base64) of the original when the decision was made; null for older decisions */
    sourceChecksum: string | null;
    /** When the original was replaced under a drawn region, which then needs review; null when current */
    staleAt: string | null;
    state: PetObservationState;
    /** Last update date */
    updatedAt: string;
};
export type PetCandidateRejectDto = {
    /** Checksum of the original the decision was made on (base64); refused with 409 when it changed */
    expectedChecksum?: string;
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
    /** Checksum of the original the decision was made on (base64); refused with 409 when it changed */
    expectedChecksum?: string;
    /** Height of the image the region was drawn on */
    imageHeight?: number;
    /** Width of the image the region was drawn on */
    imageWidth?: number;
};
export type PluginMethodResponseDto = {
    /** Hosts this method may send requests to; empty when it cannot reach other servers */
    allowedHosts: string[];
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
export type PreservationPackageCountsDto = {
    copied: number;
    failed: number;
    listed: number;
    locked: number;
    pending: number;
    skipped: number;
    total: number;
};
export type PreservationManifestSummaryDto = {
    /** Every selected item was written; a complete package can still be damaged later */
    complete: boolean;
    createdAt: string;
    exported: number;
    failed: number;
    includeLocked: boolean;
    includeMetadata: boolean;
    locked: number;
    /** The package’s own identity, from its manifest */
    packageId: string;
    producerVersion: string;
    scopeDescription: string;
    skipped: number;
};
export type PreservationSupportDto = {
    category: PreservationSupportCategory;
    level: PreservationSupportLevel;
};
export type PreservationVerificationDto = {
    changed: number;
    checked: number;
    /** Index documents whose digest no longer matches */
    documentsChanged: string[];
    finishedAt: string;
    missing: number;
    ok: number;
    reasonKey: string | null;
    status: PreservationVerificationStatus;
    /** Files in the package its manifest does not account for */
    unexpected: number;
};
export type PreservationPackageDto = {
    counts: PreservationPackageCountsDto;
    createdAt: string;
    downloadable: boolean;
    /** When an uploaded package is discarded */
    expiresAt: string | null;
    format: PreservationPackageFormat;
    id: string;
    includeLocked: boolean;
    includeMetadata: boolean;
    /** It holds Locked items: downloading it needs an unlocked session */
    lockedContent: boolean;
    manifest: (PreservationManifestSummaryDto) | null;
    name: string;
    /** The newest job on this package */
    operation: (MediaOperationDto) | null;
    origin: PreservationPackageOrigin;
    restorable: boolean;
    scopeDescription: string | null;
    sizeBytes: string | null;
    status: PreservationPackageStatus;
    support: PreservationSupportDto[];
    updatedAt: string;
    verification: (PreservationVerificationDto) | null;
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
    lensModel?: StringPatternFilter;
    libraryId?: IdFilterNullable;
    localDateTime?: DateFilter;
    make?: StringPatternFilter;
    model?: StringPatternFilter;
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
    lensModel?: StringPatternFilter;
    libraryId?: IdFilterNullable;
    localDateTime?: DateFilter;
    make?: StringPatternFilter;
    model?: StringPatternFilter;
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
export type PreservationScopeDto = {
    /** Exactly these items of yours, instead of a filter */
    assetIds?: string[];
    /** Your items matching these conditions; the whole library when empty */
    filter?: SearchFilter;
};
export type PreservationExportCreateDto = {
    /** Include your Locked items. Needs an unlocked session; they are restored Locked. */
    includeLocked?: boolean;
    /** Include metadata sidecars, albums, people, tags and edit recipes. Checksums are always included. */
    includeMetadata?: boolean;
    name: string;
    /** Idempotency key; a repeated submit answers with the first package */
    requestKey?: string;
    scope?: PreservationScopeDto;
};
export type PreservationItemDto = {
    assetId: string | null;
    error: string | null;
    id: string;
    locked: boolean;
    name: string | null;
    reasonKey: string | null;
    sha256: string | null;
    sizeBytes: string | null;
    sourceAssetId: string | null;
    state: PreservationItemState;
    verifyState: (PreservationVerifyState) | null;
};
export type PreservationItemsResponseDto = {
    items: PreservationItemDto[];
    total: number;
};
export type PreservationPreviewDto = {
    /** Count Locked items as included; needs an unlocked session */
    includeLocked?: boolean;
    scope?: PreservationScopeDto;
};
export type PreservationPreviewResponseDto = {
    bytes: string;
    /** Free space where the package would be written */
    freeBytes: string | null;
    includedBytes: string;
    /** Items the export would include */
    includedItems: number;
    /** Items matching, Locked ones not counted */
    items: number;
    /** This session is unlocked, so Locked items may be included */
    lockedAllowed: boolean;
    lockedBytes: string;
    /** Locked items matching */
    lockedItems: number;
    maxItems: number;
    support: PreservationSupportDto[];
    withinLimit: boolean;
};
export type PreservationRestoreCountsDto = {
    conflicts: number;
    /** Originals the library already holds; they are matched, never copied again */
    existing: number;
    failed: number;
    findings: number;
    locked: number;
    matched: number;
    /** Originals the library does not hold */
    "new": number;
    pending: number;
    ready: number;
    restored: number;
    skipped: number;
    total: number;
    /** Originals the library holds in the trash; restore them from the trash first */
    trashed: number;
};
export type PreservationRestoreDto = {
    /** Albums and collections in the package */
    albums: number;
    conflictDefault: PreservationDecision;
    counts: PreservationRestoreCountsDto;
    createdAt: string;
    id: string;
    name: string;
    /** The newest job on this restoration */
    operation: (MediaOperationDto) | null;
    packageId: string | null;
    /** Named people in the package */
    people: number;
    reasonKey: string | null;
    restoreEditRecipes: boolean;
    status: PreservationRestoreStatus;
    support: PreservationSupportDto[];
    updatedAt: string;
};
export type PreservationRestoreCreateDto = {
    /** What to do where the package and the library disagree and you have not chosen; `keep` when omitted */
    conflictDefault?: PreservationDecision;
    name?: string;
    packageId: string;
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    requestKey?: string;
    /** Restore edit recipes; edited versions are rendered again */
    restoreEditRecipes?: boolean;
};
export type PreservationItemDecisionsDto = {
    decisions: {
        [key: string]: PreservationDecision;
    };
    id: string;
};
export type PreservationDecisionsUpdateDto = {
    conflictDefault?: PreservationDecision;
    items?: PreservationItemDecisionsDto[];
    restoreEditRecipes?: boolean;
};
export type PreservationConflictDto = {
    /** The package’s value */
    archived: string | null;
    /** The library’s value */
    current: string | null;
    /** Your choice; the restoration default applies when null */
    decision: (PreservationDecision) | null;
    field: PreservationConflictField;
};
export type PreservationRestoreItemDto = {
    applied: boolean;
    assetId: string | null;
    conflicts: PreservationConflictDto[];
    error: string | null;
    /** Translation keys for what the restore left for you to look at */
    findings: string[];
    id: string;
    /** Locked in the package or in your library; listed only to an unlocked session */
    locked: boolean;
    match: (PreservationRestoreMatch) | null;
    name: string | null;
    reasonKey: string | null;
    sourceAssetId: string | null;
    state: PreservationRestoreItemState;
};
export type PreservationRestoreItemsResponseDto = {
    items: PreservationRestoreItemDto[];
    total: number;
};
export type PreservationServerPackageCreateDto = {
    name?: string;
    /** A package directory or ZIP file on this server, outside its media storage */
    path: string;
};
export type PreservationUploadCreateDto = {
    /** A `.frameleaf-preservation.zip` package */
    file: Blob;
};
export type FrameleafPublicConfigDto = {
    /** This server on the home network; given only to a remote-access visitor who is on it */
    localUrl: string | null;
    /** The remote-access host shown on the login page, when known */
    relayHost: string | null;
    /** Whether a remote-access visitor is on the same network as this server */
    sameNetwork: boolean;
    /** Whether Sign in with Frameleaf is available (the server is linked) */
    signInAvailable: boolean;
    /** Whether this visitor arrived through remote access, where only Sign in with Frameleaf is offered */
    signInRequired: boolean;
    /** How the request arrived; null when the edge worker did not vouch for it */
    via: (FrameleafVia) | null;
};
export type PublicConfigFrameleafSignInDto = {
    /** Sign in with Frameleaf button text */
    buttonText: string;
    /** Show Sign in with Frameleaf on the local sign-in page too */
    showOnLocalLogin: boolean;
};
export type PublicConfigFrameleafCloudDto = {
    signIn: PublicConfigFrameleafSignInDto;
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
    /** Server name shown in settings; empty uses the host name */
    name: string;
};
export type PublicConfigThemeDto = {
    /** Custom CSS for theming */
    customCss: string;
};
export type PublicConfigDto = {
    frameleaf: FrameleafPublicConfigDto;
    frameleafCloud: PublicConfigFrameleafCloudDto;
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
export type QueueJobAccountDto = {
    /** Account ID */
    id: string;
    /** Account name */
    name: string;
};
export type QueueJobWorkerDto = {
    kind: QueueJobWorkerKind;
    /** The processing destination name, for a machine-learning worker */
    name: string | null;
};
export type QueueJobResponseDto = {
    /** The account whose item the job works on, when the job names an asset, person, library or account */
    account?: QueueJobAccountDto;
    /** How many times the job has been attempted */
    attemptsMade?: number;
    /** Job data payload */
    data: {
        [key: string]: any;
    };
    /** Why the last attempt failed, for a failed job */
    failedReason?: string;
    /** Job ID */
    id?: string;
    name: JobName;
    /** Job creation timestamp */
    timestamp: number;
    /** Where the job runs or ran */
    worker: QueueJobWorkerDto;
};
export type QueueRetryFailedResponseDto = {
    /** How many failed jobs were put back in the queue */
    count: number;
};
export type QueueOwnerStatisticsResponseDto = {
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
    /** Whether a state had more jobs than were scanned, so its count is a lower bound */
    truncated: boolean;
    /** Number of waiting jobs */
    waiting: number;
};
export type RenderWorkerAdmissionDto = {
    /** Encoder and decoder names the check verified */
    codecs?: string[];
    /** Colour precision the conformance check verified; absent means 8-bit SDR only (FL-42) */
    colorPrecision?: {
        /** The check verified Dolby Vision output */
        dolbyVision: boolean;
        /** The check verified HDR10 (PQ, BT.2020) output */
        hdr10: boolean;
        /** Highest bit depth the check rendered and verified */
        maxBitDepth: number;
    };
    /** When the conformance check ran */
    conformanceReportedAt: string;
    /** Digest of the engine and patches actually loaded */
    engineDigest: string;
    enrolmentSecret: string;
    /** Containers the check verified writing, such as `mp4`, `webm` or `mov` */
    formats?: string[];
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
export type RenderWorkerClaimRequestDto = {
    /** Narrow the claim to these kinds */
    kinds?: MediaOperationKind[];
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
export type RenderWorkerCancelAckDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    /** True when remote resources are confirmed gone */
    released: boolean;
};
export type RenderWorkerWriteResultDto = {
    accepted: boolean;
    refusal: (RenderWorkerRefusalReason) | null;
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
export type RenderWorkerOutputDto = {
    /** SHA-256 of the whole file */
    checksum: string;
    /** `video/mp4`, `video/webm` or `video/quicktime` */
    contentType: string;
    /** Absolute path inside the render directory the claim named */
    path: string;
    /** What the worker calls a copy it kept; it is asked to delete it until it acknowledges */
    remoteRef?: string | null;
    sizeInBytes: string;
};
export type RenderWorkerCompleteDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    /** Required for a Studio export */
    output?: RenderWorkerOutputDto;
    /** Must be null for a Studio export: its result is adopted by publication, never named by a worker */
    resultAssetId: string | null;
};
export type RenderWorkerFailDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    error: string;
    errorCode: string;
};
export type RenderWorkerHeartbeatDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    /** Total output bytes produced so far */
    outputBytes?: string;
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
export type RenderWorkerProgressDto = {
    /** The claim token this operation was handed out with */
    claimToken: string;
    outputBytes?: string;
    processedUnits: number;
    status: Status3;
    totalUnits: number | null;
};
export type RenderWorkerRemoteReferenceDto = {
    id: string;
    /** The render job */
    operationId: string;
    reason: StudioExportRemoteReason;
    /** The copy to delete, for a `delete` reference */
    remoteRef: string | null;
    requestedAt: string;
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
    mode: SearchAskMode;
    /** Normalized query text */
    normalizedQuery: string;
};
export type SearchFacetCountResponseDto = {
    /** Number of assets with this facet value */
    count: number;
    /** The newest matching asset with this value (by capture time), when `facetCovers` was asked for */
    coverAssetId?: string | null;
    /** Display name when the value is an id (a person or a tag); the viewer's own name for it */
    label?: string | null;
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
export type SearchCityCountResponseDto = {
    /** City name, grouped as in GET /search/cities (which lists only cities with a photo) */
    city: string;
    /** Number of timeline photos and videos in this city */
    count: number;
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
export type SearchFacetsDto = {
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
    /** Also return, per value, the newest matching asset (by capture time) as its cover */
    facetCovers?: boolean;
    /** Most frequent values per facet (default 10) */
    facetLimit?: number;
    /** Facets to count, each once (repeats are ignored); every facet when omitted */
    facets?: SearchFacetField[];
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
export type SearchFacetsResponseDto = {
    /** Per facet, the most frequent values, busiest first. type, rating and isFavorite always add up to total; people, places, cameras, lenses and tags count assets that have a value */
    facets: SearchFacetResponseDto[];
    /** Number of assets the search body matches, as POST /search/statistics reports */
    total: number;
};
export type SearchHistogramDto = {
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
    /** Bucket size */
    granularity?: SearchHistogramGranularity;
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
export type SearchHistogramBucketDto = {
    count: number;
    /** First local capture date of the bucket (YYYY-MM-DD) */
    date: string;
};
export type SearchHistogramResponseDto = {
    /** Non-empty buckets by local capture date, oldest first */
    buckets: SearchHistogramBucketDto[];
    granularity: SearchHistogramGranularity;
    /** Sum of every bucket; equals POST /search/statistics for the same body */
    total: number;
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
export type SmartSearchStatisticsResponseDto = {
    /** More than 1000 assets match; total is the cap */
    capped: boolean;
    /** Assets smart search would rank for this body, counted up to 1000 */
    total: number;
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
export type ServerAppReleasesResponseDto = {
    /** Android application */
    android: {
        /** Android package id of the signed release */
        appId?: string;
        /** Whether a signed Android release is configured for this server */
        available: boolean;
        /** Signed APK downloads for this server version */
        links?: ServerApkLinksDto;
        /** SHA-256 fingerprint of the release signing certificate, as AA:BB:... */
        signingCertificateSha256?: string;
        /** Store listing of the Android app, when the operator configured one (FL-135) */
        storeUrl?: string;
    };
    /** iOS application */
    ios: {
        /** Whether an iOS release is configured for this server */
        available: boolean;
        /** App Store or TestFlight page */
        url?: string;
    };
};
export type ServerFrameleafConfigDto = {
    /** The address Frameleaf Cloud published for this server, while it is linked */
    publicUrl: string | null;
    /** Whether Sign in with Frameleaf is available (the server is linked) */
    signInAvailable: boolean;
    /** Whether this request arrived through remote access, where a Frameleaf sign-in is required */
    signInRequired: boolean;
    /** How the request arrived; null when the edge worker did not vouch for it */
    via: (FrameleafVia) | null;
};
export type ServerConfigDto = {
    /** Canonical default for the image-description advanced raw prompt template */
    defaultImageDescriptionRawPromptTemplate: string;
    /** External domain URL */
    externalDomain: string;
    frameleaf: ServerFrameleafConfigDto;
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
    /** Server name set by an administrator; empty when none is set */
    serverName: string;
    /** Number of days before trashed assets are permanently deleted */
    trashDays: number;
    /** Delay in days before deleted users are permanently removed */
    userDeleteDelay: number;
};
export type ServerFeaturesDto = {
    /** Whether Ask Search (natural-language questions about the library) is enabled and can answer */
    askSearch: boolean;
    /** Whether the Frameleaf Cloud plan includes cloud backup (FL-156) */
    cloudBackup: boolean;
    /** Whether the Frameleaf Cloud plan includes cloud processing (FL-156) */
    cloudMl: boolean;
    /** Whether config file is available */
    configFile: boolean;
    /** Whether duplicate detection is enabled */
    duplicateDetection: boolean;
    /** Whether email notifications are enabled */
    email: boolean;
    /** Whether facial recognition is enabled */
    facialRecognition: boolean;
    /** Whether this server is linked to Frameleaf Cloud (FL-156) */
    frameleafCloud: boolean;
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
    /** Whether the Frameleaf Cloud plan includes remote access (FL-156) */
    remoteAccess: boolean;
    /** Whether reverse geocoding is enabled */
    reverseGeocoding: boolean;
    /** Whether search is enabled */
    search: boolean;
    /** Whether sidecar files are supported */
    sidecar: boolean;
    /** Whether smart search is enabled */
    smartSearch: boolean;
    /** Whether this server carries a Frameleaf supporter licence (FL-156) */
    supporter: boolean;
    /** Whether trash feature is enabled */
    trash: boolean;
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
    /** Full pre-release identifier (for example rc.1 or beta.2), present only for a pre-release (FL-80) */
    prereleaseName?: string;
};
export type VersionCheckStateResponseDto = {
    /** Last check timestamp */
    checkedAt: string | null;
    /** Release version */
    releaseVersion: string | null;
};
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
export type SharedLinkOwnerResponseDto = {
    /** Display name of the user who created the link */
    name: string;
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
    /** Display name of the user who created the link, for "Shared by" on the public page */
    owner?: SharedLinkOwnerResponseDto;
    /** Has password: a fixed mask when the link has one, never the password itself */
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
    invitedBy: (UserResponseDto) | null;
    /** People already in the shared space, including its owner */
    memberCount: number;
    /** Who owns the shared space */
    owner: UserResponseDto;
    /** The role the recipient gets on accept */
    role: AlbumUserRole;
    /** Earliest item date, sensitive and Locked media excluded */
    startDate?: string;
};
export type RecipientGroupResponseDto = {
    /** When the group was saved */
    createdAt: string;
    /** Recipient group ID */
    id: string;
    /** Name, visible to its owner only */
    name: string;
    /** When the group last changed */
    updatedAt: string;
    /** People in the group who still have an account, by name */
    users: UserResponseDto[];
};
export type RecipientGroupCreateDto = {
    /** Name, visible to its owner only */
    name: string;
    /** People in the group. Yourself and repeats are dropped. */
    userIds: string[];
};
export type RecipientGroupUpdateDto = {
    /** Name, visible to its owner only */
    name?: string;
    /** People in the group. Yourself and repeats are dropped. */
    userIds?: string[];
};
export type SharedSpaceEventResponseDto = {
    /** The comment or like this event announces, if any */
    activityId: string | null;
    /** Who did it; null once that account is gone */
    actor: (UserResponseDto) | null;
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
    targetUser: (UserResponseDto) | null;
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
    linkedBy: (UserResponseDto) | null;
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
export type StudioExportSettingsDto = {
    color: StudioExportColor;
    format: StudioExportFormat;
    resolution: StudioExportResolution;
};
export type StudioExportVersionDto = {
    cancelledAt: string | null;
    contentType: string | null;
    createdAt: string;
    destination: MediaOperationDestination;
    error: string | null;
    errorCode: string | null;
    /** Export version ID */
    id: string;
    /** At least one source is shared with you rather than yours */
    includesSharedSources: boolean;
    /** The result inherited a lock from a Locked or sensitive source */
    locked: boolean;
    /** Null once the project was deleted for good */
    projectId: string | null;
    publishOperationId: string | null;
    publishedAt: string | null;
    renderOperationId: string | null;
    /** The asset a `library` result became */
    resultAssetId: string | null;
    /** The project revision that was rendered */
    revision: number;
    /** Where the published result lives */
    scope: (StudioExportScope) | null;
    /** The result inherited sensitive evidence from a source */
    sensitive: boolean;
    settings: StudioExportSettingsDto;
    sizeInBytes: string | null;
    /** Library sources the result was made from */
    sourceCount: number;
    state: StudioExportVersionState;
    /** The version number, once published */
    version: number | null;
};
export type StudioPreviewTimeDto = {
    /** Time denominator; must be positive */
    denominator: string;
    /** Time numerator, in seconds over the denominator */
    numerator: string;
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
export type StudioProjectTrashEmptyResponseDto = {
    /** Projects deleted for good */
    count: number;
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
export type StudioBundleExportCreateDto = {
    /** Copy the media you own into the bundle. Shared media always travels as a reference, and nothing Locked is ever copied. */
    includeMedia?: boolean;
    /** Idempotency key; a repeated submit answers with the first job */
    requestKey?: string;
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
export type StudioProjectDuplicateDto = {
    /** Name of the copy; the client supplies the translated default */
    name?: string;
};
export type StudioExportListResponseDto = {
    items: StudioExportVersionDto[];
    /** Matching versions, before paging */
    total: number;
};
export type StudioExportCreateDto = {
    /** You agree to the media leaving your network for this export */
    cloudConsent?: boolean;
    color: StudioExportColor;
    /** Where it renders. A cloud destination needs `cloudConsent` */
    destination: MediaOperationDestination;
    /** The revision you are looking at; a newer head refuses the export with `409` instead of rendering it */
    expectedRevision?: number;
    format: StudioExportFormat;
    /** Idempotency key; a repeated submit answers with the first export */
    requestKey?: string;
    resolution: StudioExportResolution;
};
export type StudioExportCreateResponseDto = {
    /** The render job; follow it in Activity */
    operation: MediaOperationDto;
    version: StudioExportVersionDto;
};
export type StudioProjectLeaseRequestDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    clientId: string;
    /** Take a live lease away from another of your editor instances; never implicit */
    takeover?: boolean;
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
export type StudioCommandSummaryDto = {
    /** Command id to how many times it appeared */
    counts: {
        [key: string]: number;
    };
    /** Commands in the batch */
    total: number;
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
export type StudioCommandEnvelopeDto = {
    /** Published command id (studio/frameleaf-studio-commands.json) */
    id: string;
    idempotencyKey: string;
    /** Epoch milliseconds */
    issuedAt: number;
    /** Command payload; graph-shaped values pass through unread */
    payload: {
        [key: string]: any;
    };
    /** The head revision the command was issued against */
    revision: number;
};
export type StudioProjectSaveDto = {
    /** Client-chosen identifier; letters, digits, `_ . : -`, up to 128 characters */
    clientId: string;
    /** The canonical commands the engine applied to produce this document (FL-92). Each is checked against the catalogue and the head, and the revision summary is counted from them. */
    commands?: StudioCommandEnvelopeDto[];
    envelope: StudioProjectEnvelopeDto;
    /** The head this document was built on */
    expectedRevision: number;
    /** Stable per attempt; a retry carries the same key */
    requestKey: string;
    summary?: StudioCommandSummaryDto;
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
    "from": number;
    /** The two envelopes have the same digest */
    identical: boolean;
    /** Changed graph paths, aggregated and capped */
    paths: string[];
    removed: number;
    to: number;
    /** More paths changed than are listed */
    truncated: boolean;
};
export type StudioWorkspaceDto = {
    /** The engine revision that wrote the layout */
    engineRevision: string | null;
    /** The engine layout as the same JSON value it was saved as (key order and spacing are not kept); null when none is stored */
    layout: {
        [key: string]: any;
    } | null;
    savedAt: string | null;
};
export type StudioWorkspaceSaveDto = {
    /** The pinned engine revision writing it */
    engineRevision: string;
    /** The engine layout; stored and returned as the same JSON value (key order and spacing are not kept) */
    layout: {
        [key: string]: any;
    };
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
    /** Descriptions are routed to Frameleaf Cloud, which describes photos in batches from Frameleaf Cloud processing with an estimate first; nothing was queued here */
    cloudBatches: boolean;
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
    kind?: SmartAlbumBuiltInKind;
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
export type FrameleafSetupChoicesDto = {
    /** Whether the local administrator exists */
    accountCreated?: boolean;
    /** Administrator email */
    adminEmail?: string;
    /** Administrator name */
    adminName?: string;
    /** Language chosen on the welcome step */
    language?: string;
    /** Folder layout preset, or "keep" */
    layout?: string;
    /** Whether the server is linked to a Frameleaf account */
    linked?: boolean;
    /** Map tiles */
    map?: boolean;
    /** Model tier */
    model?: FrameleafSetupModelTier;
    /** Nightly database backups */
    nightlyBackup?: boolean;
    /** Where processing runs */
    processing?: FrameleafSetupProcessing;
    /** Choice for a found cloud backup */
    restore?: FrameleafSetupRestore;
    /** How the administrator signs in */
    signIn?: FrameleafSetupSignIn;
    /** Whether the administrator signed in (existing library) */
    signedIn?: boolean;
    /** Theme after setup */
    theme?: FrameleafSetupTheme;
    /** Check for Frameleaf updates */
    updates?: boolean;
};
export type FrameleafSetupProgressDto = {
    choices: FrameleafSetupChoicesDto;
    /** Furthest step index reached */
    reached: number;
    /** Current step id */
    step: string;
    /** Payload version (1) */
    version: number;
};
export type FrameleafSetupResponseDto = {
    /** Whether Frameleaf setup is complete */
    completed: boolean;
    /** When setup was completed */
    completedAt: string | null;
    flow: FrameleafSetupFlow;
    progress: (FrameleafSetupProgressDto) | null;
};
export type FrameleafSetupUpdateDto = {
    flow?: FrameleafSetupFlow;
    progress: FrameleafSetupProgressDto;
};
export type FrameleafSetupLibraryResponseDto = {
    /** Albums */
    albums: number;
    /** Size of the originals in bytes */
    bytes: number;
    /** Photos and videos on the server */
    items: number;
    /** Named and unnamed people */
    people: number;
    /** Accounts on the server */
    users: number;
};
export type FrameleafSetupStorageResponseDto = {
    /** Free space in bytes */
    freeBytes: number;
    /** Where the library is stored */
    path: string;
    /** Total space in bytes */
    totalBytes: number;
    /** Whether Frameleaf can write there */
    writable: boolean;
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
export type TagStatisticsResponseDto = {
    /** Timeline items tagged with exactly this tag */
    count: number;
    /** Tag ID */
    id: string;
    /** Timeline items tagged with this tag or any tag nested under it */
    total: number;
};
export type TagUpdateDto = {
    /** Tag color (hex) */
    color?: string | null;
    /** Tag name */
    name?: string;
    /** Move the tag under this parent tag; null moves it to the top level. The tag and all its descendants take the new path */
    parentId?: string | null;
};
export type TakeoutAlbumDto = {
    /** Items in the folder */
    count: number;
    /** The export folder */
    folder: string;
    /** The album name it becomes */
    name: string;
    /** Recreated by the next import */
    selected: boolean;
    /** One of Google’s automatic year folders */
    year: boolean;
};
export type TakeoutCountsDto = {
    failed: number;
    /** Files found in the sources */
    files: number;
    /** Items going into Locked, not listed until Locked is unlocked */
    hiddenLocked: number;
    imported: number;
    importing: number;
    /** Photos and videos */
    items: number;
    matched: number;
    /** Items already in the library, whose album memberships are restored */
    matchedOriginals: number;
    /** Items still to import that are not in the library yet */
    newAssets: number;
    ready: number;
    /** Archive entries refused */
    rejected: number;
    review: number;
    skipped: number;
    /** Possible Live Photo pairs awaiting a decision */
    suggestedPairs: number;
    /** Live Photo pairs that could not be linked */
    unresolvedPairs: number;
};
export type TakeoutOptionsResponseDto = {
    albums: boolean;
    archive: boolean;
    dates: boolean;
    descriptions: boolean;
    favorites: boolean;
    locations: boolean;
    selectedAlbums?: string[];
    sidecarReview: boolean;
    updateMatchedMetadata: boolean;
};
export type TakeoutSourceResponseDto = {
    id: string;
    kind: TakeoutSourceKind;
    /** The archive’s file name, or the directory’s name */
    name: string;
    /** Bytes staged so far; an upload resumes here */
    received: number;
    /** Entries refused: unsafe names, links or encryption */
    rejected: number;
    /** Every entry has been read */
    scanned: boolean;
    /** Declared archive size in bytes; zero for a directory */
    size: number;
};
export type TakeoutResponseDto = {
    /** What the latest job did or is doing */
    action: (TakeoutAction) | null;
    albums: TakeoutAlbumDto[];
    counts: TakeoutCountsDto;
    createdAt: string;
    error: string | null;
    errorCode: string | null;
    id: string;
    name: string;
    /** The latest job, as Activity lists it */
    operationId: string | null;
    options: TakeoutOptionsResponseDto;
    phase: TakeoutPhase;
    /** Units the latest job has finished */
    processed: number;
    sources: TakeoutSourceResponseDto[];
    state: TakeoutState;
    /** Units the latest job knows of so far; grows while a scan reads its sources */
    total: number | null;
    updatedAt: string;
};
export type TakeoutCreateDto = {
    /** Administrators only: the directory inside the root, relative to it; empty for the root itself */
    directory?: string;
    /** A name for this import */
    name: string;
    /** Administrators only: the permitted import root to read a server directory from */
    rootId?: string;
};
export type TakeoutRootDto = {
    id: string;
    /** The directory the administrator permitted */
    path: string;
};
export type TakeoutRootsResponseDto = {
    roots: TakeoutRootDto[];
};
export type TakeoutArchiveCreateDto = {
    /** The archive’s file name */
    name: string;
    /** The archive’s size in bytes */
    size: number;
};
export type TakeoutVerifyChunkDto = {
    /** Byte offset of the range */
    offset: number;
    /** SHA-256 of the range, hex */
    sha256: string;
    /** Length of the range */
    size: number;
};
export type TakeoutControlDto = {
    action: TakeoutControlAction;
};
export type TakeoutOptionsDto = {
    /** Recreate album memberships, including for photos already in the library */
    albums?: boolean;
    /** Bring over archived photos as archived */
    archive?: boolean;
    /** Bring over the dates photos were taken */
    dates?: boolean;
    /** Bring over descriptions */
    descriptions?: boolean;
    /** Bring over favorites */
    favorites?: boolean;
    /** Bring over locations */
    locations?: boolean;
    /** Album folders to recreate; omitted means every folder that is not a year folder */
    selectedAlbums?: string[];
    /** Hold items whose metadata sidecars disagree for a decision; off imports them without a sidecar */
    sidecarReview?: boolean;
    /** Fill metadata missing from photos already in the library; values already there are never replaced */
    updateMatchedMetadata?: boolean;
};
export type TakeoutMetadataDto = {
    /** Archived in Google Photos */
    archived?: boolean;
    /** When Google Photos received the photo (ISO 8601) */
    createdAt?: string;
    /** Description */
    description?: string;
    /** Favorite in Google Photos */
    favorite?: boolean;
    /** Latitude */
    latitude?: number;
    /** In the Google Photos Locked Folder; imported into Locked */
    locked?: boolean;
    /** Longitude */
    longitude?: number;
    /** When the photo was taken (ISO 8601) */
    takenAt?: string;
    /** File name Google Photos recorded */
    title: string;
    /** In the Google Photos trash; not imported */
    trashed?: boolean;
};
export type TakeoutSidecarCandidateDto = {
    id: string;
    metadata: TakeoutMetadataDto;
    path: string;
};
export type TakeoutItemResponseDto = {
    albums: string[];
    /** The library item it became or matched, when this session may open it */
    assetId: string | null;
    candidates: TakeoutSidecarCandidateDto[];
    error: string | null;
    folder: string;
    id: string;
    kind: TakeoutItemKind;
    locked: boolean;
    metadata: TakeoutMetadataDto;
    /** Path inside the export */
    path: string;
    sidecarId: string | null;
    size: number;
    /** The archive or directory the file came from */
    source: string;
    state: TakeoutItemState;
    warnings: TakeoutWarning[];
};
export type TakeoutItemsResponseDto = {
    hiddenLocked: number;
    items: TakeoutItemResponseDto[];
    total: number;
};
export type TakeoutResolveDto = {
    /** The sidecar to use; null imports without one */
    sidecarId?: string | null;
    /** True leaves the item out of the import; false brings it back */
    skip?: boolean;
};
export type TakeoutPairResponseDto = {
    error: string | null;
    photoItemId: string;
    photoPath: string;
    state: TakeoutPairState;
    videoItemId: string;
    videoPath: string;
};
export type TakeoutPairsResponseDto = {
    pairs: TakeoutPairResponseDto[];
    total: number;
};
export type TakeoutPairDecisionDto = {
    /** True links them as one Live Photo; false keeps them separate */
    approve: boolean;
    /** The still photo */
    photoItemId: string;
    /** The motion video */
    videoItemId: string;
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
    /** Array of file sizes in bytes (null when unknown). Omitted for shared links that hide EXIF */
    fileSizeInByte?: (number | null)[];
    /** Array of heights in pixels (null when unknown). Omitted for shared links that hide EXIF */
    height?: (number | null)[];
    /** Array of asset IDs in the time bucket */
    id: string[];
    /** Array indicating whether each asset is favorited */
    isFavorite: boolean[];
    /** Array indicating whether each asset is an image (false for videos) */
    isImage: boolean[];
    /** Array indicating whether each asset is offline (its file is missing from an external library) */
    isOffline?: boolean[];
    /** Array indicating whether each asset is in the trash */
    isTrashed: boolean[];
    /** Array of latitude coordinates extracted from EXIF GPS data */
    latitude?: (number | null)[];
    /** Array of live photo video asset IDs (null for non-live photos) */
    livePhotoVideoId: (string | null)[];
    /** Array of UTC offset hours at the time each photo was taken. Positive values are east of UTC, negative values are west of UTC. Values may be fractional (e.g., 5.5 for +05:30, -9.75 for -09:45). Applying this offset to 'fileCreatedAt' will give you the time the photo was taken from the photographer's perspective. */
    localOffsetHours: number[];
    /** Why each asset is locked, or null when it is not. Returned with visibility LOCKED and for the timeline of an elevated owner, which reveals their marked and detected items */
    lockReason?: ((AssetLockReason) | null)[];
    /** Array of longitude coordinates extracted from EXIF GPS data */
    longitude?: (number | null)[];
    /** Array of original file names. Omitted for shared links that hide EXIF */
    originalFileName?: string[];
    /** Array of owner IDs for each asset */
    ownerId: string[];
    /** Array of projection types for 360° content (e.g., "EQUIRECTANGULAR", "CUBEFACE", "CYLINDRICAL") */
    projectionType: (string | null)[];
    /** Array of star ratings from EXIF (-1 rejected, 0 unrated, 1-5 stars; null when unknown). Omitted for shared links that hide EXIF */
    rating?: (number | null)[];
    /** Array of aspect ratios (width/height) for each asset */
    ratio: number[];
    /** Array of stack information as [stackId, assetCount] tuples (null for non-stacked assets) */
    stack?: (string[] | null)[];
    /** Array of BlurHash strings for generating asset previews (base64 encoded) */
    thumbhash: (string | null)[];
    /** Array of visibility statuses for each asset (e.g., ARCHIVE, TIMELINE, HIDDEN, LOCKED) */
    visibility: AssetVisibility[];
    /** Array of widths in pixels (null when unknown). Omitted for shared links that hide EXIF */
    width?: (number | null)[];
};
export type TimeBucketsResponseDto = {
    /** Number of assets in this time bucket */
    count: number;
    /** Time bucket identifier in YYYY-MM-DD format representing the start of the time period */
    timeBucket: string;
};
export type TimelineHighlightResponseDto = {
    /** Number of assets in this year or month, the same as the time buckets report */
    count: number;
    /** The next best assets in capture order (month cards only), never including the key photo */
    highlightAssetIds: string[];
    /** Key photo: highest Best Photos score, then highest star rating, then most recent capture */
    keyAssetId: string | null;
    /** Up to three most frequent places (city, else state, else country), busiest first. Empty when the viewer may not see locations */
    places: string[];
    /** First day of the year or month in YYYY-MM-DD format, as in GET /timeline/buckets */
    timeBucket: string;
};
export type UtilityActivityItemDto = {
    /** Asset ID */
    assetId: string;
    /** Size of the original when it was moved, in bytes */
    bytes: number;
    /** Original file name */
    fileName: string;
};
export type UtilityActivityEntryDto = {
    action: UtilityActivityAction;
    /** Combined size of the items listed below, in bytes */
    bytes: number;
    /** When the change was made */
    createdAt: string;
    /** Entry ID */
    id: string;
    /** Items listed below */
    itemCount: number;
    items: UtilityActivityItemDto[];
    /** Items of this change no longer shown: permanently deleted, or not visible to this session */
    unavailableCount: number;
};
export type UtilityActivityResponseDto = {
    /** Newest first */
    entries: UtilityActivityEntryDto[];
};
export type TrashApplyDto = {
    action: TrashReviewAction;
    /** The chosen items, for trash, restore and delete. Ignored by restore-all and empty. */
    ids?: string[];
    /** The utility the change was made from. A move to the trash or a restore from Large files is kept in its activity history. */
    source?: UtilityActivityTool;
    /** The token returned by the review */
    token: string;
};
export type TrashResponseDto = {
    /** Number of items in trash */
    count: number;
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
export type UserPreferenceHistoryChangeDto = {
    /** The value after, JSON encoded; null when protected */
    after: string | null;
    /** The value before, JSON encoded; null when protected */
    before: string | null;
    /** The changed preference, as a dotted path such as memories.enabled */
    path: string;
    /** Changed, but its values are not recorded (Locked content) */
    "protected"?: boolean;
};
export type UserPreferenceHistoryEntryDto = {
    /** Every changed preference */
    changes: UserPreferenceHistoryChangeDto[];
    /** When the change was saved */
    createdAt: string;
    /** The device that saved it, such as "macOS · Web" */
    deviceLabel: string | null;
    /** Entry ID */
    id: string;
    /** Changed preferences left out because the entry reached its limit */
    omittedChanges: number;
};
export type UserPreferenceHistoryResponseDto = {
    /** The newest preference changes first */
    entries: UserPreferenceHistoryEntryDto[];
};
export type CreateProfileImageDto = {
    /** ID of the photo the image was copied from, if any. A Locked photo is refused. */
    assetId?: string;
    /** Profile image file */
    file: Blob;
    /** The image is a new crop of the current profile picture: keep the photo it was copied from, if any. Ignored when assetId is set. */
    keepSource?: boolean;
};
export type CreateProfileImageResponseDto = {
    /** Profile image change date */
    profileChangedAt: string;
    /** Profile image file path */
    profileImagePath: string;
    /** User ID */
    userId: string;
};
export type FolderSummaryResponseDto = {
    /** Originals directly in this folder */
    count: number;
    /** Folder path, without a trailing slash */
    path: string;
    /** Bytes of the originals directly in this folder */
    size: number;
};
export type WorkflowIssueDto = {
    code: WorkflowIssueCode;
    /** What prevents the workflow from running */
    message: string;
    /** Index of the step the issue belongs to */
    step?: number;
};
export type WorkflowStepResponseDto = {
    /** Step configuration, without stored credential values */
    config: {
        [key: string]: any;
    } | null;
    /** Step is enabled */
    enabled: boolean;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra: {
        [key: string]: any;
    };
    /** Step ID */
    id: string;
    /** Step plugin method, as plugin#method */
    method: string;
    /** Configuration paths (keys joined with ".") holding a stored credential that is never returned */
    storedSecrets: string[];
};
export type WorkflowResponseDto = {
    /** Creation date */
    createdAt: string;
    /** Workflow description */
    description: string | null;
    /** Workflow enabled */
    enabled: boolean;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra: {
        [key: string]: any;
    };
    /** Workflow ID */
    id: string;
    /** What prevents this definition from running on this server; empty when it can run */
    issues: WorkflowIssueDto[];
    /** Workflow logs run results */
    logging: boolean;
    /** Workflow name */
    name: string | null;
    /** Workflow steps */
    steps: WorkflowStepResponseDto[];
    /** Workflow trigger type */
    trigger: string;
    /** Update date */
    updatedAt: string;
};
export type WorkflowStepDto = {
    /** Step configuration */
    config: {
        [key: string]: any;
    } | null;
    /** Step is enabled */
    enabled?: boolean;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra?: {
        [key: string]: any;
    };
    /** Step ID from a previous response. A credential left out of its configuration keeps its stored value */
    id?: string;
    /** Step plugin method, as plugin#method */
    method: string;
};
export type WorkflowCreateDto = {
    /** Workflow description */
    description?: string | null;
    /** Workflow enabled */
    enabled?: boolean;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra?: {
        [key: string]: any;
    };
    /** Workflow logs run results */
    logging?: boolean;
    /** Workflow name */
    name?: string | null;
    steps?: WorkflowStepDto[];
    /** Workflow trigger type. An unavailable trigger is kept, but the workflow cannot be enabled */
    trigger: string;
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
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra?: {
        [key: string]: any;
    };
    /** Workflow logs run results */
    logging?: boolean;
    /** Workflow name */
    name?: string | null;
    steps?: WorkflowStepDto[];
    /** Workflow trigger type. An unavailable trigger is kept, but the workflow cannot be enabled */
    trigger?: string;
};
export type WorkflowLogEntryDto = {
    /** Workflow run date/time */
    at: string;
    /** 0 for the first attempt, 1 for the automatic retry, then manual retries */
    attempt: number;
    /** Why the run failed, without stored credentials */
    error?: string;
    errorCode?: WorkflowRunErrorCode;
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
    /** Run ID shared by every attempt of one run */
    runId: string;
    /** Workflow trigger data ID */
    triggerDataId?: string;
};
export type WorkflowShareStepDto = {
    /** Step configuration, without credentials */
    config: {
        [key: string]: any;
    } | null;
    /** Step is enabled */
    enabled?: boolean;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra: {
        [key: string]: any;
    };
    /** Step plugin method */
    method: string;
};
export type WorkflowShareResponseDto = {
    /** Workflow description */
    description: string | null;
    /** Additional fields of an imported definition, kept and exported unchanged */
    extra: {
        [key: string]: any;
    };
    /** Workflow name */
    name: string | null;
    /** Workflow steps */
    steps: WorkflowShareStepDto[];
    /** Workflow trigger type */
    trigger: string;
};
export type LicenseResponseDto = UserLicense;
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
 * Check in with Frameleaf Cloud now
 */
export function checkInCloud(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/heartbeat", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Unlink this server from Frameleaf Cloud
 */
export function unlinkCloud(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/link", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Check the Frameleaf Cloud link
 */
export function getCloudLink(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/link", {
        ...opts
    }));
}
/**
 * Start linking this server to a Frameleaf account
 */
export function startCloudLink(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/link", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Cancel a pending link
 */
export function cancelCloudLink(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/link/pending", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get Frameleaf Cloud processing status
 */
export function getCloudMlStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlStatusResponseDto;
    }>("/admin/cloud/ml", {
        ...opts
    }));
}
/**
 * List Frameleaf Cloud models
 */
export function getCloudMlCatalog(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlCatalogResponseDto;
    }>("/admin/cloud/ml/catalog", {
        ...opts
    }));
}
/**
 * List Frameleaf Cloud consent records
 */
export function getCloudMlConsentHistory(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlConsentHistoryResponseDto;
    }>("/admin/cloud/ml/consent", {
        ...opts
    }));
}
/**
 * Describe photos with Frameleaf Cloud
 */
export function startCloudMlDescriptionBackfill({ cloudMlDescriptionBatchCreateDto }: {
    cloudMlDescriptionBatchCreateDto: CloudMlDescriptionBatchCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: CloudMlDescriptionBatchesResponseDto;
    }>("/admin/cloud/ml/descriptions/batches", oazapfts.json({
        ...opts,
        method: "POST",
        body: cloudMlDescriptionBatchCreateDto
    })));
}
/**
 * Estimate describing photos with Frameleaf Cloud
 */
export function estimateCloudMlDescriptionBackfill(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlDescriptionEstimateResponseDto;
    }>("/admin/cloud/ml/descriptions/estimate", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Add Frameleaf Cloud as a processing destination
 */
export function createCloudMlDestination({ cloudMlDestinationCreateDto }: {
    cloudMlDestinationCreateDto: CloudMlDestinationCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MlDestinationResponseDto;
    }>("/admin/cloud/ml/destination", oazapfts.json({
        ...opts,
        method: "POST",
        body: cloudMlDestinationCreateDto
    })));
}
/**
 * List the chosen Frameleaf Cloud models
 */
export function getCloudMlModelChoices(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlModelChoicesResponseDto;
    }>("/admin/cloud/ml/models", {
        ...opts
    }));
}
/**
 * Choose the Frameleaf Cloud model of a model group
 */
export function setCloudMlModelChoice({ group, cloudMlModelChoiceUpdateDto }: {
    group: CloudMlModelGroup;
    cloudMlModelChoiceUpdateDto: CloudMlModelChoiceUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlModelChoicesResponseDto;
    }>(`/admin/cloud/ml/models/${encodeURIComponent(group)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: cloudMlModelChoiceUpdateDto
    })));
}
/**
 * List settled Frameleaf Cloud charges
 */
export function getCloudMlSettlements(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlSettlementsResponseDto;
    }>("/admin/cloud/ml/settlements", {
        ...opts
    }));
}
/**
 * Apply Frameleaf Cloud settlements
 */
export function reconcileCloudMlUsage(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/admin/cloud/ml/usage", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Get the AI Wallet
 */
export function getCloudMlWallet(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlWalletDto;
    }>("/admin/cloud/ml/wallet", {
        ...opts
    }));
}
/**
 * Change the AI Wallet daily cap or automatic top-up
 */
export function updateCloudMlWallet({ cloudMlWalletUpdateDto }: {
    cloudMlWalletUpdateDto: CloudMlWalletUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudMlWalletDto;
    }>("/admin/cloud/ml/wallet", oazapfts.json({
        ...opts,
        method: "PUT",
        body: cloudMlWalletUpdateDto
    })));
}
/**
 * Choose what Frameleaf Cloud may ask this server to do
 */
export function updateCloudPermissions({ cloudPermissionsUpdateDto }: {
    cloudPermissionsUpdateDto: CloudPermissionsUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/permissions", oazapfts.json({
        ...opts,
        method: "PUT",
        body: cloudPermissionsUpdateDto
    })));
}
/**
 * Choose what remote access may carry
 */
export function updateCloudRemoteAccess({ cloudRemoteAccessUpdateDto }: {
    cloudRemoteAccessUpdateDto: CloudRemoteAccessUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/remote-access", oazapfts.json({
        ...opts,
        method: "PUT",
        body: cloudRemoteAccessUpdateDto
    })));
}
/**
 * Choose where Sign in with Frameleaf is offered
 */
export function updateCloudSignIn({ cloudSignInUpdateDto }: {
    cloudSignInUpdateDto: CloudSignInUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/sign-in", oazapfts.json({
        ...opts,
        method: "PUT",
        body: cloudSignInUpdateDto
    })));
}
/**
 * Get the Frameleaf Cloud link status
 */
export function getCloudStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: CloudStatusResponseDto;
    }>("/admin/cloud/status", {
        ...opts
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
 * List the server credentials
 */
export function getConfigCredentials(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ConfigCredentialResponseDto[];
    }>("/admin/config/credentials", {
        ...opts
    }));
}
/**
 * Clear a server credential
 */
export function deleteConfigCredential({ name }: {
    name: ConfigCredential;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ConfigCredentialResponseDto;
    }>(`/admin/config/credentials/${encodeURIComponent(name)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Replace a server credential
 */
export function updateConfigCredential({ name, configCredentialUpdateDto }: {
    name: ConfigCredential;
    configCredentialUpdateDto: ConfigCredentialUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ConfigCredentialResponseDto;
    }>(`/admin/config/credentials/${encodeURIComponent(name)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: configCredentialUpdateDto
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
 * Get the settings change history
 */
export function getAdminConfigHistory(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SystemConfigHistoryResponseDto;
    }>("/admin/config/history", {
        ...opts
    }));
}
/**
 * Get the admin configuration with its revision
 */
export function getAdminConfigWithRevision(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigRevisionResponseDto;
    }>("/admin/config/revision", {
        ...opts
    }));
}
/**
 * Update the system configuration if it is unchanged
 */
export function updateAdminConfigWithRevision({ adminConfigRevisionUpdateDto }: {
    adminConfigRevisionUpdateDto: AdminConfigRevisionUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AdminConfigRevisionResponseDto;
    } | {
        status: 409;
    }>("/admin/config/revision", oazapfts.json({
        ...opts,
        method: "PUT",
        body: adminConfigRevisionUpdateDto
    })));
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
 * Get backup restore verification
 */
export function getBackupRestoreVerification(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BackupRestoreVerificationResponseDto;
    }>("/admin/database-backups/restore-verification", {
        ...opts
    }));
}
/**
 * Record a backup restore test
 */
export function recordBackupRestoreVerification({ backupRestoreVerificationRecordDto }: {
    backupRestoreVerificationRecordDto: BackupRestoreVerificationRecordDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: BackupRestoreVerificationResponseDto;
    }>("/admin/database-backups/restore-verification", oazapfts.json({
        ...opts,
        method: "POST",
        body: backupRestoreVerificationRecordDto
    })));
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
 * Get the Hardware & GPU check
 */
export function getHardwareCheck(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: HardwareCheckResponseDto;
    }>("/admin/hardware", {
        ...opts
    }));
}
/**
 * Run a short benchmark
 */
export function runHardwareBenchmark(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: HardwareCheckResponseDto;
    }>("/admin/hardware/benchmark", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Check the GPU again
 */
export function runHardwareCheck(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: HardwareCheckResponseDto;
    }>("/admin/hardware/check", {
        ...opts,
        method: "POST"
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
 * Get integrity check runs
 */
export function getIntegrityCheckRuns(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: IntegrityCheckRunsResponseDto;
    }>("/admin/integrity/runs", {
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
 * Remove the licence key
 */
export function removeLicenseKey(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get the licence status
 */
export function getLicenseStatus(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license", {
        ...opts
    }));
}
/**
 * Activate a server licence key
 */
export function activateLicense({ licenseActivateDto }: {
    licenseActivateDto: LicenseActivateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license/activate", oazapfts.json({
        ...opts,
        method: "PUT",
        body: licenseActivateDto
    })));
}
/**
 * Install a licence file
 */
export function installLicenseCertificate({ licenseCertificateDto }: {
    licenseCertificateDto: LicenseCertificateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license/certificate", oazapfts.json({
        ...opts,
        method: "PUT",
        body: licenseCertificateDto
    })));
}
/**
 * Remove the plan from this server
 */
export function removeLicensePlan(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license/plan", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Refresh the licence now
 */
export function refreshLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseStatusResponseDto;
    }>("/admin/license/refresh", {
        ...opts,
        method: "POST"
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
 * Restore a copy of an applied physical deduplication plan
 */
export function restorePhysicalDeduplicationCopy({ id, physicalDeduplicationRestoreRequestDto }: {
    id: string;
    physicalDeduplicationRestoreRequestDto: PhysicalDeduplicationRestoreRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PhysicalDeduplicationVerificationDto;
    }>(`/admin/physical-deduplication/applies/${encodeURIComponent(id)}/restore`, oazapfts.json({
        ...opts,
        method: "POST",
        body: physicalDeduplicationRestoreRequestDto
    })));
}
/**
 * Verify an applied physical deduplication plan
 */
export function verifyPhysicalDeduplicationApply({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PhysicalDeduplicationVerificationDto;
    }>(`/admin/physical-deduplication/applies/${encodeURIComponent(id)}/verify`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Apply a reviewed physical deduplication plan
 */
export function applyPhysicalDeduplicationPlan({ physicalDeduplicationApplyRequestDto }: {
    physicalDeduplicationApplyRequestDto: PhysicalDeduplicationApplyRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>("/admin/physical-deduplication/plan/apply", oazapfts.json({
        ...opts,
        method: "POST",
        body: physicalDeduplicationApplyRequestDto
    })));
}
/**
 * Review a physical deduplication plan
 */
export function reviewPhysicalDeduplicationPlan({ physicalDeduplicationReviewRequestDto }: {
    physicalDeduplicationReviewRequestDto: PhysicalDeduplicationReviewRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PhysicalDeduplicationReviewResponseDto;
    }>("/admin/physical-deduplication/plan/review", oazapfts.json({
        ...opts,
        method: "POST",
        body: physicalDeduplicationReviewRequestDto
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
 * Get render worker compatibility
 */
export function getRenderWorkerCompatibility(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerCompatibilityResponseDto;
    }>("/admin/render-workers/compatibility", {
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
 * FL-76: the account detail's Activity tab. What administrators did to this account and its
 * libraries, newest first, recorded by the services that made each change.
 */
export function getUserHistoryAdmin({ before, id, take }: {
    before?: string;
    id: string;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminHistoryResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/history${QS.query(QS.explode({
        before,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve whether a user has a PIN
 */
export function getUserPinCodeStateAdmin({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminPinCodeStateResponseDto;
    }>(`/admin/users/${encodeURIComponent(id)}/pin-code`, {
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
 * FL-76: `SessionService.delete` only checks `Permission.AuthDeviceDelete` over the caller's
 * own sessions, so an administrator could never revoke a foreign session through it. This is
 * the explicit, audited admin path the account detail's Security tab needs instead.
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
 * Get the worker inventory
 */
export function getWorkerInventory(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: WorkerInventoryResponseDto;
    }>("/admin/workers", {
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
 * Arrange a group of the album directory
 */
export function setAlbumOrder({ albumOrderDto }: {
    albumOrderDto: AlbumOrderDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/albums/order", oazapfts.json({
        ...opts,
        method: "PUT",
        body: albumOrderDto
    })));
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
export function getAlbumMapMarkers({ fileCreatedAfter, fileCreatedBefore, id, isArchived, isFavorite, key, slug, withPartners, withSharedAlbums }: {
    fileCreatedAfter?: string;
    fileCreatedBefore?: string;
    id: string;
    isArchived?: boolean;
    isFavorite?: boolean;
    key?: string;
    slug?: string;
    withPartners?: boolean;
    withSharedAlbums?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MapMarkerResponseDto[];
    }>(`/albums/${encodeURIComponent(id)}/map-markers${QS.query(QS.explode({
        fileCreatedAfter,
        fileCreatedBefore,
        isArchived,
        isFavorite,
        key,
        slug,
        withPartners,
        withSharedAlbums
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
 * Retrieve library analytics
 */
export function getAnalyticsReport({ range, scope }: {
    range?: AnalyticsRange;
    scope?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AnalyticsReportResponseDto;
    }>(`/analytics${QS.query(QS.explode({
        range,
        scope
    }))}`, {
        ...opts
    }));
}
/**
 * List analytics scopes
 */
export function getAnalyticsScopes(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AnalyticsScopesResponseDto;
    }>("/analytics/scopes", {
        ...opts
    }));
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
 * List recent archive operations
 */
export function getArchiveOperations(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ArchiveOperationResponseDto[];
    }>("/archive-operations", {
        ...opts
    }));
}
/**
 * Archive a selection in the background
 */
export function createArchiveOperation({ archiveOperationCreateDto }: {
    archiveOperationCreateDto: ArchiveOperationCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ArchiveOperationResponseDto;
    }>("/archive-operations", oazapfts.json({
        ...opts,
        method: "POST",
        body: archiveOperationCreateDto
    })));
}
/**
 * Count and freeze every matching Timeline asset
 */
export function prepareArchiveOperation({ archiveOperationPrepareDto }: {
    archiveOperationPrepareDto: ArchiveOperationPrepareDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ArchiveOperationResponseDto;
    }>("/archive-operations/prepare", oazapfts.json({
        ...opts,
        method: "POST",
        body: archiveOperationPrepareDto
    })));
}
/**
 * Retrieve an archive operation
 */
export function getArchiveOperation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ArchiveOperationResponseDto;
    }>(`/archive-operations/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Confirm a prepared archive selection
 */
export function confirmArchiveOperation({ id, archiveOperationConfirmDto }: {
    id: string;
    archiveOperationConfirmDto: ArchiveOperationConfirmDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ArchiveOperationResponseDto;
    }>(`/archive-operations/${encodeURIComponent(id)}/confirm`, oazapfts.json({
        ...opts,
        method: "POST",
        body: archiveOperationConfirmDto
    })));
}
/**
 * Undo an archive operation
 */
export function undoArchiveOperation({ id, archiveOperationUndoDto }: {
    id: string;
    archiveOperationUndoDto: ArchiveOperationUndoDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ArchiveOperationResponseDto;
    }>(`/archive-operations/${encodeURIComponent(id)}/undo`, oazapfts.json({
        ...opts,
        method: "POST",
        body: archiveOperationUndoDto
    })));
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
 * List exports of an original for editing elsewhere
 */
export function getAssetDevelopExports({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DevelopExportResponseDto[];
    }>(`/assets/${encodeURIComponent(id)}/develop/exports`, {
        ...opts
    }));
}
/**
 * Export an original for editing elsewhere
 */
export function createAssetDevelopExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: DevelopExportResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop/exports`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Bring back a file developed elsewhere
 */
export function importAssetDevelopRendition({ id, assetDevelopImportDto }: {
    id: string;
    assetDevelopImportDto: AssetDevelopImportDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: AssetDevelopRevisionResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/develop/imports`, oazapfts.multipart({
        ...opts,
        method: "POST",
        body: assetDevelopImportDto
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
 * List saved video versions
 */
export function getVideoEditVersions({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoEditVersionResponseDto[];
    }>(`/assets/${encodeURIComponent(id)}/edit-versions`, {
        ...opts
    }));
}
/**
 * Export the current video version
 */
export function exportVideoEditVersion({ id, videoEditExportDto }: {
    id: string;
    videoEditExportDto: VideoEditExportDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: VideoEditVersionResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/edit-versions/export`, oazapfts.json({
        ...opts,
        method: "POST",
        body: videoEditExportDto
    })));
}
/**
 * Prune an unselected video version
 */
export function pruneVideoEditVersion({ id, versionId }: {
    id: string;
    versionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/edit-versions/${encodeURIComponent(versionId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Download a video version master
 */
export function downloadVideoEditVersion({ id, versionId }: {
    id: string;
    versionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/edit-versions/${encodeURIComponent(versionId)}/download`, {
        ...opts
    }));
}
/**
 * Restore a saved video version
 */
export function restoreVideoEditVersion({ id, versionId }: {
    id: string;
    versionId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/assets/${encodeURIComponent(id)}/edit-versions/${encodeURIComponent(versionId)}/restore`, {
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
 * List the original video's keyframes
 */
export function getAssetEditKeyframes({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetEditKeyframesResponseDto;
    }>(`/assets/${encodeURIComponent(id)}/edits/keyframes`, {
        ...opts
    }));
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
export function playAssetVideo({ edited, id, key, slug }: {
    edited?: boolean;
    id: string;
    key?: string;
    slug?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/assets/${encodeURIComponent(id)}/video/playback${QS.query(QS.explode({
        edited,
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
 * Retrieve classification contributions for an asset
 */
export function getAssetClassifications({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationContributionDto[];
    }>(`/classification/assets/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Preview a classification rule
 */
export function previewClassificationRule({ classificationPreviewDto }: {
    classificationPreviewDto: ClassificationPreviewDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationPreviewResponseDto;
    }>("/classification/preview", oazapfts.json({
        ...opts,
        method: "POST",
        body: classificationPreviewDto
    })));
}
/**
 * List classification rules
 */
export function getClassificationRules({ albumId }: {
    albumId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationRuleResponseDto[];
    }>(`/classification/rules${QS.query(QS.explode({
        albumId
    }))}`, {
        ...opts
    }));
}
/**
 * Create a classification rule
 */
export function createClassificationRule({ classificationRuleCreateDto }: {
    classificationRuleCreateDto: ClassificationRuleCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: ClassificationRuleResponseDto;
    }>("/classification/rules", oazapfts.json({
        ...opts,
        method: "POST",
        body: classificationRuleCreateDto
    })));
}
/**
 * Delete a classification rule
 */
export function deleteClassificationRule({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/classification/rules/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve a classification rule
 */
export function getClassificationRule({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationRuleResponseDto;
    }>(`/classification/rules/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Update a classification rule
 */
export function updateClassificationRule({ id, classificationRuleUpdateDto }: {
    id: string;
    classificationRuleUpdateDto: ClassificationRuleUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationRuleResponseDto;
    }>(`/classification/rules/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: classificationRuleUpdateDto
    })));
}
/**
 * Apply a classification rule
 */
export function applyClassificationRule({ id, classificationApplyDto }: {
    id: string;
    classificationApplyDto: ClassificationApplyDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationApplyResponseDto;
    }>(`/classification/rules/${encodeURIComponent(id)}/apply`, oazapfts.json({
        ...opts,
        method: "POST",
        body: classificationApplyDto
    })));
}
/**
 * Review classification rule matches
 */
export function decideClassificationRuleMatches({ id, classificationDecisionDto }: {
    id: string;
    classificationDecisionDto: ClassificationDecisionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationDecisionResponseDto;
    }>(`/classification/rules/${encodeURIComponent(id)}/decisions`, oazapfts.json({
        ...opts,
        method: "POST",
        body: classificationDecisionDto
    })));
}
/**
 * List classification rule matches
 */
export function getClassificationRuleMatches({ decision, id, page, size }: {
    decision?: ClassificationMatchDecision;
    id: string;
    page?: number;
    size?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationMatchPageDto;
    }>(`/classification/rules/${encodeURIComponent(id)}/matches${QS.query(QS.explode({
        decision,
        page,
        size
    }))}`, {
        ...opts
    }));
}
/**
 * Plan a classification rule re-evaluation
 */
export function planClassificationRule({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationPlanResponseDto;
    }>(`/classification/rules/${encodeURIComponent(id)}/plan`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve classification rule settings
 */
export function getClassificationSettings(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ClassificationSettingsDto;
    }>("/classification/settings", {
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
 * List develop presets
 */
export function getDevelopPresets(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DevelopPresetResponseDto[];
    }>("/develop-presets", {
        ...opts
    }));
}
/**
 * Save a develop preset
 */
export function createDevelopPreset({ developPresetCreateDto }: {
    developPresetCreateDto: DevelopPresetCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: DevelopPresetResponseDto;
    }>("/develop-presets", oazapfts.json({
        ...opts,
        method: "POST",
        body: developPresetCreateDto
    })));
}
/**
 * Delete a develop preset
 */
export function deleteDevelopPreset({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/develop-presets/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Update a develop preset
 */
export function updateDevelopPreset({ id, developPresetUpdateDto }: {
    id: string;
    developPresetUpdateDto: DevelopPresetUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DevelopPresetResponseDto;
    }>(`/develop-presets/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: developPresetUpdateDto
    })));
}
/**
 * Search documents
 */
export function searchDocuments({ page, query, size }: {
    page?: number;
    query?: string;
    size?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentSearchResponseDto;
    }>(`/documents${QS.query(QS.explode({
        page,
        query,
        size
    }))}`, {
        ...opts
    }));
}
/**
 * Retrieve a document
 */
export function getDocument({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentResponseDto;
    }>(`/documents/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Clear a document field decision
 */
export function deleteDocumentField({ field, id, revision }: {
    field: DocumentField;
    id: string;
    revision: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentResponseDto;
    }>(`/documents/${encodeURIComponent(id)}/fields/${encodeURIComponent(field)}${QS.query(QS.explode({
        revision
    }))}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Decide a document field
 */
export function updateDocumentField({ field, id, documentFieldEditDto }: {
    field: DocumentField;
    id: string;
    documentFieldEditDto: DocumentFieldEditDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentResponseDto;
    }>(`/documents/${encodeURIComponent(id)}/fields/${encodeURIComponent(field)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: documentFieldEditDto
    })));
}
/**
 * Correct or dismiss a line of text
 */
export function updateDocumentLine({ id, documentLineEditDto }: {
    id: string;
    documentLineEditDto: DocumentLineEditDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentResponseDto;
    }>(`/documents/${encodeURIComponent(id)}/lines`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: documentLineEditDto
    })));
}
/**
 * Restore a line of text
 */
export function deleteDocumentLine({ editId, id, revision }: {
    editId: string;
    id: string;
    revision: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DocumentResponseDto;
    }>(`/documents/${encodeURIComponent(id)}/lines/${encodeURIComponent(editId)}${QS.query(QS.explode({
        revision
    }))}`, {
        ...opts,
        method: "DELETE"
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
 * Retrieve recent duplicate decisions
 */
export function getDuplicateDecisions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DuplicateDecisionHistoryDto;
    }>("/duplicates/decisions", {
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
 * Retrieve the duplicate review
 */
export function getDuplicateReview(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: DuplicateReviewGroupDto[];
    }>("/duplicates/review", {
        ...opts
    }));
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
 * Get a video moment frame
 */
export function getVideoMomentFrame({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/enrichment/frames/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Find moments like a video frame
 */
export function searchSimilarVideoMoments({ id, limit }: {
    id: string;
    limit?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoMomentSearchResponseDto;
    }>(`/enrichment/frames/${encodeURIComponent(id)}/similar${QS.query(QS.explode({
        limit
    }))}`, {
        ...opts
    }));
}
/**
 * Search video moments
 */
export function searchVideoMoments({ videoMomentSearchDto }: {
    videoMomentSearchDto: VideoMomentSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoMomentSearchResponseDto;
    }>("/enrichment/moments/search", oazapfts.json({
        ...opts,
        method: "POST",
        body: videoMomentSearchDto
    })));
}
/**
 * Get enrichment options
 */
export function getEnrichmentOptions(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: EnrichmentOptionsResponseDto;
    }>("/enrichment/options", {
        ...opts
    }));
}
/**
 * Queue an enrichment plan
 */
export function createEnrichmentPlan({ enrichmentPlanCreateDto }: {
    enrichmentPlanCreateDto: EnrichmentPlanCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: EnrichmentPlanResponseDto;
    }>("/enrichment/plans", oazapfts.json({
        ...opts,
        method: "POST",
        body: enrichmentPlanCreateDto
    })));
}
/**
 * Get an enrichment plan
 */
export function getEnrichmentPlan({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: EnrichmentPlanResponseDto;
    }>(`/enrichment/plans/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Preview an enrichment change
 */
export function previewEnrichment({ enrichmentPreviewRequestDto }: {
    enrichmentPreviewRequestDto: EnrichmentPreviewRequestDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: EnrichmentPreviewResponseDto;
    }>("/enrichment/preview", oazapfts.json({
        ...opts,
        method: "POST",
        body: enrichmentPreviewRequestDto
    })));
}
/**
 * Choose a video cover frame
 */
export function setVideoMomentCover({ id, videoMomentCoverDto }: {
    id: string;
    videoMomentCoverDto: VideoMomentCoverDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoMomentsResponseDto;
    }>(`/enrichment/videos/${encodeURIComponent(id)}/cover`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: videoMomentCoverDto
    })));
}
/**
 * Get video moments
 */
export function getVideoMoments({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoMomentsResponseDto;
    }>(`/enrichment/videos/${encodeURIComponent(id)}/moments`, {
        ...opts
    }));
}
/**
 * Add a video moment
 */
export function createVideoMoment({ id, videoMomentCreateDto }: {
    id: string;
    videoMomentCreateDto: VideoMomentCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: VideoMomentDto;
    }>(`/enrichment/videos/${encodeURIComponent(id)}/moments`, oazapfts.json({
        ...opts,
        method: "POST",
        body: videoMomentCreateDto
    })));
}
/**
 * Delete a video moment
 */
export function deleteVideoMoment({ id, momentId }: {
    id: string;
    momentId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/enrichment/videos/${encodeURIComponent(id)}/moments/${encodeURIComponent(momentId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Update a video moment
 */
export function updateVideoMoment({ id, momentId, videoMomentUpdateDto }: {
    id: string;
    momentId: string;
    videoMomentUpdateDto: VideoMomentUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: VideoMomentDto;
    }>(`/enrichment/videos/${encodeURIComponent(id)}/moments/${encodeURIComponent(momentId)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: videoMomentUpdateDto
    })));
}
/**
 * Retrieve faces for asset
 */
export function getFaces({ id, withHidden }: {
    id: string;
    withHidden?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFaceResponseDto[];
    }>(`/faces${QS.query(QS.explode({
        id,
        withHidden
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
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: AssetFaceResponseDto;
    }>("/faces", oazapfts.json({
        ...opts,
        method: "POST",
        body: assetFaceCreateDto
    })));
}
/**
 * Retrieve the face source revision for an asset
 */
export function getFaceSource({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFaceSourceResponseDto;
    }>(`/faces/source${QS.query(QS.explode({
        id
    }))}`, {
        ...opts
    }));
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
 * Correct a face
 */
export function correctFace({ id, assetFaceCorrectionDto }: {
    id: string;
    assetFaceCorrectionDto: AssetFaceCorrectionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: AssetFaceResponseDto;
    }>(`/faces/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PATCH",
        body: assetFaceCorrectionDto
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
export function removeICloudConnection({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/icloud-sync/connections/${encodeURIComponent(id)}/remove`, {
        ...opts,
        method: "POST"
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
export function getAllLibraries({ withDeleted }: {
    withDeleted?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryResponseDto[];
    }>(`/libraries${QS.query(QS.explode({
        withDeleted
    }))}`, {
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
 * Retrieve managed upload statistics
 */
export function getManagedUploadStatistics(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ManagedUploadsStatsResponseDto[];
    }>("/libraries/managed-uploads", {
        ...opts
    }));
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
 * Review a library removal
 */
export function getLibraryRemovalReview({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LibraryRemovalReviewDto;
    }>(`/libraries/${encodeURIComponent(id)}/removal`, {
        ...opts
    }));
}
/**
 * Remove a library
 */
export function removeLibrary({ id, libraryRemovalDto }: {
    id: string;
    libraryRemovalDto: LibraryRemovalDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/libraries/${encodeURIComponent(id)}/removal`, oazapfts.json({
        ...opts,
        method: "POST",
        body: libraryRemovalDto
    })));
}
/**
 * Cancel a library scan
 */
export function cancelLibraryScan({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/libraries/${encodeURIComponent(id)}/scan`, {
        ...opts,
        method: "DELETE"
    }));
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
 * Get Support Frameleaf prices
 */
export function getLicenseProducts(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: LicenseProductsResponseDto;
    }>("/license/products", {
        ...opts
    }));
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
 * Retrieve map statistics
 */
export function getMapStatistics({ fileCreatedAfter, fileCreatedBefore, isArchived, isFavorite, withPartners, withSharedAlbums }: {
    fileCreatedAfter?: string;
    fileCreatedBefore?: string;
    isArchived?: boolean;
    isFavorite?: boolean;
    withPartners?: boolean;
    withSharedAlbums?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MapStatisticsResponseDto;
    }>(`/map/statistics${QS.query(QS.explode({
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
 * List media health findings
 */
export function list({ allAccounts, category, needsAttention, ownerId, page, size, status }: {
    allAccounts?: boolean;
    category?: MediaHealthCategory;
    needsAttention?: boolean;
    ownerId?: string;
    page?: number;
    size?: number;
    status?: MediaHealthStatus;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaHealthListResponseDto;
    }>(`/media-health${QS.query(QS.explode({
        allAccounts,
        category,
        needsAttention,
        ownerId,
        page,
        size,
        status
    }))}`, {
        ...opts
    }));
}
/**
 * Choose media health candidates
 */
export function chooseCandidates({ mediaHealthChooseCandidatesDto }: {
    mediaHealthChooseCandidatesDto: MediaHealthChooseCandidatesDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthBulkResponseDto;
    }>("/media-health/candidates/choose", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthChooseCandidatesDto
    })));
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
 * Recover damaged media from a verified copy
 */
export function recoverDamaged({ mediaHealthRecoverDto }: {
    mediaHealthRecoverDto: MediaHealthRecoverDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthBulkResponseDto;
    }>("/media-health/corrupt/recover", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthRecoverDto
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
export function locateMissing({ mediaHealthLocateDto }: {
    mediaHealthLocateDto: MediaHealthLocateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthScanResponseDto;
    }>("/media-health/missing/locate", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthLocateDto
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
 * Reopen media health findings
 */
export function reopen({ mediaHealthBulkActionDto }: {
    mediaHealthBulkActionDto: MediaHealthBulkActionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaHealthBulkResponseDto;
    }>("/media-health/reopen", oazapfts.json({
        ...opts,
        method: "POST",
        body: mediaHealthBulkActionDto
    })));
}
/**
 * List Library Care search locations
 */
export function getRoots(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaHealthRootsResponseDto;
    }>("/media-health/roots", {
        ...opts
    }));
}
/**
 * Get Library Care summary
 */
export function getSummary({ allAccounts, ownerId }: {
    allAccounts?: boolean;
    ownerId?: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MediaHealthSummaryResponseDto;
    }>(`/media-health/summary${QS.query(QS.explode({
        allAccounts,
        ownerId
    }))}`, {
        ...opts
    }));
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
export function searchMemories({ $for, id, isHidden, isSaved, isTrashed, isUpcoming, order, page, size, $type }: {
    $for?: string;
    id?: string;
    isHidden?: boolean;
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
        isHidden,
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
 * Remove a memories show-less rule
 */
export function removeMemoryShowLess({ memoryShowLessDto }: {
    memoryShowLessDto: MemoryShowLessDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryShowLessResponseDto[];
    }>("/memories/show-less", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: memoryShowLessDto
    })));
}
/**
 * Retrieve memories show-less rules
 */
export function getMemoryShowLess(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryShowLessResponseDto[];
    }>("/memories/show-less", {
        ...opts
    }));
}
/**
 * Show less of a person, pet, date or kind of memory
 */
export function addMemoryShowLess({ memoryShowLessDto }: {
    memoryShowLessDto: MemoryShowLessDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: MemoryShowLessResponseDto[];
    }>("/memories/show-less", oazapfts.json({
        ...opts,
        method: "POST",
        body: memoryShowLessDto
    })));
}
/**
 * Retrieve memories statistics
 */
export function memoriesStatistics({ $for, id, isHidden, isSaved, isTrashed, isUpcoming, order, page, size, $type }: {
    $for?: string;
    id?: string;
    isHidden?: boolean;
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
        isHidden,
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
export function admitMlDestination({ id, mlAdmissionRequestDto }: {
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
 * Redirect OAuth to the Frameleaf mobile app
 */
export function redirectOAuthToFrameleafMobile(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/oauth/frameleaf-mobile-redirect", {
        ...opts
    }));
}
/**
 * Start Sign in with Frameleaf
 */
export function startFrameleafSignIn({ oAuthConfigDto }: {
    oAuthConfigDto: OAuthConfigDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: OAuthAuthorizeResponseDto;
    }>("/oauth/frameleaf/authorize", oazapfts.json({
        ...opts,
        method: "POST",
        body: oAuthConfigDto
    })));
}
/**
 * Finish Sign in with Frameleaf
 */
export function finishFrameleafSignIn({ oAuthCallbackDto }: {
    oAuthCallbackDto: OAuthCallbackDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LoginResponseDto;
    }>("/oauth/frameleaf/callback", oazapfts.json({
        ...opts,
        method: "POST",
        body: oAuthCallbackDto
    })));
}
/**
 * Hand a Sign in with Frameleaf session to another address
 */
export function createFrameleafHandoff(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: FrameleafHandoffResponseDto;
    }>("/oauth/frameleaf/handoff", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Sign in with a handoff code
 */
export function redeemFrameleafHandoff({ frameleafHandoffRedeemDto }: {
    frameleafHandoffRedeemDto: FrameleafHandoffRedeemDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: LoginResponseDto;
    }>("/oauth/frameleaf/handoff/redeem", oazapfts.json({
        ...opts,
        method: "POST",
        body: frameleafHandoffRedeemDto
    })));
}
/**
 * Unlink your Frameleaf account
 */
export function unlinkFrameleafAccount(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/oauth/frameleaf/link", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get your Frameleaf account link
 */
export function getFrameleafAccountLink(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafAccountLinkResponseDto;
    }>("/oauth/frameleaf/link", {
        ...opts
    }));
}
/**
 * Link your Frameleaf account
 */
export function linkFrameleafAccount({ oAuthCallbackDto }: {
    oAuthCallbackDto: OAuthCallbackDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserAdminResponseDto;
    }>("/oauth/frameleaf/link", oazapfts.json({
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
 * Undo a face correction
 */
export function undoCorrection({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonCorrectionDto;
    }>(`/people/corrections/${encodeURIComponent(id)}/undo`, {
        ...opts,
        method: "POST"
    }));
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
 * Undo a merge suggestion verdict
 */
export function deleteMergeVerdict({ personMergeVerdictDeleteDto }: {
    personMergeVerdictDeleteDto: PersonMergeVerdictDeleteDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/people/merge-suggestions/verdicts", oazapfts.json({
        ...opts,
        method: "DELETE",
        body: personMergeVerdictDeleteDto
    })));
}
/**
 * Record a merge suggestion verdict
 */
export function setMergeVerdict({ personMergeVerdictCreateDto }: {
    personMergeVerdictCreateDto: PersonMergeVerdictCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonMergeVerdictResponseDto;
    }>("/people/merge-suggestions/verdicts", oazapfts.json({
        ...opts,
        method: "PUT",
        body: personMergeVerdictCreateDto
    })));
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
 * Get correction history
 */
export function getCorrectionHistory({ id, page, size }: {
    id: string;
    page?: number;
    size?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PersonCorrectionsResponseDto;
    }>(`/people/${encodeURIComponent(id)}/corrections${QS.query(QS.explode({
        page,
        size
    }))}`, {
        ...opts
    }));
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
export function rejectPetCandidate({ id, petCandidateRejectDto }: {
    id: string;
    petCandidateRejectDto: PetCandidateRejectDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetObservationResponseDto;
    }>(`/pets/candidates/${encodeURIComponent(id)}/reject`, oazapfts.json({
        ...opts,
        method: "POST",
        body: petCandidateRejectDto
    })));
}
/**
 * Retrieve the pet observations of an asset
 */
export function getAssetPetObservations({ assetId }: {
    assetId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetObservationResponseDto[];
    }>(`/pets/observations${QS.query(QS.explode({
        assetId
    }))}`, {
        ...opts
    }));
}
/**
 * Remove a pet observation
 */
export function deletePetObservation({ expectedChecksum, id }: {
    expectedChecksum?: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/pets/observations/${encodeURIComponent(id)}${QS.query(QS.explode({
        expectedChecksum
    }))}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Cancel pet recognition
 */
export function cancelPetRecognition(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetRecognitionStatusResponseDto;
    }>("/pets/recognition", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Retrieve pet recognition status
 */
export function getPetRecognition(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PetRecognitionStatusResponseDto;
    }>("/pets/recognition", {
        ...opts
    }));
}
/**
 * Start pet recognition
 */
export function startPetRecognition(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PetRecognitionStatusResponseDto;
    }>("/pets/recognition", {
        ...opts,
        method: "POST"
    }));
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
 * List preservation packages
 */
export function getPreservationPackages(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationPackageDto[];
    }>("/preservation/packages", {
        ...opts
    }));
}
/**
 * Create a preservation package
 */
export function createPreservationPackage({ preservationExportCreateDto }: {
    preservationExportCreateDto: PreservationExportCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PreservationPackageDto;
    }>("/preservation/packages", oazapfts.json({
        ...opts,
        method: "POST",
        body: preservationExportCreateDto
    })));
}
/**
 * Remove a preservation package
 */
export function removePreservationPackage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/preservation/packages/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a preservation package
 */
export function getPreservationPackage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationPackageDto;
    }>(`/preservation/packages/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Download a preservation package
 */
export function downloadPreservationPackage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/preservation/packages/${encodeURIComponent(id)}/download`, {
        ...opts
    }));
}
/**
 * Get a preservation package item report
 */
export function getPreservationPackageItems({ id, skip, state, take, verifyState }: {
    id: string;
    skip?: number;
    state?: PreservationItemState;
    take?: number;
    verifyState?: PreservationVerifyState;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationItemsResponseDto;
    }>(`/preservation/packages/${encodeURIComponent(id)}/items${QS.query(QS.explode({
        skip,
        state,
        take,
        verifyState
    }))}`, {
        ...opts
    }));
}
/**
 * Download a preservation manifest
 */
export function downloadPreservationManifest({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/preservation/packages/${encodeURIComponent(id)}/manifest`, {
        ...opts
    }));
}
/**
 * Retry a preservation export
 */
export function retryPreservationPackage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>(`/preservation/packages/${encodeURIComponent(id)}/retry`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Verify a preservation package
 */
export function verifyPreservationPackage({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>(`/preservation/packages/${encodeURIComponent(id)}/verify`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Preview a preservation export
 */
export function previewPreservationExport({ preservationPreviewDto }: {
    preservationPreviewDto: PreservationPreviewDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationPreviewResponseDto;
    }>("/preservation/preview", oazapfts.json({
        ...opts,
        method: "POST",
        body: preservationPreviewDto
    })));
}
/**
 * List restorations
 */
export function getPreservationRestores(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationRestoreDto[];
    }>("/preservation/restores", {
        ...opts
    }));
}
/**
 * Start a restoration
 */
export function createPreservationRestore({ preservationRestoreCreateDto }: {
    preservationRestoreCreateDto: PreservationRestoreCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PreservationRestoreDto;
    }>("/preservation/restores", oazapfts.json({
        ...opts,
        method: "POST",
        body: preservationRestoreCreateDto
    })));
}
/**
 * Get a restoration
 */
export function getPreservationRestore({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationRestoreDto;
    }>(`/preservation/restores/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Restore a reviewed package
 */
export function applyPreservationRestore({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: MediaOperationDto;
    }>(`/preservation/restores/${encodeURIComponent(id)}/apply`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Record restoration choices
 */
export function updatePreservationRestoreDecisions({ id, preservationDecisionsUpdateDto }: {
    id: string;
    preservationDecisionsUpdateDto: PreservationDecisionsUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationRestoreDto;
    }>(`/preservation/restores/${encodeURIComponent(id)}/decisions`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: preservationDecisionsUpdateDto
    })));
}
/**
 * Get restoration items
 */
export function getPreservationRestoreItems({ filter, id, skip, take }: {
    filter?: PreservationRestoreItemFilter;
    id: string;
    skip?: number;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: PreservationRestoreItemsResponseDto;
    }>(`/preservation/restores/${encodeURIComponent(id)}/items${QS.query(QS.explode({
        filter,
        skip,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Register a preservation package on the server
 */
export function registerPreservationServerPackage({ preservationServerPackageCreateDto }: {
    preservationServerPackageCreateDto: PreservationServerPackageCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PreservationPackageDto;
    }>("/preservation/server-packages", oazapfts.json({
        ...opts,
        method: "POST",
        body: preservationServerPackageCreateDto
    })));
}
/**
 * Upload a preservation package
 */
export function uploadPreservationPackage({ preservationUploadCreateDto }: {
    preservationUploadCreateDto: PreservationUploadCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: PreservationPackageDto;
    }>("/preservation/uploads", oazapfts.multipart({
        ...opts,
        method: "POST",
        body: preservationUploadCreateDto
    })));
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
export function getQueueJobs({ name, ownerId, status }: {
    name: QueueName;
    ownerId?: string;
    status?: QueueJobStatus[];
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueJobResponseDto[];
    }>(`/queues/${encodeURIComponent(name)}/jobs${QS.query(QS.explode({
        ownerId,
        status
    }))}`, {
        ...opts
    }));
}
/**
 * Retry failed queue jobs
 */
export function retryFailedQueueJobs({ name }: {
    name: QueueName;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueRetryFailedResponseDto;
    }>(`/queues/${encodeURIComponent(name)}/jobs/retry-failed`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve queue statistics for an account
 */
export function getQueueOwnerStatistics({ name, ownerId }: {
    name: QueueName;
    ownerId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: QueueOwnerStatisticsResponseDto;
    }>(`/queues/${encodeURIComponent(name)}/statistics${QS.query(QS.explode({
        ownerId
    }))}`, {
        ...opts
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
export function claimRenderOperation({ xFrameleafWorkerSession, renderWorkerClaimRequestDto }: {
    xFrameleafWorkerSession: string;
    renderWorkerClaimRequestDto: RenderWorkerClaimRequestDto;
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
export function acknowledgeRenderCancel({ id, xFrameleafWorkerSession, renderWorkerCancelAckDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerCancelAckDto: RenderWorkerCancelAckDto;
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
export function planRenderCheckpoint({ id, xFrameleafWorkerSession, renderWorkerCheckpointPlanDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerCheckpointPlanDto: RenderWorkerCheckpointPlanDto;
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
export function completeRenderCheckpoint({ id, sequence, xFrameleafWorkerSession, renderWorkerCheckpointCompleteDto }: {
    id: string;
    sequence: number;
    xFrameleafWorkerSession: string;
    renderWorkerCheckpointCompleteDto: RenderWorkerCheckpointCompleteDto;
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
export function completeRenderOperation({ id, xFrameleafWorkerSession, renderWorkerCompleteDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerCompleteDto: RenderWorkerCompleteDto;
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
export function failRenderOperation({ id, xFrameleafWorkerSession, renderWorkerFailDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerFailDto: RenderWorkerFailDto;
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
export function heartbeatRenderOperation({ id, xFrameleafWorkerSession, renderWorkerHeartbeatDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerHeartbeatDto: RenderWorkerHeartbeatDto;
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
export function reportRenderOperationProgress({ id, xFrameleafWorkerSession, renderWorkerProgressDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerProgressDto: RenderWorkerProgressDto;
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
export function validateRenderOperation({ id, xFrameleafWorkerSession, renderWorkerCompleteDto }: {
    id: string;
    xFrameleafWorkerSession: string;
    renderWorkerCompleteDto: RenderWorkerCompleteDto;
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
 * List what this worker must stop or delete
 */
export function getRenderRemoteReferences({ xFrameleafWorkerSession }: {
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerRemoteReferenceDto[];
    }>("/render-workers/remote-references", {
        ...opts,
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
    }));
}
/**
 * Acknowledge a remote reference
 */
export function acknowledgeRenderRemoteReference({ id, xFrameleafWorkerSession }: {
    id: string;
    xFrameleafWorkerSession: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RenderWorkerWriteResultDto;
    }>(`/render-workers/remote-references/${encodeURIComponent(id)}/acknowledge`, {
        ...opts,
        method: "POST",
        headers: oazapfts.mergeHeaders(opts?.headers, {
            "x-frameleaf-worker-session": xFrameleafWorkerSession
        })
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
 * Retrieve asset counts by city
 */
export function getCityAssetCounts(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchCityCountResponseDto[];
    }>("/search/cities/counts", {
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
 * Search facet counts
 */
export function searchFacets({ searchFacetsDto }: {
    searchFacetsDto: SearchFacetsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchFacetsResponseDto;
    }>("/search/facets", oazapfts.json({
        ...opts,
        method: "POST",
        body: searchFacetsDto
    })));
}
/**
 * Search date histogram
 */
export function searchHistogram({ searchHistogramDto }: {
    searchHistogramDto: SearchHistogramDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SearchHistogramResponseDto;
    }>("/search/histogram", oazapfts.json({
        ...opts,
        method: "POST",
        body: searchHistogramDto
    })));
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
 * Smart search statistics
 */
export function searchSmartStatistics({ smartSearchDto }: {
    smartSearchDto: SmartSearchDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: SmartSearchStatisticsResponseDto;
    }>("/search/smart/statistics", oazapfts.json({
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
    } | {
        status: 404;
    }>("/server/apk-links", {
        ...opts
    }));
}
/**
 * Get app releases
 */
export function getAppReleases(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ServerAppReleasesResponseDto;
    }>("/server/app-releases", {
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
 * Check for updates now
 */
export function checkVersionNow(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: ReleaseEventV1;
    }>("/server/version-check", {
        ...opts,
        method: "POST"
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
 * List recipient groups
 */
export function getRecipientGroups(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RecipientGroupResponseDto[];
    }>("/shared-spaces/recipient-groups", {
        ...opts
    }));
}
/**
 * Create a recipient group
 */
export function createRecipientGroup({ recipientGroupCreateDto }: {
    recipientGroupCreateDto: RecipientGroupCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: RecipientGroupResponseDto;
    }>("/shared-spaces/recipient-groups", oazapfts.json({
        ...opts,
        method: "POST",
        body: recipientGroupCreateDto
    })));
}
/**
 * Delete a recipient group
 */
export function deleteRecipientGroup({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/recipient-groups/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Update a recipient group
 */
export function updateRecipientGroup({ id, recipientGroupUpdateDto }: {
    id: string;
    recipientGroupUpdateDto: RecipientGroupUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: RecipientGroupResponseDto;
    }>(`/shared-spaces/recipient-groups/${encodeURIComponent(id)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: recipientGroupUpdateDto
    })));
}
/**
 * Accept a shared space invitation
 */
export function acceptSharedSpaceInvitation({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: AlbumResponseDto;
    }>(`/shared-spaces/${encodeURIComponent(id)}/accept`, {
        ...opts,
        method: "POST"
    }));
}
/**
 * What happened in a shared space
 */
export function getSharedSpaceActivity({ before, id, take }: {
    before?: string;
    id: string;
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
export function unlinkSharedSpaceAlbum({ albumId, id }: {
    albumId: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/albums/${encodeURIComponent(albumId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Link an album into a shared space
 */
export function linkSharedSpaceAlbum({ albumId, id }: {
    albumId: string;
    id: string;
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
export function getSharedSpaceComments({ assetId, id }: {
    assetId?: string;
    id: string;
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
export function deleteSharedSpaceComment({ commentId, id }: {
    commentId: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/shared-spaces/${encodeURIComponent(id)}/comments/${encodeURIComponent(commentId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Edit a shared space comment
 */
export function updateSharedSpaceComment({ commentId, id, sharedSpaceCommentUpdateDto }: {
    commentId: string;
    id: string;
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
 * Get a Studio export
 */
export function getStudioExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioExportVersionDto;
    }>(`/studio/exports/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Download a Studio export kept with its project
 */
export function downloadStudioExport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchBlob<{
        status: 200;
        data: Blob;
    }>(`/studio/exports/${encodeURIComponent(id)}/download`, {
        ...opts
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
 * List Studio projects
 */
export function searchStudioProjects({ query, shelf, skip, sort, take }: {
    query?: string;
    shelf?: StudioProjectShelf;
    skip?: number;
    sort?: StudioProjectSort;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
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
 * List a Studio project’s exports
 */
export function getStudioExports({ id, skip, take }: {
    id: string;
    skip?: number;
    take?: number;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioExportListResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/exports${QS.query(QS.explode({
        skip,
        take
    }))}`, {
        ...opts
    }));
}
/**
 * Export a Studio project
 */
export function createStudioExport({ id, studioExportCreateDto }: {
    id: string;
    studioExportCreateDto: StudioExportCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: StudioExportCreateResponseDto;
    }>(`/studio/projects/${encodeURIComponent(id)}/exports`, oazapfts.json({
        ...opts,
        method: "POST",
        body: studioExportCreateDto
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
 * Get your Studio workspace layout
 */
export function getStudioWorkspace(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioWorkspaceDto;
    }>("/studio/workspace", {
        ...opts
    }));
}
/**
 * Save your Studio workspace layout
 */
export function saveStudioWorkspace({ studioWorkspaceSaveDto }: {
    studioWorkspaceSaveDto: StudioWorkspaceSaveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: StudioWorkspaceDto;
    }>("/studio/workspace", oazapfts.json({
        ...opts,
        method: "PUT",
        body: studioWorkspaceSaveDto
    })));
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
 * Retrieve Frameleaf setup
 */
export function getFrameleafSetup(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafSetupResponseDto;
    }>("/system-metadata/frameleaf-setup", {
        ...opts
    }));
}
/**
 * Save Frameleaf setup progress
 */
export function updateFrameleafSetup({ frameleafSetupUpdateDto }: {
    frameleafSetupUpdateDto: FrameleafSetupUpdateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafSetupResponseDto;
    }>("/system-metadata/frameleaf-setup", oazapfts.json({
        ...opts,
        method: "PUT",
        body: frameleafSetupUpdateDto
    })));
}
/**
 * Finish Frameleaf setup
 */
export function finishFrameleafSetup(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafSetupResponseDto;
    }>("/system-metadata/frameleaf-setup/finish", {
        ...opts,
        method: "POST"
    }));
}
/**
 * Retrieve library totals for setup
 */
export function getFrameleafSetupLibrary(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafSetupLibraryResponseDto;
    }>("/system-metadata/frameleaf-setup/library", {
        ...opts
    }));
}
/**
 * Check library storage for setup
 */
export function getFrameleafSetupStorage(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FrameleafSetupStorageResponseDto;
    }>("/system-metadata/frameleaf-setup/storage", {
        ...opts
    }));
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
 * Retrieve tag statistics
 */
export function getTagStatistics(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TagStatisticsResponseDto[];
    }>("/tags/statistics", {
        ...opts
    }));
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
 * List Google Photos imports
 */
export function listTakeoutImports(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto[];
    }>("/takeout", {
        ...opts
    }));
}
/**
 * Start a Google Photos import
 */
export function createTakeoutImport({ takeoutCreateDto }: {
    takeoutCreateDto: TakeoutCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: TakeoutResponseDto;
    }>("/takeout", oazapfts.json({
        ...opts,
        method: "POST",
        body: takeoutCreateDto
    })));
}
/**
 * List the permitted import locations
 */
export function getTakeoutRoots(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutRootsResponseDto;
    }>("/takeout/roots", {
        ...opts
    }));
}
/**
 * Delete a Google Photos import
 */
export function deleteTakeoutImport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/takeout/${encodeURIComponent(id)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get a Google Photos import
 */
export function getTakeoutImport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}`, {
        ...opts
    }));
}
/**
 * Stage a Takeout archive
 */
export function createTakeoutArchive({ id, takeoutArchiveCreateDto }: {
    id: string;
    takeoutArchiveCreateDto: TakeoutArchiveCreateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 201;
        data: TakeoutSourceResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/archives`, oazapfts.json({
        ...opts,
        method: "POST",
        body: takeoutArchiveCreateDto
    })));
}
/**
 * Remove a staged Takeout archive
 */
export function deleteTakeoutArchive({ archiveId, id }: {
    archiveId: string;
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/takeout/${encodeURIComponent(id)}/archives/${encodeURIComponent(archiveId)}`, {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Upload part of a Takeout archive
 */
export function uploadTakeoutArchiveChunk({ archiveId, id, offset, body }: {
    archiveId: string;
    id: string;
    offset: number;
    body: Blob;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutSourceResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/archives/${encodeURIComponent(archiveId)}/chunks${QS.query(QS.explode({
        offset
    }))}`, {
        ...opts,
        method: "PUT",
        body
    }));
}
/**
 * Check a staged part of a Takeout archive
 */
export function verifyTakeoutArchiveChunk({ archiveId, id, takeoutVerifyChunkDto }: {
    archiveId: string;
    id: string;
    takeoutVerifyChunkDto: TakeoutVerifyChunkDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/takeout/${encodeURIComponent(id)}/archives/${encodeURIComponent(archiveId)}/verify`, oazapfts.json({
        ...opts,
        method: "POST",
        body: takeoutVerifyChunkDto
    })));
}
/**
 * Pause, resume or cancel a Google Photos import
 */
export function controlTakeoutImport({ id, takeoutControlDto }: {
    id: string;
    takeoutControlDto: TakeoutControlDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/control`, oazapfts.json({
        ...opts,
        method: "POST",
        body: takeoutControlDto
    })));
}
/**
 * Import the reviewed items
 */
export function startTakeoutImport({ id, takeoutOptionsDto }: {
    id: string;
    takeoutOptionsDto: TakeoutOptionsDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/import`, oazapfts.json({
        ...opts,
        method: "POST",
        body: takeoutOptionsDto
    })));
}
/**
 * List the items of a Google Photos import
 */
export function getTakeoutItems({ id, limit, offset, state }: {
    id: string;
    limit?: number;
    offset?: number;
    state?: TakeoutItemState;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutItemsResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/items${QS.query(QS.explode({
        limit,
        offset,
        state
    }))}`, {
        ...opts
    }));
}
/**
 * Choose metadata for an item, or leave it out
 */
export function resolveTakeoutItem({ id, itemId, takeoutResolveDto }: {
    id: string;
    itemId: string;
    takeoutResolveDto: TakeoutResolveDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/items/${encodeURIComponent(itemId)}`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: takeoutResolveDto
    })));
}
/**
 * List possible Live Photos in a Google Photos import
 */
export function getTakeoutPairs({ id, limit, offset, state }: {
    id: string;
    limit?: number;
    offset?: number;
    state?: TakeoutPairState;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutPairsResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/live-photos${QS.query(QS.explode({
        limit,
        offset,
        state
    }))}`, {
        ...opts
    }));
}
/**
 * Link or separate a possible Live Photo
 */
export function decideTakeoutPair({ id, takeoutPairDecisionDto }: {
    id: string;
    takeoutPairDecisionDto: TakeoutPairDecisionDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutPairsResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/live-photos`, oazapfts.json({
        ...opts,
        method: "PUT",
        body: takeoutPairDecisionDto
    })));
}
/**
 * Scan a Google Photos import
 */
export function scanTakeoutImport({ id }: {
    id: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TakeoutResponseDto;
    }>(`/takeout/${encodeURIComponent(id)}/scan`, {
        ...opts,
        method: "POST"
    }));
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
 * Get timeline highlights
 */
export function getTimelineHighlights({ albumId, bbox, dateType, grouping, highlightCount, isFavorite, isTrashed, key, lockReason, order, orderBy, personId, petId, slug, suppressedOnly, tagId, userId, visibility, withCoordinates, withPartners, withStacked }: {
    albumId?: string;
    bbox?: string;
    dateType?: TimeBucketDateType;
    grouping?: TimelineHighlightGrouping;
    highlightCount?: number;
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
        data: TimelineHighlightResponseDto[];
    }>(`/timeline/highlights${QS.query(QS.explode({
        albumId,
        bbox,
        dateType,
        grouping,
        highlightCount,
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
 * Get the timeline in a flat order
 */
export function getTimelineOrdered({ albumId, bbox, dateType, isFavorite, isTrashed, key, lockReason, order, orderBy, personId, petId, skip, slug, sort, suppressedOnly, tagId, take, userId, visibility, withCoordinates, withPartners, withStacked }: {
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
    skip?: number;
    slug?: string;
    sort: TimelineOrderedSort;
    suppressedOnly?: boolean;
    tagId?: string;
    take?: number;
    userId?: string;
    visibility?: AssetVisibility;
    withCoordinates?: boolean;
    withPartners?: boolean;
    withStacked?: boolean;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: TimeBucketAssetResponseDto;
    }>(`/timeline/ordered${QS.query(QS.explode({
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
        skip,
        slug,
        sort,
        suppressedOnly,
        tagId,
        take,
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
 * Get utility activity
 */
export function getUtilityActivity({ tool }: {
    tool: UtilityActivityTool;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UtilityActivityResponseDto;
    }>(`/trash/activity${QS.query(QS.explode({
        tool
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
 * Remove your supporter key
 */
export function deleteUserLicense(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText("/users/me/license", {
        ...opts,
        method: "DELETE"
    }));
}
/**
 * Get your supporter key
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
 * Activate your supporter key
 */
export function setUserLicense({ licenseActivateDto }: {
    licenseActivateDto: LicenseActivateDto;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserLicense;
    }>("/users/me/license", oazapfts.json({
        ...opts,
        method: "PUT",
        body: licenseActivateDto
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
 * Get my preference history
 */
export function getMyPreferenceHistory(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: UserPreferenceHistoryResponseDto;
    }>("/users/me/preferences/history", {
        ...opts
    }));
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
 * Retrieve folder summaries
 */
export function getFolderSummary(opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchJson<{
        status: 200;
        data: FolderSummaryResponseDto[];
    }>("/view/folder/summary", {
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
 * Retry a workflow run
 */
export function retryWorkflowRun({ id, runId }: {
    id: string;
    runId: string;
}, opts?: Oazapfts.RequestOpts) {
    return oazapfts.ok(oazapfts.fetchText(`/workflows/${encodeURIComponent(id)}/runs/${encodeURIComponent(runId)}/retry`, {
        ...opts,
        method: "POST"
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
export enum CloudHeartbeatField {
    Version = "version",
    BootId = "bootId",
    UptimeSec = "uptimeSec",
    Health = "health",
    Endpoints = "endpoints",
    RemoteAccess = "remoteAccess",
    Permissions = "permissions",
    LicenseKid = "licenseKid"
}
export enum CloudLinkRefusal {
    InstanceLimit = "instance-limit",
    ServerRefused = "server-refused",
    InstanceIdTaken = "instance-id-taken",
    KeyAlreadyLinked = "key-already-linked"
}
export enum CloudLinkResult {
    Pending = "pending",
    Approved = "approved",
    Denied = "denied",
    Expired = "expired"
}
export enum CloudLinkState {
    NotConfigured = "not-configured",
    Unlinked = "unlinked",
    Pending = "pending",
    Linked = "linked",
    Revoked = "revoked"
}
export enum CloudMlConnection {
    NotConfigured = "not-configured",
    NotLinked = "not-linked",
    Ready = "ready",
    Unavailable = "unavailable"
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
    DestinationUnhealthy = "destination-unhealthy",
    RoleConflict = "role-conflict",
    CloudUnavailable = "cloud-unavailable",
    EntitlementMissing = "entitlement-missing",
    ConsentVersionOutdated = "consent-version-outdated",
    WalletInsufficient = "wallet-insufficient",
    QuotaExceeded = "quota-exceeded",
    ModelMismatch = "model-mismatch",
    InsufficientMemory = "insufficient-memory",
    RequestInvalid = "request-invalid"
}
export enum MlWorkload {
    Face = "face",
    Clip = "clip",
    Ocr = "ocr",
    Enrichment = "enrichment",
    RestorationFaithful = "restoration-faithful",
    RestorationCreative = "restoration-creative",
    StudioAi = "studio-ai",
    Upscale = "upscale",
    Interpolation = "interpolation",
    StudioRender = "studio-render",
    PetRecognition = "pet-recognition"
}
export enum MlDestinationHealth {
    Healthy = "healthy",
    Unhealthy = "unhealthy",
    Unknown = "unknown"
}
export enum MlDestinationKind {
    Local = "local",
    Lan = "lan",
    FrameleafCloud = "frameleaf-cloud"
}
export enum MlWorkerRole {
    LibraryAnalysis = "library-analysis",
    Restoration = "restoration",
    Studio = "studio",
    Mixed = "mixed",
    Unassigned = "unassigned"
}
export enum CloudMlModelGroup {
    Descriptions = "descriptions",
    Upscale = "upscale",
    RestorationFaithful = "restoration-faithful",
    RestorationCreative = "restoration-creative",
    Interpolation = "interpolation",
    Transcription = "transcription",
    Tts = "tts"
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
export enum CloudRouteMode {
    Local = "local",
    Both = "both",
    Cloud = "cloud"
}
export enum StartWith {
    Local = "local",
    Cloud = "cloud"
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
export enum ReleaseChannel {
    Stable = "stable",
    ReleaseCandidate = "releaseCandidate"
}
export enum OAuthTokenEndpointAuthMethod {
    ClientSecretPost = "client_secret_post",
    ClientSecretBasic = "client_secret_basic"
}
export enum ClassificationRuleAction {
    Review = "review",
    Tag = "tag"
}
export enum ConfigCredential {
    SmtpPassword = "smtp-password",
    OauthClientSecret = "oauth-client-secret"
}
export enum SystemConfigHistoryCredentialChange {
    Replaced = "replaced",
    Cleared = "cleared"
}
export enum SystemConfigHistoryKind {
    Settings = "settings",
    Credential = "credential",
    Review = "review"
}
export enum HardwareBackend {
    Cuda = "CUDA",
    RoCm = "ROCm",
    OpenVino = "OpenVINO",
    Nvenc = "NVENC",
    VaApi = "VA-API",
    Qsv = "QSV",
    Cpu = "CPU"
}
export enum Kind {
    Transcode = "transcode",
    Embedding = "embedding"
}
export enum IntegrityReport {
    UntrackedFile = "untracked_file",
    MissingFile = "missing_file",
    ChecksumMismatch = "checksum_mismatch"
}
export enum LicenseKind {
    Server = "server",
    Individual = "individual",
    Plan = "plan"
}
export enum Source {
    Key = "key",
    File = "file",
    Account = "account"
}
export enum LicenseState {
    None = "none",
    Active = "active",
    Grace = "grace",
    Expired = "expired",
    Invalid = "invalid"
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
export enum PhysicalDeduplicationCopyFile {
    Removed = "removed",
    Present = "present",
    Changed = "changed"
}
export enum PhysicalDeduplicationRetainedFile {
    Intact = "intact",
    Missing = "missing",
    Changed = "changed"
}
export enum AssetTypeEnum {
    Image = "IMAGE",
    Video = "VIDEO",
    Audio = "AUDIO",
    Other = "OTHER"
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
    RelinkLivePhoto = "relink-live-photo",
    ResolveDuplicates = "resolve-duplicates",
    UndoDuplicates = "undo-duplicates",
    RelinkMissingMedia = "relink-missing-media",
    RecoverDamagedMedia = "recover-damaged-media",
    TrashDamagedMedia = "trash-damaged-media",
    ApplyClassificationRule = "apply-classification-rule"
}
export enum MediaOperationDestination {
    Local = "local",
    Lan = "lan",
    FrameleafCloud = "frameleaf-cloud"
}
export enum MediaOperationKind {
    StudioExport = "studio_export",
    StudioPreview = "studio_preview",
    Restoration = "restoration",
    RestorationPreview = "restoration_preview",
    QuickEdit = "quick_edit",
    Bulk = "bulk",
    StudioBundleExport = "studio_bundle_export",
    StudioBundleImport = "studio_bundle_import",
    EnrichmentPlan = "enrichment_plan",
    MediaHealth = "media_health",
    IcloudSync = "icloud_sync",
    TakeoutImport = "takeout_import",
    PhysicalDeduplication = "physical_deduplication",
    LibraryScan = "library_scan",
    PreservationExport = "preservation_export",
    PreservationVerify = "preservation_verify",
    PreservationReview = "preservation_review",
    PreservationRestore = "preservation_restore",
    StudioExportPublish = "studio_export_publish",
    CloudDescriptionBatch = "cloud_description_batch"
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
    Updated = "updated",
    DeviceLost = "device_lost"
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
    ManifestIncomplete = "manifest_incomplete",
    CodecUnsupported = "codec_unsupported"
}
export enum Kind2 {
    Individual = "individual"
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
export enum AdminAuditAction {
    AccountCreated = "account-created",
    AccountUpdated = "account-updated",
    AdminGranted = "admin-granted",
    AdminRevoked = "admin-revoked",
    QuotaChanged = "quota-changed",
    StorageLabelChanged = "storage-label-changed",
    PasswordReset = "password-reset",
    PinSet = "pin-set",
    PinReset = "pin-reset",
    SessionRevoked = "session-revoked",
    PreferencesUpdated = "preferences-updated",
    CastingDisabled = "casting-disabled",
    CastingAllowed = "casting-allowed",
    AccountDeleted = "account-deleted",
    AccountRemovalScheduled = "account-removal-scheduled",
    AccountRestored = "account-restored",
    LibraryCreated = "library-created",
    LibraryUpdated = "library-updated",
    LibraryScanQueued = "library-scan-queued",
    LibraryScanCancelled = "library-scan-cancelled",
    LibraryDeleted = "library-deleted",
    CloudLinked = "cloud-linked",
    CloudUnlinked = "cloud-unlinked",
    CloudRevoked = "cloud-revoked",
    CloudPermissionsChanged = "cloud-permissions-changed",
    CloudKeyRecoveryRotation = "cloud-key-recovery-rotation",
    LicenseActivated = "license-activated",
    LicenseRemoved = "license-removed",
    FrameleafAccountLinked = "frameleaf-account-linked",
    FrameleafAccountUnlinked = "frameleaf-account-unlinked"
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
export enum MlWorkerAcceleration {
    Unknown = "unknown",
    Cpu = "cpu",
    Gpu = "gpu"
}
export enum WorkerCredentialState {
    None = "none",
    Stored = "stored",
    Managed = "managed",
    Enrolled = "enrolled"
}
export enum MlWorkerReadiness {
    Unknown = "unknown",
    Disabled = "disabled",
    Unreachable = "unreachable",
    NotServing = "not-serving",
    Cpu = "cpu",
    ModelReady = "model-ready"
}
export enum WorkerInventorySource {
    MlDestination = "ml-destination",
    RenderWorker = "render-worker"
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
    Editor = "editor",
    PetRecognition = "petRecognition"
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
export enum AnalyticsRange {
    $90Days = "90days",
    Year = "year"
}
export enum AnalyticsCameraKind {
    Model = "model",
    Other = "other",
    Unknown = "unknown"
}
export enum AnalyticsGrain {
    Snapshot = "snapshot",
    Day = "day"
}
export enum AnalyticsSeriesId {
    LibraryItems = "library.items",
    LibraryPhotos = "library.photos",
    LibraryVideos = "library.videos",
    LibraryLogicalBytes = "library.logicalBytes",
    LibraryPhysicalBytes = "library.physicalBytes",
    HostVolumeUsedBytes = "host.volumeUsedBytes",
    HostCapacityBytes = "host.capacityBytes",
    HostThumbnailBytes = "host.thumbnailBytes",
    HostEncodedVideoBytes = "host.encodedVideoBytes",
    HostThumbnailOtherDiskBytes = "host.thumbnailOtherDiskBytes",
    HostEncodedVideoOtherDiskBytes = "host.encodedVideoOtherDiskBytes",
    LibraryArrivals = "library.arrivals",
    LibraryCaptures = "library.captures",
    ProcessingCompleted = "processing.completed",
    ProcessingFailed = "processing.failed",
    ProcessingEstimatedCostUsd = "processing.estimatedCostUsd"
}
export enum AnalyticsMeasurementScope {
    Selection = "selection",
    Host = "host"
}
export enum AnalyticsSeriesOwner {
    Library = "library",
    Host = "host",
    Processing = "processing"
}
export enum AnalyticsScopeKind {
    Host = "host",
    Account = "account",
    Library = "library"
}
export enum AnalyticsUnit {
    Items = "items",
    Bytes = "bytes",
    Attempts = "attempts",
    Usd = "usd"
}
export enum AnalyticsState {
    Measured = "measured",
    Stale = "stale",
    Unknown = "unknown"
}
export enum AnalyticsVolumePart {
    Previews = "previews",
    EncodedVideo = "encodedVideo"
}
export enum AnalyticsFocalLengthDtoKey {
    $016 = "0-16",
    $1728 = "17-28",
    $2940 = "29-40",
    $4170 = "41-70",
    $71135 = "71-135",
    $136300 = "136-300",
    $301 = "301+",
    Unknown = "unknown"
}
export enum AnalyticsNamedCountKind {
    Named = "named",
    Other = "other",
    Unknown = "unknown"
}
export enum AnalyticsOrientationDtoKey {
    Landscape = "landscape",
    Portrait = "portrait",
    Square = "square",
    Panorama = "panorama",
    Unknown = "unknown"
}
export enum AnalyticsPhotoFormatDtoKey {
    Heic = "HEIC",
    Jpeg = "JPEG",
    Raw = "RAW",
    Png = "PNG",
    Other = "OTHER"
}
export enum AnalyticsVideoResolutionDtoKey {
    $4K = "4K",
    $1080P = "1080p",
    $720P = "720p",
    Sd = "SD",
    Unknown = "unknown"
}
export enum AnalyticsMetadataField {
    CaptureDate = "captureDate",
    Location = "location",
    CameraModel = "cameraModel",
    AiDescription = "aiDescription",
    Checksum = "checksum"
}
export enum AnalyticsView {
    Timeline = "timeline",
    Favorites = "favorites",
    Archive = "archive",
    Trash = "trash"
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
    AdminCloudRead = "adminCloud.read",
    AdminCloudUpdate = "adminCloud.update",
    AdminCloudLink = "adminCloud.link",
    FrameleafAccountRead = "frameleafAccount.read",
    FrameleafAccountUpdate = "frameleafAccount.update",
    AdminCloudMlRead = "adminCloudMl.read",
    AdminCloudMlUpdate = "adminCloudMl.update",
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
export enum ArchiveOperationScope {
    SelectedOwnedAssets = "selected-owned-assets",
    MatchingOwnedTimeline = "matching-owned-timeline"
}
export enum ArchiveOperationPrepareScope {
    MatchingOwnedTimeline = "matching-owned-timeline"
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
    RefreshOcr = "refresh-ocr",
    RegenerateThumbnail = "regenerate-thumbnail",
    TranscodeVideo = "transcode-video"
}
export enum AssetDevelopRevisionKind {
    Recipe = "recipe",
    External = "external"
}
export enum AssetDevelopMaskKind {
    Radial = "radial",
    Linear = "linear"
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
export enum Version {
    $1 = 1
}
export enum AssetDevelopRevisionStatus {
    Saved = "saved",
    Queued = "queued",
    Rendering = "rendering",
    Rendered = "rendered",
    Failed = "failed",
    Cancelled = "cancelled"
}
export enum AssetDevelopFileKind {
    Master = "master",
    Preview = "preview"
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
export enum VideoTrimMode {
    Precise = "precise",
    Fast = "fast"
}
export enum VideoAdjustModel {
    Develop = "develop"
}
export enum VideoDevelopPreset {
    Original = "Original",
    Vivid = "Vivid",
    Natural = "Natural",
    Warm = "Warm",
    Cool = "Cool",
    Mono = "Mono",
    Silvertone = "Silvertone",
    Noir = "Noir",
    Fade = "Fade",
    BW = "B&W"
}
export enum TextOverlayPosition {
    TopLeft = "top-left",
    Top = "top",
    TopRight = "top-right",
    Left = "left",
    Center = "center",
    Right = "right",
    BottomLeft = "bottom-left",
    Bottom = "bottom",
    BottomRight = "bottom-right"
}
export enum VideoEditVersionPurpose {
    Save = "save",
    Export = "export",
    Revert = "revert"
}
export enum VideoEditVersionStatus {
    Pending = "pending",
    Ready = "ready",
    Failed = "failed"
}
export enum VideoEditExportProfile {
    Master = "master"
}
export enum AssetEditsColorPolicy {
    Preserve = "preserve",
    ToneMap = "tone-map",
    Unsupported = "unsupported"
}
export enum EnrichmentStaleReason {
    SourceChanged = "source-changed",
    IdentityChanged = "identity-changed",
    ConfigChanged = "config-changed"
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
export enum AssetMediaSize {
    Original = "original",
    Fullsize = "fullsize",
    Preview = "preview",
    Thumbnail = "thumbnail"
}
export enum ClassificationMatchDecision {
    Matched = "matched",
    Suggested = "suggested",
    Accepted = "accepted",
    Rejected = "rejected"
}
export enum ClassificationMediaType {
    Any = "any",
    Photo = "photo",
    Video = "video"
}
export enum ClassificationReviewDecision {
    Accepted = "accepted",
    Rejected = "rejected"
}
export enum DocumentField {
    Date = "date",
    Total = "total",
    Reference = "reference",
    Email = "email",
    Phone = "phone"
}
export enum DocumentFieldStatus {
    Suggested = "suggested",
    Confirmed = "confirmed",
    Corrected = "corrected",
    Dismissed = "dismissed"
}
export enum DocumentLineStatus {
    Recognized = "recognized",
    Corrected = "corrected",
    Dismissed = "dismissed",
    Kept = "kept"
}
export enum DocumentEditAction {
    Confirm = "confirm",
    Correct = "correct",
    Dismiss = "dismiss"
}
export enum DuplicateDecisionKind {
    Keepers = "keepers",
    KeepAll = "keep-all",
    Stack = "stack"
}
export enum DuplicateGroupBlock {
    HiddenMembers = "hidden-members",
    OtherOwner = "other-owner"
}
export enum DuplicateGroupKind {
    Duplicates = "duplicates",
    Burst = "burst"
}
export enum DuplicateQualityReason {
    OriginalFormat = "original-format",
    LargestFile = "largest-file",
    HighestResolution = "highest-resolution",
    MostMetadata = "most-metadata",
    CompressedCopy = "compressed-copy",
    LowerResolution = "lower-resolution"
}
export enum VideoMomentMatch {
    Visual = "visual",
    Caption = "caption",
    Transcript = "transcript"
}
export enum EnrichmentStage {
    Frames = "frames",
    LockedCheck = "locked-check",
    Description = "description",
    MomentIndex = "moment-index",
    MomentCaptions = "moment-captions"
}
export enum EnrichmentItemState {
    Queued = "queued",
    Running = "running",
    Skipped = "skipped",
    Failed = "failed",
    Completed = "completed",
    Cancelled = "cancelled"
}
export enum EnrichmentPreviewStatus {
    Success = "success",
    Failed = "failed",
    Skipped = "skipped"
}
export enum VideoMomentSource {
    Generated = "generated",
    Manual = "manual"
}
export enum VideoMomentIndexState {
    None = "none",
    Ready = "ready",
    Stale = "stale"
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
export enum ICloudLibraryArea {
    Private = "private",
    Shared = "shared"
}
export enum ICloudReviewKind {
    Review = "review",
    Failed = "failed",
    Unsupported = "unsupported",
    KeptTrashed = "kept-trashed",
    SourceRemoved = "source-removed"
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
    IntegrityChecksumMismatchDeleteAll = "integrity-checksum-mismatch-delete-all",
    AnalyticsCollect = "analytics-collect"
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
export enum QueueCommand {
    Start = "start",
    Pause = "pause",
    Resume = "resume",
    Empty = "empty",
    ClearFailed = "clear-failed"
}
export enum LibraryScanPhase {
    Crawl = "crawl",
    Check = "check",
    Done = "done"
}
export enum LibraryScanStopReason {
    PathsChanged = "paths_changed",
    LibraryRemoved = "library_removed",
    OwnerDeleted = "owner_deleted"
}
export enum LibraryImportPathReason {
    Valid = "valid",
    NotAbsolute = "not_absolute",
    InvalidCharacters = "invalid_characters",
    ParentTraversal = "parent_traversal",
    UploadFolder = "upload_folder",
    ContainsUploadFolder = "contains_upload_folder",
    NotFound = "not_found",
    NotDirectory = "not_directory",
    NotReadable = "not_readable",
    Unavailable = "unavailable",
    Duplicate = "duplicate",
    Nested = "nested",
    OtherLibrary = "other_library"
}
export enum Currency {
    Usd = "USD"
}
export enum Kind3 {
    Plan = "plan",
    Supporter = "supporter",
    Credit = "credit"
}
export enum Period {
    Month = "month",
    Year = "year",
    OneTime = "one-time"
}
export enum LivePhotoMatchConfidence {
    High = "high",
    Low = "low"
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
export enum MediaHealthChecksumAlgorithm {
    Sha1 = "sha1",
    Sha256 = "sha256"
}
export enum MediaHealthRootKind {
    Managed = "managed",
    Library = "library",
    Recovery = "recovery"
}
export enum MediaHealthProvenanceAction {
    Relinked = "relinked",
    Recovered = "recovered"
}
export enum MediaHealthSeverity {
    Info = "info",
    Warning = "warning",
    Critical = "critical"
}
export enum MediaHealthOperationMode {
    Scan = "scan",
    Locate = "locate"
}
export enum MediaHealthActivityAction {
    Scan = "scan",
    Locate = "locate",
    RelinkMissingMedia = "relink-missing-media",
    RecoverDamagedMedia = "recover-damaged-media",
    TrashDamagedMedia = "trash-damaged-media"
}
export enum DateMode {
    Set = "set",
    Shift = "shift"
}
export enum MediaOperationItemStatus {
    Ok = "ok",
    Skipped = "skipped",
    Failed = "failed"
}
export enum MediaOperationCheckpointState {
    Pending = "pending",
    Complete = "complete",
    Invalid = "invalid"
}
export enum MemorySearchOrder {
    Asc = "asc",
    Desc = "desc",
    Random = "random"
}
export enum MemoryType {
    OnThisDay = "on_this_day",
    EventStory = "event_story",
    YearInReview = "year_in_review",
    PetStory = "pet_story",
    Birthday = "birthday",
    PersonRecap = "person_recap"
}
export enum Kind4 {
    EventStory = "event_story"
}
export enum Kind5 {
    YearInReview = "year_in_review"
}
export enum Kind6 {
    PetStory = "pet_story"
}
export enum Kind7 {
    Birthday = "birthday"
}
export enum Subject {
    Person = "person",
    Pet = "pet"
}
export enum Kind8 {
    PersonRecap = "person_recap"
}
export enum MemoryShowLessKind {
    Person = "person",
    Pet = "pet",
    Date = "date",
    Type = "type"
}
export enum MlStudioFeature {
    SpeechToText = "speech-to-text",
    Captions = "captions",
    Speech = "speech"
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
export enum PartnerDirection {
    SharedBy = "shared-by",
    SharedWith = "shared-with"
}
export enum PersonCorrectionAction {
    Reassign = "reassign",
    NewPerson = "new-person",
    Unassign = "unassign",
    Remove = "remove",
    Merge = "merge",
    BoxMove = "box-move"
}
export enum PersonMergeVerdict {
    Same = "same",
    Different = "different",
    Later = "later",
    Ignore = "ignore"
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
export enum PetRecognitionUnavailableReason {
    MachineLearningDisabled = "machine-learning-disabled",
    SmartSearchDisabled = "smart-search-disabled",
    DestinationMissing = "destination-missing",
    DestinationDisabled = "destination-disabled",
    WorkloadNotRouted = "workload-not-routed",
    WorkloadNotAllowed = "workload-not-allowed",
    WorkloadNotServed = "workload-not-served",
    ConsentMissing = "consent-missing",
    BudgetExceeded = "budget-exceeded",
    EndpointUnresolved = "endpoint-unresolved",
    DestinationUnhealthy = "destination-unhealthy",
    RoleConflict = "role-conflict",
    InsufficientMemory = "insufficient-memory",
    CloudUnavailable = "cloud-unavailable",
    EntitlementMissing = "entitlement-missing",
    ConsentVersionOutdated = "consent-version-outdated",
    WalletInsufficient = "wallet-insufficient",
    QuotaExceeded = "quota-exceeded",
    ModelMismatch = "model-mismatch",
    RequestInvalid = "request-invalid"
}
export enum PetRecognitionRunStatus {
    Queued = "queued",
    Running = "running",
    Completed = "completed",
    Cancelled = "cancelled",
    Failed = "failed"
}
export enum PetObservationSource {
    Manual = "manual",
    Review = "review"
}
export enum PetObservationState {
    Confirmed = "confirmed",
    Rejected = "rejected"
}
export enum WorkflowType {
    AssetV1 = "AssetV1"
}
export enum WorkflowTrigger {
    AssetCreate = "AssetCreate",
    AssetMetadataExtraction = "AssetMetadataExtraction",
    AssetTagged = "AssetTagged"
}
export enum PreservationPackageFormat {
    Directory = "directory",
    Zip = "zip"
}
export enum PreservationPackageOrigin {
    Export = "export",
    Upload = "upload",
    Server = "server"
}
export enum PreservationPackageStatus {
    Building = "building",
    Ready = "ready",
    Incomplete = "incomplete",
    Unreadable = "unreadable",
    Removed = "removed"
}
export enum PreservationSupportCategory {
    Originals = "originals",
    Dates = "dates",
    Places = "places",
    Descriptions = "descriptions",
    Ratings = "ratings",
    Favorites = "favorites",
    Archive = "archive",
    Locked = "locked",
    Albums = "albums",
    Tags = "tags",
    People = "people",
    EditRecipes = "editRecipes",
    LivePhotos = "livePhotos",
    Stacks = "stacks",
    DocumentCorrections = "documentCorrections",
    MomentNotes = "momentNotes",
    GeneratedDescriptions = "generatedDescriptions",
    GeneratedMoments = "generatedMoments",
    CameraDetails = "cameraDetails",
    Sharing = "sharing",
    Pets = "pets",
    StudioProjects = "studioProjects",
    Memories = "memories"
}
export enum PreservationSupportLevel {
    Restored = "restored",
    RestoredWhenEmpty = "restored-when-empty",
    ProvenanceOnly = "provenance-only",
    NotIncluded = "not-included"
}
export enum PreservationVerificationStatus {
    Verified = "verified",
    Problems = "problems",
    Unreadable = "unreadable"
}
export enum PreservationItemState {
    Pending = "pending",
    Copied = "copied",
    Failed = "failed",
    Skipped = "skipped",
    Listed = "listed"
}
export enum PreservationVerifyState {
    Ok = "ok",
    Missing = "missing",
    Changed = "changed"
}
export enum PreservationDecision {
    Keep = "keep",
    Replace = "replace"
}
export enum PreservationRestoreStatus {
    Reviewing = "reviewing",
    Ready = "ready",
    Restoring = "restoring",
    Completed = "completed",
    Unreadable = "unreadable"
}
export enum PreservationRestoreItemFilter {
    Conflicts = "conflicts",
    Failed = "failed",
    Findings = "findings"
}
export enum PreservationConflictField {
    Date = "date",
    Description = "description",
    Location = "location",
    Rating = "rating",
    Favorite = "favorite",
    Archive = "archive",
    EditRecipe = "editRecipe"
}
export enum PreservationRestoreMatch {
    New = "new",
    Existing = "existing",
    Trashed = "trashed"
}
export enum PreservationRestoreItemState {
    Pending = "pending",
    Ready = "ready",
    Failed = "failed",
    Creating = "creating",
    Restored = "restored",
    Matched = "matched",
    Skipped = "skipped"
}
export enum FrameleafVia {
    Lan = "lan",
    Wan = "wan",
    Relay = "relay"
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
    AnalyticsCollect = "AnalyticsCollect",
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
    AssetDevelopRender = "AssetDevelopRender",
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
    LibraryScanRun = "LibraryScanRun",
    HlsSessionCleanup = "HlsSessionCleanup",
    MemoryCleanup = "MemoryCleanup",
    MemoryGenerate = "MemoryGenerate",
    MemoryExport = "MemoryExport",
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
    PersonIdentityRefresh = "PersonIdentityRefresh",
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
    FrameleafHeartbeat = "FrameleafHeartbeat",
    FrameleafLicenseRefresh = "FrameleafLicenseRefresh",
    CloudMlDescriptionBatch = "CloudMlDescriptionBatch",
    OcrQueueAll = "OcrQueueAll",
    Ocr = "Ocr",
    ImageDescriptionQueueAll = "ImageDescriptionQueueAll",
    ImageDescription = "ImageDescription",
    NsfwDetectionQueueAll = "NsfwDetectionQueueAll",
    NsfwDetection = "NsfwDetection",
    PetRecognitionQueueAll = "PetRecognitionQueueAll",
    PetRecognition = "PetRecognition",
    PetRecognitionNearest = "PetRecognitionNearest",
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
export enum QueueJobWorkerKind {
    Server = "server",
    Local = "local",
    Lan = "lan",
    FrameleafCloud = "frameleaf-cloud"
}
export enum Status3 {
    Preparing = "preparing",
    Rendering = "rendering"
}
export enum StudioExportRemoteReason {
    Cancel = "cancel",
    Delete = "delete"
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
export enum SearchAskMode {
    Smart = "smart",
    Metadata = "metadata"
}
export enum SearchFacetField {
    People = "people",
    Type = "type",
    City = "city",
    Country = "country",
    Make = "make",
    Model = "model",
    LensModel = "lensModel",
    Rating = "rating",
    IsFavorite = "isFavorite",
    Tags = "tags"
}
export enum SearchHistogramGranularity {
    Day = "day",
    Month = "month",
    Year = "year"
}
export enum SearchSuggestionType {
    Country = "country",
    State = "state",
    City = "city",
    CameraMake = "camera-make",
    CameraModel = "camera-model",
    CameraLensModel = "camera-lens-model"
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
export enum SharedLinkType {
    Album = "ALBUM",
    Individual = "INDIVIDUAL"
}
export enum AssetIdErrorReason {
    Duplicate = "duplicate",
    NoPermission = "no_permission",
    NotFound = "not_found"
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
export enum StudioBundleSourceMode {
    Embedded = "embedded",
    Reference = "reference"
}
export enum StudioBundleSourceResolution {
    Kept = "kept",
    Suggested = "suggested",
    Missing = "missing"
}
export enum StudioExportScope {
    Library = "library",
    Project = "project"
}
export enum StudioExportColor {
    Preserve = "preserve",
    Hdr10 = "hdr10",
    DolbyVision = "dolby-vision"
}
export enum StudioExportFormat {
    Mp4HevcMain10 = "mp4-hevc-main10",
    Mp4H264 = "mp4-h264",
    WebmAv1 = "webm-av1",
    Prores422Hq = "prores-422-hq"
}
export enum StudioExportResolution {
    $720P = "720p",
    $1080P = "1080p",
    $1440P = "1440p",
    $2160P = "2160p"
}
export enum StudioExportVersionState {
    Rendering = "rendering",
    Staged = "staged",
    Published = "published",
    Failed = "failed",
    Cancelled = "cancelled"
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
export enum StudioProjectAccess {
    Owner = "owner",
    Reviewer = "reviewer"
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
export enum SmartAlbumBuiltInKind {
    Travel = "travel",
    Documents = "documents",
    Screenshots = "screenshots",
    Food = "food",
    Pets = "pets",
    Nature = "nature"
}
export enum FrameleafSetupFlow {
    New = "new",
    Existing = "existing"
}
export enum FrameleafSetupModelTier {
    Light = "light",
    Balanced = "balanced",
    Best = "best"
}
export enum FrameleafSetupProcessing {
    Local = "local",
    Cloud = "cloud",
    Later = "later"
}
export enum FrameleafSetupRestore {
    Restore = "restore",
    Fresh = "fresh"
}
export enum FrameleafSetupSignIn {
    Frameleaf = "frameleaf",
    Local = "local"
}
export enum FrameleafSetupTheme {
    Dark = "dark",
    Light = "light"
}
export enum TakeoutAction {
    Scan = "scan",
    Import = "import"
}
export enum TakeoutPhase {
    Sources = "sources",
    Scanning = "scanning",
    Review = "review",
    Importing = "importing",
    Completed = "completed"
}
export enum TakeoutSourceKind {
    Zip = "zip",
    Directory = "directory"
}
export enum TakeoutState {
    Sources = "sources",
    Queued = "queued",
    Scanning = "scanning",
    Review = "review",
    Importing = "importing",
    Paused = "paused",
    Cancelling = "cancelling",
    Cancelled = "cancelled",
    Failed = "failed",
    Completed = "completed"
}
export enum TakeoutControlAction {
    Pause = "pause",
    Resume = "resume",
    Cancel = "cancel"
}
export enum TakeoutItemState {
    Ready = "ready",
    Review = "review",
    Importing = "importing",
    Imported = "imported",
    Matched = "matched",
    Skipped = "skipped",
    Failed = "failed"
}
export enum TakeoutItemKind {
    Image = "image",
    Video = "video"
}
export enum TakeoutWarning {
    AmbiguousSidecar = "ambiguous_sidecar",
    NoSidecar = "no_sidecar",
    InvalidSidecar = "invalid_sidecar",
    Trashed = "trashed",
    Locked = "locked"
}
export enum TakeoutPairState {
    Suggested = "suggested",
    Approved = "approved",
    Skipped = "skipped",
    Linked = "linked",
    Failed = "failed"
}
export enum TimeBucketDateType {
    Added = "added",
    Taken = "taken"
}
export enum AssetLockReason {
    Marked = "marked",
    Detected = "detected",
    ImmichLockedFolder = "immich-locked-folder"
}
export enum AssetOrderBy {
    TakenAt = "takenAt",
    CreatedAt = "createdAt"
}
export enum TimelineHighlightGrouping {
    Year = "year",
    Month = "month"
}
export enum TimelineOrderedSort {
    Filename = "filename",
    Rating = "rating"
}
export enum UtilityActivityTool {
    LargeFiles = "large-files"
}
export enum UtilityActivityAction {
    Trash = "trash",
    Restore = "restore"
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
export enum WorkflowIssueCode {
    TriggerUnavailable = "trigger_unavailable",
    MethodUnavailable = "method_unavailable",
    MethodIncompatible = "method_incompatible",
    ConfigInvalid = "config_invalid"
}
export enum WorkflowResult {
    Completed = "completed",
    Halted = "halted",
    Error = "error"
}
export enum WorkflowRunErrorCode {
    Unsupported = "unsupported",
    StepFailed = "step_failed"
}
export enum UserMetadataKey {
    Preferences = "preferences",
    License = "license",
    Onboarding = "onboarding"
}
