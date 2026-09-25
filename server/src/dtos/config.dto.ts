import { CronExpression } from '@nestjs/schedule';
import { validateCronExpression } from 'cron';
import { createZodDto } from 'nestjs-zod';
import z from 'zod';
import type { DeepPartial } from 'src/types.js';
import {
  AudioCodec,
  AudioCodecSchema,
  CQMode,
  CQModeSchema,
  ClassificationRuleAction,
  ClassificationRuleActionSchema,
  Colorspace,
  ColorspaceSchema,
  ConfigVisibility,
  HlsVideoResolution,
  HlsVideoResolutionSchema,
  ImageFormat,
  ImageFormatSchema,
  LogLevel,
  LogLevelSchema,
  MachineLearningHardwareAcceleration,
  MachineLearningHardwareAccelerationSchema,
  OAuthTokenEndpointAuthMethod,
  OAuthTokenEndpointAuthMethodSchema,
  ReleaseChannel,
  ReleaseChannelSchema,
  ToneMapping,
  ToneMappingSchema,
  TranscodeHardwareAcceleration,
  TranscodeHardwareAccelerationSchema,
  TranscodePolicy,
  TranscodePolicySchema,
  VideoCodec,
  VideoCodecSchema,
  VideoContainer,
  VideoContainerSchema,
} from 'src/enum.js';

const { Admin, User, Public } = ConfigVisibility;

const configBool = z
  .preprocess(
    (val) => z.stringbool({ truthy: ['true'], falsy: ['false'], case: 'sensitive' }).safeParse(val).data ?? val,
    z.boolean(),
  )

  .nonoptional()
  .meta({ type: 'boolean' });

const cronExpressionSchema = z
  .string()
  .superRefine((value, ctx) => {
    const validated = validateCronExpression(value);
    if (!validated.valid) {
      ctx.addIssue({
        code: 'custom',
        message: `Invalid cron expression. ${validated.error?.message ?? ''}`,
        input: value,
      });
    }
  })
  .describe('Cron expression');

const emptyOrUrl = (error: string) =>
  z.string().refine((url) => url.length === 0 || z.url().safeParse(url).success, { error });

const AdminConfigIntegrityJobSchema = z
  .object({
    enabled: z.boolean().describe('Enabled'),
    cronExpression: cronExpressionSchema.describe('Cron expression for when the integrity check should run'),
  })
  .describe('Integrity job config')
  .meta({ id: 'AdminConfigIntegrityJobDto' });

const AdminConfigJobSettingsSchema = z
  .object({ concurrency: z.int().min(1).describe('Concurrency') })
  .meta({ id: 'AdminConfigJobSettingsDto' });

// Fork job entries need schema-level defaults so configs saved before these
// queues existed still validate. A distinct schema id is required: reusing
// AdminConfigJobSettingsSchema inside .default() would put the original object
// (id kept) next to its visibility clone (same id) and break OpenAPI generation.
const ForkJobSettingsSchema = z
  .object({ concurrency: z.int().min(1).describe('Concurrency') })
  .meta({ id: 'AdminConfigForkJobSettingsDto' });

const AdminConfigMachineLearningTaskSchema = z.object({
  enabled: z.boolean().describe('Whether the task is enabled').meta({ visibility: User }),
});

const AdminConfigMachineLearningModelSchema = AdminConfigMachineLearningTaskSchema.extend({
  modelName: z.string().describe('Name of the model to use'),
});

// Fork defaults that are also used as schema-level `.default()` values. They
// are hoisted as standalone constants (instead of referencing `defaults`)
// because `defaults` is typed by the schema itself — referencing it from a
// schema initializer would make the SystemConfig type circular.
const imageDescriptionDefaults = {
  enabled: true,
  acceleration: MachineLearningHardwareAcceleration.Auto,
  modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
  fallbackModelName: 'microsoft/Florence-2-base-ft',
  device: 'AUTO',
  prompt: {
    style: 'balanced' as const,
    sentenceCountTarget: 3,
    lookFor: [
      'brands',
      'signage',
      'screens',
      'documents',
      'uniforms',
      'tools',
      'vehicles',
      'animals',
      'food',
      'landmarks',
    ],
    customVocabulary: [],
    customInstructions: '',
    nsfwIndicators: [
      'adult-nudity',
      'bare-buttocks',
      'bondage',
      'explicit',
      'exposed-genitals',
      'naked',
      'nsfw',
      'nudity',
      'restraint',
      'sex-toy',
      'sexual-activity',
    ],
    medicalIndicators: [
      'bandage',
      'cast',
      'crutches',
      'exam-table',
      'hospital',
      'iv-line',
      'lab-result',
      'medical',
      'medical-monitor',
      'medical-paperwork',
      'mobility-aid',
      'pill-organizer',
      'prescription',
      'syringe',
      'ultrasound',
      'wheelchair',
      'wound',
      'x-ray',
    ],
    forbiddenInferences: ['diagnoses', 'medication names', 'procedures', 'pregnancy', 'disability'],
    identityInjection: { enabled: true, maxNames: 5, minFaceConfidence: 0.7 },
    advanced: { enabled: false, rawPromptTemplate: '', placeholderValidation: 'strict' as const },
  },
  pendingRequeueAt: null,
  lastConfigChangeAt: null,
};

const nsfwDetectionDefaults = {
  enabled: false,
  modelName: 'onnx-community/nsfw_image_detection-ONNX',
  threshold: 0.85,
  device: 'AUTO',
  hideFromLibrary: false,
};

/**
 * FL-159: Frameleaf Cloud processing. Everything is off until an administrator turns it on and adds the
 * destination; faces are refused by policy and cannot be turned on in this version.
 */
const frameleafCloudDefaults = {
  // FL-158: Sign in with Frameleaf. Off at home until an administrator shows it; the client secret
  // is only for a cloud that registered this server with one (private_key_jwt needs none).
  signIn: { buttonText: 'Sign in with Frameleaf', showOnLocalLogin: false, clientSecret: '' },
  cloudMl: {
    enabled: false,
    descriptions: { enabled: false, defaultModel: '', autoBatch: false, dailyBudgetUsd: 0 },
    restoration: { enabled: false, defaultModel: '' },
    faces: { enabled: false as const },
  },
};

/**
 * Library care (FL-69, settings-catalog.mjs:905-977): the template's Media health & integrity,
 * Repair queues and Enrichment completeness toggles. Hoisted like the other fork defaults so the
 * schema can default a configuration saved before the section existed.
 */
const libraryCareDefaults = {
  healthScan: true,
  healthScanCronExpression: CronExpression.EVERY_DAY_AT_2AM as string,
  checksumScan: true,
  integrityAudit: true,
  livePhotoRepair: true,
  rawRecovery: true,
  duplicateReview: true,
  incrementalEnrichment: true,
  manualMetadata: true,
};

