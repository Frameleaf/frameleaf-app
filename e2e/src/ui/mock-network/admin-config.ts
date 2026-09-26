/**
 * The server's default administrator settings (`GET /api/system-config/defaults`, `mapAdminConfig(defaults)`
 * in server/src/dtos/config.dto.ts). The UI specs mock the signed-in user as an administrator, and the
 * Command Center (FL-71) loads these settings for an administrator whichever section it opens, so the
 * mocked server answers with its real defaults. Regenerate from the server when the settings change.
 */
export const adminConfigDefaults = {
  backup: {
    database: {
      enabled: true,
      cronExpression: '0 02 * * *',
      keepLastAmount: 14,
    },
  },
  ffmpeg: {
    crf: 23,
    threads: 0,
    preset: 'ultrafast',
    targetVideoCodec: 'h264',
    acceptedVideoCodecs: ['h264'],
    targetAudioCodec: 'aac',
    acceptedAudioCodecs: ['aac', 'mp3', 'opus'],
    acceptedContainers: ['mov', 'ogg', 'webm'],
    targetResolution: '720',
    maxBitrate: '0',
    bframes: -1,
    refs: 0,
    gopSize: 0,
    temporalAQ: false,
    cqMode: 'auto',
    twoPass: false,
    preferredHwDevice: 'auto',
    transcode: 'required',
    tonemap: 'hable',
    accel: 'disabled',
    accelDecode: true,
    realtime: {
      enabled: false,
      videoCodecs: ['h264', 'hevc'],
      resolutions: [480, 720, 1080],
    },
  },
  integrityChecks: {
    missingFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
    },
    untrackedFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
    },
    checksumFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
      timeLimit: 3_600_000,
      percentageLimit: 1,
    },
  },
  job: {
    thumbnailGeneration: {
      concurrency: 3,
    },
    metadataExtraction: {
      concurrency: 5,
    },
    videoConversion: {
      concurrency: 1,
    },
    faceDetection: {
      concurrency: 2,
    },
    smartSearch: {
      concurrency: 2,
    },
    videoDuplicateDetection: {
      concurrency: 1,
    },
    backgroundTask: {
      concurrency: 5,
    },
    migration: {
      concurrency: 5,
    },
    search: {
      concurrency: 5,
    },
    sidecar: {
      concurrency: 5,
    },
    library: {
      concurrency: 5,
    },
    notifications: {
      concurrency: 5,
    },
    ocr: {
      concurrency: 1,
    },
    imageEnrichment: {
      concurrency: 2,
    },
    imageDescription: {
      concurrency: 2,
    },
    nsfwDetection: {
      concurrency: 2,
    },
    mediaHealth: {
      concurrency: 2,
    },
    workflow: {
      concurrency: 5,
    },
    editor: {
      concurrency: 2,
    },
    integrityCheck: {
      concurrency: 1,
    },
  },
  logging: {
    enabled: true,
    level: 'log',
  },
  machineLearning: {
    enabled: true,
    urls: ['http://immich-machine-learning:3003'],
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
    imageDescription: {
      enabled: true,
      acceleration: 'auto',
      modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
      fallbackModelName: 'microsoft/Florence-2-base-ft',
      device: 'AUTO',
      prompt: {
        style: 'balanced',
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
        identityInjection: {
          enabled: true,
          maxNames: 5,
          minFaceConfidence: 0.7,
        },
        advanced: {
          enabled: false,
          rawPromptTemplate: '',
          placeholderValidation: 'strict',
        },
      },
      pendingRequeueAt: null,
      lastConfigChangeAt: null,
    },
    nsfwDetection: {
      enabled: false,
      modelName: 'onnx-community/nsfw_image_detection-ONNX',
      threshold: 0.85,
      device: 'AUTO',
      hideFromLibrary: false,
    },
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
    tokenEndpointAuthMethod: 'client_secret_post',
    timeout: 30_000,
    allowInsecureRequests: false,
    clientSecretConfigured: false,
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
      format: 'webp',
      size: 250,
      quality: 80,
      progressive: false,
    },
    preview: {
      format: 'jpeg',
      size: 1440,
      quality: 80,
      progressive: false,
    },
    colorspace: 'p3',
    extractEmbedded: false,
    enhancedRaw: {
      enabled: true,
    },
    fullsize: {
      enabled: false,
      format: 'jpeg',
      quality: 80,
      progressive: false,
    },
  },
  newVersionCheck: {
    enabled: false,
    channel: 'stable',
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
      cronExpression: '0 0 * * *',
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
        passwordConfigured: false,
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
  // FL-69: Library care settings.
  libraryCare: {
    healthScan: true,
    healthScanCronExpression: '0 02 * * *',
    checksumScan: true,
    integrityAudit: true,
    livePhotoRepair: true,
    rawRecovery: true,
    duplicateReview: true,
    incrementalEnrichment: true,
    manualMetadata: true,
  },
  // FL-159: Frameleaf Cloud processing replaced the previous GPU provider settings.
  frameleafCloud: {
    cloudMl: {
      enabled: false,
      routing: {
        descriptions: 'local',
        upscale: 'local',
        restoration: 'local',
        studio: 'local',
        interpolation: 'local',
      },
      startWith: 'local',
      autoDescribe: { enabled: false, dailyBudgetUsd: 2 },
      faces: { enabled: false },
    },
  },
  smartAlbums: {
    enabled: false,
    rules: {
      visualCategories: true,
      defaultAction: 'review',
    },
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
  },
} as const;
