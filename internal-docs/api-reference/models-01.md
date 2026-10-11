# Server API models 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## ActivityCreateDto

Related models: [ReactionType](models-29.md#reactiontype).

```json
{
  "description": "Activity create",
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID (if activity is for an asset)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "comment": {
      "description": "Comment text (required if type is comment)",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/ReactionType"
    }
  },
  "required": [
    "albumId",
    "type"
  ],
  "type": "object"
}
```

## ActivityResponseDto

Related models: [ReactionType](models-29.md#reactiontype), [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID (if activity is for an asset)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "comment": {
      "description": "Comment text (for comment activities)",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Activity ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/ReactionType"
    },
    "user": {
      "$ref": "#/components/schemas/UserResponseDto"
    }
  },
  "required": [
    "assetId",
    "createdAt",
    "id",
    "type",
    "user"
  ],
  "type": "object"
}
```

## ActivityStatisticsResponseDto


```json
{
  "properties": {
    "comments": {
      "description": "Number of comments",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "likes": {
      "description": "Number of likes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "comments",
    "likes"
  ],
  "type": "object"
}
```

## AddUsersDto

Related models: [AlbumUserAddDto](models-02.md#albumuseradddto).

```json
{
  "properties": {
    "albumUsers": {
      "description": "Album users to add",
      "items": {
        "$ref": "#/components/schemas/AlbumUserAddDto"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "albumUsers"
  ],
  "type": "object"
}
```

## AdjustParameters

Related models: [VideoAdjustModel](models-40.md#videoadjustmodel), [VideoDevelopPreset](models-40.md#videodeveloppreset).

```json
{
  "properties": {
    "blackPoint": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "blacks": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "blueTone": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brightness": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "contrast": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "dehaze": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "description": "Exposure in EV (develop model)",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "grain": {
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "hdr": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "highlights": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "model": {
      "$ref": "#/components/schemas/VideoAdjustModel"
    },
    "noiseReduction": {
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "preset": {
      "$ref": "#/components/schemas/VideoDevelopPreset"
    },
    "presetStrength": {
      "description": "Strength of the preset, 0 to 100",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "saturation": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "skinTone": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "temperature": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vibrance": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "warmth": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whitePoint": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "type": "object"
}
```

## AdminAuditAction


```json
{
  "description": "What an administrator did to an account or one of its libraries",
  "enum": [
    "account-created",
    "account-updated",
    "admin-granted",
    "admin-revoked",
    "quota-changed",
    "storage-label-changed",
    "password-reset",
    "pin-set",
    "pin-reset",
    "session-revoked",
    "preferences-updated",
    "casting-disabled",
    "casting-allowed",
    "account-deleted",
    "account-removal-scheduled",
    "account-restored",
    "library-created",
    "library-updated",
    "library-scan-queued",
    "library-scan-cancelled",
    "library-deleted",
    "cloud-linked",
    "cloud-unlinked",
    "cloud-revoked",
    "cloud-permissions-changed",
    "cloud-key-recovery-rotation",
    "license-activated",
    "license-removed",
    "frameleaf-account-linked",
    "frameleaf-account-unlinked"
  ],
  "type": "string"
}
```

## AdminConfigAdvancedPromptDto


```json
{
  "properties": {
    "enabled": {
      "default": false,
      "description": "Use a raw prompt template instead of the structured fields",
      "type": "boolean"
    },
    "placeholderValidation": {
      "default": "strict",
      "description": "Whether missing {schema} placeholder fails save (strict) or warns (warn)",
      "enum": [
        "strict",
        "warn"
      ],
      "type": "string"
    },
    "rawPromptTemplate": {
      "default": "",
      "description": "Raw prompt template with {names}, {schema}, {vocabulary}, {style_hint} placeholders",
      "type": "string"
    }
  },
  "type": "object"
}
```

## AdminConfigAnalyticsDto


```json
{
  "properties": {
    "enabled": {
      "description": "Collect local analytics history every night",
      "type": "boolean"
    },
    "historyDays": {
      "description": "Days of local analytics history to keep",
      "maximum": 800,
      "minimum": 30,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "historyDays"
  ],
  "type": "object"
}
```

## AdminConfigAskSearchDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enable local Ask Photos-style search",
      "type": "boolean"
    },
    "maxResults": {
      "description": "Maximum number of Ask Search results",
      "maximum": 1000,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "maxResults"
  ],
  "type": "object"
}
```

## AdminConfigBackupsDto

Related models: [AdminConfigDatabaseBackupDto](models-01.md#adminconfigdatabasebackupdto).

```json
{
  "properties": {
    "database": {
      "$ref": "#/components/schemas/AdminConfigDatabaseBackupDto"
    }
  },
  "required": [
    "database"
  ],
  "type": "object"
}
```

## AdminConfigClipDto

Related models: [AdminConfigZeroShotTaggingDto](models-02.md#adminconfigzeroshottaggingdto).

```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "modelName": {
      "description": "Name of the model to use",
      "type": "string"
    },
    "zeroShotTagging": {
      "$ref": "#/components/schemas/AdminConfigZeroShotTaggingDto"
    }
  },
  "required": [
    "enabled",
    "modelName",
    "zeroShotTagging"
  ],
  "type": "object"
}
```

## AdminConfigDatabaseBackupDto


```json
{
  "properties": {
    "cronExpression": {
      "description": "Cron expression",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "keepLastAmount": {
      "description": "Keep last amount",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "cronExpression",
    "enabled",
    "keepLastAmount"
  ],
  "type": "object"
}
```

## AdminConfigDto

Related models: [AdminConfigAnalyticsDto](models-01.md#adminconfiganalyticsdto), [AdminConfigBackupsDto](models-01.md#adminconfigbackupsdto), [AdminConfigFFmpegDto](models-01.md#adminconfigffmpegdto), [AdminConfigFrameleafCloudDto](models-01.md#adminconfigframeleafclouddto), [AdminConfigImageDto](models-01.md#adminconfigimagedto), [AdminConfigIntegrityChecksDto](models-01.md#adminconfigintegritychecksdto), [AdminConfigJobDto](models-01.md#adminconfigjobdto), [AdminConfigLibraryCareDto](models-01.md#adminconfiglibrarycaredto), [AdminConfigLibraryDto](models-01.md#adminconfiglibrarydto), [AdminConfigLocalFeaturesDto](models-01.md#adminconfiglocalfeaturesdto), [AdminConfigLoggingDto](models-01.md#adminconfigloggingdto), [AdminConfigMachineLearningDto](models-02.md#adminconfigmachinelearningdto), [AdminConfigMapDto](models-02.md#adminconfigmapdto), [AdminConfigMetadataDto](models-02.md#adminconfigmetadatadto), [AdminConfigNewVersionCheckDto](models-02.md#adminconfignewversioncheckdto), [AdminConfigNightlyTasksDto](models-02.md#adminconfignightlytasksdto), [AdminConfigNotificationsDto](models-02.md#adminconfignotificationsdto), [AdminConfigOAuthDto](models-02.md#adminconfigoauthdto), [AdminConfigPasswordLoginDto](models-02.md#adminconfigpasswordlogindto), [AdminConfigReverseGeocodingDto](models-02.md#adminconfigreversegeocodingdto), [AdminConfigServerDto](models-02.md#adminconfigserverdto), [AdminConfigSmartAlbumsDto](models-02.md#adminconfigsmartalbumsdto), [AdminConfigStorageTemplateDto](models-02.md#adminconfigstoragetemplatedto), [AdminConfigTemplatesDto](models-02.md#adminconfigtemplatesdto), [AdminConfigThemeDto](models-02.md#adminconfigthemedto), [AdminConfigTrashDto](models-02.md#adminconfigtrashdto), [AdminConfigUserDto](models-02.md#adminconfiguserdto).

```json
{
  "description": "Configuration properties that are visible to the admin",
  "properties": {
    "analytics": {
      "$ref": "#/components/schemas/AdminConfigAnalyticsDto"
    },
    "backup": {
      "$ref": "#/components/schemas/AdminConfigBackupsDto"
    },
    "ffmpeg": {
      "$ref": "#/components/schemas/AdminConfigFFmpegDto"
    },
    "frameleafCloud": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudDto"
    },
    "image": {
      "$ref": "#/components/schemas/AdminConfigImageDto"
    },
    "integrityChecks": {
      "$ref": "#/components/schemas/AdminConfigIntegrityChecksDto"
    },
    "job": {
      "$ref": "#/components/schemas/AdminConfigJobDto"
    },
    "library": {
      "$ref": "#/components/schemas/AdminConfigLibraryDto"
    },
    "libraryCare": {
      "$ref": "#/components/schemas/AdminConfigLibraryCareDto"
    },
    "localFeatures": {
      "$ref": "#/components/schemas/AdminConfigLocalFeaturesDto"
    },
    "logging": {
      "$ref": "#/components/schemas/AdminConfigLoggingDto"
    },
    "machineLearning": {
      "$ref": "#/components/schemas/AdminConfigMachineLearningDto"
    },
    "map": {
      "$ref": "#/components/schemas/AdminConfigMapDto"
    },
    "metadata": {
      "$ref": "#/components/schemas/AdminConfigMetadataDto"
    },
    "newVersionCheck": {
      "$ref": "#/components/schemas/AdminConfigNewVersionCheckDto"
    },
    "nightlyTasks": {
      "$ref": "#/components/schemas/AdminConfigNightlyTasksDto"
    },
    "notifications": {
      "$ref": "#/components/schemas/AdminConfigNotificationsDto"
    },
    "oauth": {
      "$ref": "#/components/schemas/AdminConfigOAuthDto"
    },
    "passwordLogin": {
      "$ref": "#/components/schemas/AdminConfigPasswordLoginDto"
    },
    "reverseGeocoding": {
      "$ref": "#/components/schemas/AdminConfigReverseGeocodingDto"
    },
    "server": {
      "$ref": "#/components/schemas/AdminConfigServerDto"
    },
    "smartAlbums": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumsDto"
    },
    "storageTemplate": {
      "$ref": "#/components/schemas/AdminConfigStorageTemplateDto"
    },
    "templates": {
      "$ref": "#/components/schemas/AdminConfigTemplatesDto"
    },
    "theme": {
      "$ref": "#/components/schemas/AdminConfigThemeDto"
    },
    "trash": {
      "$ref": "#/components/schemas/AdminConfigTrashDto"
    },
    "user": {
      "$ref": "#/components/schemas/AdminConfigUserDto"
    }
  },
  "required": [
    "backup",
    "ffmpeg",
    "image",
    "integrityChecks",
    "job",
    "library",
    "logging",
    "machineLearning",
    "map",
    "metadata",
    "newVersionCheck",
    "nightlyTasks",
    "notifications",
    "oauth",
    "passwordLogin",
    "reverseGeocoding",
    "server",
    "storageTemplate",
    "templates",
    "theme",
    "trash",
    "user"
  ],
  "type": "object"
}
```

## AdminConfigDuplicateDetectionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "enhancedVideo": {
      "properties": {
        "enabled": {
          "description": "Whether enhanced video duplicate detection is enabled",
          "type": "boolean"
        },
        "frameCount": {
          "description": "Number of video frames to sample for duplicate confirmation",
          "maximum": 8,
          "minimum": 2,
          "type": "integer"
        },
        "maxDistance": {
          "description": "Maximum distance threshold for enhanced video duplicate frame matching",
          "format": "double",
          "maximum": 0.1,
          "minimum": 0.001,
          "type": "number"
        },
        "minMatchingFrames": {
          "description": "Minimum matching sampled frames required to confirm a video duplicate",
          "maximum": 8,
          "minimum": 1,
          "type": "integer"
        }
      },
      "required": [
        "enabled",
        "frameCount",
        "minMatchingFrames",
        "maxDistance"
      ],
      "type": "object"
    },
    "maxDistance": {
      "description": "Maximum distance threshold for duplicate detection",
      "format": "double",
      "maximum": 0.1,
      "minimum": 0.001,
      "type": "number"
    },
    "preferOriginalFormat": {
      "deprecated": true,
      "description": "Deprecated compatibility setting. RAW, then HEIC/HEIF/HIF, are always preferred over other formats regardless of size",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "enhancedVideo",
    "maxDistance",
    "preferOriginalFormat"
  ],
  "type": "object"
}
```

## AdminConfigEnhancedRawImageDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enhanced RAW rendering",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigFFmpegDto

Related models: [AdminConfigFFmpegRealtimeDto](models-01.md#adminconfigffmpegrealtimedto), [AudioCodec](models-06.md#audiocodec), [CQMode](models-07.md#cqmode), [ToneMapping](models-38.md#tonemapping), [TranscodeHWAccel](models-38.md#transcodehwaccel), [TranscodePolicy](models-38.md#transcodepolicy), [VideoCodec](models-40.md#videocodec), [VideoContainer](models-40.md#videocontainer).

```json
{
  "properties": {
    "accel": {
      "$ref": "#/components/schemas/TranscodeHWAccel"
    },
    "accelDecode": {
      "description": "Accelerated decode",
      "type": "boolean"
    },
    "acceptedAudioCodecs": {
      "description": "Accepted audio codecs",
      "items": {
        "$ref": "#/components/schemas/AudioCodec"
      },
      "type": "array"
    },
    "acceptedContainers": {
      "description": "Accepted containers",
      "items": {
        "$ref": "#/components/schemas/VideoContainer"
      },
      "type": "array"
    },
    "acceptedVideoCodecs": {
      "description": "Accepted video codecs",
      "items": {
        "$ref": "#/components/schemas/VideoCodec"
      },
      "type": "array"
    },
    "bframes": {
      "description": "B-frames",
      "maximum": 16,
      "minimum": -1,
      "type": "integer"
    },
    "cqMode": {
      "$ref": "#/components/schemas/CQMode"
    },
    "crf": {
      "description": "CRF",
      "maximum": 51,
      "minimum": 0,
      "type": "integer"
    },
    "gopSize": {
      "description": "GOP size",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "maxBitrate": {
      "description": "Max bitrate",
      "type": "string"
    },
    "preferredHwDevice": {
      "description": "Preferred hardware device",
      "type": "string"
    },
    "preset": {
      "description": "Preset",
      "type": "string"
    },
    "realtime": {
      "$ref": "#/components/schemas/AdminConfigFFmpegRealtimeDto"
    },
    "refs": {
      "description": "References",
      "maximum": 6,
      "minimum": 0,
      "type": "integer"
    },
    "targetAudioCodec": {
      "$ref": "#/components/schemas/AudioCodec"
    },
    "targetResolution": {
      "description": "Target resolution",
      "type": "string"
    },
    "targetVideoCodec": {
      "$ref": "#/components/schemas/VideoCodec"
    },
    "temporalAQ": {
      "description": "Temporal AQ",
      "type": "boolean"
    },
    "threads": {
      "description": "Threads",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "tonemap": {
      "$ref": "#/components/schemas/ToneMapping"
    },
    "transcode": {
      "$ref": "#/components/schemas/TranscodePolicy"
    },
    "twoPass": {
      "description": "Two pass",
      "type": "boolean"
    }
  },
  "required": [
    "accel",
    "accelDecode",
    "acceptedAudioCodecs",
    "acceptedContainers",
    "acceptedVideoCodecs",
    "bframes",
    "cqMode",
    "crf",
    "gopSize",
    "maxBitrate",
    "preferredHwDevice",
    "preset",
    "realtime",
    "refs",
    "targetAudioCodec",
    "targetResolution",
    "targetVideoCodec",
    "temporalAQ",
    "threads",
    "tonemap",
    "transcode",
    "twoPass"
  ],
  "type": "object"
}
```

## AdminConfigFFmpegRealtimeDto

Related models: [HlsVideoResolution](models-13.md#hlsvideoresolution), [VideoCodec](models-40.md#videocodec).

```json
{
  "properties": {
    "enabled": {
      "description": "Enable real-time HLS transcoding (alpha)",
      "type": "boolean"
    },
    "resolutions": {
      "description": "Resolutions to use for real-time HLS transcoding",
      "items": {
        "$ref": "#/components/schemas/HlsVideoResolution"
      },
      "type": "array"
    },
    "videoCodecs": {
      "description": "Video codecs to use for real-time HLS transcoding",
      "items": {
        "$ref": "#/components/schemas/VideoCodec"
      },
      "type": "array"
    }
  },
  "required": [
    "enabled",
    "resolutions",
    "videoCodecs"
  ],
  "type": "object"
}
```

## AdminConfigFacesDto


```json
{
  "properties": {
    "import": {
      "description": "Import",
      "type": "boolean"
    }
  },
  "required": [
    "import"
  ],
  "type": "object"
}
```

## AdminConfigFacialRecognitionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "maxDistance": {
      "description": "Maximum distance threshold for face recognition",
      "format": "double",
      "maximum": 2,
      "minimum": 0.1,
      "type": "number"
    },
    "minFaces": {
      "description": "Minimum number of faces required for recognition",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "minScore": {
      "description": "Minimum confidence score for face detection",
      "format": "double",
      "maximum": 1,
      "minimum": 0.1,
      "type": "number"
    },
    "modelName": {
      "description": "Name of the model to use",
      "type": "string"
    }
  },
  "required": [
    "enabled",
    "maxDistance",
    "minFaces",
    "minScore",
    "modelName"
  ],
  "type": "object"
}
```

## AdminConfigForkJobSettingsDto


```json
{
  "properties": {
    "concurrency": {
      "description": "Concurrency",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "concurrency"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudAutoDescribeDto


```json
{
  "properties": {
    "dailyBudgetUsd": {
      "description": "Daily budget for automatic descriptions, USD; counts toward the AI Wallet daily cap",
      "format": "double",
      "maximum": 100,
      "minimum": 0.5,
      "type": "number"
    },
    "enabled": {
      "description": "Describe new photos automatically on Frameleaf Cloud",
      "type": "boolean"
    }
  },
  "required": [
    "dailyBudgetUsd",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudBackupDto

Related models: [AdminConfigFrameleafCloudBackupIncludeDto](models-01.md#adminconfigframeleafcloudbackupincludedto), [AdminConfigFrameleafCloudBackupRetentionDto](models-01.md#adminconfigframeleafcloudbackupretentiondto), [AdminConfigFrameleafCloudBackupS3Dto](models-01.md#adminconfigframeleafcloudbackups3dto), [AdminConfigFrameleafCloudBackupScheduleDto](models-01.md#adminconfigframeleafcloudbackupscheduledto), [CloudBackupKeyMode](models-08.md#cloudbackupkeymode), [CloudBackupTargetSetting](models-08.md#cloudbackuptargetsetting).

```json
{
  "properties": {
    "enabled": {
      "description": "Back up to the claimed bucket (set up from Settings › Frameleaf Cloud › Cloud backup)",
      "type": "boolean"
    },
    "escrow": {
      "description": "Keep a passphrase-wrapped copy of the bucket key with Frameleaf Cloud (server key mode only)",
      "type": "boolean"
    },
    "include": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudBackupIncludeDto"
    },
    "keyMode": {
      "$ref": "#/components/schemas/CloudBackupKeyMode"
    },
    "retention": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudBackupRetentionDto"
    },
    "s3": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudBackupS3Dto"
    },
    "schedule": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudBackupScheduleDto"
    },
    "target": {
      "$ref": "#/components/schemas/CloudBackupTargetSetting"
    },
    "verifyWeekly": {
      "description": "Check a sample of the backed-up files every week, and every referenced file every month",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "escrow",
    "include",
    "keyMode",
    "retention",
    "s3",
    "schedule",
    "target",
    "verifyWeekly"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudBackupIncludeDto


```json
{
  "properties": {
    "encodedVideo": {
      "description": "Also back up transcoded videos",
      "type": "boolean"
    },
    "thumbs": {
      "description": "Also back up thumbnails and previews",
      "type": "boolean"
    }
  },
  "required": [
    "encodedVideo",
    "thumbs"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudBackupRetentionDto


```json
{
  "properties": {
    "keepDaily": {
      "description": "Daily runs kept, in days",
      "maximum": 90,
      "minimum": 1,
      "type": "integer"
    },
    "keepMonthly": {
      "description": "Monthly runs kept, in months",
      "maximum": 120,
      "minimum": 0,
      "type": "integer"
    },
    "keepWeekly": {
      "description": "Weekly runs kept, in weeks",
      "maximum": 52,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "keepDaily",
    "keepMonthly",
    "keepWeekly"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudBackupS3Dto


```json
{
  "properties": {
    "accessKeyId": {
      "description": "Access key ID",
      "maxLength": 256,
      "type": "string"
    },
    "bucket": {
      "description": "Bucket name",
      "maxLength": 63,
      "type": "string"
    },
    "endpoint": {
      "description": "Storage address of your own S3-compatible bucket (HTTPS)",
      "type": "string"
    },
    "region": {
      "description": "Region; empty reads it from the storage address or uses us-east-1",
      "maxLength": 64,
      "type": "string"
    },
    "secretAccessKey": {
      "description": "Secret access key (write-only; empty preserves the existing secret)",
      "type": "string"
    },
    "secretAccessKeyConfigured": {
      "description": "Read-only indicator that a secret access key is stored. Set by the server; ignored on write.",
      "type": "boolean"
    }
  },
  "required": [
    "accessKeyId",
    "bucket",
    "endpoint",
    "region",
    "secretAccessKey"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudBackupScheduleDto


```json
{
  "properties": {
    "cronExpression": {
      "description": "When scheduled backup runs start",
      "type": "string"
    }
  },
  "required": [
    "cronExpression"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudDto

Related models: [AdminConfigFrameleafCloudBackupDto](models-01.md#adminconfigframeleafcloudbackupdto), [AdminConfigFrameleafCloudMlDto](models-01.md#adminconfigframeleafcloudmldto), [AdminConfigFrameleafRemoteAccessDto](models-01.md#adminconfigframeleafremoteaccessdto), [AdminConfigFrameleafSignInDto](models-01.md#adminconfigframeleafsignindto).

```json
{
  "properties": {
    "cloudBackup": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudBackupDto"
    },
    "cloudMl": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudMlDto"
    },
    "remoteAccess": {
      "$ref": "#/components/schemas/AdminConfigFrameleafRemoteAccessDto"
    },
    "signIn": {
      "$ref": "#/components/schemas/AdminConfigFrameleafSignInDto"
    }
  },
  "required": [
    "cloudMl"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudFacesDto


```json
{
  "properties": {
    "enabled": {
      "description": "Faces never run on Frameleaf Cloud",
      "enum": [
        false
      ],
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudMlDto

Related models: [AdminConfigFrameleafCloudAutoDescribeDto](models-01.md#adminconfigframeleafcloudautodescribedto), [AdminConfigFrameleafCloudFacesDto](models-01.md#adminconfigframeleafcloudfacesdto), [AdminConfigFrameleafCloudRoutingDto](models-01.md#adminconfigframeleafcloudroutingdto), [AdminConfigFrameleafCloudSpenderDto](models-01.md#adminconfigframeleafcloudspenderdto).

```json
{
  "properties": {
    "autoDescribe": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudAutoDescribeDto"
    },
    "enabled": {
      "description": "Use Frameleaf Cloud for chosen jobs (each job still needs consent and confirmation)",
      "type": "boolean"
    },
    "faces": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudFacesDto"
    },
    "routing": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCloudRoutingDto"
    },
    "spenders": {
      "description": "People besides administrators who may spend the AI Wallet, each with an optional monthly limit",
      "items": {
        "$ref": "#/components/schemas/AdminConfigFrameleafCloudSpenderDto"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "startWith": {
      "description": "The destination a job preselects when its kind of work may run in both places",
      "enum": [
        "local",
        "cloud"
      ],
      "type": "string"
    }
  },
  "required": [
    "autoDescribe",
    "enabled",
    "faces",
    "routing",
    "spenders",
    "startWith"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudRoutingDto

Related models: [CloudRouteMode](models-09.md#cloudroutemode).

```json
{
  "description": "Where each kind of work may run",
  "properties": {
    "descriptions": {
      "$ref": "#/components/schemas/CloudRouteMode"
    },
    "interpolation": {
      "$ref": "#/components/schemas/CloudRouteMode"
    },
    "restoration": {
      "$ref": "#/components/schemas/CloudRouteMode"
    },
    "studio": {
      "$ref": "#/components/schemas/CloudRouteMode"
    },
    "upscale": {
      "$ref": "#/components/schemas/CloudRouteMode"
    }
  },
  "required": [
    "descriptions",
    "interpolation",
    "restoration",
    "studio",
    "upscale"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCloudSpenderDto


```json
{
  "properties": {
    "monthlyCapUsd": {
      "description": "Their monthly limit, USD: settled charges plus the holds of running jobs; null for none",
      "format": "double",
      "maximum": 100000,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "userId": {
      "description": "A person allowed to confirm Frameleaf Cloud jobs",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "monthlyCapUsd",
    "userId"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafCustomHostnameDto

Related models: [RemoteHostnameStatus](models-29.md#remotehostnamestatus).

```json
{
  "properties": {
    "checkedAt": {
      "description": "When its DNS records were last checked",
      "nullable": true,
      "type": "string"
    },
    "host": {
      "description": "A hostname on a domain the administrator owns; empty when none",
      "maxLength": 253,
      "pattern": "^$|^(?:[\\da-z](?:[\\da-z-]{0,61}[\\da-z])?\\.){2,}[\\da-z](?:[\\da-z-]{0,61}[\\da-z])?$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/RemoteHostnameStatus"
    }
  },
  "required": [
    "checkedAt",
    "host",
    "status"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafRemoteAccessDto

Related models: [AdminConfigFrameleafCustomHostnameDto](models-01.md#adminconfigframeleafcustomhostnamedto), [RemoteAccessMode](models-29.md#remoteaccessmode), [RemoteAccessPublicUrl](models-29.md#remoteaccesspublicurl).

```json
{
  "properties": {
    "allowOriginalsOverRelay": {
      "description": "Allow original downloads, archives and database backups over the Frameleaf relay",
      "type": "boolean"
    },
    "allowPasswordOverRelay": {
      "description": "Allow password sign-in, and sessions it creates, over remote access",
      "type": "boolean"
    },
    "customHostname": {
      "$ref": "#/components/schemas/AdminConfigFrameleafCustomHostnameDto"
    },
    "directPort": {
      "description": "External port for direct connections",
      "maximum": 65535,
      "minimum": 1024,
      "type": "integer"
    },
    "enabled": {
      "description": "Serve remote access through Frameleaf Cloud (needs a linked server with a remote access plan)",
      "type": "boolean"
    },
    "mode": {
      "$ref": "#/components/schemas/RemoteAccessMode"
    },
    "portMapping": {
      "description": "Ask the router to open the direct port automatically; off when it is forwarded by hand",
      "type": "boolean"
    },
    "publicUrl": {
      "$ref": "#/components/schemas/RemoteAccessPublicUrl"
    }
  },
  "required": [
    "allowOriginalsOverRelay",
    "allowPasswordOverRelay",
    "customHostname",
    "directPort",
    "enabled",
    "mode",
    "portMapping",
    "publicUrl"
  ],
  "type": "object"
}
```

## AdminConfigFrameleafSignInDto


```json
{
  "properties": {
    "buttonText": {
      "description": "Sign in with Frameleaf button text",
      "maxLength": 100,
      "type": "string"
    },
    "invitedStorageQuota": {
      "description": "Storage quota in GiB for an account Sign in with Frameleaf creates for a person invited to this server; null or omitted is unlimited. Applied when the account is created; existing accounts keep their quota.",
      "maximum": 1000000,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "showOnLocalLogin": {
      "description": "Show Sign in with Frameleaf on the local sign-in page too",
      "type": "boolean"
    }
  },
  "required": [
    "buttonText",
    "showOnLocalLogin"
  ],
  "type": "object"
}
```

## AdminConfigGeneratedFullsizeImageDto

Related models: [ImageFormat](models-14.md#imageformat).

```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "format": {
      "$ref": "#/components/schemas/ImageFormat"
    },
    "progressive": {
      "description": "Progressive",
      "type": "boolean"
    },
    "quality": {
      "description": "Quality",
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "format",
    "quality"
  ],
  "type": "object"
}
```

## AdminConfigGeneratedImageDto

Related models: [ImageFormat](models-14.md#imageformat).

```json
{
  "properties": {
    "format": {
      "$ref": "#/components/schemas/ImageFormat"
    },
    "progressive": {
      "description": "Progressive",
      "type": "boolean"
    },
    "quality": {
      "description": "Quality",
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "size": {
      "description": "Size",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "format",
    "quality",
    "size"
  ],
  "type": "object"
}
```

## AdminConfigIdentityInjectionDto


```json
{
  "properties": {
    "enabled": {
      "default": true,
      "description": "Inject named-face data into description prompts",
      "type": "boolean"
    },
    "maxNames": {
      "default": 5,
      "description": "Maximum named persons to inject into a single prompt",
      "maximum": 20,
      "minimum": 1,
      "type": "integer"
    },
    "minFaceConfidence": {
      "default": 0.7,
      "description": "Minimum face-recognition confidence required to inject a name",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "type": "object"
}
```

## AdminConfigImageDescriptionDto

Related models: [AdminConfigImageDescriptionPromptDto](models-01.md#adminconfigimagedescriptionpromptdto), [MachineLearningHardwareAcceleration](models-16.md#machinelearninghardwareacceleration).

```json
{
  "properties": {
    "acceleration": {
      "$ref": "#/components/schemas/MachineLearningHardwareAcceleration",
      "default": "auto",
      "description": "Hardware acceleration backend to use"
    },
    "device": {
      "description": "Hardware device to use",
      "type": "string"
    },
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "fallbackModelName": {
      "description": "Name of the fallback model to use",
      "type": "string"
    },
    "lastConfigChangeAt": {
      "default": null,
      "description": "ISO timestamp of the last meaningful imageDescription config change. Set server-side; ignored on inbound writes (server is the source of truth).",
      "nullable": true,
      "type": "string"
    },
    "modelName": {
      "description": "Name of the model to use",
      "type": "string"
    },
    "pendingRequeueAt": {
      "default": null,
      "description": "ISO timestamp set when an admin defers a re-queue from the cost modal. Cleared when the re-queue actually dispatches. Drives the persistent \"re-queue pending\" banner.",
      "nullable": true,
      "type": "string"
    },
    "prompt": {
      "$ref": "#/components/schemas/AdminConfigImageDescriptionPromptDto",
      "default": {
        "advanced": {
          "enabled": false,
          "placeholderValidation": "strict",
          "rawPromptTemplate": ""
        },
        "customInstructions": "",
        "customVocabulary": [],
        "forbiddenInferences": [
          "diagnoses",
          "medication names",
          "procedures",
          "pregnancy",
          "disability"
        ],
        "identityInjection": {
          "enabled": true,
          "maxNames": 5,
          "minFaceConfidence": 0.7
        },
        "lookFor": [
          "brands",
          "signage",
          "screens",
          "documents",
          "uniforms",
          "tools",
          "vehicles",
          "animals",
          "food",
          "landmarks"
        ],
        "medicalIndicators": [
          "bandage",
          "cast",
          "crutches",
          "exam-table",
          "hospital",
          "iv-line",
          "lab-result",
          "medical",
          "medical-monitor",
          "medical-paperwork",
          "mobility-aid",
          "pill-organizer",
          "prescription",
          "syringe",
          "ultrasound",
          "wheelchair",
          "wound",
          "x-ray"
        ],
        "nsfwIndicators": [
          "adult-nudity",
          "bare-buttocks",
          "bondage",
          "explicit",
          "exposed-genitals",
          "naked",
          "nsfw",
          "nudity",
          "restraint",
          "sex-toy",
          "sexual-activity"
        ],
        "sentenceCountTarget": 3,
        "style": "balanced"
      }
    },
    "videoMomentCaptions": {
      "default": false,
      "description": "Describe video moments: after a video is described, caption each of its reusable frames (one more model request per frame). Off by default; plans choose captions separately.",
      "type": "boolean"
    }
  },
  "required": [
    "device",
    "enabled",
    "fallbackModelName",
    "modelName"
  ],
  "type": "object"
}
```

## AdminConfigImageDescriptionPromptDto

Related models: [AdminConfigAdvancedPromptDto](models-01.md#adminconfigadvancedpromptdto), [AdminConfigIdentityInjectionDto](models-01.md#adminconfigidentityinjectiondto).

```json
{
  "properties": {
    "advanced": {
      "$ref": "#/components/schemas/AdminConfigAdvancedPromptDto",
      "default": {
        "enabled": false,
        "placeholderValidation": "strict",
        "rawPromptTemplate": ""
      },
      "description": "Advanced raw-prompt-editor configuration"
    },
    "customInstructions": {
      "default": "",
      "description": "Free-form additional natural-language instructions appended to the description prompt. Example: \"If you see a car, identify the make and model. If people are playing a sport, name the sport.\"",
      "maxLength": 2000,
      "type": "string"
    },
    "customVocabulary": {
      "default": [],
      "description": "Tag values the model should prefer when applicable",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "forbiddenInferences": {
      "default": [
        "diagnoses",
        "medication names",
        "procedures",
        "pregnancy",
        "disability"
      ],
      "description": "Categories the model must not infer (diagnoses, medications, etc.)",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "identityInjection": {
      "$ref": "#/components/schemas/AdminConfigIdentityInjectionDto",
      "default": {
        "enabled": true,
        "maxNames": 5,
        "minFaceConfidence": 0.7
      },
      "description": "Named-face injection configuration"
    },
    "lookFor": {
      "default": [
        "brands",
        "signage",
        "screens",
        "documents",
        "uniforms",
        "tools",
        "vehicles",
        "animals",
        "food",
        "landmarks"
      ],
      "description": "Additional categories the model should note when visibly supported (brands, sports equipment, etc.)",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "medicalIndicators": {
      "default": [
        "bandage",
        "cast",
        "crutches",
        "exam-table",
        "hospital",
        "iv-line",
        "lab-result",
        "medical",
        "medical-monitor",
        "medical-paperwork",
        "mobility-aid",
        "pill-organizer",
        "prescription",
        "syringe",
        "ultrasound",
        "wheelchair",
        "wound",
        "x-ray"
      ],
      "description": "Allow-list of medical indicator terms permitted in the description",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "nsfwIndicators": {
      "default": [
        "adult-nudity",
        "bare-buttocks",
        "bondage",
        "explicit",
        "exposed-genitals",
        "naked",
        "nsfw",
        "nudity",
        "restraint",
        "sex-toy",
        "sexual-activity"
      ],
      "description": "Allow-list of explicit NSFW indicator terms permitted in the description",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sentenceCountTarget": {
      "default": 3,
      "description": "Target number of sentences in the description",
      "maximum": 6,
      "minimum": 1,
      "type": "integer"
    },
    "style": {
      "default": "balanced",
      "description": "Description verbosity preset",
      "enum": [
        "terse",
        "balanced",
        "rich"
      ],
      "type": "string"
    }
  },
  "type": "object"
}
```

## AdminConfigImageDto

Related models: [AdminConfigEnhancedRawImageDto](models-01.md#adminconfigenhancedrawimagedto), [AdminConfigGeneratedFullsizeImageDto](models-01.md#adminconfiggeneratedfullsizeimagedto), [AdminConfigGeneratedImageDto](models-01.md#adminconfiggeneratedimagedto), [Colorspace](models-10.md#colorspace).

```json
{
  "properties": {
    "colorspace": {
      "$ref": "#/components/schemas/Colorspace"
    },
    "enhancedRaw": {
      "$ref": "#/components/schemas/AdminConfigEnhancedRawImageDto"
    },
    "extractEmbedded": {
      "description": "Extract embedded",
      "type": "boolean"
    },
    "fullsize": {
      "$ref": "#/components/schemas/AdminConfigGeneratedFullsizeImageDto"
    },
    "preview": {
      "$ref": "#/components/schemas/AdminConfigGeneratedImageDto"
    },
    "thumbnail": {
      "$ref": "#/components/schemas/AdminConfigGeneratedImageDto"
    }
  },
  "required": [
    "colorspace",
    "extractEmbedded",
    "fullsize",
    "preview",
    "thumbnail"
  ],
  "type": "object"
}
```

## AdminConfigIntegrityChecksDto

Related models: [AdminConfigIntegrityChecksumJobDto](models-01.md#adminconfigintegritychecksumjobdto), [AdminConfigIntegrityJobDto](models-01.md#adminconfigintegrityjobdto).

```json
{
  "description": "Integrity checks config",
  "properties": {
    "checksumFiles": {
      "$ref": "#/components/schemas/AdminConfigIntegrityChecksumJobDto"
    },
    "missingFiles": {
      "$ref": "#/components/schemas/AdminConfigIntegrityJobDto"
    },
    "untrackedFiles": {
      "$ref": "#/components/schemas/AdminConfigIntegrityJobDto"
    }
  },
  "required": [
    "checksumFiles",
    "missingFiles",
    "untrackedFiles"
  ],
  "type": "object"
}
```

## AdminConfigIntegrityChecksumJobDto


```json
{
  "description": "Integrity checksum job config",
  "properties": {
    "cronExpression": {
      "description": "Cron expression for when the integrity check should run",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "percentageLimit": {
      "description": "Percentage limit of the integrity checksum job",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "timeLimit": {
      "description": "How long the integrity checksum job may run for",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "cronExpression",
    "enabled",
    "percentageLimit",
    "timeLimit"
  ],
  "type": "object"
}
```

## AdminConfigIntegrityJobDto


```json
{
  "description": "Integrity job config",
  "properties": {
    "cronExpression": {
      "description": "Cron expression for when the integrity check should run",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "cronExpression",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigJobDto

Related models: [AdminConfigForkJobSettingsDto](models-01.md#adminconfigforkjobsettingsdto), [AdminConfigJobSettingsDto](models-01.md#adminconfigjobsettingsdto).

```json
{
  "properties": {
    "backgroundTask": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "editor": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "faceDetection": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "imageDescription": {
      "$ref": "#/components/schemas/AdminConfigForkJobSettingsDto",
      "default": {
        "concurrency": 2
      }
    },
    "imageEnrichment": {
      "$ref": "#/components/schemas/AdminConfigForkJobSettingsDto",
      "default": {
        "concurrency": 2
      }
    },
    "integrityCheck": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "library": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "mediaHealth": {
      "$ref": "#/components/schemas/AdminConfigForkJobSettingsDto",
      "default": {
        "concurrency": 2
      }
    },
    "metadataExtraction": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "migration": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "notifications": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "nsfwDetection": {
      "$ref": "#/components/schemas/AdminConfigForkJobSettingsDto",
      "default": {
        "concurrency": 2
      }
    },
    "ocr": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "petRecognition": {
      "$ref": "#/components/schemas/AdminConfigForkJobSettingsDto",
      "default": {
        "concurrency": 1
      }
    },
    "search": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "sidecar": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "smartSearch": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "thumbnailGeneration": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "videoConversion": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "videoDuplicateDetection": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    },
    "workflow": {
      "$ref": "#/components/schemas/AdminConfigJobSettingsDto"
    }
  },
  "required": [
    "backgroundTask",
    "editor",
    "faceDetection",
    "integrityCheck",
    "library",
    "metadataExtraction",
    "migration",
    "notifications",
    "ocr",
    "search",
    "sidecar",
    "smartSearch",
    "thumbnailGeneration",
    "videoConversion",
    "videoDuplicateDetection",
    "workflow"
  ],
  "type": "object"
}
```

## AdminConfigJobSettingsDto


```json
{
  "properties": {
    "concurrency": {
      "description": "Concurrency",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "concurrency"
  ],
  "type": "object"
}
```

## AdminConfigLibraryCareDto


```json
{
  "properties": {
    "checksumScan": {
      "description": "Health scans verify each original against its recorded checksum",
      "type": "boolean"
    },
    "duplicateReview": {
      "description": "Group near-duplicates for review; deletion stays explicit",
      "type": "boolean"
    },
    "healthScan": {
      "description": "Schedule incremental health scans of every account; each resumes from its recorded checkpoints",
      "type": "boolean"
    },
    "healthScanCronExpression": {
      "description": "When the scheduled health scan starts",
      "type": "string"
    },
    "incrementalEnrichment": {
      "description": "A full description rerun reprocesses only results that are missing, failed or out of date",
      "type": "boolean"
    },
    "integrityAudit": {
      "description": "Run the scheduled database and file reference audits (missing and untracked files)",
      "type": "boolean"
    },
    "livePhotoRepair": {
      "description": "Suggest Live Photo pairs to relink; ambiguous pairs stay in review",
      "type": "boolean"
    },
    "manualMetadata": {
      "description": "A description rerun replaces only generated text and keeps manual text",
      "type": "boolean"
    },
    "rawRecovery": {
      "description": "Search for recoverable copies of RAW originals when locating originals",
      "type": "boolean"
    }
  },
  "required": [
    "checksumScan",
    "duplicateReview",
    "healthScan",
    "healthScanCronExpression",
    "incrementalEnrichment",
    "integrityAudit",
    "livePhotoRepair",
    "manualMetadata",
    "rawRecovery"
  ],
  "type": "object"
}
```

## AdminConfigLibraryDto

Related models: [AdminConfigLibraryScanDto](models-01.md#adminconfiglibraryscandto), [AdminConfigLibraryWatchDto](models-01.md#adminconfiglibrarywatchdto).

```json
{
  "properties": {
    "scan": {
      "$ref": "#/components/schemas/AdminConfigLibraryScanDto"
    },
    "watch": {
      "$ref": "#/components/schemas/AdminConfigLibraryWatchDto"
    }
  },
  "required": [
    "scan",
    "watch"
  ],
  "type": "object"
}
```

## AdminConfigLibraryScanDto


```json
{
  "properties": {
    "cronExpression": {
      "description": "Cron expression",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "cronExpression",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigLibraryWatchDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigLocalFeaturesDto

Related models: [AdminConfigAskSearchDto](models-01.md#adminconfigasksearchdto).

```json
{
  "properties": {
    "askSearch": {
      "$ref": "#/components/schemas/AdminConfigAskSearchDto"
    }
  },
  "required": [
    "askSearch"
  ],
  "type": "object"
}
```

## AdminConfigLoggingDto

Related models: [LogLevel](models-16.md#loglevel).

```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "level": {
      "$ref": "#/components/schemas/LogLevel"
    }
  },
  "required": [
    "enabled",
    "level"
  ],
  "type": "object"
}
```

## AdminConfigMachineLearningAvailabilityChecksDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "interval": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "timeout": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "interval",
    "timeout"
  ],
  "type": "object"
}
```