const smartAlbumRulesDefaults = {
  visualCategories: true,
  defaultAction: ClassificationRuleAction.Review,
};

const smartAlbumsDefaults = {
  enabled: false,
  rules: smartAlbumRulesDefaults,
  builtIn: {
    travel: {
      enabled: true,
      name: 'Travel',
      tagTriggers: ['airport', 'beach', 'mountain', 'landmark', 'hotel', 'passport', 'suitcase', 'tourist'],
      clipQueries: ['vacation travel landscape', 'tourist destination'],
      threshold: 0.28,
    },
    documents: {
      enabled: true,
      name: 'Documents & Receipts',
      tagTriggers: ['receipt', 'document', 'invoice', 'paperwork', 'scan', 'id-card'],
      clipQueries: ['paper document', 'receipt or invoice'],
      threshold: 0.28,
    },
    screenshots: {
      enabled: true,
      name: 'Screenshots',
      tagTriggers: ['screenshot', 'ui', 'screen-capture', 'user-interface'],
      clipQueries: ['phone or computer screenshot'],
      threshold: 0.28,
    },
    food: {
      enabled: true,
      name: 'Food',
      tagTriggers: ['food', 'meal', 'dish', 'restaurant', 'plate', 'cooking'],
      clipQueries: ['plated food meal', 'restaurant dish'],
      threshold: 0.28,
    },
    pets: {
      enabled: true,
      name: 'Pets',
      tagTriggers: ['pet', 'dog', 'cat', 'puppy', 'kitten'],
      clipQueries: ['domestic pet animal'],
      threshold: 0.28,
    },
    nature: {
      enabled: true,
      name: 'Nature',
      tagTriggers: ['nature', 'forest', 'mountain', 'ocean', 'sunset', 'wildlife', 'flower'],
      clipQueries: ['natural landscape', 'wildlife'],
      threshold: 0.28,
    },
  },
};

const AdminConfigZeroShotTaggingSchema = z
  .object({
    enabled: z.boolean().describe('Whether zero-shot auto-tagging is enabled'),
    minSimilarity: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(1)
      .describe('Cosine similarity above which a label is applied as a tag'),
    maxTags: z.int().min(1).max(20).describe('Maximum number of zero-shot tags applied per asset'),
  })
  .meta({ id: 'AdminConfigZeroShotTaggingDto' });

export const CLIPConfigSchema = AdminConfigMachineLearningModelSchema.extend({
  zeroShotTagging: AdminConfigZeroShotTaggingSchema,
}).meta({ id: 'AdminConfigClipDto' });

export const DuplicateDetectionConfigSchema = AdminConfigMachineLearningTaskSchema.extend({
  maxDistance: z
    .number()
    .min(0.001)
    .max(0.1)
    .describe('Maximum distance threshold for duplicate detection')
    .meta({ format: 'double' }),
  preferOriginalFormat: z
    .boolean()
    .describe(
      'When suggesting which duplicate to keep, prefer native camera originals (RAW, then HEIC/HEIF) over re-encoded formats such as JPG, regardless of file size',
    ),
  enhancedVideo: z
    .object({
      enabled: z.boolean().describe('Whether enhanced video duplicate detection is enabled'),
      frameCount: z.int().min(2).max(8).describe('Number of video frames to sample for duplicate confirmation'),
      minMatchingFrames: z
        .int()
        .min(1)
        .max(8)
        .describe('Minimum matching sampled frames required to confirm a video duplicate'),
      maxDistance: z
        .number()
        .meta({ format: 'double' })
        .min(0.001)
        .max(0.1)
        .describe('Maximum distance threshold for enhanced video duplicate frame matching'),
    })
    .meta({ id: 'AdminConfigEnhancedVideoDuplicateDetectionDto' })
    .refine(({ frameCount, minMatchingFrames }) => minMatchingFrames <= frameCount, {
      message: 'Minimum matching frames cannot exceed frame count',
      path: ['minMatchingFrames'],
    }),
}).meta({ id: 'AdminConfigDuplicateDetectionDto' });

const IdentityInjectionSchema = z
  .object({
    enabled: z.boolean().default(true).describe('Inject named-face data into description prompts'),
    maxNames: z.int().min(1).max(20).default(5).describe('Maximum named persons to inject into a single prompt'),
    minFaceConfidence: z
      .number()
      .meta({ format: 'double' })
      .min(0)
      .max(1)
      .default(0.7)
      .describe('Minimum face-recognition confidence required to inject a name'),
  })
  .meta({ id: 'AdminConfigIdentityInjectionDto' });

const AdvancedPromptSchema = z
  .object({
    enabled: z.boolean().default(false).describe('Use a raw prompt template instead of the structured fields'),
    rawPromptTemplate: z
      .string()
      .default('')
      .describe('Raw prompt template with {names}, {schema}, {vocabulary}, {style_hint} placeholders'),
    placeholderValidation: z
      .enum(['strict', 'warn'])
      .default('strict')
      .describe('Whether missing {schema} placeholder fails save (strict) or warns (warn)'),
  })
  .meta({ id: 'AdminConfigAdvancedPromptDto' });

export const ImageDescriptionPromptSchema = z
  .object({
    style: z.enum(['terse', 'balanced', 'rich']).default('balanced').describe('Description verbosity preset'),
    sentenceCountTarget: z.int().min(1).max(6).default(3).describe('Target number of sentences in the description'),
    lookFor: z
      .array(z.string())
      .default([
        'brands',
        'signage',
        'screens',
        'documents',
        'uniforms',
        'tools',
        'vehicles',
        'animals',
        'food',
        'landmarks',
      ])
      .describe('Additional categories the model should note when visibly supported (brands, sports equipment, etc.)'),
    customVocabulary: z.array(z.string()).default([]).describe('Tag values the model should prefer when applicable'),
    customInstructions: z
      .string()
      .max(2000)
      .default('')
      .describe(
        'Free-form additional natural-language instructions appended to the description prompt. Example: "If you see a car, identify the make and model. If people are playing a sport, name the sport."',
      ),
    nsfwIndicators: z
      .array(z.string())
      .default([
        'adult-nudity',
        'bare-buttocks',
        'bondage',
        'explicit',
        'exposed-genitals',
        'naked',
        'nsfw',
        'nudity',
        'restraint',
        'sex-toy',
        'sexual-activity',
      ])
      .describe('Allow-list of explicit NSFW indicator terms permitted in the description'),
    medicalIndicators: z
      .array(z.string())
      .default([
        'bandage',
        'cast',
        'crutches',
        'exam-table',
        'hospital',
        'iv-line',
        'lab-result',
        'medical',
        'medical-monitor',
        'medical-paperwork',
        'mobility-aid',
        'pill-organizer',
        'prescription',
        'syringe',
        'ultrasound',
        'wheelchair',
        'wound',
        'x-ray',
      ])
      .describe('Allow-list of medical indicator terms permitted in the description'),
    forbiddenInferences: z
      .array(z.string())
      .default(['diagnoses', 'medication names', 'procedures', 'pregnancy', 'disability'])
      .describe('Categories the model must not infer (diagnoses, medications, etc.)'),
    identityInjection: IdentityInjectionSchema.default(() => IdentityInjectionSchema.parse({})).describe(
      'Named-face injection configuration',
    ),
    advanced: AdvancedPromptSchema.default(() => AdvancedPromptSchema.parse({})).describe(
      'Advanced raw-prompt-editor configuration',
    ),
  })
  .meta({ id: 'AdminConfigImageDescriptionPromptDto' });

