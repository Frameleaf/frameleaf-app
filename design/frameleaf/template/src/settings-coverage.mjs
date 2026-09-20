// Source audit snapshot, 2026-09-19. Status describes prototype UI only; no
// entry claims production API parity. Schema drift is checked by the tests.
import { allSettings, settingsSections } from "./settings-catalog.mjs";
import { MANUAL_JOBS, QUEUE_CATALOG } from "./jobs-data.mjs";

export const coverageStatuses = [
  "ui-control",
  "resource-flow",
  "deployment-policy",
  "not-yet-built",
];
export const sourceForms = [
  {
    id: "system/authentication",
    scope: "server",
    source: "web/src/routes/admin/system-settings/AuthSettings.svelte",
    prefixes: ["oauth.", "passwordLogin."],
  },
  {
    id: "system/backup",
    scope: "server",
    source: "web/src/routes/admin/system-settings/BackupSettings.svelte",
    prefixes: ["backup."],
  },
  {
    id: "system/image",
    scope: "server",
    source: "web/src/routes/admin/system-settings/ImageSettings.svelte",
    prefixes: ["image."],
  },
  {
    id: "system/integrity-checks",
    scope: "server",
    source:
      "web/src/routes/admin/system-settings/IntegrityChecksSettings.svelte",
    prefixes: ["integrityChecks."],
  },
  {
    id: "system/job",
    scope: "server",
    source: "web/src/routes/admin/system-settings/JobSettings.svelte",
    prefixes: ["job."],
  },
  {
    id: "system/external-library",
    scope: "server",
    source: "web/src/routes/admin/system-settings/LibrarySettings.svelte",
    prefixes: ["library."],
  },
  {
    id: "system/logging",
    scope: "server",
    source: "web/src/routes/admin/system-settings/LoggingSettings.svelte",
    prefixes: ["logging."],
  },
  {
    id: "system/machine-learning",
    scope: "server",
    source:
      "web/src/routes/admin/system-settings/MachineLearningSettings.svelte",
    prefixes: ["machineLearning.", "localFeatures."],
  },
  {
    id: "system/location",
    scope: "server",
    source: "web/src/routes/admin/system-settings/MapSettings.svelte",
    prefixes: ["map.", "reverseGeocoding."],
  },
  {
    id: "system/metadata",
    scope: "server",
    source: "web/src/routes/admin/system-settings/MetadataSettings.svelte",
    prefixes: ["metadata."],
  },
  {
    id: "system/nightly-tasks",
    scope: "server",
    source: "web/src/routes/admin/system-settings/NightlyTasksSettings.svelte",
    prefixes: ["nightlyTasks."],
  },
  {
    id: "system/notifications",
    scope: "server",
    source: "web/src/routes/admin/system-settings/NotificationSettings.svelte",
    prefixes: ["notifications.", "templates."],
  },
  {
    id: "system/server",
    scope: "server",
    source: "web/src/routes/admin/system-settings/ServerSettings.svelte",
    prefixes: ["server."],
  },
  {
    id: "system/smart-albums",
    scope: "server",
    source: "web/src/routes/admin/system-settings/SmartAlbumsSettings.svelte",
    prefixes: ["smartAlbums."],
  },
  {
    id: "system/storage-template",
    scope: "server",
    source:
      "web/src/lib/components/admin-settings/StorageTemplateSettings.svelte",
    prefixes: ["storageTemplate.", "physicalDeduplication."],
  },
  {
    id: "system/theme",
    scope: "server",
    source: "web/src/routes/admin/system-settings/ThemeSettings.svelte",
    prefixes: ["theme."],
  },
  {
    id: "system/trash",
    scope: "server",
    source: "web/src/routes/admin/system-settings/TrashSettings.svelte",
    prefixes: ["trash."],
  },
  {
    id: "system/user-settings",
    scope: "server",
    source: "web/src/routes/admin/system-settings/UserSettings.svelte",
    prefixes: ["user."],
  },
  {
    id: "system/version-check",
    scope: "server",
    source:
      "web/src/routes/admin/system-settings/NewVersionCheckSettings.svelte",
    prefixes: ["newVersionCheck."],
  },
  {
    id: "system/video-transcoding",
    scope: "server",
    source: "web/src/routes/admin/system-settings/FFmpegSettings.svelte",
    prefixes: ["ffmpeg."],
  },
  {
    id: "personal/app",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/AppSettings.svelte",
  },
  {
    id: "personal/account",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/UserProfileSettings.svelte",
  },
  {
    id: "personal/usage",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/UserUsageStatistic.svelte",
  },
  {
    id: "personal/api-keys",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/UserApiKeyList.svelte",
  },
  {
    id: "personal/devices",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/DeviceList.svelte",
  },
  {
    id: "personal/downloads",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/DownloadSettings.svelte",
  },
  {
    id: "personal/features",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/FeatureSettings.svelte",
  },
  {
    id: "personal/notifications",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/NotificationsSettings.svelte",
  },
  {
    id: "personal/oauth",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/OauthSettings.svelte",
  },
  {
    id: "personal/password",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/ChangePasswordSettings.svelte",
  },
  {
    id: "personal/pin",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/PinCodeSettings.svelte",
  },
  {
    id: "personal/suppression",
    scope: "account",
    source:
      "web/src/routes/(user)/user-settings/SuppressedContentSettings.svelte",
  },
  {
    id: "personal/purchase",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/UserPurchaseSettings.svelte",
  },
  {
    id: "personal/sharing",
    scope: "account",
    source: "web/src/routes/(user)/user-settings/SharingSettings.svelte",
  },
];

