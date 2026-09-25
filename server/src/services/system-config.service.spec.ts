import { BadRequestException, ConflictException } from '@nestjs/common';
import { cloneDeep, get } from 'lodash-es';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { mapConfig } from 'src/dtos/system-config.dto.js';
import {
  AudioCodec,
  CQMode,
  ClassificationRuleAction,
  Colorspace,
  ConfigCredential,
  DatabaseLock,
  HlsVideoResolution,
  ImageFormat,
  LogLevel,
  MachineLearningHardwareAcceleration,
  OAuthTokenEndpointAuthMethod,
  QueueName,
  ReleaseChannel,
  SystemMetadataKey,
  ToneMapping,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  VideoCodec,
  VideoContainer,
} from 'src/enum.js';
import { SystemConfigService } from 'src/services/system-config.service.js';
import { DeepPartial } from 'src/types.js';
import { getConfigRevision } from 'src/utils/config.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const partialConfig = {
  ffmpeg: { crf: 30 },
  oauth: { autoLaunch: true },
  trash: { days: 10 },
  user: { deleteDelay: 15 },
} satisfies DeepPartial<SystemConfig>;

const updatedConfig = Object.freeze<SystemConfig>({
  job: {
    [QueueName.BackgroundTask]: { concurrency: 5 },
    [QueueName.SmartSearch]: { concurrency: 2 },
    [QueueName.VideoDuplicateDetection]: { concurrency: 1 },
    [QueueName.MediaHealth]: { concurrency: 2 },
    [QueueName.MetadataExtraction]: { concurrency: 5 },
    [QueueName.FaceDetection]: { concurrency: 2 },
    [QueueName.Search]: { concurrency: 5 },
    [QueueName.Sidecar]: { concurrency: 5 },
    [QueueName.Library]: { concurrency: 5 },
    [QueueName.Migration]: { concurrency: 5 },
    [QueueName.ThumbnailGeneration]: { concurrency: 3 },
    [QueueName.VideoConversion]: { concurrency: 1 },
    [QueueName.Notification]: { concurrency: 5 },
    [QueueName.Ocr]: { concurrency: 1 },
    [QueueName.ImageEnrichment]: { concurrency: 2 },
    [QueueName.ImageDescription]: { concurrency: 2 },
    [QueueName.NsfwDetection]: { concurrency: 2 },
    [QueueName.Workflow]: { concurrency: 5 },
    [QueueName.IntegrityCheck]: { concurrency: 1 },
    [QueueName.Editor]: { concurrency: 2 },
  },
  backup: {
    database: {
      enabled: true,
      cronExpression: '0 02 * * *',
      keepLastAmount: 14,
    },
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
  ffmpeg: {
    crf: 30,
    threads: 0,
    preset: 'ultrafast',
    targetAudioCodec: AudioCodec.Aac,
    acceptedAudioCodecs: [AudioCodec.Aac, AudioCodec.Mp3, AudioCodec.Opus],
    targetResolution: '720',
    targetVideoCodec: VideoCodec.H264,
    acceptedVideoCodecs: [VideoCodec.H264],
    acceptedContainers: [VideoContainer.Mov, VideoContainer.Ogg, VideoContainer.Webm],
    maxBitrate: '0',
    bframes: -1,
    refs: 0,
    gopSize: 0,
    temporalAQ: false,
    cqMode: CQMode.Auto,
    twoPass: false,
    preferredHwDevice: 'auto',
    transcode: TranscodePolicy.Required,
    accel: TranscodeHardwareAcceleration.Disabled,
    accelDecode: true,
    tonemap: ToneMapping.Hable,
    realtime: {
      enabled: false,
      videoCodecs: [VideoCodec.H264, VideoCodec.Hevc],
      resolutions: [HlsVideoResolution.p480, HlsVideoResolution.p720, HlsVideoResolution.p1080],
    },
  },
  integrityChecks: {
    untrackedFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
    },
    missingFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
    },
    checksumFiles: {
      enabled: true,
      cronExpression: '0 03 * * *',
      timeLimit: 60 * 60 * 1000,
      percentageLimit: 1,
    },
  },
  logging: {
    enabled: true,
    level: LogLevel.Log,
  },
  metadata: {
    faces: {
      import: false,
    },
  },
  machineLearning: {
    enabled: true,
    urls: ['http://immich-machine-learning:3003'],
    availabilityChecks: {
      enabled: true,
      interval: 30_000,
      timeout: 2000,
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
      acceleration: MachineLearningHardwareAcceleration.Auto,
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
        identityInjection: { enabled: true, maxNames: 5, minFaceConfidence: 0.7 },
        advanced: { enabled: false, rawPromptTemplate: '', placeholderValidation: 'strict' },
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
    runpod: {
      enabled: false,
      mode: 'disabled',
      apiKey: '',
      hfToken: '',
      imageName: 'ghcr.io/frameleaf/frameleaf-machine-learning:release-cuda-runpod',
      dataPrivacyAcknowledged: false,
      defaultGpuTypeId: 'NVIDIA RTX A5000',
      containerDiskGb: 50,
      volumeGb: 20,
      autoStopEnabled: true,
      autoStopGraceMinutes: 15,
      autoBackfillOnLaunch: false,
      maxRuntimeHours: 24,
      provisionTimeoutMinutes: 5,
      serverless: {
        gpuTypeIds: ['AMPERE_48', 'ADA_48_PRO', 'AMPERE_80'],
        workersMin: 0,
        workersMax: 3,
        idleTimeoutSeconds: 30,
        executionTimeoutMs: 600_000,
        scalerType: 'REQUEST_COUNT',
        scalerValue: 4,
      },
    },
  },
  map: {
    enabled: true,
    lightStyle: 'https://tiles.immich.cloud/v1/style/light.json',
    darkStyle: 'https://tiles.immich.cloud/v1/style/dark.json',
  },
  nightlyTasks: {
    startTime: '00:00',
    databaseCleanup: true,
    clusterNewFaces: true,
    missingThumbnails: true,
    generateMemories: true,
    syncQuotaUsage: true,
  },
  reverseGeocoding: {
    enabled: true,
  },
  oauth: {
    accountManagementUrl: '',
    autoLaunch: true,
    autoRegister: true,
    buttonText: 'Login with OAuth',
    clientId: '',
    clientSecret: '',
    defaultStorageQuota: null,
    enabled: false,
    issuerUrl: '',
    endSessionEndpoint: '',
    mobileOverrideEnabled: false,
    mobileRedirectUri: '',
    prompt: '',
    scope: 'openid email profile',
    signingAlgorithm: 'RS256',
    profileSigningAlgorithm: 'none',
    tokenEndpointAuthMethod: OAuthTokenEndpointAuthMethod.ClientSecretPost,
    timeout: 30_000,
    allowInsecureRequests: false,
    storageLabelClaim: 'preferred_username',
    storageQuotaClaim: 'immich_quota',
    roleClaim: 'immich_role',
  },
  passwordLogin: {
    enabled: true,
  },
  server: {
    name: '',
    externalDomain: '',
    loginPageMessage: '',
    publicUsers: true,
  },
  storageTemplate: {
    enabled: false,
    hashVerificationEnabled: true,
    template: '{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}',
  },
  image: {
    thumbnail: {
      size: 250,
      format: ImageFormat.Webp,
      quality: 80,
      progressive: false,
    },
    preview: {
      size: 1440,
      format: ImageFormat.Jpeg,
      quality: 80,
      progressive: false,
    },
    fullsize: { enabled: false, format: ImageFormat.Jpeg, quality: 80, progressive: false },
    colorspace: Colorspace.P3,
    extractEmbedded: false,
    enhancedRaw: {
      enabled: true,
    },
  },
  newVersionCheck: {
    enabled: false,
    channel: ReleaseChannel.Stable,
  },
  trash: {
    enabled: true,
    days: 10,
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
  user: {
    deleteDelay: 15,
  },
  notifications: {
    smtp: {
      enabled: false,
      from: '',
      replyTo: '',
      transport: {
        host: '',
        port: 587,
        secure: false,
        username: '',
        password: '',
        ignoreCert: false,
      },
    },
  },
  templates: {
    email: {
      albumInviteTemplate: '',
      welcomeTemplate: '',
      albumUpdateTemplate: '',
    },
  },
  smartAlbums: {
    enabled: false,
    rules: { visualCategories: true, defaultAction: ClassificationRuleAction.Review },
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
});

describe(SystemConfigService.name, () => {
  let sut: SystemConfigService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(SystemConfigService));
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('getDefaults', () => {
    it('should return the default config', () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);

      expect(sut.getAdminConfigDefaults()).toEqual(mapConfig(defaults));
      expect(mocks.systemMetadata.get).not.toHaveBeenCalled();
    });
  });

  describe('getConfig', () => {
    it('should return the default config', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.getAdminConfig()).resolves.toEqual(mapConfig(defaults));
    });

    it('hard-disables version checks from legacy database configuration', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ newVersionCheck: { enabled: true } });
      const config = await sut.getAdminConfig();
      expect(config.newVersionCheck.enabled).toBe(false);
    });

    it('hard-disables version checks from file configuration', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({ newVersionCheck: { enabled: true } }));
      const config = await sut.getAdminConfig();
      expect(config.newVersionCheck.enabled).toBe(false);
    });

    it('should merge the overrides', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { crf: 30 },
        oauth: { autoLaunch: true },
        trash: { days: 10 },
        user: { deleteDelay: 15 },
      });

      await expect(sut.getAdminConfig()).resolves.toEqual(mapConfig(updatedConfig));
    });

    it('should load the config from a json file', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify(partialConfig));

      await expect(sut.getAdminConfig()).resolves.toEqual(mapConfig(updatedConfig));

      expect(mocks.systemMetadata.readFile).toHaveBeenCalledWith('immich-config.json');
    });

    it('should transform booleans', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({ ffmpeg: { twoPass: 'false' } }));

      await expect(sut.getAdminConfig()).resolves.toMatchObject({
        ffmpeg: expect.objectContaining({ twoPass: false }),
      });
    });

    it('should transform numbers', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({ ffmpeg: { threads: '42' } }));

      await expect(sut.getAdminConfig()).resolves.toMatchObject({
        ffmpeg: expect.objectContaining({ threads: 42 }),
      });
    });

    it('should accept valid cron expressions', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(
        JSON.stringify({ library: { scan: { cronExpression: '0 0 */3 * *' } } }),
      );

      await expect(sut.getAdminConfig()).resolves.toMatchObject({
        library: {
          scan: {
            enabled: true,
            cronExpression: '0 0 */3 * *',
          },
        },
      });
    });

    it('should reject an invalid issuer URL', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({ oauth: { issuerUrl: 'accounts.google.com' } }));

      await expect(sut.getAdminConfig()).rejects.toThrow(
        '[oauth.issuerUrl] Issuer URL must be an empty string or a valid URL',
      );
    });

    it('should reject invalid cron expressions', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({ library: { scan: { cronExpression: 'foo' } } }));

      await expect(sut.getAdminConfig()).rejects.toThrow('[library.scan.cronExpression] Invalid cron expression');
    });

    it('should log errors with the config file', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));

      mocks.systemMetadata.readFile.mockResolvedValue(`{ "ffmpeg2": true, "ffmpeg2": true }`);

      await expect(sut.getAdminConfig()).rejects.toBeInstanceOf(Error);

      expect(mocks.systemMetadata.readFile).toHaveBeenCalledWith('immich-config.json');
      expect(mocks.logger.error).toHaveBeenCalledTimes(2);
      expect(mocks.logger.error.mock.calls[0][0]).toEqual('Unable to load configuration file: immich-config.json');
      expect(mocks.logger.error.mock.calls[1][0].toString()).toEqual(
        expect.stringContaining('YAMLException: duplicated mapping key (1:21)'),
      );
    });

    it('should load the config from a yaml file', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.yaml' }));
      const partialConfig = `
        ffmpeg:
          crf: 30
        oauth:
          autoLaunch: true
        trash:
          days: 10
        user:
          deleteDelay: 15
      `;
      mocks.systemMetadata.readFile.mockResolvedValue(partialConfig);

      await expect(sut.getAdminConfig()).resolves.toEqual(mapConfig(updatedConfig));

      expect(mocks.systemMetadata.readFile).toHaveBeenCalledWith('immich-config.yaml');
    });

    it('should accept an empty configuration file', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({}));

      await expect(sut.getAdminConfig()).resolves.toEqual(mapConfig(defaults));

      expect(mocks.systemMetadata.readFile).toHaveBeenCalledWith('immich-config.json');
    });

    it('should allow underscores in the machine learning url', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      const partialConfig = { machineLearning: { urls: ['immich_machine_learning'] } };
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify(partialConfig));

      const config = await sut.getAdminConfig();
      expect(config.machineLearning.urls).toEqual(['immich_machine_learning']);
    });

    const externalDomainTests = [
      { should: 'with a trailing slash', externalDomain: 'https://demo.immich.app/' },
      { should: 'without a trailing slash', externalDomain: 'https://demo.immich.app' },
      { should: 'with a port', externalDomain: 'https://demo.immich.app:42', result: 'https://demo.immich.app:42' },
      {
        should: 'with basic auth',
        externalDomain: 'https://user:password@example.com:123',
        result: 'https://user:password@example.com:123',
      },
    ];

    for (const { should, externalDomain, result } of externalDomainTests) {
      it(`should normalize an external domain ${should}`, async () => {
        mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
        const partialConfig = { server: { externalDomain } };
        mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify(partialConfig));

        const config = await sut.getAdminConfig();
        expect(config.server.externalDomain).toEqual(result ?? 'https://demo.immich.app');
      });
    }

    it('should warn for unknown options in yaml', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.yaml' }));
      const partialConfig = `
        unknownOption: true
      `;
      mocks.systemMetadata.readFile.mockResolvedValue(partialConfig);

      await sut.getAdminConfig();
      expect(mocks.logger.warn).toHaveBeenCalled();
    });

    const tests = [
      {
        should: 'validate numbers',
        config: { ffmpeg: { crf: 'not-a-number' } },
        throws: '[ffmpeg.crf] Invalid input: expected number, received NaN',
      },
      {
        should: 'validate booleans',
        config: { oauth: { enabled: 'invalid' } },
        throws: '[oauth.enabled] Invalid input: expected boolean, received string',
      },
      {
        should: 'validate enums',
        config: { ffmpeg: { transcode: 'unknown' } },
        throws: '[ffmpeg.transcode] Invalid option: expected one of',
      },
      {
        should: 'validate required oauth fields',
        config: { oauth: { enabled: true } },
        check: (c: SystemConfig) => expect(c.oauth.enabled).toBe(true),
      },
      { should: 'warn for top level unknown options', warn: true, config: { unknownOption: true } },
      { should: 'warn for nested unknown options', warn: true, config: { ffmpeg: { unknownOption: true } } },
    ];

    for (const test of tests) {
      it(`should ${test.should}`, async () => {
        mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
        mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify(test.config));

        if (test.throws) {
          await expect(sut.getAdminConfig()).rejects.toThrow(test.throws);
        } else if (test.warn) {
          await sut.getAdminConfig();
          expect(mocks.logger.warn).toHaveBeenCalled();
        } else {
          const config = await sut.getAdminConfig();
          test.check!(config);
        }
      });
    }
  });

  describe('updateConfig', () => {
    it('should reject physical deduplication without a master user', async () => {
      await expect(
        sut.onConfigValidate({
          newConfig: { ...defaults, physicalDeduplication: { enabled: true, masterUserId: null } },
          oldConfig: defaults,
        }),
      ).rejects.toThrow('Physical deduplication requires a master user.');
    });

    it('should reject physical deduplication with a missing master user', async () => {
      mocks.user.get.mockResolvedValue(null as never);

      await expect(
        sut.onConfigValidate({
          newConfig: { ...defaults, physicalDeduplication: { enabled: true, masterUserId: 'missing-user-id' } },
          oldConfig: defaults,
        }),
      ).rejects.toThrow('Physical deduplication master user must exist and be active.');
    });

    it('should allow physical deduplication with an active master user', async () => {
      mocks.user.get.mockResolvedValue({ id: 'master-user-id', deletedAt: null } as never);

      await expect(
        sut.onConfigValidate({
          newConfig: { ...defaults, physicalDeduplication: { enabled: true, masterUserId: 'master-user-id' } },
          oldConfig: defaults,
        }),
      ).resolves.toBeUndefined();
    });

    it('should reject runpod api key changes while pod is provisioning', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ status: 'provisioning' } as never);
      await expect(
        sut.onConfigValidate({
          oldConfig: defaults,
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, apiKey: 'new-key' },
            },
          },
        }),
      ).rejects.toThrow(
        /Cannot change RunPod API key, image, or mode while a transition is in flight \(status=provisioning\)/,
      );
    });

    it('should reject runpod image changes while pod is stopping', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ status: 'stopping' } as never);
      await expect(
        sut.onConfigValidate({
          oldConfig: defaults,
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, imageName: 'ghcr.io/x/y:new-tag' },
            },
          },
        }),
      ).rejects.toThrow(
        /Cannot change RunPod API key, image, or mode while a transition is in flight \(status=stopping\)/,
      );
    });

    it('should allow runpod api key changes when no pod transition is in flight', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ status: 'running' } as never);
      await expect(
        sut.onConfigValidate({
          oldConfig: defaults,
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, apiKey: 'new-key' },
            },
          },
        }),
      ).resolves.toBeUndefined();
    });

    it('should allow runpod api key changes when there is no runpod state at all', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);
      await expect(
        sut.onConfigValidate({
          oldConfig: defaults,
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, apiKey: 'new-key' },
            },
          },
        }),
      ).resolves.toBeUndefined();
    });

    it('should reject mode changes while serverless setup is in flight', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ status: 'serverless-provisioning' } as never);
      await expect(
        sut.onConfigValidate({
          oldConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, mode: 'serverless' },
            },
          },
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, mode: 'disabled' },
            },
          },
        }),
      ).rejects.toThrow(
        /Cannot change RunPod API key, image, or mode while a transition is in flight \(status=serverless-provisioning\)/,
      );
    });

    it('should reject switching away from pod mode while a pod is running', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ status: 'running' } as never);
      await expect(
        sut.onConfigValidate({
          oldConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, mode: 'pod' },
            },
          },
          newConfig: {
            ...defaults,
            machineLearning: {
              ...defaults.machineLearning,
              runpod: { ...defaults.machineLearning.runpod, mode: 'serverless' },
            },
          },
        }),
      ).rejects.toThrow(/Terminate the running pod before switching modes/);
    });

    it('should update the config and emit an event', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);
      await expect(sut.updateAdminConfig(updatedConfig)).resolves.toEqual(mapConfig(updatedConfig));
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'ConfigUpdate',
        expect.objectContaining({ oldConfig: expect.any(Object), newConfig: updatedConfig }),
      );
    });

    it('should throw an error if a config file is in use', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({}));
      await expect(sut.updateAdminConfig(defaults)).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.systemMetadata.set).not.toHaveBeenCalled();
    });

    it('should redact runpod.apiKey on read via mapConfig', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { runpod: { apiKey: 'rp_secret_value', enabled: true } },
      });

      const result = await sut.getAdminConfig();

      expect(result.machineLearning.runpod.apiKey).toBe('');
    });

    it('should preserve stored runpod.apiKey when an empty value is written back', async () => {
      const storedConfig = {
        machineLearning: { runpod: { apiKey: 'rp_secret_value', enabled: true } },
      };
      mocks.systemMetadata.get.mockResolvedValue(storedConfig);

      // The admin reads the config (apiKey: ''), edits some other field, and saves.
      // The empty apiKey in the submitted DTO must not wipe the stored secret.
      const newConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          runpod: { ...defaults.machineLearning.runpod, apiKey: '', enabled: true },
        },
      };

      await sut.updateAdminConfig(newConfig);

      // updateConfig is called with the dto we mutated in-place; verify the
      // preserved-key value is what gets persisted.
      const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1);
      expect(persisted).toBeDefined();
      // The persisted partial config should include the preserved key.
      const partial = persisted![0] as { machineLearning?: { runpod?: { apiKey?: string } } };
      expect(partial.machineLearning?.runpod?.apiKey).toBe('rp_secret_value');
    });

    describe('imageDescription lastConfigChangeAt bump', () => {
      const baselineDescription = defaults.machineLearning.imageDescription;

      it('should bump lastConfigChangeAt when an imageDescription field changes', async () => {
        // Old config has the baseline.
        mocks.systemMetadata.get.mockResolvedValue({});

        const newConfig: SystemConfig = {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            imageDescription: {
              ...baselineDescription,
              modelName: 'some-new-model',
            },
          },
        };

        const before = Date.now();
        await sut.updateAdminConfig(newConfig);
        const after = Date.now();

        const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1);
        expect(persisted).toBeDefined();
        const partial = persisted![0] as {
          machineLearning?: { imageDescription?: { lastConfigChangeAt?: string | null } };
        };
        const bumped = partial.machineLearning?.imageDescription?.lastConfigChangeAt;
        expect(bumped).toBeTypeOf('string');
        const bumpedTime = Date.parse(bumped!);
        expect(bumpedTime).toBeGreaterThanOrEqual(before);
        expect(bumpedTime).toBeLessThanOrEqual(after);
      });

      it('should NOT bump lastConfigChangeAt when only non-imageDescription fields change', async () => {
        const initialLastChange = '2024-01-01T00:00:00.000Z';
        mocks.systemMetadata.get.mockResolvedValue({
          machineLearning: {
            imageDescription: { lastConfigChangeAt: initialLastChange },
          },
        });

        // Change only an FFmpeg setting.
        const newConfig: SystemConfig = {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            imageDescription: {
              ...baselineDescription,
              // Client sends an empty/null pendingRequeueAt; server must
              // overwrite with the stored value (null in defaults).
              lastConfigChangeAt: initialLastChange,
            },
          },
          ffmpeg: { ...defaults.ffmpeg, crf: 42 },
        };

        const before = Date.now();
        await sut.updateAdminConfig(newConfig);

        // The persisted partial config should NOT include a new
        // imageDescription.lastConfigChangeAt different from the stored one
        // (updateConfig diffs against defaults, so the existing 2024 value
        // would be persisted only if it differs from null — which it does).
        const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1);
        const partial = persisted![0] as {
          machineLearning?: { imageDescription?: { lastConfigChangeAt?: string | null } };
        };
        const lastChange = partial.machineLearning?.imageDescription?.lastConfigChangeAt;
        // The stored value must NOT have moved forward in time. The persisted
        // partial must either omit the field (filtered out by updateConfig's
        // diff because it equals the default) or carry the exact original
        // ISO string — never a fresh "now" timestamp.
        if (lastChange === undefined || lastChange === null) {
          // Field was filtered out — no fresh bump persisted. Pass.
        } else {
          expect(lastChange).toBe(initialLastChange);
          expect(Date.parse(lastChange)).toBeLessThan(before);
        }
      });

      it('should NOT ratchet on bare timestamp-only diffs (pendingRequeueAt/lastConfigChangeAt are ignored in the compare)', async () => {
        // Old config has timestamps set; client sends back the exact same
        // imageDescription block but with different timestamp values.
        const initialLastChange = '2023-12-31T00:00:00.000Z';
        const initialPendingRequeue = '2024-01-01T00:00:00.000Z';
        mocks.systemMetadata.get.mockResolvedValue({
          machineLearning: {
            imageDescription: {
              pendingRequeueAt: initialPendingRequeue,
              lastConfigChangeAt: initialLastChange,
            },
          },
        });

        // Client tries to send different timestamps — the service must ignore
        // them on input AND must not bump again because the rest of the block
        // is unchanged.
        const newConfig: SystemConfig = {
          ...defaults,
          machineLearning: {
            ...defaults.machineLearning,
            imageDescription: {
              ...baselineDescription,
              pendingRequeueAt: null,
              lastConfigChangeAt: null,
            },
          },
        };

        const before = Date.now();
        await sut.updateAdminConfig(newConfig);

        const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1);
        const partial = persisted![0] as {
          machineLearning?: {
            imageDescription?: { lastConfigChangeAt?: string | null; pendingRequeueAt?: string | null };
          };
        };
        // The pre-existing stored timestamps must be preserved (server is the
        // source of truth for these two fields). The persisted partial must
        // either omit the field (filtered out by updateConfig diff) or carry
        // the exact original ISO string — never a fresh "now" timestamp.
        const persistedLastChange = partial.machineLearning?.imageDescription?.lastConfigChangeAt;
        if (persistedLastChange === undefined || persistedLastChange === null) {
          // Filtered out — no fresh bump persisted. Pass.
        } else {
          expect(persistedLastChange).toBe(initialLastChange);
          expect(Date.parse(persistedLastChange)).toBeLessThan(before);
        }
        const persistedPendingRequeue = partial.machineLearning?.imageDescription?.pendingRequeueAt;
        if (persistedPendingRequeue === undefined || persistedPendingRequeue === null) {
          // Filtered out — no fresh ratchet persisted. Pass.
        } else {
          expect(persistedPendingRequeue).toBe(initialPendingRequeue);
          expect(Date.parse(persistedPendingRequeue)).toBeLessThan(before);
        }
      });
    });

    it('should accept a non-empty new runpod.apiKey on write (rotation)', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { runpod: { apiKey: 'rp_old_value', enabled: true } },
      });

      const newConfig = {
        ...defaults,
        machineLearning: {
          ...defaults.machineLearning,
          runpod: { ...defaults.machineLearning.runpod, apiKey: 'rp_NEW_value', enabled: true },
        },
      };

      await sut.updateAdminConfig(newConfig);

      const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1);
      const partial = persisted![0] as { machineLearning?: { runpod?: { apiKey?: string } } };
      expect(partial.machineLearning?.runpod?.apiKey).toBe('rp_NEW_value');
    });
  });

  describe('write-only credentials (FL-67)', () => {
    type PersistedSecrets = {
      notifications?: { smtp?: { transport?: { password?: string } } };
      oauth?: { clientSecret?: string };
      machineLearning?: { runpod?: { apiKey?: string } };
    };
    const lastPersisted = () => mocks.forkSchema.persistConfig.mock.calls.at(-1)?.[0] as PersistedSecrets | undefined;
    const storedSecrets = {
      notifications: { smtp: { transport: { password: 'smtp-secret' } } },
      oauth: { clientSecret: 'oauth-secret' },
    };

    it('should never return the SMTP password or the OAuth client secret, only that they are stored', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);

      const config = await sut.getAdminConfig();

      expect(config.notifications.smtp.transport).toMatchObject({ password: '', passwordConfigured: true });
      expect(config.oauth).toMatchObject({ clientSecret: '', clientSecretConfigured: true });
      expect(JSON.stringify(config)).not.toContain('smtp-secret');
      expect(JSON.stringify(config)).not.toContain('oauth-secret');
    });

    it('should report secrets that are not stored as not configured', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      const config = await sut.getAdminConfig();

      expect(config.notifications.smtp.transport.passwordConfigured).toBe(false);
      expect(config.oauth.clientSecretConfigured).toBe(false);
    });

    it('should keep the stored SMTP password and OAuth secret when a redacted configuration is saved back', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);
      const redacted = await sut.getAdminConfig();

      await sut.updateAdminConfig({ ...redacted, trash: { ...redacted.trash, days: 12 } });

      expect(lastPersisted()?.notifications?.smtp?.transport?.password).toBe('smtp-secret');
      expect(lastPersisted()?.oauth?.clientSecret).toBe('oauth-secret');
    });

    it('should never send the stored SMTP password or OAuth secret to a new server', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);
      const redacted = await sut.getAdminConfig();

      await sut.updateAdminConfig({
        ...redacted,
        notifications: {
          smtp: {
            ...redacted.notifications.smtp,
            transport: { ...redacted.notifications.smtp.transport, host: 'mail.elsewhere.example' },
          },
        },
        oauth: { ...redacted.oauth, issuerUrl: 'https://id.elsewhere.example' },
      });

      expect(lastPersisted()?.notifications?.smtp?.transport?.password).toBeUndefined();
      expect(lastPersisted()?.oauth?.clientSecret).toBeUndefined();
      // the configuration validated against the new servers (SMTP is verified there) carries no secret
      const [, validate] = mocks.event.emit.mock.calls.find(([name]) => name === 'ConfigValidate')!;
      const { newConfig } = validate as { newConfig: SystemConfig };
      expect(newConfig.notifications.smtp.transport.password).toBe('');
      expect(newConfig.oauth.clientSecret).toBe('');
    });

    it('should not treat the read-only configured flags as a change or store them', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);
      const redacted = await sut.getAdminConfig();

      await sut.updateAdminConfig({ ...redacted, trash: { ...redacted.trash, days: 12 } });

      const [, validate] = mocks.event.emit.mock.calls.find(([name]) => name === 'ConfigValidate')!;
      const { newConfig, oldConfig } = validate as { newConfig: SystemConfig; oldConfig: SystemConfig };
      expect(newConfig.notifications.smtp).toEqual(oldConfig.notifications.smtp);
      expect(newConfig.oauth).toEqual(oldConfig.oauth);
      expect(JSON.stringify(lastPersisted())).not.toContain('Configured');
    });

    it('should list whether each credential is stored without returning a value', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);

      await expect(sut.getCredentials()).resolves.toEqual([
        { name: ConfigCredential.SmtpPassword, configured: true },
        { name: ConfigCredential.OAuthClientSecret, configured: true },
        { name: ConfigCredential.RunPodApiKey, configured: false },
        { name: ConfigCredential.HuggingFaceToken, configured: false },
      ]);
    });

    it('should replace one credential through the validation and update events', async () => {
      // read to validate, read again under the settings lock, read back after the write
      mocks.systemMetadata.get
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ oauth: { clientSecret: 'replacement' } });

      await expect(
        sut.setCredential(authStub.admin, ConfigCredential.OAuthClientSecret, { value: 'replacement' }),
      ).resolves.toEqual({ name: ConfigCredential.OAuthClientSecret, configured: true });

      expect(lastPersisted()?.oauth?.clientSecret).toBe('replacement');
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigValidate', expect.any(Object));
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigUpdate', expect.any(Object));
    });

    it('should clear one credential and report it as no longer stored', async () => {
      mocks.systemMetadata.get
        .mockResolvedValueOnce(storedSecrets)
        .mockResolvedValueOnce(storedSecrets)
        .mockResolvedValueOnce({ oauth: { clientSecret: 'oauth-secret' } });

      await expect(sut.clearCredential(authStub.admin, ConfigCredential.SmtpPassword)).resolves.toEqual({
        name: ConfigCredential.SmtpPassword,
        configured: false,
      });

      expect(lastPersisted()?.notifications?.smtp?.transport?.password).toBeUndefined();
      expect(lastPersisted()?.oauth?.clientSecret).toBe('oauth-secret');
    });

    it('should not write anything when the credential already has that value', async () => {
      mocks.systemMetadata.get.mockResolvedValue({});

      await expect(sut.clearCredential(authStub.admin, ConfigCredential.HuggingFaceToken)).resolves.toEqual({
        name: ConfigCredential.HuggingFaceToken,
        configured: false,
      });
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
    });

    it('should refuse to clear the RunPod key while RunPod is on', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { runpod: { apiKey: 'rp_secret_value', enabled: true, mode: 'pod' } },
      });

      await expect(sut.clearCredential(authStub.admin, ConfigCredential.RunPodApiKey)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
    });

    it('should refuse a credential the validation rejects and keep the stored one', async () => {
      mocks.systemMetadata.get.mockResolvedValue(storedSecrets);
      mocks.event.emit.mockRejectedValueOnce(new Error('Failed to validate SMTP configuration'));

      await expect(
        sut.setCredential(authStub.admin, ConfigCredential.SmtpPassword, { value: 'wrong' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
    });

    it('should refuse credential changes while a configuration file is in use', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));

      await expect(
        sut.setCredential(authStub.admin, ConfigCredential.SmtpPassword, { value: 'secret' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.clearCredential(authStub.admin, ConfigCredential.SmtpPassword)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('should never write a credential value to the log', async () => {
      mocks.systemMetadata.get.mockResolvedValueOnce({}).mockResolvedValueOnce({});

      await sut.setCredential(authStub.admin, ConfigCredential.SmtpPassword, { value: 'do-not-log-me' });

      for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
        for (const call of mocks.logger[method].mock.calls) {
          expect(JSON.stringify(call)).not.toContain('do-not-log-me');
        }
      }
    });
  });

  describe('settings revision (FL-66)', () => {
    it('should return the saved config with the revision of the saved settings', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);

      const current = await sut.getAdminConfigWithRevision();

      expect(current.config.trash.days).toBe(10);
      expect(current.revision).toBe(getConfigRevision(await sut.getConfig({ withCache: false })));
    });

    it('should report a different revision once a saved setting changes', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);
      const before = await sut.getAdminConfigWithRevision();

      mocks.systemMetadata.get.mockResolvedValue({ ...partialConfig, trash: { days: 11 } });
      const after = await sut.getAdminConfigWithRevision();

      expect(after.revision).not.toBe(before.revision);
    });

    it('should save a draft made against the current revision and return the new revision', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);
      const { revision } = await sut.getAdminConfigWithRevision();

      const saved = await sut.updateAdminConfigWithRevision({ config: updatedConfig, expectedRevision: revision });

      expect(saved.revision).toBe(getConfigRevision(await sut.getConfig({ withCache: false })));
      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.SystemConfigUpdate, expect.any(Function));
      expect(mocks.forkSchema.persistConfig).toHaveBeenCalled();
      expect(mocks.event.emit).toHaveBeenCalledWith(
        'ConfigUpdate',
        expect.objectContaining({ newConfig: expect.any(Object) }),
      );
    });

    it('should refuse a draft made against settings that changed since, and change nothing', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);
      const { revision } = await sut.getAdminConfigWithRevision();

      // Another administrator saves in between.
      mocks.systemMetadata.get.mockResolvedValue({ ...partialConfig, trash: { days: 30 } });

      await expect(
        sut.updateAdminConfigWithRevision({ config: updatedConfig, expectedRevision: revision }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('ConfigUpdate', expect.anything());
    });

    it('should check the revision before validating, so a stale draft never reaches the validators', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);

      await expect(
        sut.updateAdminConfigWithRevision({ config: updatedConfig, expectedRevision: 'stale' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.event.emit).not.toHaveBeenCalledWith('ConfigValidate', expect.anything());
    });

    it('should refuse a draft when another save lands between validation and the write', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);
      const { revision } = await sut.getAdminConfigWithRevision();

      // Validation still sees the loaded settings; under the lock the settings have moved on.
      mocks.systemMetadata.get
        .mockResolvedValueOnce(partialConfig)
        .mockResolvedValue({ ...partialConfig, trash: { days: 30 } });

      await expect(
        sut.updateAdminConfigWithRevision({ config: updatedConfig, expectedRevision: revision }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.event.emit).toHaveBeenCalledWith('ConfigValidate', expect.anything());
      expect(mocks.forkSchema.persistConfig).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('ConfigUpdate', expect.anything());
    });

    it('should prepare and validate a save without a revision again when the settings moved on', async () => {
      mocks.systemMetadata.get
        .mockResolvedValueOnce(partialConfig)
        .mockResolvedValue({ ...partialConfig, trash: { days: 30 } });

      await sut.updateAdminConfig(updatedConfig);

      const validations = mocks.event.emit.mock.calls.filter(([name]) => name === 'ConfigValidate');
      expect(validations).toHaveLength(2);
      expect(mocks.forkSchema.persistConfig).toHaveBeenCalledTimes(1);
    });

    it('should keep the re-queue reminder saved in between rather than the one seen at validation', async () => {
      mocks.systemMetadata.get.mockResolvedValueOnce(partialConfig).mockResolvedValue({
        ...partialConfig,
        machineLearning: { imageDescription: { pendingRequeueAt: '2026-09-23T10:00:00.000Z' } },
      });

      await sut.updateAdminConfig(cloneDeep(updatedConfig));

      const persisted = mocks.forkSchema.persistConfig.mock.calls.at(-1)![1] as SystemConfig;
      expect(persisted.machineLearning.imageDescription.pendingRequeueAt).toBe('2026-09-23T10:00:00.000Z');
    });

    it('should serialize saves without a revision through the same lock', async () => {
      mocks.systemMetadata.get.mockResolvedValue(partialConfig);

      await sut.updateAdminConfig(updatedConfig);

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.SystemConfigUpdate, expect.any(Function));
    });

    it('should write the re-queue reminder under the settings lock from the saved settings', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        ...partialConfig,
        machineLearning: { imageDescription: { enabled: true } },
      });

      await sut.deferDescriptionRequeue();

      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.SystemConfigUpdate, expect.any(Function));
    });

    it('should refuse a revisioned save while a config file is in use', async () => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ configFile: 'immich-config.json' }));
      mocks.systemMetadata.readFile.mockResolvedValue(JSON.stringify({}));

      await expect(
        sut.updateAdminConfigWithRevision({ config: defaults, expectedRevision: 'any' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.database.withLock).not.toHaveBeenCalled();
    });
  });

  describe('concurrent saves and write-only credentials (FL-66)', () => {
    /**
     * A settings store the service really reads and writes, and a settings lock that really
     * serializes: what one save writes is what the next read under the lock sees.
     */
    const useStatefulStore = (initial: DeepPartial<SystemConfig>) => {
      let stored = cloneDeep(initial);
      let queue: Promise<unknown> = Promise.resolve();
      mocks.systemMetadata.get.mockImplementation(() => Promise.resolve(cloneDeep(stored)));
      mocks.forkSchema.persistConfig.mockImplementation((partial: DeepPartial<SystemConfig>) => {
        stored = cloneDeep(partial);
        return Promise.resolve();
      });
      mocks.database.withLock.mockImplementation((_lock, fn) => {
        const run = queue.then(() => fn());
        queue = run.catch(() => {});
        return run;
      });
      return { stored: () => stored };
    };

    /** Holds the first validation of the draft save until `release()`, like a slow SMTP check. */
    const holdFirstValidation = () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      let reached!: () => void;
      const waiting = new Promise<void>((resolve) => (reached = resolve));
      let held = false;
      mocks.event.emit.mockImplementation(async (...[name]) => {
        if (name !== 'ConfigValidate' || held) {
          return;
        }
        held = true;
        reached();
        await gate;
      });
      return { release, waiting };
    };

    const savedSecrets = {
      notifications: { smtp: { transport: { host: 'mail.example', username: 'frameleaf', password: 'smtp-old' } } },
      oauth: { issuerUrl: 'https://id.example', clientSecret: 'oauth-old' },
      machineLearning: { runpod: { apiKey: 'rp_old', hfToken: 'hf_old' } },
    };

    it.each([
      [ConfigCredential.RunPodApiKey, 'machineLearning.runpod.apiKey', 'rp_new'],
      [ConfigCredential.HuggingFaceToken, 'machineLearning.runpod.hfToken', 'hf_new'],
      [ConfigCredential.SmtpPassword, 'notifications.smtp.transport.password', 'smtp-new'],
      [ConfigCredential.OAuthClientSecret, 'oauth.clientSecret', 'oauth-new'],
    ])('should keep a %s replaced while a draft save was validating', async (name, path, replacement) => {
      const store = useStatefulStore(savedSecrets);
      const { config, revision } = await sut.getAdminConfigWithRevision();
      const hold = holdFirstValidation();

      // Administrator A saves a draft that changes the trash setting and sends every
      // credential back empty ("keep the stored one").
      const draftSave = sut.updateAdminConfigWithRevision(
        { config: { ...config, trash: { ...config.trash, days: 12 } }, expectedRevision: revision },
        authStub.admin,
      );
      await hold.waiting;

      // Administrator B replaces the credential meanwhile. It stays configured, so the settings
      // revision (which never digests a secret) does not change and A's draft is not stale.
      await sut.setCredential(authStub.admin, name, { value: replacement });
      expect(get(store.stored(), path)).toBe(replacement);

      hold.release();
      await draftSave;

      expect(store.stored().trash?.days).toBe(12);
      expect(get(store.stored(), path)).toBe(replacement);
    });

    it('should keep a credential replaced while a save without a revision was validating', async () => {
      const store = useStatefulStore(savedSecrets);
      const config = await sut.getAdminConfig();
      const hold = holdFirstValidation();

      const save = sut.updateAdminConfig({ ...config, trash: { ...config.trash, days: 12 } }, authStub.admin);
      await hold.waiting;
      await sut.setCredential(authStub.admin, ConfigCredential.RunPodApiKey, { value: 'rp_new' });
      hold.release();
      await save;

      expect(store.stored().trash?.days).toBe(12);
      expect(store.stored().machineLearning?.runpod?.apiKey).toBe('rp_new');
    });

    it('should refuse a draft save when a credential was cleared while it was validating', async () => {
      const store = useStatefulStore(savedSecrets);
      const { config, revision } = await sut.getAdminConfigWithRevision();
      const hold = holdFirstValidation();

      const draftSave = sut.updateAdminConfigWithRevision(
        { config: { ...config, trash: { ...config.trash, days: 12 } }, expectedRevision: revision },
        authStub.admin,
      );
      await hold.waiting;
      await sut.clearCredential(authStub.admin, ConfigCredential.HuggingFaceToken);
      hold.release();

      // Clearing changes whether the token is set, which is part of the revision: the draft
      // is refused and nothing it carried brings the token back.
      await expect(draftSave).rejects.toBeInstanceOf(ConflictException);
      expect(store.stored().machineLearning?.runpod?.hfToken).toBeUndefined();
      expect(store.stored().machineLearning?.runpod?.apiKey).toBe('rp_old');
    });

    it('should not undo a draft save that landed while a credential change was validating', async () => {
      const store = useStatefulStore(savedSecrets);
      const hold = holdFirstValidation();

      const credentialSave = sut.setCredential(authStub.admin, ConfigCredential.RunPodApiKey, { value: 'rp_new' });
      await hold.waiting;

      // Meanwhile another administrator saves settings.
      const { config, revision } = await sut.getAdminConfigWithRevision();
      await sut.updateAdminConfigWithRevision(
        { config: { ...config, trash: { ...config.trash, days: 12 } }, expectedRevision: revision },
        authStub.admin,
      );

      hold.release();
      await credentialSave;

      expect(store.stored().trash?.days).toBe(12);
      expect(store.stored().machineLearning?.runpod?.apiKey).toBe('rp_new');
      expect(mocks.database.withLock).toHaveBeenCalledWith(DatabaseLock.SystemConfigUpdate, expect.any(Function));
    });
  });

  describe('settings change history (FL-66)', () => {
    /** Saved settings and history the service really reads back after writing them. */
    const useStore = (initial: DeepPartial<SystemConfig>) => {
      let config = cloneDeep(initial);
      let history: unknown = null;
      mocks.systemMetadata.get.mockImplementation((key) =>
        Promise.resolve(cloneDeep(key === SystemMetadataKey.SystemConfigHistory ? history : config) as never),
      );
      mocks.systemMetadata.set.mockImplementation((key, value) => {
        if (key === SystemMetadataKey.SystemConfigHistory) {
          history = cloneDeep(value);
        }
        return Promise.resolve();
      });
      mocks.forkSchema.persistConfig.mockImplementation((partial: DeepPartial<SystemConfig>) => {
        config = cloneDeep(partial);
        return Promise.resolve();
      });
      return { history: () => history };
    };

    it('should record a saved change with the administrator and the values before and after', async () => {
      const store = useStore(partialConfig);
      const { config, revision } = await sut.getAdminConfigWithRevision();

      await sut.updateAdminConfigWithRevision(
        { config: { ...config, trash: { ...config.trash, days: 12 } }, expectedRevision: revision },
        authStub.admin,
      );

      expect(store.history()).toEqual({
        entries: [
          expect.objectContaining({
            actorId: authStub.admin.user.id,
            actorName: authStub.admin.user.name,
            kind: 'settings',
            changes: [{ path: 'trash.days', before: '10', after: '12' }],
            omittedChanges: 0,
          }),
        ],
      });
      await expect(sut.getConfigHistory()).resolves.toEqual(store.history());
    });

    it('should record a credential change without its value', async () => {
      const store = useStore({});

      await sut.setCredential(authStub.admin, ConfigCredential.OAuthClientSecret, { value: 'do-not-record-me' });

      expect(store.history()).toEqual({
        entries: [
          expect.objectContaining({
            // FL-71 (CC-10): the credential's own entry (CommandCenter.jsx:1447).
            kind: 'credential',
            title: 'Updated OAuth client secret',
            changes: [{ path: 'oauth.clientSecret', before: null, after: null, credential: 'replaced' }],
          }),
        ],
      });
      expect(JSON.stringify(store.history())).not.toContain('do-not-record-me');
    });

    it('should title a cleared credential (FL-71 CC-10)', async () => {
      const store = useStore({ machineLearning: { runpod: { hfToken: 'hf_old' } } } as never);

      await sut.clearCredential(authStub.admin, ConfigCredential.HuggingFaceToken);

      expect(store.history()).toEqual({
        entries: [expect.objectContaining({ kind: 'credential', title: 'Cleared Hugging Face token' })],
      });
      expect(JSON.stringify(store.history())).not.toContain('hf_old');
    });

    it('should not record a save that changed nothing', async () => {
      const store = useStore(partialConfig);
      const { config, revision } = await sut.getAdminConfigWithRevision();

      await sut.updateAdminConfigWithRevision({ config, expectedRevision: revision }, authStub.admin);

      expect(store.history()).toBeNull();
    });

    it('should keep the save when the history cannot be written', async () => {
      useStore(partialConfig);
      mocks.systemMetadata.set.mockRejectedValue(new Error('disk full'));
      const { config, revision } = await sut.getAdminConfigWithRevision();

      await expect(
        sut.updateAdminConfigWithRevision(
          { config: { ...config, trash: { ...config.trash, days: 12 } }, expectedRevision: revision },
          authStub.admin,
        ),
      ).resolves.toEqual(expect.objectContaining({ revision: expect.any(String) }));
      expect(mocks.forkSchema.persistConfig).toHaveBeenCalled();
      expect(mocks.logger.error).toHaveBeenCalled();
    });

    it('should read an empty history when nothing was recorded', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null);

      await expect(sut.getConfigHistory()).resolves.toEqual({ entries: [] });
      expect(mocks.systemMetadata.get).toHaveBeenCalledWith(SystemMetadataKey.SystemConfigHistory);
    });
  });

  describe('getCustomCss', () => {
    it('should return the default theme', async () => {
      await expect(sut.getCustomCss()).resolves.toEqual(defaults.theme.customCss);
    });
  });

  describe('estimateDescriptionRequeue', () => {
    it('should fall back to the default rolling average when no telemetry is available', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          imageDescription: {
            enabled: true,
            modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
            acceleration: MachineLearningHardwareAcceleration.Auto,
          },
        },
      });
      mocks.asset.getDescriptionStats.mockResolvedValue({
        totalAssets: 100,
        withDescription: 40,
        withoutDescription: 60,
      });
      mocks.job.getRollingAvgMs.mockReturnValue(null);

      const result = await sut.estimateDescriptionRequeue();

      expect(result).toMatchObject({
        totalAssets: 100,
        withDescription: 40,
        withoutDescription: 60,
        rollingAvgSeconds: 1.5,
        estimatedTotalSeconds: 100 * 1.5,
        activeModel: 'Qwen/Qwen2.5-VL-3B-Instruct',
      });
      expect(typeof result.activeBackend).toBe('string');
    });

    it('should use the real rolling average when telemetry is available', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          imageDescription: {
            enabled: true,
            modelName: 'Qwen/Qwen2.5-VL-3B-Instruct',
            acceleration: MachineLearningHardwareAcceleration.Auto,
          },
        },
      });
      mocks.asset.getDescriptionStats.mockResolvedValue({
        totalAssets: 50,
        withDescription: 10,
        withoutDescription: 40,
      });
      // 2500 ms / job → 2.5 s
      mocks.job.getRollingAvgMs.mockReturnValue(2500);

      const result = await sut.estimateDescriptionRequeue();

      expect(result.rollingAvgSeconds).toBe(2.5);
      expect(result.estimatedTotalSeconds).toBe(50 * 2.5);
    });
  });

  describe('triggerDescriptionRequeue', () => {
    it('should enqueue the queue-all job and return queued=true when the queue is idle', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { imageDescription: { enabled: true } },
      });
      mocks.job.getJobCounts.mockResolvedValue({
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
        paused: 0,
      });

      await expect(sut.triggerDescriptionRequeue()).resolves.toEqual({ queued: true });

      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ImageDescriptionQueueAll',
          data: { force: true },
        }),
      );
    });

    it('should clear pendingRequeueAt when the requeue successfully enqueues', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: {
          imageDescription: { enabled: true, pendingRequeueAt: '2024-01-01T00:00:00.000Z' },
        },
      });
      mocks.job.getJobCounts.mockResolvedValue({
        active: 0,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 0,
        paused: 0,
      });

      await sut.triggerDescriptionRequeue();

      // The system-config write that clears pendingRequeueAt should be the
      // most-recent persist call.
      const persistCalls = mocks.forkSchema.persistConfig.mock.calls;
      expect(persistCalls.length).toBeGreaterThan(0);
      const latest = persistCalls.at(-1)![0] as {
        machineLearning?: { imageDescription?: { pendingRequeueAt?: string | null } };
      };
      // Confirm the cleared value made it into the persisted partial diff.
      expect(latest.machineLearning?.imageDescription?.pendingRequeueAt ?? null).toBeNull();
    });

    it('should return queued=false and not re-enqueue when the queue is already active', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { imageDescription: { enabled: true } },
      });
      mocks.job.getJobCounts.mockResolvedValue({
        active: 1,
        completed: 0,
        failed: 0,
        delayed: 0,
        waiting: 50,
        paused: 0,
      });

      await expect(sut.triggerDescriptionRequeue()).resolves.toEqual({ queued: false });

      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when image description is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { imageDescription: { enabled: false } },
      });

      await expect(sut.triggerDescriptionRequeue()).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when global machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { enabled: false, imageDescription: { enabled: true } },
      });

      await expect(sut.triggerDescriptionRequeue()).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('deferDescriptionRequeue', () => {
    it('should set pendingRequeueAt to an ISO timestamp', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { imageDescription: { enabled: true } },
      });

      const before = Date.now();
      await sut.deferDescriptionRequeue();
      const after = Date.now();

      const persistCalls = mocks.forkSchema.persistConfig.mock.calls;
      const latest = persistCalls.at(-1)![0] as {
        machineLearning?: { imageDescription?: { pendingRequeueAt?: string | null } };
      };
      const written = latest.machineLearning?.imageDescription?.pendingRequeueAt;
      expect(written).toBeTypeOf('string');
      const parsed = Date.parse(written!);
      expect(parsed).toBeGreaterThanOrEqual(before);
      expect(parsed).toBeLessThanOrEqual(after);
    });

    it('should throw BadRequestException when image description is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        machineLearning: { imageDescription: { enabled: false } },
      });

      await expect(sut.deferDescriptionRequeue()).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('estimateSmartAlbumReevaluate', () => {
    it('should return the count of assets with a completed description', async () => {
      mocks.asset.getDescriptionStats.mockResolvedValue({
        totalAssets: 200,
        withDescription: 80,
        withoutDescription: 120,
      });

      const result = await sut.estimateSmartAlbumReevaluate();

      expect(result).toEqual({ totalAssets: 80, withDescription: 80 });
    });
  });

  describe('triggerSmartAlbumReevaluate', () => {
    it('should enqueue the re-evaluate job and return queued=true when no dedup job is in flight', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: true },
      });
      mocks.job.hasDedupJob.mockResolvedValue(false);

      const result = await sut.triggerSmartAlbumReevaluate();

      expect(result).toEqual({ queued: true });
      expect(mocks.job.queue).toHaveBeenCalledWith(expect.objectContaining({ name: 'SmartAlbumReevaluateAll' }));
    });

    it('should return queued=false and not re-enqueue when a dedup job is already in flight', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: true },
      });
      mocks.job.hasDedupJob.mockResolvedValue(true);

      const result = await sut.triggerSmartAlbumReevaluate();

      expect(result).toEqual({ queued: false });
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should enqueue with kind-scoped dedup when a kind is provided', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ smartAlbums: { enabled: true } });
      mocks.job.hasDedupJob.mockResolvedValue(false);

      const result = await sut.triggerSmartAlbumReevaluate({ kind: 'food' });

      expect(result).toEqual({ queued: true });
      expect(mocks.job.hasDedupJob).toHaveBeenCalledWith(QueueName.BackgroundTask, 'SmartAlbumReevaluateAll:food');
      expect(mocks.job.queue).toHaveBeenCalledWith(
        expect.objectContaining({ name: 'SmartAlbumReevaluateAll', data: { kind: 'food' } }),
      );
    });

    it('should reject an unknown kind', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ smartAlbums: { enabled: true } });

      await expect(sut.triggerSmartAlbumReevaluate({ kind: 'not-a-real-kind' as never })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should throw BadRequestException when smartAlbums is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        smartAlbums: { enabled: false },
      });

      await expect(sut.triggerSmartAlbumReevaluate()).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
});