export const ImageDescriptionConfigSchema = AdminConfigMachineLearningModelSchema.extend({
  acceleration: MachineLearningHardwareAccelerationSchema.default(MachineLearningHardwareAcceleration.Auto).describe(
    'Hardware acceleration backend to use',
  ),
  fallbackModelName: z.string().describe('Name of the fallback model to use'),
  device: z.string().describe('Hardware device to use'),
  prompt: ImageDescriptionPromptSchema.default(() => ImageDescriptionPromptSchema.parse({})),
  pendingRequeueAt: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'ISO timestamp set when an admin defers a re-queue from the cost modal. Cleared when the re-queue actually dispatches. Drives the persistent "re-queue pending" banner.',
    ),
  lastConfigChangeAt: z
    .string()
    .nullable()
    .default(null)
    .describe(
      'ISO timestamp of the last meaningful imageDescription config change. Set server-side; ignored on inbound writes (server is the source of truth).',
    ),
}).meta({ id: 'AdminConfigImageDescriptionDto' });

export const NsfwDetectionConfigSchema = AdminConfigMachineLearningModelSchema.extend({
  threshold: z
    .number()
    .meta({ format: 'double' })
    .min(0.01)
    .max(1)
    .describe('Minimum score required to mark an image as NSFW'),
  device: z.string().describe('Hardware device to use'),
  hideFromLibrary: z
    .boolean()
    .describe('Hide NSFW assets from library views unless the session has PIN-elevated access'),
}).meta({ id: 'AdminConfigNsfwDetectionDto' });

const AdminConfigFrameleafCloudSchema = z
  .object({
    signIn: z
      .object({
        buttonText: z.string().max(100).describe('Sign in with Frameleaf button text').meta({ visibility: Public }),
        showOnLocalLogin: configBool
          .describe('Show Sign in with Frameleaf on the local sign-in page too')
          .meta({ visibility: Public }),
        // Write-only, like oauth.clientSecret: mapAdminConfig() returns '' and saving '' keeps it.
        // Replace or clear it through /admin/config/credentials/frameleaf-oidc-client-secret.
        clientSecret: z.string().describe('Frameleaf client secret (write-only; empty preserves the existing secret)'),
        clientSecretConfigured: z
          .boolean()
          .optional()
          .describe('Read-only indicator that a client secret is stored. Set by the server; ignored on write.'),
      })
      .default(frameleafCloudDefaults.signIn)
      .meta({ id: 'AdminConfigFrameleafSignInDto' }),
    cloudMl: z
      .object({
        enabled: configBool.describe('Allow Frameleaf Cloud processing at all (the destination still needs consent)'),
        descriptions: z
          .object({
            enabled: configBool.describe('Allow image descriptions on Frameleaf Cloud'),
            defaultModel: z.string().max(200).describe('Catalogue model id used for descriptions; empty = none chosen'),
            autoBatch: configBool.describe('Run background description batches automatically (needs a daily budget)'),
            dailyBudgetUsd: z
              .number()
              .min(0)
              .max(100_000)
              .meta({ format: 'double' })
              .describe('Daily spending limit for background batches, USD'),
          })
          .meta({ id: 'AdminConfigFrameleafCloudDescriptionsDto' }),
        restoration: z
          .object({
            enabled: configBool.describe('Allow restoration and upscaling on Frameleaf Cloud'),
            defaultModel: z.string().max(200).describe('Catalogue model id preselected for restoration'),
          })
          .meta({ id: 'AdminConfigFrameleafCloudRestorationDto' }),
        faces: z
          .object({ enabled: z.literal(false).describe('Faces never run on Frameleaf Cloud in this version') })
          .meta({ id: 'AdminConfigFrameleafCloudFacesDto' }),
      })
      .meta({ id: 'AdminConfigFrameleafCloudMlDto' }),
  })
  .meta({ id: 'AdminConfigFrameleafCloudDto' });

// Admin-controlled but unbounded strings flow into background-job log lines
// and the smart-album evaluator. Cap to 256 chars and reject control characters
// (CWE-117 log injection hardening + general defensive bound).
// eslint-disable-next-line no-control-regex
const SMART_ALBUM_STRING_CONTROL_PATTERN = /[\u{0000}-\u{001F}\u{007F}]/u;
const smartAlbumString = z
  .string()
  .max(256, { error: 'String must be 256 characters or fewer' })
  .refine((value) => !SMART_ALBUM_STRING_CONTROL_PATTERN.test(value), {
    error: 'String cannot contain control characters or newlines',
  });

const SmartAlbumKindSchema = z
  .object({
    enabled: configBool.describe('Whether this smart album is active'),
    name: smartAlbumString.describe('User-visible album name'),
    tagTriggers: z.array(smartAlbumString).describe('Tags that mark an asset as belonging to this album'),
    clipQueries: z.array(smartAlbumString).describe('CLIP query phrases used when no tag trigger matches'),
    threshold: z.number().meta({ format: 'double' }).min(0).max(1).describe('CLIP similarity threshold'),
  })
  .meta({ id: 'AdminConfigSmartAlbumKindDto' });

/**
 * Rules people write for their own smart albums (FL-60). `defaultAction` is only the action a new
 * rule starts with; archiving is never a default and always an explicit, consented rule choice.
 */
const AdminConfigSmartAlbumRulesSchema = z
  .object({
    visualCategories: configBool.describe('Whether rules may match visual category phrases'),
    defaultAction: ClassificationRuleActionSchema.describe('The action a new rule starts with'),
  })
  .meta({ id: 'AdminConfigSmartAlbumRulesDto' });