export const schemaControls = [
  {
    id: "system:backup.database.cronExpression",
    contract: "system",
    path: "backup.database.cronExpression",
    type: "string",
    nullable: false,
    form: "system/backup",
  },
  {
    id: "system:backup.database.enabled",
    contract: "system",
    path: "backup.database.enabled",
    type: "boolean",
    nullable: false,
    form: "system/backup",
  },
  {
    id: "system:backup.database.keepLastAmount",
    contract: "system",
    path: "backup.database.keepLastAmount",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/backup",
  },
  {
    id: "system:ffmpeg.accel",
    contract: "system",
    path: "ffmpeg.accel",
    type: "string",
    nullable: false,
    enum: ["nvenc", "qsv", "vaapi", "rkmpp", "disabled"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.accelDecode",
    contract: "system",
    path: "ffmpeg.accelDecode",
    type: "boolean",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.acceptedAudioCodecs",
    contract: "system",
    path: "ffmpeg.acceptedAudioCodecs",
    type: "array",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.acceptedContainers",
    contract: "system",
    path: "ffmpeg.acceptedContainers",
    type: "array",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.acceptedVideoCodecs",
    contract: "system",
    path: "ffmpeg.acceptedVideoCodecs",
    type: "array",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.bframes",
    contract: "system",
    path: "ffmpeg.bframes",
    type: "integer",
    nullable: false,
    minimum: -1,
    maximum: 16,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.cqMode",
    contract: "system",
    path: "ffmpeg.cqMode",
    type: "string",
    nullable: false,
    enum: ["auto", "cqp", "icq"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.crf",
    contract: "system",
    path: "ffmpeg.crf",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 51,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.gopSize",
    contract: "system",
    path: "ffmpeg.gopSize",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 9007199254740991,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.maxBitrate",
    contract: "system",
    path: "ffmpeg.maxBitrate",
    type: "string",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.preferredHwDevice",
    contract: "system",
    path: "ffmpeg.preferredHwDevice",
    type: "string",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.preset",
    contract: "system",
    path: "ffmpeg.preset",
    type: "string",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.realtime.enabled",
    contract: "system",
    path: "ffmpeg.realtime.enabled",
    type: "boolean",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.realtime.resolutions",
    contract: "system",
    path: "ffmpeg.realtime.resolutions",
    type: "array",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.realtime.videoCodecs",
    contract: "system",
    path: "ffmpeg.realtime.videoCodecs",
    type: "array",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.refs",
    contract: "system",
    path: "ffmpeg.refs",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 6,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.targetAudioCodec",
    contract: "system",
    path: "ffmpeg.targetAudioCodec",
    type: "string",
    nullable: false,
    enum: ["mp3", "aac", "libopus", "opus", "pcm_s16le"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.targetResolution",
    contract: "system",
    path: "ffmpeg.targetResolution",
    type: "string",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.targetVideoCodec",
    contract: "system",
    path: "ffmpeg.targetVideoCodec",
    type: "string",
    nullable: false,
    enum: ["h264", "hevc", "vp9", "av1"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.temporalAQ",
    contract: "system",
    path: "ffmpeg.temporalAQ",
    type: "boolean",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.threads",
    contract: "system",
    path: "ffmpeg.threads",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 9007199254740991,
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.tonemap",
    contract: "system",
    path: "ffmpeg.tonemap",
    type: "string",
    nullable: false,
    enum: ["hable", "mobius", "reinhard", "disabled"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.transcode",
    contract: "system",
    path: "ffmpeg.transcode",
    type: "string",
    nullable: false,
    enum: ["all", "optimal", "bitrate", "required", "disabled"],
    form: "system/video-transcoding",
  },
  {
    id: "system:ffmpeg.twoPass",
    contract: "system",
    path: "ffmpeg.twoPass",
    type: "boolean",
    nullable: false,
    form: "system/video-transcoding",
  },
  {
    id: "system:image.colorspace",
    contract: "system",
    path: "image.colorspace",
    type: "string",
    nullable: false,
    enum: ["srgb", "p3"],
    form: "system/image",
  },
  {
    id: "system:image.enhancedRaw.enabled",
    contract: "system",
    path: "image.enhancedRaw.enabled",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.extractEmbedded",
    contract: "system",
    path: "image.extractEmbedded",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.fullsize.enabled",
    contract: "system",
    path: "image.fullsize.enabled",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.fullsize.format",
    contract: "system",
    path: "image.fullsize.format",
    type: "string",
    nullable: false,
    enum: ["jpeg", "webp"],
    form: "system/image",
  },
  {
    id: "system:image.fullsize.progressive",
    contract: "system",
    path: "image.fullsize.progressive",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.fullsize.quality",
    contract: "system",
    path: "image.fullsize.quality",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 100,
    form: "system/image",
  },
  {
    id: "system:image.preview.format",
    contract: "system",
    path: "image.preview.format",
    type: "string",
    nullable: false,
    enum: ["jpeg", "webp"],
    form: "system/image",
  },
  {
    id: "system:image.preview.progressive",
    contract: "system",
    path: "image.preview.progressive",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.preview.quality",
    contract: "system",
    path: "image.preview.quality",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 100,
    form: "system/image",
  },
  {
    id: "system:image.preview.size",
    contract: "system",
    path: "image.preview.size",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/image",
  },
  {
    id: "system:image.thumbnail.format",
    contract: "system",
    path: "image.thumbnail.format",
    type: "string",
    nullable: false,
    enum: ["jpeg", "webp"],
    form: "system/image",
  },
  {
    id: "system:image.thumbnail.progressive",
    contract: "system",
    path: "image.thumbnail.progressive",
    type: "boolean",
    nullable: false,
    form: "system/image",
  },
  {
    id: "system:image.thumbnail.quality",
    contract: "system",
    path: "image.thumbnail.quality",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 100,
    form: "system/image",
  },
  {
    id: "system:image.thumbnail.size",
    contract: "system",
    path: "image.thumbnail.size",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/image",
  },
  {
    id: "system:integrityChecks.checksumFiles.cronExpression",
    contract: "system",
    path: "integrityChecks.checksumFiles.cronExpression",
    type: "string",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.checksumFiles.enabled",
    contract: "system",
    path: "integrityChecks.checksumFiles.enabled",
    type: "boolean",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.checksumFiles.percentageLimit",
    contract: "system",
    path: "integrityChecks.checksumFiles.percentageLimit",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.checksumFiles.timeLimit",
    contract: "system",
    path: "integrityChecks.checksumFiles.timeLimit",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 9007199254740991,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.missingFiles.cronExpression",
    contract: "system",
    path: "integrityChecks.missingFiles.cronExpression",
    type: "string",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.missingFiles.enabled",
    contract: "system",
    path: "integrityChecks.missingFiles.enabled",
    type: "boolean",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.untrackedFiles.cronExpression",
    contract: "system",
    path: "integrityChecks.untrackedFiles.cronExpression",
    type: "string",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:integrityChecks.untrackedFiles.enabled",
    contract: "system",
    path: "integrityChecks.untrackedFiles.enabled",
    type: "boolean",
    nullable: false,
    form: "system/integrity-checks",
  },
  {
    id: "system:job.backgroundTask.concurrency",
    contract: "system",
    path: "job.backgroundTask.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.editor.concurrency",
    contract: "system",
    path: "job.editor.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.faceDetection.concurrency",
    contract: "system",
    path: "job.faceDetection.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.imageDescription.concurrency",
    contract: "system",
    path: "job.imageDescription.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.imageEnrichment.concurrency",
    contract: "system",
    path: "job.imageEnrichment.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.integrityCheck.concurrency",
    contract: "system",
    path: "job.integrityCheck.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.library.concurrency",
    contract: "system",
    path: "job.library.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.mediaHealth.concurrency",
    contract: "system",
    path: "job.mediaHealth.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.metadataExtraction.concurrency",
    contract: "system",
    path: "job.metadataExtraction.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.migration.concurrency",
    contract: "system",
    path: "job.migration.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.notifications.concurrency",
    contract: "system",
    path: "job.notifications.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.nsfwDetection.concurrency",
    contract: "system",
    path: "job.nsfwDetection.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.ocr.concurrency",
    contract: "system",
    path: "job.ocr.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.search.concurrency",
    contract: "system",
    path: "job.search.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.sidecar.concurrency",
    contract: "system",
    path: "job.sidecar.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.smartSearch.concurrency",
    contract: "system",
    path: "job.smartSearch.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.thumbnailGeneration.concurrency",
    contract: "system",
    path: "job.thumbnailGeneration.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.videoConversion.concurrency",
    contract: "system",
    path: "job.videoConversion.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.videoDuplicateDetection.concurrency",
    contract: "system",
    path: "job.videoDuplicateDetection.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:job.workflow.concurrency",
    contract: "system",
    path: "job.workflow.concurrency",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/job",
  },
  {
    id: "system:library.scan.cronExpression",
    contract: "system",
    path: "library.scan.cronExpression",
    type: "string",
    nullable: false,
    form: "system/external-library",
  },
  {
    id: "system:library.scan.enabled",
    contract: "system",
    path: "library.scan.enabled",
    type: "boolean",
    nullable: false,
    form: "system/external-library",
  },
  {
    id: "system:library.watch.enabled",
    contract: "system",
    path: "library.watch.enabled",
    type: "boolean",
    nullable: false,
    form: "system/external-library",
  },
  {
    id: "system:localFeatures.askSearch.enabled",
    contract: "system",
    path: "localFeatures.askSearch.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:localFeatures.askSearch.maxResults",
    contract: "system",
    path: "localFeatures.askSearch.maxResults",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 1000,
    form: "system/machine-learning",
  },
  {
    id: "system:logging.enabled",
    contract: "system",
    path: "logging.enabled",
    type: "boolean",
    nullable: false,
    form: "system/logging",
  },
  {
    id: "system:logging.level",
    contract: "system",
    path: "logging.level",
    type: "string",
    nullable: false,
    enum: ["verbose", "debug", "log", "warn", "error", "fatal"],
    form: "system/logging",
  },
  {
    id: "system:machineLearning.availabilityChecks.enabled",
    contract: "system",
    path: "machineLearning.availabilityChecks.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.availabilityChecks.interval",
    contract: "system",
    path: "machineLearning.availabilityChecks.interval",
    type: "integer",
    nullable: false,
    minimum: -9007199254740991,
    maximum: 9007199254740991,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.availabilityChecks.timeout",
    contract: "system",
    path: "machineLearning.availabilityChecks.timeout",
    type: "integer",
    nullable: false,
    minimum: -9007199254740991,
    maximum: 9007199254740991,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.clip.enabled",
    contract: "system",
    path: "machineLearning.clip.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.clip.modelName",
    contract: "system",
    path: "machineLearning.clip.modelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.clip.zeroShotTagging.enabled",
    contract: "system",
    path: "machineLearning.clip.zeroShotTagging.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.clip.zeroShotTagging.maxTags",
    contract: "system",
    path: "machineLearning.clip.zeroShotTagging.maxTags",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 20,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.clip.zeroShotTagging.minSimilarity",
    contract: "system",
    path: "machineLearning.clip.zeroShotTagging.minSimilarity",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.enabled",
    contract: "system",
    path: "machineLearning.duplicateDetection.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.enhancedVideo.enabled",
    contract: "system",
    path: "machineLearning.duplicateDetection.enhancedVideo.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.enhancedVideo.frameCount",
    contract: "system",
    path: "machineLearning.duplicateDetection.enhancedVideo.frameCount",
    type: "integer",
    nullable: false,
    minimum: 2,
    maximum: 8,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.enhancedVideo.maxDistance",
    contract: "system",
    path: "machineLearning.duplicateDetection.enhancedVideo.maxDistance",
    type: "number",
    nullable: false,
    minimum: 0.001,
    maximum: 0.1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.enhancedVideo.minMatchingFrames",
    contract: "system",
    path: "machineLearning.duplicateDetection.enhancedVideo.minMatchingFrames",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 8,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.maxDistance",
    contract: "system",
    path: "machineLearning.duplicateDetection.maxDistance",
    type: "number",
    nullable: false,
    minimum: 0.001,
    maximum: 0.1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.duplicateDetection.preferOriginalFormat",
    contract: "system",
    path: "machineLearning.duplicateDetection.preferOriginalFormat",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.enabled",
    contract: "system",
    path: "machineLearning.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.facialRecognition.enabled",
    contract: "system",
    path: "machineLearning.facialRecognition.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.facialRecognition.maxDistance",
    contract: "system",
    path: "machineLearning.facialRecognition.maxDistance",
    type: "number",
    nullable: false,
    minimum: 0.1,
    maximum: 2,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.facialRecognition.minFaces",
    contract: "system",
    path: "machineLearning.facialRecognition.minFaces",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.facialRecognition.minScore",
    contract: "system",
    path: "machineLearning.facialRecognition.minScore",
    type: "number",
    nullable: false,
    minimum: 0.1,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.facialRecognition.modelName",
    contract: "system",
    path: "machineLearning.facialRecognition.modelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.acceleration",
    contract: "system",
    path: "machineLearning.imageDescription.acceleration",
    type: "string",
    nullable: false,
    enum: ["auto", "openvino", "cuda"],
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.device",
    contract: "system",
    path: "machineLearning.imageDescription.device",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.enabled",
    contract: "system",
    path: "machineLearning.imageDescription.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.fallbackModelName",
    contract: "system",
    path: "machineLearning.imageDescription.fallbackModelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.lastConfigChangeAt",
    contract: "system",
    path: "machineLearning.imageDescription.lastConfigChangeAt",
    type: "string",
    nullable: true,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.modelName",
    contract: "system",
    path: "machineLearning.imageDescription.modelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.pendingRequeueAt",
    contract: "system",
    path: "machineLearning.imageDescription.pendingRequeueAt",
    type: "string",
    nullable: true,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.advanced.enabled",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.advanced.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.advanced.placeholderValidation",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.advanced.placeholderValidation",
    type: "string",
    nullable: false,
    enum: ["strict", "warn"],
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.advanced.rawPromptTemplate",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.advanced.rawPromptTemplate",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.customInstructions",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.customInstructions",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.customVocabulary",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.customVocabulary",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.forbiddenInferences",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.forbiddenInferences",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.identityInjection.enabled",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.identityInjection.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.identityInjection.maxNames",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.identityInjection.maxNames",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 20,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.identityInjection.minFaceConfidence",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.identityInjection.minFaceConfidence",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.lookFor",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.lookFor",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.medicalIndicators",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.medicalIndicators",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.nsfwIndicators",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.nsfwIndicators",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.sentenceCountTarget",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.sentenceCountTarget",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 6,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.imageDescription.prompt.style",
    contract: "system",
    path: "machineLearning.imageDescription.prompt.style",
    type: "string",
    nullable: false,
    enum: ["terse", "balanced", "rich"],
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.nsfwDetection.device",
    contract: "system",
    path: "machineLearning.nsfwDetection.device",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.nsfwDetection.enabled",
    contract: "system",
    path: "machineLearning.nsfwDetection.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.nsfwDetection.hideFromLibrary",
    contract: "system",
    path: "machineLearning.nsfwDetection.hideFromLibrary",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.nsfwDetection.modelName",
    contract: "system",
    path: "machineLearning.nsfwDetection.modelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.nsfwDetection.threshold",
    contract: "system",
    path: "machineLearning.nsfwDetection.threshold",
    type: "number",
    nullable: false,
    minimum: 0.01,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.ocr.enabled",
    contract: "system",
    path: "machineLearning.ocr.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.ocr.maxResolution",
    contract: "system",
    path: "machineLearning.ocr.maxResolution",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.ocr.minDetectionScore",
    contract: "system",
    path: "machineLearning.ocr.minDetectionScore",
    type: "number",
    nullable: false,
    minimum: 0.1,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.ocr.minRecognitionScore",
    contract: "system",
    path: "machineLearning.ocr.minRecognitionScore",
    type: "number",
    nullable: false,
    minimum: 0.1,
    maximum: 1,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.ocr.modelName",
    contract: "system",
    path: "machineLearning.ocr.modelName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.apiKey",
    contract: "system",
    path: "machineLearning.runpod.apiKey",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.apiKeyConfigured",
    contract: "system",
    path: "machineLearning.runpod.apiKeyConfigured",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.autoBackfillOnLaunch",
    contract: "system",
    path: "machineLearning.runpod.autoBackfillOnLaunch",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.autoStopEnabled",
    contract: "system",
    path: "machineLearning.runpod.autoStopEnabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.autoStopGraceMinutes",
    contract: "system",
    path: "machineLearning.runpod.autoStopGraceMinutes",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 1440,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.containerDiskGb",
    contract: "system",
    path: "machineLearning.runpod.containerDiskGb",
    type: "integer",
    nullable: false,
    minimum: 10,
    maximum: 2000,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.dataPrivacyAcknowledged",
    contract: "system",
    path: "machineLearning.runpod.dataPrivacyAcknowledged",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.defaultGpuTypeId",
    contract: "system",
    path: "machineLearning.runpod.defaultGpuTypeId",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.enabled",
    contract: "system",
    path: "machineLearning.runpod.enabled",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.hfToken",
    contract: "system",
    path: "machineLearning.runpod.hfToken",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.hfTokenConfigured",
    contract: "system",
    path: "machineLearning.runpod.hfTokenConfigured",
    type: "boolean",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.imageName",
    contract: "system",
    path: "machineLearning.runpod.imageName",
    type: "string",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.maxRuntimeHours",
    contract: "system",
    path: "machineLearning.runpod.maxRuntimeHours",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 168,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.mode",
    contract: "system",
    path: "machineLearning.runpod.mode",
    type: "string",
    nullable: false,
    enum: ["disabled", "pod", "serverless"],
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.provisionTimeoutMinutes",
    contract: "system",
    path: "machineLearning.runpod.provisionTimeoutMinutes",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 60,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.executionTimeoutMs",
    contract: "system",
    path: "machineLearning.runpod.serverless.executionTimeoutMs",
    type: "integer",
    nullable: false,
    minimum: 5000,
    maximum: 3600000,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.gpuTypeIds",
    contract: "system",
    path: "machineLearning.runpod.serverless.gpuTypeIds",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.idleTimeoutSeconds",
    contract: "system",
    path: "machineLearning.runpod.serverless.idleTimeoutSeconds",
    type: "integer",
    nullable: false,
    minimum: 5,
    maximum: 3600,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.scalerType",
    contract: "system",
    path: "machineLearning.runpod.serverless.scalerType",
    type: "string",
    nullable: false,
    enum: ["QUEUE_DELAY", "REQUEST_COUNT"],
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.scalerValue",
    contract: "system",
    path: "machineLearning.runpod.serverless.scalerValue",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 60,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.workersMax",
    contract: "system",
    path: "machineLearning.runpod.serverless.workersMax",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 20,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.serverless.workersMin",
    contract: "system",
    path: "machineLearning.runpod.serverless.workersMin",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 10,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.runpod.volumeGb",
    contract: "system",
    path: "machineLearning.runpod.volumeGb",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 2000,
    form: "system/machine-learning",
  },
  {
    id: "system:machineLearning.urls",
    contract: "system",
    path: "machineLearning.urls",
    type: "array",
    nullable: false,
    form: "system/machine-learning",
  },
  {
    id: "system:map.darkStyle",
    contract: "system",
    path: "map.darkStyle",
    type: "string",
    nullable: false,
    form: "system/location",
  },
  {
    id: "system:map.enabled",
    contract: "system",
    path: "map.enabled",
    type: "boolean",
    nullable: false,
    form: "system/location",
  },
  {
    id: "system:map.lightStyle",
    contract: "system",
    path: "map.lightStyle",
    type: "string",
    nullable: false,
    form: "system/location",
  },
  {
    id: "system:metadata.faces.import",
    contract: "system",
    path: "metadata.faces.import",
    type: "boolean",
    nullable: false,
    form: "system/metadata",
  },
  {
    id: "system:newVersionCheck.channel",
    contract: "system",
    path: "newVersionCheck.channel",
    type: "string",
    nullable: false,
    enum: ["stable", "releaseCandidate"],
    form: "system/version-check",
  },
  {
    id: "system:newVersionCheck.enabled",
    contract: "system",
    path: "newVersionCheck.enabled",
    type: "boolean",
    nullable: false,
    form: "system/version-check",
  },
  {
    id: "system:nightlyTasks.clusterNewFaces",
    contract: "system",
    path: "nightlyTasks.clusterNewFaces",
    type: "boolean",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:nightlyTasks.databaseCleanup",
    contract: "system",
    path: "nightlyTasks.databaseCleanup",
    type: "boolean",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:nightlyTasks.generateMemories",
    contract: "system",
    path: "nightlyTasks.generateMemories",
    type: "boolean",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:nightlyTasks.missingThumbnails",
    contract: "system",
    path: "nightlyTasks.missingThumbnails",
    type: "boolean",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:nightlyTasks.startTime",
    contract: "system",
    path: "nightlyTasks.startTime",
    type: "string",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:nightlyTasks.syncQuotaUsage",
    contract: "system",
    path: "nightlyTasks.syncQuotaUsage",
    type: "boolean",
    nullable: false,
    form: "system/nightly-tasks",
  },
  {
    id: "system:notifications.smtp.enabled",
    contract: "system",
    path: "notifications.smtp.enabled",
    type: "boolean",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.from",
    contract: "system",
    path: "notifications.smtp.from",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.replyTo",
    contract: "system",
    path: "notifications.smtp.replyTo",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.host",
    contract: "system",
    path: "notifications.smtp.transport.host",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.ignoreCert",
    contract: "system",
    path: "notifications.smtp.transport.ignoreCert",
    type: "boolean",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.password",
    contract: "system",
    path: "notifications.smtp.transport.password",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.port",
    contract: "system",
    path: "notifications.smtp.transport.port",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 65535,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.secure",
    contract: "system",
    path: "notifications.smtp.transport.secure",
    type: "boolean",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:notifications.smtp.transport.username",
    contract: "system",
    path: "notifications.smtp.transport.username",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:oauth.accountManagementUrl",
    contract: "system",
    path: "oauth.accountManagementUrl",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.allowInsecureRequests",
    contract: "system",
    path: "oauth.allowInsecureRequests",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.autoLaunch",
    contract: "system",
    path: "oauth.autoLaunch",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.autoRegister",
    contract: "system",
    path: "oauth.autoRegister",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.buttonText",
    contract: "system",
    path: "oauth.buttonText",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.clientId",
    contract: "system",
    path: "oauth.clientId",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.clientSecret",
    contract: "system",
    path: "oauth.clientSecret",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.defaultStorageQuota",
    contract: "system",
    path: "oauth.defaultStorageQuota",
    type: "integer",
    nullable: true,
    minimum: 0,
    maximum: 9007199254740991,
    form: "system/authentication",
  },
  {
    id: "system:oauth.enabled",
    contract: "system",
    path: "oauth.enabled",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.endSessionEndpoint",
    contract: "system",
    path: "oauth.endSessionEndpoint",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.frameleafMobileRedirectUri",
    contract: "system",
    path: "oauth.frameleafMobileRedirectUri",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.issuerUrl",
    contract: "system",
    path: "oauth.issuerUrl",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.mobileOverrideEnabled",
    contract: "system",
    path: "oauth.mobileOverrideEnabled",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.mobileRedirectUri",
    contract: "system",
    path: "oauth.mobileRedirectUri",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.profileSigningAlgorithm",
    contract: "system",
    path: "oauth.profileSigningAlgorithm",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.prompt",
    contract: "system",
    path: "oauth.prompt",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.roleClaim",
    contract: "system",
    path: "oauth.roleClaim",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.scope",
    contract: "system",
    path: "oauth.scope",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.signingAlgorithm",
    contract: "system",
    path: "oauth.signingAlgorithm",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.storageLabelClaim",
    contract: "system",
    path: "oauth.storageLabelClaim",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.storageQuotaClaim",
    contract: "system",
    path: "oauth.storageQuotaClaim",
    type: "string",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:oauth.timeout",
    contract: "system",
    path: "oauth.timeout",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/authentication",
  },
  {
    id: "system:oauth.tokenEndpointAuthMethod",
    contract: "system",
    path: "oauth.tokenEndpointAuthMethod",
    type: "string",
    nullable: false,
    enum: ["client_secret_post", "client_secret_basic"],
    form: "system/authentication",
  },
  {
    id: "system:passwordLogin.enabled",
    contract: "system",
    path: "passwordLogin.enabled",
    type: "boolean",
    nullable: false,
    form: "system/authentication",
  },
  {
    id: "system:physicalDeduplication.enabled",
    contract: "system",
    path: "physicalDeduplication.enabled",
    type: "boolean",
    nullable: false,
    form: "system/storage-template",
  },
  {
    id: "system:physicalDeduplication.masterUserId",
    contract: "system",
    path: "physicalDeduplication.masterUserId",
    type: "string",
    nullable: true,
    form: "system/storage-template",
  },
  {
    id: "system:reverseGeocoding.enabled",
    contract: "system",
    path: "reverseGeocoding.enabled",
    type: "boolean",
    nullable: false,
    form: "system/location",
  },
  {
    id: "system:server.externalDomain",
    contract: "system",
    path: "server.externalDomain",
    type: "string",
    nullable: false,
    form: "system/server",
  },
  {
    id: "system:server.loginPageMessage",
    contract: "system",
    path: "server.loginPageMessage",
    type: "string",
    nullable: false,
    form: "system/server",
  },
  {
    id: "system:server.publicUsers",
    contract: "system",
    path: "server.publicUsers",
    type: "boolean",
    nullable: false,
    form: "system/server",
  },
  {
    id: "system:smartAlbums.builtIn.documents.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.documents.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.documents.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.documents.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.documents.name",
    contract: "system",
    path: "smartAlbums.builtIn.documents.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.documents.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.documents.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.documents.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.documents.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.food.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.food.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.food.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.food.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.food.name",
    contract: "system",
    path: "smartAlbums.builtIn.food.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.food.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.food.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.food.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.food.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.nature.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.nature.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.nature.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.nature.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.nature.name",
    contract: "system",
    path: "smartAlbums.builtIn.nature.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.nature.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.nature.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.nature.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.nature.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.pets.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.pets.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.pets.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.pets.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.pets.name",
    contract: "system",
    path: "smartAlbums.builtIn.pets.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.pets.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.pets.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.pets.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.pets.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.screenshots.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.screenshots.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.screenshots.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.screenshots.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.screenshots.name",
    contract: "system",
    path: "smartAlbums.builtIn.screenshots.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.screenshots.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.screenshots.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.screenshots.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.screenshots.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.travel.clipQueries",
    contract: "system",
    path: "smartAlbums.builtIn.travel.clipQueries",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.travel.enabled",
    contract: "system",
    path: "smartAlbums.builtIn.travel.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.travel.name",
    contract: "system",
    path: "smartAlbums.builtIn.travel.name",
    type: "string",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.travel.tagTriggers",
    contract: "system",
    path: "smartAlbums.builtIn.travel.tagTriggers",
    type: "array",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.builtIn.travel.threshold",
    contract: "system",
    path: "smartAlbums.builtIn.travel.threshold",
    type: "number",
    nullable: false,
    minimum: 0,
    maximum: 1,
    form: "system/smart-albums",
  },
  {
    id: "system:smartAlbums.enabled",
    contract: "system",
    path: "smartAlbums.enabled",
    type: "boolean",
    nullable: false,
    form: "system/smart-albums",
  },
  {
    id: "system:storageTemplate.enabled",
    contract: "system",
    path: "storageTemplate.enabled",
    type: "boolean",
    nullable: false,
    form: "system/storage-template",
  },
  {
    id: "system:storageTemplate.hashVerificationEnabled",
    contract: "system",
    path: "storageTemplate.hashVerificationEnabled",
    type: "boolean",
    nullable: false,
    form: "system/storage-template",
  },
  {
    id: "system:storageTemplate.template",
    contract: "system",
    path: "storageTemplate.template",
    type: "string",
    nullable: false,
    form: "system/storage-template",
  },
  {
    id: "system:templates.email.albumInviteTemplate",
    contract: "system",
    path: "templates.email.albumInviteTemplate",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:templates.email.albumUpdateTemplate",
    contract: "system",
    path: "templates.email.albumUpdateTemplate",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:templates.email.welcomeTemplate",
    contract: "system",
    path: "templates.email.welcomeTemplate",
    type: "string",
    nullable: false,
    form: "system/notifications",
  },
  {
    id: "system:theme.customCss",
    contract: "system",
    path: "theme.customCss",
    type: "string",
    nullable: false,
    form: "system/theme",
  },
  {
    id: "system:trash.days",
    contract: "system",
    path: "trash.days",
    type: "integer",
    nullable: false,
    minimum: 0,
    maximum: 9007199254740991,
    form: "system/trash",
  },
  {
    id: "system:trash.enabled",
    contract: "system",
    path: "trash.enabled",
    type: "boolean",
    nullable: false,
    form: "system/trash",
  },
  {
    id: "system:user.deleteDelay",
    contract: "system",
    path: "user.deleteDelay",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "system/user-settings",
  },
  {
    id: "personal:albums.defaultAssetOrder",
    contract: "personal",
    path: "albums.defaultAssetOrder",
    type: "string",
    nullable: false,
    enum: ["asc", "desc"],
    form: "personal/features",
  },
  {
    id: "personal:cast.gCastEnabled",
    contract: "personal",
    path: "cast.gCastEnabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:download.archiveSize",
    contract: "personal",
    path: "download.archiveSize",
    type: "integer",
    nullable: false,
    minimum: -9007199254740991,
    maximum: 9007199254740991,
    form: "personal/downloads",
  },
  {
    id: "personal:download.includeEmbeddedVideos",
    contract: "personal",
    path: "download.includeEmbeddedVideos",
    type: "boolean",
    nullable: false,
    form: "personal/downloads",
  },
  {
    id: "personal:emailNotifications.albumInvite",
    contract: "personal",
    path: "emailNotifications.albumInvite",
    type: "boolean",
    nullable: false,
    form: "personal/notifications",
  },
  {
    id: "personal:emailNotifications.albumUpdate",
    contract: "personal",
    path: "emailNotifications.albumUpdate",
    type: "boolean",
    nullable: false,
    form: "personal/notifications",
  },
  {
    id: "personal:emailNotifications.enabled",
    contract: "personal",
    path: "emailNotifications.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/notifications",
  },
  {
    id: "personal:folders.enabled",
    contract: "personal",
    path: "folders.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:folders.sidebarWeb",
    contract: "personal",
    path: "folders.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:memories.duration",
    contract: "personal",
    path: "memories.duration",
    type: "integer",
    nullable: false,
    minimum: -9007199254740991,
    maximum: 9007199254740991,
    form: "personal/features",
  },
  {
    id: "personal:memories.enabled",
    contract: "personal",
    path: "memories.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:memories.sidebarWeb",
    contract: "personal",
    path: "memories.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:people.enabled",
    contract: "personal",
    path: "people.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:people.minimumFaces",
    contract: "personal",
    path: "people.minimumFaces",
    type: "integer",
    nullable: false,
    minimum: 1,
    maximum: 9007199254740991,
    form: "personal/features",
  },
  {
    id: "personal:people.sidebarWeb",
    contract: "personal",
    path: "people.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:privacy.suppression.personIds",
    contract: "personal",
    path: "privacy.suppression.personIds",
    type: "array",
    nullable: false,
    form: "personal/suppression",
  },
  {
    id: "personal:privacy.suppression.scope",
    contract: "personal",
    path: "privacy.suppression.scope",
    type: "string",
    nullable: false,
    enum: ["owned", "visible"],
    form: "personal/suppression",
  },
  {
    id: "personal:privacy.suppression.tagIds",
    contract: "personal",
    path: "privacy.suppression.tagIds",
    type: "array",
    nullable: false,
    form: "personal/suppression",
  },
  {
    id: "personal:purchase.hideBuyButtonUntil",
    contract: "personal",
    path: "purchase.hideBuyButtonUntil",
    type: "string",
    nullable: false,
    form: "personal/purchase",
  },
  {
    id: "personal:purchase.showSupportBadge",
    contract: "personal",
    path: "purchase.showSupportBadge",
    type: "boolean",
    nullable: false,
    form: "personal/purchase",
  },
  {
    id: "personal:ratings.enabled",
    contract: "personal",
    path: "ratings.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:recentlyAdded.sidebarWeb",
    contract: "personal",
    path: "recentlyAdded.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:sharedLinks.enabled",
    contract: "personal",
    path: "sharedLinks.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:sharedLinks.sidebarWeb",
    contract: "personal",
    path: "sharedLinks.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:tags.enabled",
    contract: "personal",
    path: "tags.enabled",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
  {
    id: "personal:tags.sidebarWeb",
    contract: "personal",
    path: "tags.sidebarWeb",
    type: "boolean",
    nullable: false,
    form: "personal/features",
  },
];

const bindings = {
  "system:backup.database.enabled": {
    field: "databaseBackup",
  },
  "system:backup.database.cronExpression": {
    field: "backupCron",
  },
  "system:backup.database.keepLastAmount": {
    field: "backupRetention",
  },
  "system:ffmpeg.accel": {
    field: "acceleration",
  },
  "system:ffmpeg.accelDecode": {
    field: "advancedHardwareDecode",
  },
  "system:ffmpeg.acceptedAudioCodecs": {
    field: "advancedAcceptedAudio",
  },
  "system:ffmpeg.acceptedContainers": {
    field: "advancedAcceptedContainers",
  },
  "system:ffmpeg.acceptedVideoCodecs": {
    field: "advancedAcceptedVideo",
  },
  "system:ffmpeg.bframes": {
    field: "videoBframes",
  },
  "system:ffmpeg.cqMode": {
    field: "videoCqMode",
  },
  "system:ffmpeg.crf": {
    field: "playbackCrf",
  },
  "system:ffmpeg.gopSize": {
    field: "advancedGopSize",
  },
  "system:ffmpeg.maxBitrate": {
    field: "advancedMaxBitrate",
  },
  "system:ffmpeg.preferredHwDevice": {
    field: "advancedHardwareDevice",
  },
  "system:ffmpeg.preset": {
    field: "playbackPreset",
  },
  "system:ffmpeg.realtime.enabled": {
    field: "advancedHlsEnabled",
  },
  "system:ffmpeg.realtime.resolutions": {
    field: "advancedHlsResolutions",
  },
  "system:ffmpeg.realtime.videoCodecs": {
    field: "advancedHlsCodecs",
  },
  "system:ffmpeg.refs": {
    field: "videoReferences",
  },
  "system:ffmpeg.targetAudioCodec": {
    field: "audioCodec",
  },
  "system:ffmpeg.targetResolution": {
    field: "playbackResolution",
  },
  "system:ffmpeg.targetVideoCodec": {
    field: "playbackCodec",
  },
  "system:ffmpeg.temporalAQ": {
    field: "videoTemporalAQ",
  },
  "system:ffmpeg.threads": {
    field: "advancedFfmpegThreads",
  },
  "system:ffmpeg.tonemap": {
    field: "advancedToneMapping",
  },
  "system:ffmpeg.transcode": {
    field: "transcodePolicy",
  },
  "system:ffmpeg.twoPass": {
    field: "advancedTwoPass",
  },
  "system:image.colorspace": {
    field: "advancedImageColorSpace",
  },
  "system:image.enhancedRaw.enabled": {
    field: "imageEnhancedRaw",
  },
  "system:image.extractEmbedded": {
    field: "advancedExtractEmbedded",
  },
  "system:image.fullsize.enabled": {
    field: "advancedFullsizeImages",
  },
  "system:image.fullsize.format": {
    field: "imageFullsizeFormat",
  },
  "system:image.fullsize.progressive": {
    field: "imageFullsizeProgressive",
  },
  "system:image.fullsize.quality": {
    field: "imageFullsizeQuality",
  },
  "system:image.preview.format": {
    field: "previewFormat",
  },
  "system:image.preview.progressive": {
    field: "advancedProgressiveJpeg",
  },
  "system:image.preview.quality": {
    field: "previewQuality",
  },
  "system:image.preview.size": {
    field: "previewSize",
  },
  "system:image.thumbnail.format": {
    field: "imageThumbnailFormat",
  },
  "system:image.thumbnail.progressive": {
    field: "imageThumbnailProgressive",
  },
  "system:image.thumbnail.quality": {
    field: "imageThumbnailQuality",
  },
  "system:image.thumbnail.size": {
    field: "thumbnailSize",
  },
  "system:integrityChecks.checksumFiles.cronExpression": {
    field: "checksumFilesSchedule",
  },
  "system:integrityChecks.checksumFiles.enabled": {
    field: "checksumScan",
  },
  "system:integrityChecks.checksumFiles.percentageLimit": {
    field: "advancedChecksumFraction",
  },
  "system:integrityChecks.checksumFiles.timeLimit": {
    field: "advancedChecksumTime",
  },
  "system:integrityChecks.missingFiles.cronExpression": {
    field: "missingFilesSchedule",
  },
  "system:integrityChecks.missingFiles.enabled": {
    field: "missingFilesEnabled",
  },
  "system:integrityChecks.untrackedFiles.cronExpression": {
    field: "untrackedFilesSchedule",
  },
  "system:integrityChecks.untrackedFiles.enabled": {
    field: "untrackedFilesEnabled",
  },
  "system:library.scan.cronExpression": {
    field: "libraryScanCron",
  },
  "system:library.scan.enabled": {
    field: "libraryScheduledScan",
  },
  "system:library.watch.enabled": {
    field: "libraryWatch",
  },
  "system:localFeatures.askSearch.enabled": {
    field: "advancedAskEnabled",
  },
  "system:localFeatures.askSearch.maxResults": {
    field: "advancedAskMaxResults",
  },
  "system:logging.enabled": {
    field: "loggingEnabled",
  },
  "system:logging.level": {
    field: "logLevel",
  },
  "system:machineLearning.availabilityChecks.enabled": {
    field: "endpointHealth",
  },
  "system:machineLearning.availabilityChecks.interval": {
    field: "advancedMlHealthInterval",
  },
  "system:machineLearning.availabilityChecks.timeout": {
    field: "advancedMlHealthTimeout",
  },
  "system:machineLearning.clip.enabled": {
    field: "smartSearch",
  },
  "system:machineLearning.clip.modelName": {
    field: "clipModel",
  },
  "system:machineLearning.clip.zeroShotTagging.enabled": {
    field: "advancedZeroShotEnabled",
  },
  "system:machineLearning.clip.zeroShotTagging.maxTags": {
    field: "advancedZeroShotMaxTags",
  },
  "system:machineLearning.clip.zeroShotTagging.minSimilarity": {
    field: "advancedZeroShotSimilarity",
  },
  "system:machineLearning.duplicateDetection.enabled": {
    field: "advancedDuplicateDetection",
  },
  "system:machineLearning.duplicateDetection.enhancedVideo.enabled": {
    field: "advancedVideoDuplicate",
  },
  "system:machineLearning.duplicateDetection.enhancedVideo.frameCount": {
    field: "advancedVideoDuplicateFrames",
  },
  "system:machineLearning.duplicateDetection.enhancedVideo.maxDistance": {
    field: "advancedVideoDuplicateDistance",
  },
  "system:machineLearning.duplicateDetection.enhancedVideo.minMatchingFrames": {
    field: "advancedVideoMatchingFrames",
  },
  "system:machineLearning.duplicateDetection.maxDistance": {
    field: "advancedDuplicateDistance",
  },
  "system:machineLearning.duplicateDetection.preferOriginalFormat": {
    field: "advancedPreferOriginal",
  },
  "system:machineLearning.enabled": {
    field: "advancedMlEnabled",
  },
  "system:machineLearning.facialRecognition.enabled": {
    field: "faceRecognition",
  },
  "system:machineLearning.facialRecognition.maxDistance": {
    field: "faceDistance",
  },
  "system:machineLearning.facialRecognition.minFaces": {
    field: "advancedFaceClusterMinimum",
  },
  "system:machineLearning.facialRecognition.minScore": {
    field: "advancedFaceDetectionScore",
  },
  "system:machineLearning.facialRecognition.modelName": {
    field: "advancedFaceModel",
  },
  "system:machineLearning.imageDescription.acceleration": {
    field: "advancedDescriptionAcceleration",
  },
  "system:machineLearning.imageDescription.device": {
    field: "advancedDescriptionDevice",
  },
  "system:machineLearning.imageDescription.enabled": {
    field: "descriptions",
  },
  "system:machineLearning.imageDescription.fallbackModelName": {
    field: "advancedDescriptionFallback",
  },
  "system:machineLearning.imageDescription.modelName": {
    field: "descriptionModel",
  },
  "system:machineLearning.imageDescription.prompt.advanced.enabled": {
    field: "advancedDescriptionRawEnabled",
  },
  "system:machineLearning.imageDescription.prompt.advanced.placeholderValidation":
    {
      field: "advancedDescriptionPlaceholders",
    },
  "system:machineLearning.imageDescription.prompt.advanced.rawPromptTemplate": {
    field: "advancedDescriptionRawTemplate",
  },
  "system:machineLearning.imageDescription.prompt.customInstructions": {
    field: "advancedDescriptionInstructions",
  },
  "system:machineLearning.imageDescription.prompt.customVocabulary": {
    field: "advancedDescriptionVocabulary",
  },
  "system:machineLearning.imageDescription.prompt.forbiddenInferences": {
    field: "advancedDescriptionForbidden",
  },
  "system:machineLearning.imageDescription.prompt.identityInjection.enabled": {
    field: "advancedDescriptionIdentity",
  },
  "system:machineLearning.imageDescription.prompt.identityInjection.maxNames": {
    field: "advancedDescriptionNameCap",
  },
  "system:machineLearning.imageDescription.prompt.identityInjection.minFaceConfidence":
    {
      field: "advancedDescriptionFaceConfidence",
    },
  "system:machineLearning.imageDescription.prompt.lookFor": {
    field: "advancedDescriptionLookFor",
  },
  "system:machineLearning.imageDescription.prompt.medicalIndicators": {
    field: "advancedDescriptionMedical",
  },
  "system:machineLearning.imageDescription.prompt.nsfwIndicators": {
    field: "advancedDescriptionSensitive",
  },
  "system:machineLearning.imageDescription.prompt.sentenceCountTarget": {
    field: "advancedDescriptionSentences",
  },
  "system:machineLearning.imageDescription.prompt.style": {
    field: "advancedDescriptionStyle",
  },
  "system:machineLearning.nsfwDetection.device": {
    field: "advancedSensitiveDevice",
  },
  "system:machineLearning.nsfwDetection.enabled": {
    field: "sensitiveDetect",
  },
  "system:machineLearning.nsfwDetection.hideFromLibrary": {
    field: "hideSensitive",
  },
  "system:machineLearning.nsfwDetection.modelName": {
    field: "advancedSensitiveModel",
  },
  "system:machineLearning.nsfwDetection.threshold": {
    field: "sensitiveThreshold",
  },
  "system:machineLearning.ocr.enabled": {
    field: "ocr",
  },
  "system:machineLearning.ocr.maxResolution": {
    field: "advancedOcrResolution",
  },
  "system:machineLearning.ocr.minDetectionScore": {
    field: "advancedOcrDetectionScore",
  },
  "system:machineLearning.ocr.minRecognitionScore": {
    field: "ocrConfidence",
  },
  "system:machineLearning.ocr.modelName": {
    field: "advancedOcrModel",
  },
  "system:machineLearning.runpod.autoBackfillOnLaunch": {
    field: "advancedRunPodBackfill",
  },
  "system:machineLearning.runpod.autoStopEnabled": {
    field: "advancedRunPodAutoStop",
  },
  "system:machineLearning.runpod.autoStopGraceMinutes": {
    field: "advancedRunPodGrace",
  },
  "system:machineLearning.runpod.containerDiskGb": {
    field: "advancedRunPodDisk",
  },
  "system:machineLearning.runpod.defaultGpuTypeId": {
    field: "advancedRunPodGpu",
  },
  "system:machineLearning.runpod.enabled": {
    field: "advancedRunPodMode",
  },
  "system:machineLearning.runpod.imageName": {
    field: "advancedRunPodImage",
  },
  "system:machineLearning.runpod.maxRuntimeHours": {
    field: "advancedRunPodRuntime",
  },
  "system:machineLearning.runpod.mode": {
    field: "advancedRunPodMode",
  },
  "system:machineLearning.runpod.provisionTimeoutMinutes": {
    field: "advancedRunPodProvisionTimeout",
  },
  "system:machineLearning.runpod.serverless.executionTimeoutMs": {
    field: "advancedServerlessExecution",
  },
  "system:machineLearning.runpod.serverless.gpuTypeIds": {
    field: "advancedServerlessGpuPools",
  },
  "system:machineLearning.runpod.serverless.idleTimeoutSeconds": {
    field: "advancedServerlessIdle",
  },
  "system:machineLearning.runpod.serverless.scalerType": {
    field: "advancedServerlessScaler",
  },
  "system:machineLearning.runpod.serverless.scalerValue": {
    field: "advancedServerlessScaleThreshold",
  },
  "system:machineLearning.runpod.serverless.workersMax": {
    field: "advancedServerlessMax",
  },
  "system:machineLearning.runpod.serverless.workersMin": {
    field: "advancedServerlessMin",
  },
  "system:machineLearning.runpod.volumeGb": {
    field: "advancedRunPodVolume",
  },
  "system:machineLearning.urls": {
    field: "advancedMlUrls",
  },
  "system:map.darkStyle": {
    field: "advancedMapDarkStyle",
  },
  "system:map.enabled": {
    field: "mapsEnabled",
  },
  "system:map.lightStyle": {
    field: "advancedMapLightStyle",
  },
  "system:metadata.faces.import": {
    field: "advancedImportFaces",
  },
  "system:nightlyTasks.clusterNewFaces": {
    field: "nightlyClusterNewFaces",
  },
  "system:nightlyTasks.databaseCleanup": {
    field: "nightlyDatabaseCleanup",
  },
  "system:nightlyTasks.generateMemories": {
    field: "nightlyGenerateMemories",
  },
  "system:nightlyTasks.missingThumbnails": {
    field: "nightlyMissingThumbnails",
  },
  "system:nightlyTasks.startTime": {
    field: "nightlyStartTime",
  },
  "system:nightlyTasks.syncQuotaUsage": {
    field: "nightlySyncQuota",
  },
  "system:notifications.smtp.enabled": {
    field: "smtpEnabled",
  },
  "system:notifications.smtp.from": {
    field: "emailFrom",
  },
  "system:notifications.smtp.replyTo": {
    field: "advancedMailReplyTo",
  },
  "system:notifications.smtp.transport.host": {
    field: "smtpHost",
  },
  "system:notifications.smtp.transport.ignoreCert": {
    field: "smtpIgnoreCertificate",
  },
  "system:notifications.smtp.transport.port": {
    field: "smtpPort",
  },
  "system:notifications.smtp.transport.secure": {
    field: "smtpSecurity",
  },
  "system:notifications.smtp.transport.username": {
    field: "smtpUsername",
  },
  "system:oauth.accountManagementUrl": {
    field: "oauthAccountManagementUrl",
  },
  "system:oauth.allowInsecureRequests": {
    field: "oauthAllowInsecure",
  },
  "system:oauth.autoLaunch": {
    field: "oauthAutoLaunch",
  },
  "system:oauth.autoRegister": {
    field: "oauthAutoRegister",
  },
  "system:oauth.buttonText": {
    field: "oauthButtonText",
  },
  "system:oauth.clientId": {
    field: "oauthClient",
  },
  "system:oauth.defaultStorageQuota": {
    field: "oauthDefaultQuota",
  },
  "system:oauth.enabled": {
    field: "oauthEnabled",
  },
  "system:oauth.endSessionEndpoint": {
    field: "oauthEndSessionEndpoint",
  },
  "system:oauth.frameleafMobileRedirectUri": {
    field: "advancedFrameleafCallback",
  },
  "system:oauth.issuerUrl": {
    field: "oauthIssuer",
  },
  "system:oauth.mobileOverrideEnabled": {
    field: "oauthLegacyMobileOverride",
  },
  "system:oauth.mobileRedirectUri": {
    field: "oauthLegacyMobileRedirect",
  },
  "system:oauth.profileSigningAlgorithm": {
    field: "oauthProfileSigningAlgorithm",
  },
  "system:oauth.prompt": {
    field: "oauthPrompt",
  },
  "system:oauth.roleClaim": {
    field: "oauthRoleClaim",
  },
  "system:oauth.scope": {
    field: "oauthScope",
  },
  "system:oauth.signingAlgorithm": {
    field: "oauthSigningAlgorithm",
  },
  "system:oauth.storageLabelClaim": {
    field: "oauthStorageLabelClaim",
  },
  "system:oauth.storageQuotaClaim": {
    field: "oauthStorageQuotaClaim",
  },
  "system:oauth.timeout": {
    field: "oauthTimeout",
  },
  "system:oauth.tokenEndpointAuthMethod": {
    field: "oauthTokenAuth",
  },
  "system:passwordLogin.enabled": {
    field: "passwordLogin",
  },
  "system:physicalDeduplication.enabled": {
    field: "physicalDedup",
  },
  "system:physicalDeduplication.masterUserId": {
    field: "advancedDedupMaster",
  },
  "system:reverseGeocoding.enabled": {
    field: "reverseGeocoding",
  },
  "system:server.externalDomain": {
    field: "externalUrl",
  },
  "system:server.loginPageMessage": {
    field: "welcomeMessage",
  },
  "system:server.publicUsers": {
    field: "publicUsers",
  },
  "system:smartAlbums.enabled": {
    field: "smartAlbums",
  },
  "system:storageTemplate.enabled": {
    field: "storageTemplate",
  },
  "system:storageTemplate.hashVerificationEnabled": {
    field: "storageHashVerification",
  },
  "system:storageTemplate.template": {
    field: "template",
  },
  "system:templates.email.albumInviteTemplate": {
    field: "emailAlbumInviteTemplate",
  },
  "system:templates.email.albumUpdateTemplate": {
    field: "emailAlbumUpdateTemplate",
  },
  "system:templates.email.welcomeTemplate": {
    field: "emailWelcomeTemplate",
  },
  "system:theme.customCss": {
    field: "customCss",
  },
  "system:trash.days": {
    field: "trashDays",
  },
  "system:trash.enabled": {
    field: "trashEnabled",
  },
  "system:user.deleteDelay": {
    field: "deleteDelay",
  },
  "system:job.backgroundTask.concurrency": {
    field: "queueConcurrency_backgroundTask",
  },
  "system:job.editor.concurrency": {
    field: "queueConcurrency_editor",
  },
  "system:job.faceDetection.concurrency": {
    field: "queueConcurrency_faceDetection",
  },
  "system:job.imageDescription.concurrency": {
    field: "queueConcurrency_imageDescription",
  },
  "system:job.imageEnrichment.concurrency": {
    field: "queueConcurrency_imageEnrichment",
  },
  "system:job.integrityCheck.concurrency": {
    field: "queueConcurrency_integrityCheck",
  },
  "system:job.library.concurrency": {
    field: "queueConcurrency_library",
  },
  "system:job.mediaHealth.concurrency": {
    field: "queueConcurrency_mediaHealth",
  },
  "system:job.metadataExtraction.concurrency": {
    field: "queueConcurrency_metadataExtraction",
  },
  "system:job.migration.concurrency": {
    field: "queueConcurrency_migration",
  },
  "system:job.notifications.concurrency": {
    field: "queueConcurrency_notifications",
  },
  "system:job.nsfwDetection.concurrency": {
    field: "queueConcurrency_nsfwDetection",
  },
  "system:job.ocr.concurrency": {
    field: "queueConcurrency_ocr",
  },
  "system:job.search.concurrency": {
    field: "queueConcurrency_search",
  },
  "system:job.sidecar.concurrency": {
    field: "queueConcurrency_sidecar",
  },
  "system:job.smartSearch.concurrency": {
    field: "queueConcurrency_smartSearch",
  },
  "system:job.thumbnailGeneration.concurrency": {
    field: "thumbnailJobs",
  },
  "system:job.videoConversion.concurrency": {
    field: "videoJobs",
  },
  "system:job.videoDuplicateDetection.concurrency": {
    field: "queueConcurrency_videoDuplicateDetection",
  },
  "system:job.workflow.concurrency": {
    field: "queueConcurrency_workflow",
  },
  "system:smartAlbums.builtIn.documents.enabled": {
    field: "smartAlbumDocumentsEnabled",
  },
  "system:smartAlbums.builtIn.documents.name": {
    field: "smartAlbumDocumentsName",
  },
  "system:smartAlbums.builtIn.documents.tagTriggers": {
    field: "smartAlbumDocumentsTags",
  },
  "system:smartAlbums.builtIn.documents.clipQueries": {
    field: "smartAlbumDocumentsQueries",
  },
  "system:smartAlbums.builtIn.documents.threshold": {
    field: "smartAlbumDocumentsThreshold",
  },
  "system:smartAlbums.builtIn.food.enabled": {
    field: "smartAlbumFoodEnabled",
  },
  "system:smartAlbums.builtIn.food.name": {
    field: "smartAlbumFoodName",
  },
  "system:smartAlbums.builtIn.food.tagTriggers": {
    field: "smartAlbumFoodTags",
  },
  "system:smartAlbums.builtIn.food.clipQueries": {
    field: "smartAlbumFoodQueries",
  },
  "system:smartAlbums.builtIn.food.threshold": {
    field: "smartAlbumFoodThreshold",
  },
  "system:smartAlbums.builtIn.nature.enabled": {
    field: "smartAlbumNatureEnabled",
  },
  "system:smartAlbums.builtIn.nature.name": {
    field: "smartAlbumNatureName",
  },
  "system:smartAlbums.builtIn.nature.tagTriggers": {
    field: "smartAlbumNatureTags",
  },
  "system:smartAlbums.builtIn.nature.clipQueries": {
    field: "smartAlbumNatureQueries",
  },
  "system:smartAlbums.builtIn.nature.threshold": {
    field: "smartAlbumNatureThreshold",
  },
  "system:smartAlbums.builtIn.pets.enabled": {
    field: "smartAlbumPetsEnabled",
  },
  "system:smartAlbums.builtIn.pets.name": {
    field: "smartAlbumPetsName",
  },
  "system:smartAlbums.builtIn.pets.tagTriggers": {
    field: "smartAlbumPetsTags",
  },
  "system:smartAlbums.builtIn.pets.clipQueries": {
    field: "smartAlbumPetsQueries",
  },
  "system:smartAlbums.builtIn.pets.threshold": {
    field: "smartAlbumPetsThreshold",
  },
  "system:smartAlbums.builtIn.screenshots.enabled": {
    field: "smartAlbumScreenshotsEnabled",
  },
  "system:smartAlbums.builtIn.screenshots.name": {
    field: "smartAlbumScreenshotsName",
  },
  "system:smartAlbums.builtIn.screenshots.tagTriggers": {
    field: "smartAlbumScreenshotsTags",
  },
  "system:smartAlbums.builtIn.screenshots.clipQueries": {
    field: "smartAlbumScreenshotsQueries",
  },
  "system:smartAlbums.builtIn.screenshots.threshold": {
    field: "smartAlbumScreenshotsThreshold",
  },
  "system:smartAlbums.builtIn.travel.enabled": {
    field: "advancedTravelEnabled",
  },
  "system:smartAlbums.builtIn.travel.name": {
    field: "advancedTravelName",
  },
  "system:smartAlbums.builtIn.travel.tagTriggers": {
    field: "advancedTravelTriggers",
  },
  "system:smartAlbums.builtIn.travel.clipQueries": {
    field: "advancedTravelQueries",
  },
  "system:smartAlbums.builtIn.travel.threshold": {
    field: "advancedTravelThreshold",
  },
  "personal:albums.defaultAssetOrder": {
    field: "albumSort",
  },
  "personal:cast.gCastEnabled": {
    field: "castEnabled",
  },
  "personal:download.archiveSize": {
    field: "advancedDownloadArchiveSize",
  },
  "personal:download.includeEmbeddedVideos": {
    field: "advancedDownloadMotionVideo",
  },
  "personal:emailNotifications.albumInvite": {
    field: "personalAlbumInviteEmail",
  },
  "personal:emailNotifications.albumUpdate": {
    field: "personalAlbumUpdateEmail",
  },
  "personal:emailNotifications.enabled": {
    field: "personalEmailEnabled",
  },
  "personal:folders.enabled": {
    field: "foldersEnabled",
  },
  "personal:folders.sidebarWeb": {
    field: "foldersSidebar",
  },
  "personal:memories.duration": {
    field: "memoriesDuration",
  },
  "personal:memories.enabled": {
    field: "memories",
  },
  "personal:memories.sidebarWeb": {
    field: "memoriesSidebar",
  },
  "personal:people.enabled": {
    field: "peopleEnabled",
  },
  "personal:people.minimumFaces": {
    field: "peopleMinimumFaces",
  },
  "personal:people.sidebarWeb": {
    field: "peopleSidebar",
  },
  "personal:privacy.suppression.scope": {
    field: "advancedSuppressionScope",
  },
  "personal:purchase.showSupportBadge": {
    field: "showSupportBadge",
  },
  "personal:ratings.enabled": {
    field: "ratingsEnabled",
  },
  "personal:recentlyAdded.sidebarWeb": {
    field: "recentlyAddedSidebar",
  },
  "personal:sharedLinks.enabled": {
    field: "sharedLinksEnabled",
  },
  "personal:sharedLinks.sidebarWeb": {
    field: "sharedLinksSidebar",
  },
  "personal:tags.enabled": {
    field: "tagsEnabled",
  },
  "personal:tags.sidebarWeb": {
    field: "tagsSidebar",
  },
  "system:newVersionCheck.enabled": {
    field: "externalVersionChecks",
    status: "deployment-policy",
    notes:
      "Existing external-check policy is disabled; owner-managed updates use separate deployment configuration.",
  },
  "system:newVersionCheck.channel": {
    field: "externalVersionChecks",
    status: "deployment-policy",
    notes:
      "Existing external release channel is not the Frameleaf owner-managed update channel.",
  },
  "system:machineLearning.imageDescription.lastConfigChangeAt": {
    field: "advancedDescriptionRequeue",
    status: "deployment-policy",
    notes: "Server-owned timestamp; never writable preference.",
  },
  "system:machineLearning.imageDescription.pendingRequeueAt": {
    field: "advancedDescriptionRequeue",
    status: "deployment-policy",
    notes:
      "Server-owned pending-work timestamp; requeue/defer are separate actions.",
  },
  "system:machineLearning.runpod.apiKeyConfigured": {
    field: "advancedRunPodCredential",
    status: "deployment-policy",
    notes: "Read-only credential state; never the secret.",
  },
  "system:machineLearning.runpod.hfTokenConfigured": {
    field: "advancedRunPodCredential",
    status: "deployment-policy",
    notes: "Read-only credential state; never the secret.",
  },
  "personal:purchase.hideBuyButtonUntil": {
    field: "showSupportBadge",
    status: "deployment-policy",
    notes: "Temporary purchase-dismissal state; not a general setting.",
  },
  "system:oauth.clientSecret": {
    credential: "oauth-client-secret",
    status: "resource-flow",
    module: "CommandCenter.credentials",
    notes:
      "Ephemeral credential dialog; stores configured-state only. Server credential writes remain unconnected.",
  },
  "system:notifications.smtp.transport.password": {
    credential: "smtp-password",
    status: "resource-flow",
    module: "CommandCenter.credentials",
    notes:
      "Ephemeral credential dialog; stores configured-state only. Server credential writes remain unconnected.",
  },
  "system:machineLearning.runpod.apiKey": {
    credential: "runpod-api-key",
    status: "resource-flow",
    module: "CommandCenter.credentials",
    notes:
      "Ephemeral credential dialog; stores configured-state only. Server credential writes remain unconnected.",
  },
  "system:machineLearning.runpod.hfToken": {
    credential: "huggingface-token",
    status: "resource-flow",
    module: "CommandCenter.credentials",
    notes:
      "Ephemeral credential dialog; stores configured-state only. Server credential writes remain unconnected.",
  },
  "personal:privacy.suppression.personIds": {
    status: "not-yet-built",
    module: "protected-content-picker",
    area: "security",
    section: "advanced-protected-suppression",
    notes: "Readonly explanation is not the PIN-elevated searchable picker.",
  },
  "personal:privacy.suppression.tagIds": {
    status: "not-yet-built",
    module: "protected-content-picker",
    area: "security",
    section: "advanced-protected-suppression",
    notes: "Readonly explanation is not the PIN-elevated searchable picker.",
  },
  "system:machineLearning.runpod.dataPrivacyAcknowledged": {
    status: "not-yet-built",
    module: "runpod-cloud-consent",
    area: "processing",
    section: "advanced-runpod-ordinary",
    notes:
      "Invariant text is not the actual cloud-transfer acknowledgement workflow.",
  },
};

const fieldIndex = new Map(allSettings.map((field) => [field.id, field]));
const credentialIndex = new Map(
  Object.entries(settingsSections).flatMap(([area, sections]) =>
    sections.flatMap((section) =>
      (section.credentials ?? []).map((item) => [
        item.id,
        { area, section: section.id },
      ]),
    ),
  ),
);
export const settingsCoverage = schemaControls.map((control) => {
  const mapping = bindings[control.id];
  const field = mapping?.field && fieldIndex.get(mapping.field);
  const credential =
    mapping?.credential && credentialIndex.get(mapping.credential);
  return {
    ...control,
    status: mapping?.status ?? (field ? "ui-control" : "not-yet-built"),
    target: mapping
      ? {
          area: field?.area ?? credential?.area ?? mapping.area,
          section: field?.section ?? credential?.section ?? mapping.section,
          field: mapping.field,
          credential: mapping.credential,
          module: mapping.module,
        }
      : null,
    notes:
      mapping?.notes ??
      "Editable prototype draft; production binding and response validation remain unconnected.",
    productionConnected: false,
  };
});

export const actionCoverage = [
  {
    id: "action:system/authentication/save",
    form: "system/authentication",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "security",
      section: "signin",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/authentication/reset-saved",
    form: "system/authentication",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "security",
      section: "signin",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/authentication/reset-defaults",
    form: "system/authentication",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "signin",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/backup/save",
    form: "system/backup",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "backup",
      section: "database-backup",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/backup/reset-saved",
    form: "system/backup",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "backup",
      section: "database-backup",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/backup/reset-defaults",
    form: "system/backup",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "backup",
      section: "database-backup",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/image/save",
    form: "system/image",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "editing",
      section: "previews",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/image/reset-saved",
    form: "system/image",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "editing",
      section: "previews",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/image/reset-defaults",
    form: "system/image",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "editing",
      section: "previews",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/integrity-checks/save",
    form: "system/integrity-checks",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "care",
      section: "integrity-schedules",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/integrity-checks/reset-saved",
    form: "system/integrity-checks",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "care",
      section: "integrity-schedules",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/integrity-checks/reset-defaults",
    form: "system/integrity-checks",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "care",
      section: "integrity-schedules",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/job/save",
    form: "system/job",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "processing",
      section: "queues",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/job/reset-saved",
    form: "system/job",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "processing",
      section: "queues",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/job/reset-defaults",
    form: "system/job",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "queues",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/external-library/save",
    form: "system/external-library",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "libraries",
      section: "sources",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/external-library/reset-saved",
    form: "system/external-library",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "libraries",
      section: "sources",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/external-library/reset-defaults",
    form: "system/external-library",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "libraries",
      section: "sources",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/logging/save",
    form: "system/logging",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "diagnostics",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/logging/reset-saved",
    form: "system/logging",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "diagnostics",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/logging/reset-defaults",
    form: "system/logging",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "diagnostics",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/machine-learning/save",
    form: "system/machine-learning",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "intelligence",
      section: "smart-search",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/machine-learning/reset-saved",
    form: "system/machine-learning",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "intelligence",
      section: "smart-search",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/machine-learning/reset-defaults",
    form: "system/machine-learning",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-search",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/location/save",
    form: "system/location",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "maps",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/location/reset-saved",
    form: "system/location",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "maps",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/location/reset-defaults",
    form: "system/location",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "maps",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/metadata/save",
    form: "system/metadata",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "advanced-metadata-maps",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/metadata/reset-saved",
    form: "system/metadata",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "advanced-metadata-maps",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/metadata/reset-defaults",
    form: "system/metadata",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "advanced-metadata-maps",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/nightly-tasks/save",
    form: "system/nightly-tasks",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "processing",
      section: "nightly-tasks",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/nightly-tasks/reset-saved",
    form: "system/nightly-tasks",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "processing",
      section: "nightly-tasks",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/nightly-tasks/reset-defaults",
    form: "system/nightly-tasks",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "nightly-tasks",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/notifications/save",
    form: "system/notifications",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "notifications",
      section: "email",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/notifications/reset-saved",
    form: "system/notifications",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "notifications",
      section: "email",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/notifications/reset-defaults",
    form: "system/notifications",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "notifications",
      section: "email",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/server/save",
    form: "system/server",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "identity",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/server/reset-saved",
    form: "system/server",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "identity",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/server/reset-defaults",
    form: "system/server",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "identity",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/smart-albums/save",
    form: "system/smart-albums",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "intelligence",
      section: "classification",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/smart-albums/reset-saved",
    form: "system/smart-albums",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "intelligence",
      section: "classification",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/smart-albums/reset-defaults",
    form: "system/smart-albums",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "classification",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/storage-template/save",
    form: "system/storage-template",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "storage",
      section: "organization",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/storage-template/reset-saved",
    form: "system/storage-template",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "storage",
      section: "organization",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/storage-template/reset-defaults",
    form: "system/storage-template",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "organization",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/theme/save",
    form: "system/theme",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "branding",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/theme/reset-saved",
    form: "system/theme",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "branding",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/theme/reset-defaults",
    form: "system/theme",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "branding",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/trash/save",
    form: "system/trash",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "storage",
      section: "retention",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/trash/reset-saved",
    form: "system/trash",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "storage",
      section: "retention",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/trash/reset-defaults",
    form: "system/trash",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "retention",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/user-settings/save",
    form: "system/user-settings",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "users",
      section: "accounts",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/user-settings/reset-saved",
    form: "system/user-settings",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "users",
      section: "accounts",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/user-settings/reset-defaults",
    form: "system/user-settings",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "users",
      section: "accounts",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/version-check/save",
    form: "system/version-check",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "updates",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/version-check/reset-saved",
    form: "system/version-check",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "server",
      section: "updates",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/version-check/reset-defaults",
    form: "system/version-check",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "updates",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:system/video-transcoding/save",
    form: "system/video-transcoding",
    label: "Save settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "editing",
      section: "playback",
      module: "CommandCenter.save",
    },
    notes:
      "Global review/save is implemented locally; production section transactions remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:system/video-transcoding/reset-saved",
    form: "system/video-transcoding",
    label: "Reset to saved settings",
    source: null,
    status: "resource-flow",
    target: {
      area: "editing",
      section: "playback",
      module: "CommandCenter.discard",
    },
    notes:
      "Global discard is implemented locally; original per-section reset granularity still needs matching.",
    productionConnected: false,
  },
  {
    id: "action:system/video-transcoding/reset-defaults",
    form: "system/video-transcoding",
    label: "Reset to defaults",
    source: null,
    status: "not-yet-built",
    target: {
      area: "editing",
      section: "playback",
      module: "settings-defaults",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:config-copy",
    form: "system/configuration",
    label: "Copy configuration JSON",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "identity",
      module: "config-export",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:config-download",
    form: "system/configuration",
    label: "Download configuration JSON",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "identity",
      module: "config-export",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:config-import",
    form: "system/configuration",
    label: "Import configuration JSON",
    source: null,
    status: "not-yet-built",
    target: {
      area: "server",
      section: "identity",
      module: "config-import",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:oauth-unlink-all",
    form: "system/authentication",
    label: "Unlink all OAuth accounts",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "oauth-advanced",
      module: "oauth-unlink-all",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:oauth-frameleaf-server-callback",
    form: "system/authentication",
    label: "Use server Frameleaf callback",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-native-oauth",
      module: "oauth-callback-shortcut",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:backup-preset",
    form: "system/backup",
    label: "Choose backup schedule preset",
    source: null,
    status: "not-yet-built",
    target: {
      area: "backup",
      section: "database-backup",
      module: "schedule-presets",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:library-preset",
    form: "system/external-library",
    label: "Choose scan schedule preset",
    source: null,
    status: "not-yet-built",
    target: {
      area: "libraries",
      section: "sources",
      module: "schedule-presets",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:storage-preset",
    form: "system/storage-template",
    label: "Choose storage template preset",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "organization",
      module: "storage-template-preview",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:storage-preview",
    form: "system/storage-template",
    label: "Preview storage template paths",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "organization",
      module: "storage-template-preview",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:physical-dedup-dry-run",
    form: "system/storage-template",
    label: "Preview physical deduplication",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "deduplication",
      module: "physical-dedup",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:physical-dedup-apply",
    form: "system/storage-template",
    label: "Apply verified physical deduplication",
    source: null,
    status: "not-yet-built",
    target: {
      area: "storage",
      section: "deduplication",
      module: "physical-dedup",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:description-hardware-preset",
    form: "system/machine-learning",
    label: "Apply hardware/model preset",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "advanced-description-runtime",
      module: "description-hardware-preset",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:description-cost-estimate",
    form: "system/machine-learning",
    label: "Estimate description reprocessing",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "descriptions",
      module: "description-requeue",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:description-requeue",
    form: "system/machine-learning",
    label: "Requeue descriptions now",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "descriptions",
      module: "description-requeue",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:description-defer",
    form: "system/machine-learning",
    label: "Requeue descriptions later",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "descriptions",
      module: "description-requeue",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:description-reset-prompt",
    form: "system/machine-learning",
    label: "Reset raw prompt to default",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "advanced-description-identity",
      module: "description-prompt-reset",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-albums-estimate",
    form: "system/smart-albums",
    label: "Estimate smart-album reevaluation",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "classification",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-albums-all",
    form: "system/smart-albums",
    label: "Reevaluate all smart albums",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "classification",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smtp-test",
    form: "system/notifications",
    label: "Send test email and save notification draft",
    source: null,
    status: "not-yet-built",
    target: {
      area: "notifications",
      section: "email",
      module: "smtp-test",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-documents",
    form: "system/smart-albums",
    label: "Reevaluate documents",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-album-documents",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-food",
    form: "system/smart-albums",
    label: "Reevaluate food",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-album-food",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-nature",
    form: "system/smart-albums",
    label: "Reevaluate nature",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-album-nature",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-pets",
    form: "system/smart-albums",
    label: "Reevaluate pets",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-album-pets",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-screenshots",
    form: "system/smart-albums",
    label: "Reevaluate screenshots",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "smart-album-screenshots",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:smart-album-travel",
    form: "system/smart-albums",
    label: "Reevaluate travel",
    source: null,
    status: "not-yet-built",
    target: {
      area: "intelligence",
      section: "advanced-travel-album",
      module: "smart-album-reevaluate",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:template-preview-welcome",
    form: "system/notifications",
    label: "Preview welcome email",
    source: null,
    status: "not-yet-built",
    target: {
      area: "notifications",
      section: "email-templates",
      module: "email-template-preview",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:template-preview-album-invite",
    form: "system/notifications",
    label: "Preview album-invite email",
    source: null,
    status: "not-yet-built",
    target: {
      area: "notifications",
      section: "email-templates",
      module: "email-template-preview",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:template-preview-album-update",
    form: "system/notifications",
    label: "Preview album-update email",
    source: null,
    status: "not-yet-built",
    target: {
      area: "notifications",
      section: "email-templates",
      module: "email-template-preview",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-test",
    form: "system/machine-learning",
    label: "Test RunPod connection",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-launch",
    form: "system/machine-learning",
    label: "Launch Pod",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-resume",
    form: "system/machine-learning",
    label: "Resume Pod",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-stop",
    form: "system/machine-learning",
    label: "Stop Pod",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-terminate",
    form: "system/machine-learning",
    label: "Terminate Pod",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-clear",
    form: "system/machine-learning",
    label: "Clear saved Pod state",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-backfill",
    form: "system/machine-learning",
    label: "Start ML backfill",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-serverless-setup",
    form: "system/machine-learning",
    label: "Set up serverless endpoint",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-serverless-recreate",
    form: "system/machine-learning",
    label: "Recreate serverless endpoint",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:runpod-serverless-teardown",
    form: "system/machine-learning",
    label: "Remove serverless endpoint",
    source: null,
    status: "not-yet-built",
    target: {
      area: "processing",
      section: "advanced-runpod-ordinary",
      module: "runpod-lifecycle",
    },
    notes: "Dedicated interaction is not yet implemented in the prototype.",
    productionConnected: false,
  },
  {
    id: "action:personal/account/name",
    form: "personal/account",
    label: "Edit profile name",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "profile",
      module: "account-profile",
    },
    notes:
      "Local profile fields and global review/save exist; account server writes are unconnected.",
    productionConnected: false,
  },
  {
    id: "action:personal/account/email",
    form: "personal/account",
    label: "Edit profile email",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "profile",
      module: "account-profile",
    },
    notes:
      "Local profile fields and global review/save exist; account server writes are unconnected.",
    productionConnected: false,
  },
  {
    id: "action:personal/account/id",
    form: "personal/account",
    label: "Inspect user ID",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "account-profile",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/account/storage-label",
    form: "personal/account",
    label: "Inspect storage label",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "account-profile",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/account/save",
    form: "personal/account",
    label: "Save account profile",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "profile",
      module: "account-profile",
    },
    notes:
      "Local profile fields and global review/save exist; account server writes are unconnected.",
    productionConnected: false,
  },
  {
    id: "action:personal/usage/scope",
    form: "personal/usage",
    label: "Choose account usage scope",
    source: null,
    status: "not-yet-built",
    target: {
      area: "analytics",
      section: null,
      module: "SettingsAnalytics",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/usage/totals",
    form: "personal/usage",
    label: "Inspect timeline/favorites/archive/trash counts",
    source: null,
    status: "not-yet-built",
    target: {
      area: "analytics",
      section: null,
      module: "SettingsAnalytics",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/usage/albums",
    form: "personal/usage",
    label: "Inspect owned and shared albums",
    source: null,
    status: "not-yet-built",
    target: {
      area: "analytics",
      section: null,
      module: "SettingsAnalytics",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/usage/heatmaps",
    form: "personal/usage",
    label: "Inspect upload and capture heatmaps",
    source: null,
    status: "not-yet-built",
    target: {
      area: "analytics",
      section: null,
      module: "SettingsAnalytics",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/api-keys/create",
    form: "personal/api-keys",
    label: "Create API key with permissions",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-api-keys",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/api-keys/rename",
    form: "personal/api-keys",
    label: "Rename API key",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-api-keys",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/api-keys/permissions",
    form: "personal/api-keys",
    label: "Update API permissions",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-api-keys",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/api-keys/rotate",
    form: "personal/api-keys",
    label: "Rotate and reveal new key",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-api-keys",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/api-keys/delete",
    form: "personal/api-keys",
    label: "Delete API key",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-api-keys",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/devices/list",
    form: "personal/devices",
    label: "Inspect current and other sessions",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-devices",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/devices/revoke-one",
    form: "personal/devices",
    label: "Revoke another session",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-devices",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/devices/revoke-all",
    form: "personal/devices",
    label: "Revoke all other sessions",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "credentials",
      module: "personal-devices",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/oauth/link",
    form: "personal/oauth",
    label: "Link OAuth account",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "personal-oauth",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/oauth/unlink",
    form: "personal/oauth",
    label: "Unlink OAuth account",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "personal-oauth",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/oauth/manage",
    form: "personal/oauth",
    label: "Open identity provider account",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "personal-oauth",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/password/change",
    form: "personal/password",
    label: "Change password",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "personal-password",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/password/invalidate",
    form: "personal/password",
    label: "Invalidate other sessions",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "profile",
      module: "personal-password",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/pin/create",
    form: "personal/pin",
    label: "Create PIN",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "personal-pin",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/pin/change",
    form: "personal/pin",
    label: "Change PIN",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "personal-pin",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/pin/clear",
    form: "personal/pin",
    label: "Clear PIN",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "personal-pin",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/pin/reset",
    form: "personal/pin",
    label: "Reset PIN with password",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "personal-pin",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/unlock",
    form: "personal/suppression",
    label: "Unlock protected preferences",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/tags",
    form: "personal/suppression",
    label: "Search/create/add/remove suppressed tags",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/people",
    form: "personal/suppression",
    label: "Search hidden/visible people with thumbnails",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/remove-person",
    form: "personal/suppression",
    label: "Remove suppressed person",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/open",
    form: "personal/suppression",
    label: "Open suppressed-content view",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/suppression/conflict",
    form: "personal/suppression",
    label: "Handle changes in another session",
    source: null,
    status: "not-yet-built",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "protected-content-picker",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/purchase/activate",
    form: "personal/purchase",
    label: "Activate supporter key",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "supporter-preference",
      module: "supporter-key",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/purchase/purchase",
    form: "personal/purchase",
    label: "Open support information",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "supporter-preference",
      module: "supporter-key",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/purchase/remove",
    form: "personal/purchase",
    label: "Remove personal key",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "supporter-preference",
      module: "supporter-key",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/purchase/server-key",
    form: "personal/purchase",
    label: "Inspect/remove server key as administrator",
    source: null,
    status: "not-yet-built",
    target: {
      area: "preferences",
      section: "supporter-preference",
      module: "supporter-key",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/group-members",
    form: "personal/sharing",
    label: "Inspect recognition-group members",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/invite",
    form: "personal/sharing",
    label: "Invite to recognition group",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/accept",
    form: "personal/sharing",
    label: "Accept invitation",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/decline",
    form: "personal/sharing",
    label: "Decline invitation",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/cancel",
    form: "personal/sharing",
    label: "Cancel sent invitation",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/leave",
    form: "personal/sharing",
    label: "Leave recognition group",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/regenerate",
    form: "personal/sharing",
    label: "Rerun group recognition",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/partner-create",
    form: "personal/sharing",
    label: "Create partner link",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/partner-remove",
    form: "personal/sharing",
    label: "Remove partner link",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/sharing/partner-timeline",
    form: "personal/sharing",
    label: "Choose partner timeline inclusion",
    source: null,
    status: "not-yet-built",
    target: {
      area: "sharing",
      section: "advanced-sharing-boundaries",
      module: "recognition-groups",
    },
    notes:
      "Dedicated personal workflow not yet implemented; administrator user reset/session flows are different.",
    productionConnected: false,
  },
  {
    id: "action:personal/downloads/save",
    form: "personal/downloads",
    label: "Save personal preferences",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "advanced-download-packaging",
      module: "CommandCenter.save",
    },
    notes: "Local review/save exists; server preferences remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:personal/features/save",
    form: "personal/features",
    label: "Save personal preferences",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "library-features",
      module: "CommandCenter.save",
    },
    notes: "Local review/save exists; server preferences remain unconnected.",
    productionConnected: false,
  },
  {
    id: "action:personal/notifications/save",
    form: "personal/notifications",
    label: "Save personal preferences",
    source: null,
    status: "resource-flow",
    target: {
      area: "preferences",
      section: "email-preferences",
      module: "CommandCenter.save",
    },
    notes: "Local review/save exists; server preferences remain unconnected.",
    productionConnected: false,
  },
];

export const browserCoverage = [
  {
    id: "device:theme",
    form: "personal/app",
    field: "useSystemTheme",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:language",
    form: "personal/app",
    field: "language",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:browser-locale",
    form: "personal/app",
    field: "useBrowserLocale",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:custom-locale",
    form: "personal/app",
    field: "formattingLocale",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:original-photos",
    form: "personal/app",
    field: "originalPhotos",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:video-hover",
    form: "personal/app",
    field: "videoHoverPlayback",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:video-autoplay",
    form: "personal/app",
    field: "videoAutoplay",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:video-loop",
    form: "personal/app",
    field: "videoLoop",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:original-video",
    form: "personal/app",
    field: "originalVideo",
    status: "ui-control",
    productionConnected: false,
  },
  {
    id: "device:delete-confirmation",
    form: "personal/app",
    field: "permanentDeleteWarning",
    status: "ui-control",
    productionConnected: false,
  },
];

export const utilitiesCoverage = [
  {
    id: "utility:duplicates",
    label: "Review duplicates",
    sourceRoute: "/utilities/duplicates",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "duplicates",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Choose keeper",
      "Compare matches",
      "Remove duplicate selections",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:large-files",
    label: "Review large files",
    sourceRoute: "/utilities/large-files",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "large-files",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Sort by original size",
      "Select assets",
      "Review/delete selections",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:live-photos",
    label: "Relink Live Photos",
    sourceRoute: "/utilities/live-photos",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "live-photos",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Inspect candidate evidence/confidence",
      "Link a pair",
      "Link all high-confidence pairs",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:geolocation",
    label: "Manage geolocation",
    sourceRoute: "/utilities/geolocation",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "geolocation",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Select assets",
      "Pick map location",
      "Apply location",
      "Cancel/clear selection",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:icloud",
    label: "iCloud Photos Sync",
    sourceRoute: "/utilities/icloud-sync",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "icloud",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Create connection",
      "Authenticate and verify 2FA",
      "Select libraries/albums",
      "Set source options/budgets",
      "Run/pause/resume/cancel/retry/rescan/disconnect",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:missing-media",
    label: "Missing media",
    sourceRoute: "/utilities/missing-media",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "missing-media",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Review missing findings",
      "Choose scan roots",
      "Scan/hash matching",
      "Review candidates",
      "Recover existing asset",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:corrupt-media",
    label: "Corrupt media",
    sourceRoute: "/utilities/corrupt-media",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "corrupt-media",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Review validation findings",
      "Distinguish unsupported RAW/timeouts",
      "Scan candidates",
      "Verify replacement",
      "Recover existing asset",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:workflows",
    label: "Workflows",
    sourceRoute: "/workflows",
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "workflows",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Create/edit automation",
      "Choose trigger/conditions/actions",
      "Enable/disable",
      "Inspect runs/errors",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:downloads",
    label: "Download applications",
    sourceRoute: null,
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "downloads",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Choose platform",
      "Open configured Frameleaf distribution link",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
  {
    id: "utility:obtainium",
    label: "Obtainium configurator",
    sourceRoute: null,
    source: "web/src/routes/(user)/utilities/UtilitiesMenu.svelte",
    target: {
      area: "utilities",
      section: "obtainium",
      module: "UtilitiesWorkspace",
    },
    controls: [
      "Select release/build variant",
      "Inspect update configuration",
      "Export configuration",
    ],
    status: "not-yet-built",
    productionConnected: false,
    notes:
      "Module owned by the main implementation; confirm completed interactions before updating status.",
  },
];

// Child forms contain controls that are intentionally grouped under the parent
// destination. Keep them explicit so new source forms cannot disappear in prose.
export const sourceChildForms = [
  ...[
    "AvailabilityChecksSection",
    "DuplicateDetectionSection",
    "FacialRecognitionSection",
    "ImageDescriptionPromptSection",
    "ImageDescriptionSection",
    "MlUrlsSection",
    "NsfwDetectionSection",
    "OcrSection",
    "RunPodSection",
    "SmartSearchSection",
  ].map((name) => ({
    form: "system/machine-learning",
    source: `web/src/routes/admin/system-settings/machine-learning/${name}.svelte`,
  })),
  {
    form: "system/notifications",
    source: "web/src/routes/admin/system-settings/TemplateSettings.svelte",
  },
  {
    form: "personal/pin",
    source: "web/src/routes/(user)/user-settings/PinCodeChangeForm.svelte",
  },
  {
    form: "personal/pin",
    source:
      "web/src/lib/components/user-settings-page/PinCodeCreateForm.svelte",
  },
  {
    form: "personal/pin",
    source: "web/src/lib/modals/PinCodeResetModal.svelte",
  },
  {
    form: "personal/api-keys",
    source: "web/src/lib/modals/ApiKeyCreateModal.svelte",
  },
  {
    form: "personal/api-keys",
    source: "web/src/lib/modals/ApiKeyUpdateModal.svelte",
  },
  {
    form: "personal/devices",
    source: "web/src/lib/components/user-settings-page/DeviceCard.svelte",
  },
  {
    form: "personal/account",
    source: "web/src/lib/modals/AvatarEditModal.svelte",
  },
];
for (const entry of actionCoverage) {
  entry.source =
    sourceForms.find((form) => form.id === entry.form)?.source ??
    "web/src/lib/services/system-config.service.ts";
}
for (const entry of settingsCoverage)
  entry.source = sourceForms.find((form) => form.id === entry.form)?.source;
for (const entry of browserCoverage) {
  const field = fieldIndex.get(entry.field);
  entry.source = sourceForms.find((form) => form.id === entry.form)?.source;
  entry.target = { area: field.area, section: field.section, field: field.id };
  entry.notes =
    "Browser-local preference; does not update server user preferences.";
}

// Verified prototype modules are local interactions, not production parity.
function completedAction(
  id,
  module,
  target,
  notes = "Review and state changes are implemented using local sample data; no production request is sent.",
) {
  const action = actionCoverage.find((entry) => entry.id === `action:${id}`);
  if (!action) throw new Error(`Unknown reviewed action ${id}`);
  Object.assign(action, {
    status: "resource-flow",
    notes,
    target: { ...action.target, ...target, module },
  });
}
for (const id of [
  "description-hardware-preset",
  "description-cost-estimate",
  "description-requeue",
  "description-defer",
  "smart-albums-estimate",
  "smart-albums-all",
  ...["documents", "food", "nature", "pets", "screenshots", "travel"].map(
    (kind) => `smart-album-${kind}`,
  ),
])
  completedAction(id, "JobsManager", { area: "processing", section: "queues" });
for (const id of [
  "runpod-test",
  "runpod-launch",
  "runpod-resume",
  "runpod-stop",
  "runpod-terminate",
  "runpod-clear",
  "runpod-backfill",
  "runpod-serverless-setup",
  "runpod-serverless-recreate",
  "runpod-serverless-teardown",
])
  completedAction(
    id,
    "RunPodManager",
    { area: "processing", section: "runpod" },
    "Provider action review is implemented locally. Clearing state remains blocked without provider confirmation; no provider is contacted or billed.",
  );
for (const id of [
  "template-preview-welcome",
  "template-preview-album-invite",
  "template-preview-album-update",
])
  completedAction(
    id,
    "CommandCenter.emailPreview",
    null,
    "Sandboxed local template preview; no delivery or production template rendering.",
  );
for (const action of actionCoverage) {
  if (action.id.endsWith("/reset-defaults")) {
    action.status = "resource-flow";
    action.target.module = "CommandCenter.resetPage";
    action.notes =
      "Reset the current page into the local draft. Original source form groups can span several new pages; no server defaults are fetched.";
  }
  if (
    /^action:personal\/(api-keys|password|pin)\//.test(action.id) ||
    [
      "action:personal/devices/list",
      "action:personal/devices/revoke-one",
      "action:personal/oauth/link",
      "action:personal/oauth/unlink",
      "action:personal/purchase/activate",
      "action:personal/purchase/remove",
    ].includes(action.id)
  ) {
    action.status = "resource-flow";
    action.target = {
      area: "preferences",
      section: "account-security",
      module: "PersonalAccess",
    };
    action.notes =
      "Local form/review implemented using sample account state. API-key permissions cover all current source values; secrets are not persisted.";
  }
}
export const accountLibraryCoverage = [
  ...[
    "List/filter/sort accounts",
    "Create account",
    "Edit name/email/role/quota/storage label",
    "Require password change",
    "Review owned libraries/storage",
    "Inspect and revoke sessions",
    "Reset password",
    "Reset PIN",
    "Soft-delete account",
    "Restore account",
  ].map((label, i) => ({
    id: `admin-account:${i}`,
    label,
    source: "web/src/routes/admin/users/(list)/+page.svelte",
    status: "resource-flow",
    target: { area: "users", section: "accounts", module: "AccountsLibraries" },
    notes:
      "Local account lifecycle and permissions guards; production administrator authorization remains unconnected.",
    productionConnected: false,
  })),
  ...[
    "List/filter/sort libraries",
    "Create external library with fixed owner",
    "Rename library",
    "Add/edit/remove import paths",
    "Add/edit/remove exclusion patterns",
    "Validate path syntax",
    "Queue/review/cancel a sample scan",
    "Confirm removal with name and asset count",
  ].map((label, i) => ({
    id: `admin-library:${i}`,
    label,
    source: "server/src/services/library.service.ts",
    status: "resource-flow",
    target: {
      area: "libraries",
      section: "sources",
      module: "AccountsLibraries",
    },
    notes:
      "Local structured resource flow. Filesystem reachability validation and actual scans/deletion require the server.",
    productionConnected: false,
  })),
];
const cloudConsent = settingsCoverage.find(
  (entry) => entry.path === "machineLearning.runpod.dataPrivacyAcknowledged",
);
Object.assign(cloudConsent, {
  status: "resource-flow",
  target: { area: "processing", section: "runpod", module: "RunPodManager" },
  notes:
    "Explicit acknowledgement is reviewed with the selected sample provider action; no media is transferred.",
});

for (const id of ["config-copy", "config-download", "config-import"])
  completedAction(
    id,
    "ConfigurationTransfer",
    { area: "server", section: "configuration" },
    "Local configuration export/import with reviewed draft changes; secrets and resource collections are excluded. This is not a complete server-backup format.",
  );
for (const entry of settingsCoverage.filter((entry) =>
  [
    "privacy.suppression.personIds",
    "privacy.suppression.tagIds",
    "privacy.suppression.scope",
  ].includes(entry.path),
))
  Object.assign(entry, {
    status: "resource-flow",
    target: {
      area: "security",
      section: "advanced-protected-suppression",
      module: "ProtectedContent",
    },
    notes:
      "Ephemeral sample PIN unlock, protected name pickers and conflict handling. Browser sample data is not encrypted storage or real server PIN authorization.",
  });
for (const action of actionCoverage) {
  if (action.form === "personal/suppression" && !action.id.endsWith("/open")) {
    action.status = "resource-flow";
    action.target.module = "ProtectedContent";
    action.notes =
      "Sample PIN-gated names/search and external-update conflict review. No server elevation or actual library privacy mutation.";
  }
  if (
    action.form === "personal/sharing" &&
    !action.id.endsWith("/regenerate")
  ) {
    action.status = "resource-flow";
    action.target = {
      area: "sharing",
      section: action.id.includes("partner-")
        ? "partner"
        : "advanced-sharing-boundaries",
      module: "SharingAccess",
    };
    action.notes =
      "Local partner/group invitation and membership reviews; actual sharing permissions are unchanged.";
  }
  if (
    [
      "action:personal/account/id",
      "action:personal/account/storage-label",
    ].includes(action.id)
  ) {
    action.status = "resource-flow";
    action.target = {
      area: "preferences",
      section: "account-security",
      module: "PersonalAccess",
    };
    action.notes =
      "Readonly current-account identity details from local fixtures.";
  }
}

completedAction(
  "oauth-unlink-all",
  "AdminOAuthDisconnect",
  { area: "security", section: "oauth-advanced" },
  "Typed confirmation and password-fallback guard in local account state; no provider or server request.",
);
completedAction(
  "storage-preview",
  "CommandCenter.storagePreview",
  { area: "storage", section: "organization" },
  "Local sample path generation rejects traversal and reports unsupported tokens; it does not move files.",
);
for (const id of [
  "backup-preset",
  "library-preset",
  "storage-preset",
  "oauth-frameleaf-server-callback",
  "smtp-test",
])
  completedAction(
    id,
    "CommandCenter",
    null,
    "Source-backed local control or request preview. No scheduling, provider authentication or email request is executed.",
  );
for (const action of actionCoverage) {
  if (action.form === "personal/usage") {
    action.status = "resource-flow";
    action.target = {
      area: "analytics",
      section: null,
      module: "SettingsAnalytics",
    };
    action.notes =
      "Interactive scope/category counts, album membership and capture/upload heatmaps from deterministic sample data. Real source metrics remain unconnected.";
  }
  if (
    [
      "action:personal/devices/revoke-all",
      "action:personal/oauth/manage",
      "action:personal/purchase/server-key",
    ].includes(action.id)
  ) {
    action.status = "resource-flow";
    action.target = {
      area: "preferences",
      section: "account-security",
      module: "PersonalAccess",
    };
    action.notes =
      "Local confirmed account interaction. Provider management opens only an explicitly configured, validated account-management URL; no invented purchase service.";
  }
}
completedAction(
  "physical-dedup-dry-run",
  "JobsManager",
  { area: "processing", section: "queues" },
  "Exact dry-run manual task can be reviewed and queued locally. Applying physical changes remains blocked until a concrete plan is available.",
);
const purchaseAction = actionCoverage.find(
  (entry) => entry.id === "action:personal/purchase/purchase",
);
Object.assign(purchaseAction, {
  status: "deployment-policy",
  notes:
    "No Frameleaf purchase service is configured; upstream attribution is retained without directing Frameleaf purchases to an invented destination.",
});

export const queueCoverage = QUEUE_CATALOG.flatMap((queue) => [
  {
    id: `queue:${queue.id}:concurrency`,
    source: "server/src/dtos/config.dto.ts",
    status: queue.fixed ? "deployment-policy" : "ui-control",
    target: {
      area: "processing",
      section: "queues",
      ...(queue.setting ? { field: queue.setting } : { module: "JobsManager" }),
    },
    notes: queue.fixed
      ? "Source fixes this queue at one worker."
      : "Prototype UI caps concurrency at 1000; source requires a positive integer without this upper limit.",
    productionConnected: false,
  },
  {
    id: `queue:${queue.id}:operations`,
    source: "server/src/services/queue.service.ts",
    status: "resource-flow",
    target: { area: "processing", section: "queues", module: "JobsManager" },
    controls: [
      ...(queue.startJob ? [queue.runLabel] : []),
      ...(queue.canForce ? [queue.forceLabel] : []),
      ...(queue.canPause ? ["Pause", "Resume"] : []),
      "Review failed jobs",
      "Retry selected sample jobs",
      "Clear waiting jobs",
    ],
    notes:
      "Queue-wide actions and local job inspection are implemented. Production API currently exposes queue counts/actions; per-job retry, error history and owner attribution need API work.",
    productionConnected: false,
  },
]);
export const manualJobCoverage = MANUAL_JOBS.map((job) => ({
  id: `manual-job:${job.id}`,
  label: job.title,
  source: "server/src/enum.ts",
  status:
    job.id === "physical-deduplication-apply"
      ? "not-yet-built"
      : "resource-flow",
  target: { area: "processing", section: "queues", module: "JobsManager" },
  notes:
    job.id === "physical-deduplication-apply"
      ? "Blocked until a specific completed deduplication plan can be reviewed; a generic start action is unsafe."
      : "Exact source manual task identifier, local review and queued sample activity only.",
  productionConnected: false,
}));

// Per-workflow gaps remain separate even when a destination has a usable page.
const utilityGaps = {
  duplicates: [],
  "large-files": [],
  "live-photos": [],
  geolocation: [],
  icloud: [
    "Live Apple authentication and inventory require the production service",
  ],
  "missing-media": [
    "Filesystem candidate search and original replacement execution",
  ],
  "corrupt-media": [],
  workflows: [
    "Discover installed third-party plugin schemas and execute/read logs through the server workflow service",
  ],
  downloads: ["Signed owner-configured application release"],
  obtainium: ["Generated configuration and signed release integration"],
};
for (const entry of utilitiesCoverage) {
  const id = entry.id.slice("utility:".length);
  entry.status = ["downloads", "obtainium"].includes(id)
    ? "deployment-policy"
    : "resource-flow";
  entry.target.module = "UtilitiesManager";
  entry.gaps = utilityGaps[id];
  entry.notes =
    "Local review workflow; see per-action gaps. No originals, cloud accounts or files are changed.";
}
export const utilityGapCoverage = utilitiesCoverage.flatMap((entry) =>
  entry.gaps.map((label, index) => ({
    id: `${entry.id}:gap:${index}`,
    label,
    source: entry.source,
    status: "not-yet-built",
    target: entry.target,
    productionConnected: false,
    notes:
      "Page presence does not count this missing interaction as implemented.",
  })),
);

export const roadmapWorkflowCoverage = [
  [
    "takeout",
    "Takeout import",
    "backup",
    "takeout",
    "server/src/controllers/takeout.controller.ts",
  ],
  ["migration", "Server migration", "storage", "migration", "README.md"],
  [
    "preservation",
    "Preservation packages",
    "backup",
    "preservation",
    "server/src/controllers/preservation.controller.ts",
  ],
  [
    "enrichment",
    "Enrichment plans",
    "care",
    "enrichment-care",
    "server/src/controllers/enrichment-plan.controller.ts",
  ],
  [
    "care",
    "Library Care",
    "care",
    "repair",
    "server/src/controllers/library-care.controller.ts",
  ],
].map(([id, label, area, section, source]) => ({
  id: `roadmap:${id}`,
  label,
  source,
  status: "not-yet-built",
  target: { area, section, module: "Existing production route" },
  notes:
    "Settings provide an entry point and policy controls; full source manifest/report/repair workflow is not recreated in this settings prototype.",
  productionConnected: false,
}));

export const trashCoverage = [
  ["browse", "Browse and filter your own trashed photos and videos"],
  ["restore", "Restore selected items or your entire trash"],
  ["delete", "Permanently delete a frozen selection or empty your trash"],
].map(([id, label]) => ({
  id: `trash:${id}`,
  label,
  source: "server/src/services/trash.service.ts",
  status: "resource-flow",
  target: { area: "trash", section: "contents", module: "TrashManager" },
  productionConnected: false,
  notes:
    "Owner-only sample state connected to utility deletion decisions. Permanent deletion revalidates the reviewed set; no physical cleanup or immediate disk savings are claimed.",
}));

export const fullSettingsCoverage = [
  ...trashCoverage,
  ...settingsCoverage,
  ...browserCoverage,
  ...actionCoverage,
  ...utilitiesCoverage,
  ...utilityGapCoverage,
  ...queueCoverage,
  ...manualJobCoverage,
  ...roadmapWorkflowCoverage,
  ...accountLibraryCoverage,
];
export const settingsCoverageSummary = Object.fromEntries(
  coverageStatuses.map((status) => [
    status,
    fullSettingsCoverage.filter((entry) => entry.status === status).length,
  ]),
);