const AdminConfigSmartAlbumsSchema = z
  .object({
    enabled: configBool.describe('Master smart-album enabled toggle'),
    rules: AdminConfigSmartAlbumRulesSchema.default(smartAlbumRulesDefaults),
    builtIn: z
      .object({
        travel: SmartAlbumKindSchema,
        documents: SmartAlbumKindSchema,
        screenshots: SmartAlbumKindSchema,
        food: SmartAlbumKindSchema,
        pets: SmartAlbumKindSchema,
        nature: SmartAlbumKindSchema,
      })
      .meta({ id: 'AdminConfigSmartAlbumBuiltInDto' }),
  })
  .meta({ id: 'AdminConfigSmartAlbumsDto' });

const AdminConfigLibraryCareSchema = z
  .object({
    healthScan: configBool.describe(
      'Schedule incremental health scans of every account; each resumes from its recorded checkpoints',
    ),
    healthScanCronExpression: cronExpressionSchema.describe('When the scheduled health scan starts'),
    checksumScan: configBool.describe('Health scans verify each original against its recorded checksum'),
    integrityAudit: configBool.describe(
      'Run the scheduled database and file reference audits (missing and untracked files)',
    ),
    livePhotoRepair: configBool.describe('Suggest Live Photo pairs to relink; ambiguous pairs stay in review'),
    rawRecovery: configBool.describe('Search for recoverable copies of RAW originals when locating originals'),
    duplicateReview: configBool.describe('Group near-duplicates for review; deletion stays explicit'),
    incrementalEnrichment: configBool.describe(
      'A full description rerun reprocesses only results that are missing, failed or out of date',
    ),
    manualMetadata: configBool.describe('A description rerun replaces only generated text and keeps manual text'),
  })
  .meta({ id: 'AdminConfigLibraryCareDto' });

const AdminConfigGeneratedImageSchema = z
  .object({
    format: ImageFormatSchema,
    quality: z.int().min(1).max(100).describe('Quality'),
    size: z.int().min(1).describe('Size').meta({ visibility: User }),
    progressive: configBool.default(false).optional().describe('Progressive'),
  })
  .meta({ id: 'AdminConfigGeneratedImageDto' });

const AdminConfigFFmpegSchema = z
  .object({
    crf: z.coerce.number().int().min(0).max(51).describe('CRF'),
    threads: z.coerce.number().int().min(0).describe('Threads'),
    preset: z.string().describe('Preset'),
    targetVideoCodec: VideoCodecSchema,
    acceptedVideoCodecs: z.array(VideoCodecSchema).describe('Accepted video codecs'),
    targetAudioCodec: AudioCodecSchema,
    acceptedAudioCodecs: z.array(AudioCodecSchema).describe('Accepted audio codecs'),
    acceptedContainers: z.array(VideoContainerSchema).describe('Accepted containers'),
    targetResolution: z.string().describe('Target resolution'),
    maxBitrate: z.string().describe('Max bitrate'),
    bframes: z.coerce.number().int().min(-1).max(16).describe('B-frames'),
    refs: z.coerce.number().int().min(0).max(6).describe('References'),
    gopSize: z.coerce.number().int().min(0).describe('GOP size'),
    temporalAQ: configBool.describe('Temporal AQ'),
    cqMode: CQModeSchema,
    twoPass: configBool.describe('Two pass'),
    preferredHwDevice: z.string().describe('Preferred hardware device'),
    transcode: TranscodePolicySchema,
    accel: TranscodeHardwareAccelerationSchema,
    accelDecode: configBool.describe('Accelerated decode'),
    tonemap: ToneMappingSchema,
    realtime: z
      .object({
        enabled: configBool.describe('Enable real-time HLS transcoding (alpha)').meta({ visibility: User }),
        videoCodecs: z
          .array(VideoCodecSchema)
          .describe('Video codecs to use for real-time HLS transcoding')
          .meta({ visibility: User }),
        resolutions: z
          .array(HlsVideoResolutionSchema)
          .describe('Resolutions to use for real-time HLS transcoding')
          .meta({ visibility: User }),
      })
      .meta({ id: 'AdminConfigFFmpegRealtimeDto' }),
  })
  .meta({ id: 'AdminConfigFFmpegDto' });

const AdminConfigSmtpSchema = z
  .object({
    enabled: configBool.describe('Whether SMTP email notifications are enabled'),
    from: z.string().describe('Email address to send from'),
    replyTo: z.string().describe('Email address for replies'),
    transport: z
      .object({
        ignoreCert: configBool.describe('Whether to ignore SSL certificate errors'),
        host: z.string().describe('SMTP server hostname'),
        port: z.int().min(0).max(65_535).describe('SMTP server port'),
        secure: configBool.describe('Whether to use secure connection (TLS/SSL)'),
        username: z.string().describe('SMTP username'),
        // FL-67: write-only, like oauth.clientSecret. mapAdminConfig() returns '' and
        // updateAdminConfig() keeps the stored password when '' comes back. Replace or clear it
        // through /admin/config/credentials/smtp-password.
        password: z.string().describe('SMTP password (write-only; empty preserves the existing password)'),
        passwordConfigured: z
          .boolean()
          .optional()
          .describe('Read-only indicator that an SMTP password is stored. Set by the server; ignored on write.'),
      })
      .meta({ id: 'AdminConfigSmtpTransportDto' }),
  })
  .meta({ id: 'AdminConfigSmtpDto' });

const AdminConfigSchemaWithVisibility = z
  .object({
    backup: z
      .object({
        database: z
          .object({
            enabled: configBool.describe('Enabled'),
            cronExpression: cronExpressionSchema,
            keepLastAmount: z.int().min(1).describe('Keep last amount'),
          })
          .meta({ id: 'AdminConfigDatabaseBackupDto' }),
      })
      .meta({ id: 'AdminConfigBackupsDto' }),
    ffmpeg: AdminConfigFFmpegSchema,
    integrityChecks: z
      .object({
        missingFiles: AdminConfigIntegrityJobSchema,
        untrackedFiles: AdminConfigIntegrityJobSchema,
        checksumFiles: AdminConfigIntegrityJobSchema.extend({
          timeLimit: z.int().nonnegative().describe('How long the integrity checksum job may run for'),
          percentageLimit: z
            .float32()
            .nonnegative()
            .max(1)
            .describe('Percentage limit of the integrity checksum job')
            .meta({ format: 'double' }),
        })
          .describe('Integrity checksum job config')
          .meta({ id: 'AdminConfigIntegrityChecksumJobDto' }),
      })
      .describe('Integrity checks config')
      .meta({ id: 'AdminConfigIntegrityChecksDto' }),
    job: z
      .object({
        thumbnailGeneration: AdminConfigJobSettingsSchema,
        metadataExtraction: AdminConfigJobSettingsSchema,
        videoConversion: AdminConfigJobSettingsSchema,
        faceDetection: AdminConfigJobSettingsSchema,
        smartSearch: AdminConfigJobSettingsSchema,
        videoDuplicateDetection: AdminConfigJobSettingsSchema,
        backgroundTask: AdminConfigJobSettingsSchema,
        migration: AdminConfigJobSettingsSchema,
        search: AdminConfigJobSettingsSchema,
        sidecar: AdminConfigJobSettingsSchema,
        library: AdminConfigJobSettingsSchema,
        notifications: AdminConfigJobSettingsSchema,
        ocr: AdminConfigJobSettingsSchema,
        imageEnrichment: ForkJobSettingsSchema.default({ concurrency: 2 }),
        imageDescription: ForkJobSettingsSchema.default({ concurrency: 2 }),
        nsfwDetection: ForkJobSettingsSchema.default({ concurrency: 2 }),
        mediaHealth: ForkJobSettingsSchema.default({ concurrency: 2 }),
        workflow: AdminConfigJobSettingsSchema,
        editor: AdminConfigJobSettingsSchema,
        integrityCheck: AdminConfigJobSettingsSchema,
        petRecognition: ForkJobSettingsSchema.default({ concurrency: 1 }),
      })
      .meta({ id: 'AdminConfigJobDto' }),
    logging: z
      .object({
        enabled: configBool.describe('Enabled'),
        level: LogLevelSchema,
      })
      .meta({ id: 'AdminConfigLoggingDto' }),
    machineLearning: z
      .object({
        enabled: configBool.describe('Enabled').meta({ visibility: User }),
        urls: z.array(z.string()).min(1).describe('ML service URLs'),
        availabilityChecks: z
          .object({
            enabled: configBool.describe('Enabled'),
            timeout: z.int(),
            interval: z.int(),
          })
          .meta({ id: 'AdminConfigMachineLearningAvailabilityChecksDto' }),
        clip: CLIPConfigSchema,
        duplicateDetection: DuplicateDetectionConfigSchema,
        facialRecognition: AdminConfigMachineLearningModelSchema.extend({
          minScore: z
            .number()
            .min(0.1)
            .max(1)
            .describe('Minimum confidence score for face detection')
            .meta({ format: 'double' }),
          maxDistance: z
            .number()
            .min(0.1)
            .max(2)
            .describe('Maximum distance threshold for face recognition')
            .meta({ format: 'double' }),
          minFaces: z
            .int()
            .min(1)
            .describe('Minimum number of faces required for recognition')
            .meta({ visibility: User }),
        }).meta({ id: 'AdminConfigFacialRecognitionDto' }),
        ocr: AdminConfigMachineLearningModelSchema.extend({
          maxResolution: z.int().min(1).describe('Maximum resolution for OCR processing'),
          minDetectionScore: z
            .number()
            .min(0.1)
            .max(1)
            .describe('Minimum confidence score for text detection')
            .meta({ format: 'double' }),
          minRecognitionScore: z
            .number()
            .min(0.1)
            .max(1)
            .describe('Minimum confidence score for text recognition')
            .meta({ format: 'double' }),
          // FL-63: off by default, as in the design; suggestions stay editable and tied to their text
          documentFields: z
            .boolean()
            .default(false)
            .describe('Suggest receipt and document fields (dates, totals, references) from recognized text'),
        }).meta({ id: 'AdminConfigOcrDto' }),
        imageDescription: ImageDescriptionConfigSchema.default(imageDescriptionDefaults),
        nsfwDetection: NsfwDetectionConfigSchema.default(nsfwDetectionDefaults),
      })
      .meta({ id: 'AdminConfigMachineLearningDto' }),
    map: z
      .object({
        enabled: configBool.describe('Enabled').meta({ visibility: User }),
        lightStyle: z.url().describe('Light map style URL').meta({ visibility: User }),
        darkStyle: z.url().describe('Dark map style URL').meta({ visibility: User }),
      })
      .meta({ id: 'AdminConfigMapDto' }),
    reverseGeocoding: z
      .object({ enabled: configBool.describe('Enabled').meta({ visibility: User }) })
      .meta({ id: 'AdminConfigReverseGeocodingDto' }),
    metadata: z
      .object({
        faces: z.object({ import: configBool.describe('Import') }).meta({ id: 'AdminConfigFacesDto' }),
      })
      .meta({ id: 'AdminConfigMetadataDto' }),
    oauth: z
      .object({
        autoLaunch: configBool.describe('Auto launch').meta({ visibility: Public }),
        autoRegister: configBool.describe('Auto register'),
        buttonText: z.string().describe('Button text').meta({ visibility: Public }),
        clientId: z.string().describe('Client ID'),
        // FL-67: write-only. mapAdminConfig() returns '' and updateAdminConfig() keeps the stored
        // secret when '' comes back. Replace or clear it through
        // /admin/config/credentials/oauth-client-secret.
        clientSecret: z.string().describe('Client secret (write-only; empty preserves the existing secret)'),
        clientSecretConfigured: z
          .boolean()
          .optional()
          .describe('Read-only indicator that a client secret is stored. Set by the server; ignored on write.'),
        tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethodSchema,
        timeout: z.int().min(1).describe('Timeout'),
        allowInsecureRequests: configBool.describe('Allow insecure requests'),
        defaultStorageQuota: z.int().min(0).nullable().describe('Default storage quota'),
        enabled: configBool.describe('Enabled').meta({ visibility: Public }),
        issuerUrl: emptyOrUrl('Issuer URL must be an empty string or a valid URL').describe('Issuer URL'),
        accountManagementUrl: emptyOrUrl('Account management URL must be an empty string or a valid URL')
          .describe('Account management URL')
          .optional()
          .default(''),
        scope: z.string().describe('Scope'),
        prompt: z.string().describe('OAuth prompt parameter (e.g. select_account, login, consent)'),
        endSessionEndpoint: emptyOrUrl('endSessionEndpoint must be an empty string or a valid URL').describe(
          'End session endpoint',
        ),
        signingAlgorithm: z.string().describe('Signing algorithm'),
        profileSigningAlgorithm: z.string().describe('Profile signing algorithm'),
        storageLabelClaim: z.string().describe('Storage label claim'),
        storageQuotaClaim: z.string().describe('Storage quota claim'),
        roleClaim: z.string().describe('Role claim'),
        mobileOverrideEnabled: configBool.describe('Mobile override enabled'),
        mobileRedirectUri: z.string().describe('Mobile redirect URI (set to empty string to disable)'),
      })
      .transform((value, ctx) => {
        if (!value.mobileOverrideEnabled || value.mobileRedirectUri === '') {
          return value;
        }

        if (!z.url().safeParse(value.mobileRedirectUri).success) {
          ctx.issues.push({
            code: 'custom',
            message: 'Mobile redirect URI must be an empty string or a valid URL',
            input: value.mobileRedirectUri,
          });
          return z.NEVER;
        }

        return value;
      })
      .meta({ id: 'AdminConfigOAuthDto' }),
    passwordLogin: z
      .object({ enabled: configBool.describe('Enabled').meta({ visibility: Public }) })
      .meta({ id: 'AdminConfigPasswordLoginDto' }),
    physicalDeduplication: z
      .object({
        enabled: configBool.describe('Enabled'),
        masterUserId: z.uuidv4().nullable().describe('Master user ID'),
      })
      .meta({ id: 'AdminConfigPhysicalDeduplicationDto' })
      .default({ enabled: false, masterUserId: null }),
    // FL-71: the template's "Logs & diagnostics" local analytics rows. The nightly collector only
    // reads counts and sizes into this server's database; external telemetry stays off regardless.
    analytics: z
      .object({
        enabled: configBool.describe('Collect local analytics history every night'),
        historyDays: z.int().min(30).max(800).describe('Days of local analytics history to keep'),
      })
      .meta({ id: 'AdminConfigAnalyticsDto' })
      .default({ enabled: true, historyDays: 730 }),
    localFeatures: z
      .object({
        askSearch: z
          .object({
            enabled: configBool.describe('Enable local Ask Photos-style search'),
            maxResults: z.int().min(1).max(1000).describe('Maximum number of Ask Search results'),
          })
          .meta({ id: 'AdminConfigAskSearchDto' }),
      })
      .meta({ id: 'AdminConfigLocalFeaturesDto' })
      .default({ askSearch: { enabled: true, maxResults: 100 } }),
    storageTemplate: z
      .object({
        enabled: configBool.describe('Enabled'),
        hashVerificationEnabled: configBool.describe('Hash verification enabled'),
        template: z.string().describe('Template'),
      })
      .meta({ id: 'AdminConfigStorageTemplateDto' }),
    image: z
      .object({
        thumbnail: AdminConfigGeneratedImageSchema,
        preview: AdminConfigGeneratedImageSchema,
        fullsize: z
          .object({
            enabled: configBool.describe('Enabled').meta({ visibility: User }),
            format: ImageFormatSchema,
            quality: z.int().min(1).max(100).describe('Quality'),
            progressive: configBool.default(false).optional().describe('Progressive'),
          })
          .meta({ id: 'AdminConfigGeneratedFullsizeImageDto' }),
        colorspace: ColorspaceSchema,
        extractEmbedded: configBool.describe('Extract embedded'),
        enhancedRaw: z
          .object({
            enabled: configBool.describe('Enhanced RAW rendering'),
          })
          .meta({ id: 'AdminConfigEnhancedRawImageDto' })
          .default({ enabled: true }),
      })
      .meta({ id: 'AdminConfigImageDto' }),
    newVersionCheck: z
      .object({ enabled: configBool.describe('Enabled'), channel: ReleaseChannelSchema })
      .meta({ id: 'AdminConfigNewVersionCheckDto' }),
    nightlyTasks: z
      .object({
        startTime: z.iso
          .time({
            precision: -1,
            error: (iss) => `Invalid input: expected string in HH:MM format, received ${typeof iss.input}`,
          })
          .describe('Start time (HH:MM)'),
        databaseCleanup: configBool.describe('Database cleanup'),
        missingThumbnails: configBool.describe('Missing thumbnails'),
        clusterNewFaces: configBool.describe('Cluster new faces'),
        generateMemories: configBool.describe('Generate memories'),
        syncQuotaUsage: configBool.describe('Sync quota usage'),
      })
      .meta({ id: 'AdminConfigNightlyTasksDto' }),
    trash: z
      .object({
        enabled: configBool.describe('Enabled').meta({ visibility: User }),
        days: z.int().min(0).describe('Days').meta({ visibility: User }),
      })
      .meta({ id: 'AdminConfigTrashDto' }),
    theme: z
      .object({ customCss: z.string().describe('Custom CSS for theming').meta({ visibility: Public }) })
      .meta({ id: 'AdminConfigThemeDto' }),
    library: z
      .object({
        scan: z
          .object({
            enabled: configBool.describe('Enabled'),
            cronExpression: cronExpressionSchema,
          })
          .meta({ id: 'AdminConfigLibraryScanDto' }),
        watch: z.object({ enabled: configBool.describe('Enabled') }).meta({ id: 'AdminConfigLibraryWatchDto' }),
      })
      .meta({ id: 'AdminConfigLibraryDto' }),
    notifications: z.object({ smtp: AdminConfigSmtpSchema }).meta({ id: 'AdminConfigNotificationsDto' }),
    templates: z
      .object({
        email: z
          .object({
            welcomeTemplate: z.string().describe('Welcome template'),
            albumInviteTemplate: z.string().describe('Album invite template'),
            albumUpdateTemplate: z.string().describe('Album update template'),
          })
          .meta({ id: 'AdminConfigTemplateEmailsDto' }),
      })
      .meta({ id: 'AdminConfigTemplatesDto' }),
    server: z
      .object({
        // FL-71 (CC-4): the server's name in the Command Center rail and context bar (CommandCenter.jsx).
        name: z
          .string()
          .trim()
          .max(100)
          .describe('Server name shown in settings; empty uses the host name')
          .meta({ visibility: Public }),
        externalDomain: emptyOrUrl('External domain must be an empty string or a valid URL')
          .describe('External domain')
          .meta({ visibility: User }),
        loginPageMessage: z.string().describe('Login page message').meta({ visibility: Public }),
        publicUsers: configBool.describe('Public users').meta({ visibility: User }),
      })
      .meta({ id: 'AdminConfigServerDto' }),
    user: z
      .object({ deleteDelay: z.int().min(1).describe('Delete delay').meta({ visibility: User }) })
      .meta({ id: 'AdminConfigUserDto' }),
    smartAlbums: AdminConfigSmartAlbumsSchema.default(smartAlbumsDefaults),
    frameleafCloud: AdminConfigFrameleafCloudSchema.default(frameleafCloudDefaults),
    libraryCare: AdminConfigLibraryCareSchema.default(libraryCareDefaults),
  })
  .describe('Configuration properties that are visible to the admin')
  .meta({ id: 'AdminConfigDto' });

export type SystemConfig = z.infer<typeof AdminConfigSchemaWithVisibility>;
export type MachineLearningConfig = SystemConfig['machineLearning'];

const visibilities = [Public, User, Admin];

const isVisible = (property: ConfigVisibility, visibility: ConfigVisibility) =>
  visibilities.indexOf(property) <= visibilities.indexOf(visibility);

const getMeta = (schema: z.ZodType) =>
  (z.globalRegistry.get(schema) ?? {}) as { id?: string; description?: string; visibility?: ConfigVisibility };

const unwrap = (schema: z.ZodType) => (schema instanceof z.ZodPipe ? (schema.def.in as z.ZodType) : schema);

const visibleSchemas = new Map<z.ZodType, Map<ConfigVisibility, z.ZodType | undefined>>();

const applyVisibility = (visibility: ConfigVisibility): z.ZodType | undefined => {
  const map: Record<ConfigVisibility, string> = {
    [Admin]: 'Configuration properties that are visible to the admin',
    [User]: 'Configuration properties that are visible to a logged user',
    [Public]: 'Configuration properties that are visible to everyone',
  };

  return applyVisibilityRecursive(AdminConfigSchemaWithVisibility, visibility, map[visibility]);
};

const applyVisibilityRecursive = (
  schema: z.ZodType,
  visibility: ConfigVisibility,
  override?: string,
): z.ZodType | undefined => {
  const object = unwrap(schema);
  const { id, description, visibility: property } = getMeta(schema);

  if (!(object instanceof z.ZodObject)) {
    return isVisible(property ?? Admin, visibility) ? schema : undefined;
  }

  let cache = visibleSchemas.get(schema);
  if (!cache) {
    cache = new Map();
    visibleSchemas.set(schema, cache);
  }

  if (cache.has(visibility)) {
    return cache.get(visibility);
  }

  const shape: Record<string, z.ZodType> = {};
  for (const [key, value] of Object.entries(object.shape as Record<string, z.ZodType>)) {
    const visible = applyVisibilityRecursive(value, visibility);
    if (visible) {
      shape[key] = visible;
    }
  }

  let visible: z.ZodType | undefined;
  if (Object.keys(shape).length > 0) {
    visible = z.object(shape).meta({
      ...(id && { id: `${visibility}${id.slice(Admin.length)}` }),
      ...((override ?? description) && { description: override ?? description }),
    });
  }

  cache.set(visibility, visible);

  return visible;
};

const stripVisibilityMetadata = <T extends z.ZodType>(schema: T): T => {
  const object = unwrap(schema);
  if (object instanceof z.ZodObject) {
    for (const value of Object.values(object.shape as Record<string, z.ZodType>)) {
      stripVisibilityMetadata(value);
    }

    return schema;
  }

  const { visibility, ...meta } = getMeta(schema);
  if (visibility) {
    z.globalRegistry.add(schema, meta);
  }

  return schema;
};

export const AdminConfigSchema = applyVisibility(Admin)! as z.ZodType<SystemConfig>;
const UserConfigSchema = applyVisibility(User)! as z.ZodType<DeepPartial<SystemConfig>>;
const PublicConfigSchema = applyVisibility(Public)! as z.ZodType<DeepPartial<SystemConfig>>;

// prevent visibility metadata from leaking to openapi spec
// eslint-disable-next-line unicorn/no-top-level-side-effects
stripVisibilityMetadata(AdminConfigSchemaWithVisibility);

const ConfigTemplateStorageOptionSchema = z
  .object({
    yearOptions: z.array(z.string()).describe('Available year format options for storage template'),
    monthOptions: z.array(z.string()).describe('Available month format options for storage template'),
    weekOptions: z.array(z.string()).describe('Available week format options for storage template'),
    dayOptions: z.array(z.string()).describe('Available day format options for storage template'),
    hourOptions: z.array(z.string()).describe('Available hour format options for storage template'),
    minuteOptions: z.array(z.string()).describe('Available minute format options for storage template'),
    secondOptions: z.array(z.string()).describe('Available second format options for storage template'),
    presetOptions: z.array(z.string()).describe('Available preset template options'),
  })
  .meta({ id: 'SystemConfigTemplateStorageOptionDto' });

export class AdminConfigDto extends createZodDto(AdminConfigSchema) {}
export class UserConfigDto extends createZodDto(UserConfigSchema) {}
export class PublicConfigDto extends createZodDto(PublicConfigSchema) {}
export class ConfigFFmpegDto extends createZodDto(AdminConfigFFmpegSchema) {}
export class ConfigSmtpDto extends createZodDto(AdminConfigSmtpSchema) {}
export class ConfigTemplateStorageOptionDto extends createZodDto(ConfigTemplateStorageOptionSchema) {}

/** @deprecated the `/system-config` endpoints these are named after are on their way out */
export { AdminConfigDto as SystemConfigDto, ConfigSmtpDto as SystemConfigSmtpDto };

export class CLIPConfig extends createZodDto(CLIPConfigSchema) {}

export function mapAdminConfig(config: SystemConfig): AdminConfigDto {
  // Redact secrets on read. Writes that come back with an empty string here
  // preserve the stored value (see system-config.service.ts:updateAdminConfig).
  // The `apiKeyConfigured` flag exists so the admin UI can render a "Key
  // Saved" indicator without exposing the actual key.
  // FL-67: the SMTP password and the OAuth client secret follow the same rule, so no secret ever
  // reaches a settings draft, a copied or exported configuration, or a log of the response.
  return {
    ...config,
    notifications: {
      ...config.notifications,
      smtp: {
        ...config.notifications.smtp,
        transport: {
          ...config.notifications.smtp.transport,
          password: '',
          passwordConfigured: config.notifications.smtp.transport.password.length > 0,
        },
      },
    },
    oauth: {
      ...config.oauth,
      clientSecret: '',
      clientSecretConfigured: config.oauth.clientSecret.length > 0,
    },
    frameleafCloud: {
      ...config.frameleafCloud,
      signIn: {
        ...config.frameleafCloud.signIn,
        clientSecret: '',
        clientSecretConfigured: (config.frameleafCloud.signIn?.clientSecret ?? '').length > 0,
      },
    },
  };
}

export function mapUserConfig(config: SystemConfig): UserConfigDto {
  return UserConfigSchema.parse(config);
}

export function mapPublicConfig(config: SystemConfig): PublicConfigDto {
  return PublicConfigSchema.parse(config);
}

export const defaults = Object.freeze<SystemConfig>({
  backup: {
    database: {
      enabled: true,
      cronExpression: CronExpression.EVERY_DAY_AT_2AM,
      keepLastAmount: 14,
    },
  },
  ffmpeg: {
    crf: 23,
    threads: 0,
    preset: 'ultrafast',
    targetVideoCodec: VideoCodec.H264,
    acceptedVideoCodecs: [VideoCodec.H264],
    targetAudioCodec: AudioCodec.Aac,
    acceptedAudioCodecs: [AudioCodec.Aac, AudioCodec.Mp3, AudioCodec.Opus],
    acceptedContainers: [VideoContainer.Mov, VideoContainer.Ogg, VideoContainer.Webm],
    targetResolution: '720',
    maxBitrate: '0',
    bframes: -1,
    refs: 0,
    gopSize: 0,
    temporalAQ: false,
    cqMode: CQMode.Auto,
    twoPass: false,
    preferredHwDevice: 'auto',
    transcode: TranscodePolicy.Required,
    tonemap: ToneMapping.Hable,
    accel: TranscodeHardwareAcceleration.Disabled,
    accelDecode: true,
    realtime: {
      enabled: false,
      videoCodecs: [VideoCodec.H264, VideoCodec.Hevc],
      resolutions: [HlsVideoResolution.p480, HlsVideoResolution.p720, HlsVideoResolution.p1080],
    },
  },
  integrityChecks: {
    missingFiles: {
      enabled: true,
      cronExpression: CronExpression.EVERY_DAY_AT_3AM,
    },
    untrackedFiles: {
      enabled: true,
      cronExpression: CronExpression.EVERY_DAY_AT_3AM,
    },
    checksumFiles: {
      enabled: true,
      cronExpression: CronExpression.EVERY_DAY_AT_3AM,
      timeLimit: 60 * 60 * 1000, // 1 hour
      percentageLimit: 1, // 100% of assets
    },
  },
  job: {
    thumbnailGeneration: { concurrency: 3 },
    metadataExtraction: { concurrency: 5 },
    videoConversion: { concurrency: 1 },
    faceDetection: { concurrency: 2 },
    smartSearch: { concurrency: 2 },
    videoDuplicateDetection: { concurrency: 1 },
    backgroundTask: { concurrency: 5 },
    migration: { concurrency: 5 },
    search: { concurrency: 5 },
    sidecar: { concurrency: 5 },
    library: { concurrency: 5 },
    notifications: { concurrency: 5 },
    ocr: { concurrency: 1 },
    imageEnrichment: { concurrency: 2 },
    imageDescription: { concurrency: 2 },
    nsfwDetection: { concurrency: 2 },
    mediaHealth: { concurrency: 2 },
    workflow: { concurrency: 5 },
    editor: { concurrency: 2 },
    integrityCheck: { concurrency: 1 },
    petRecognition: { concurrency: 1 },
  },
  logging: {
    enabled: true,
    level: LogLevel.Log,
  },
  machineLearning: {
    enabled: process.env.IMMICH_MACHINE_LEARNING_ENABLED !== 'false',
    urls: [process.env.IMMICH_MACHINE_LEARNING_URL || 'http://immich-machine-learning:3003'],
    availabilityChecks: {
      enabled: true,
      timeout: 2000,
      interval: 30_000,
    },
    clip: {
      enabled: true,
      modelName: 'ViT-B-16-SigLIP-384__webli',
      zeroShotTagging: {
        enabled: true,
        minSimilarity: 0.25,
        maxTags: 6,
      },
    },
    duplicateDetection: {
      enabled: true,
      maxDistance: 0.01,
      preferOriginalFormat: true,
      enhancedVideo: {
        enabled: true,
        frameCount: 4,
        minMatchingFrames: 2,
        maxDistance: 0.01,
      },
    },
    facialRecognition: {
      enabled: true,
      modelName: 'buffalo_l',
      minScore: 0.7,
      maxDistance: 0.5,
      minFaces: 3,
    },
    ocr: {
      enabled: true,
      modelName: 'PP-OCRv5_mobile',
      minDetectionScore: 0.5,
      minRecognitionScore: 0.8,
      maxResolution: 736,
      documentFields: false,
    },
    imageDescription: imageDescriptionDefaults,
    nsfwDetection: nsfwDetectionDefaults,
  },
  map: {
    enabled: true,
    lightStyle: 'https://tiles.immich.cloud/v1/style/light.json',
    darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json',
  },
  reverseGeocoding: {
    enabled: true,
  },
  metadata: {
    faces: {
      import: false,
    },
  },
  oauth: {
    autoLaunch: false,
    autoRegister: true,
    buttonText: 'Login with OAuth',
    clientId: '',
    clientSecret: '',
    defaultStorageQuota: null,
    enabled: false,
    issuerUrl: '',
    accountManagementUrl: '',
    endSessionEndpoint: '',
    mobileOverrideEnabled: false,
    mobileRedirectUri: '',
    prompt: '',
    scope: 'openid email profile',
    signingAlgorithm: 'RS256',
    profileSigningAlgorithm: 'none',
    storageLabelClaim: 'preferred_username',
    storageQuotaClaim: 'immich_quota',
    roleClaim: 'immich_role',
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
    timeout: 30_000,
    allowInsecureRequests: false,
  },
  passwordLogin: {
    enabled: true,
  },
  physicalDeduplication: {
    enabled: false,
    masterUserId: null,
  },
  analytics: {
    enabled: true,
    historyDays: 730,
  },
  localFeatures: {
    askSearch: {
      enabled: true,
      maxResults: 100,
    },
  },
  storageTemplate: {
    enabled: false,
    hashVerificationEnabled: true,
    template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}',
  },
  image: {
    thumbnail: {
      format: ImageFormat.Webp,
      size: 250,
      quality: 80,
      progressive: false,
    },
    preview: {
      format: ImageFormat.Jpeg,
      size: 1440,
      quality: 80,
      progressive: false,
    },
    colorspace: Colorspace.P3,
    extractEmbedded: false,
    enhancedRaw: {
      enabled: true,
    },
    fullsize: {
      enabled: false,
      format: ImageFormat.Jpeg,
      quality: 80,
      progressive: false,
    },
  },
  newVersionCheck: {
    enabled: false,
    channel: ReleaseChannel.Stable,
  },
  nightlyTasks: {
    startTime: '00:00',
    databaseCleanup: true,
    generateMemories: true,
    syncQuotaUsage: true,
    missingThumbnails: true,
    clusterNewFaces: true,
  },
  trash: {
    enabled: true,
    days: 30,
  },
  theme: {
    customCss: '',
  },
  library: {
    scan: {
      enabled: true,
      cronExpression: CronExpression.EVERY_DAY_AT_MIDNIGHT,
    },
    watch: {
      enabled: false,
    },
  },
  server: {
    name: '',
    externalDomain: '',
    loginPageMessage: '',
    publicUsers: true,
  },
  notifications: {
    smtp: {
      enabled: false,
      from: '',
      replyTo: '',
      transport: {
        ignoreCert: false,
        host: '',
        port: 587,
        secure: false,
        username: '',
        password: '',
      },
    },
  },
  templates: {
    email: {
      welcomeTemplate: '',
      albumInviteTemplate: '',
      albumUpdateTemplate: '',
    },
  },
  user: {
    deleteDelay: 7,
  },
  smartAlbums: smartAlbumsDefaults,
  frameleafCloud: frameleafCloudDefaults,
  libraryCare: libraryCareDefaults,
});
