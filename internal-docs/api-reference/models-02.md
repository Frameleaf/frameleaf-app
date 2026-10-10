# Server API models 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## AdminConfigMachineLearningDto

Related models: [AdminConfigClipDto](models-01.md#adminconfigclipdto), [AdminConfigDuplicateDetectionDto](models-01.md#adminconfigduplicatedetectiondto), [AdminConfigFacialRecognitionDto](models-01.md#adminconfigfacialrecognitiondto), [AdminConfigImageDescriptionDto](models-01.md#adminconfigimagedescriptiondto), [AdminConfigMachineLearningAvailabilityChecksDto](models-01.md#adminconfigmachinelearningavailabilitychecksdto), [AdminConfigNsfwDetectionDto](models-02.md#adminconfignsfwdetectiondto), [AdminConfigOcrDto](models-02.md#adminconfigocrdto).

```json
{
  "properties": {
    "availabilityChecks": {
      "$ref": "#/components/schemas/AdminConfigMachineLearningAvailabilityChecksDto"
    },
    "clip": {
      "$ref": "#/components/schemas/AdminConfigClipDto"
    },
    "duplicateDetection": {
      "$ref": "#/components/schemas/AdminConfigDuplicateDetectionDto"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "facialRecognition": {
      "$ref": "#/components/schemas/AdminConfigFacialRecognitionDto"
    },
    "imageDescription": {
      "$ref": "#/components/schemas/AdminConfigImageDescriptionDto",
      "default": {
        "acceleration": "auto",
        "device": "AUTO",
        "enabled": true,
        "fallbackModelName": "microsoft/Florence-2-base-ft",
        "lastConfigChangeAt": null,
        "modelName": "Qwen/Qwen2.5-VL-3B-Instruct",
        "pendingRequeueAt": null,
        "prompt": {
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
        },
        "videoMomentCaptions": false
      }
    },
    "nsfwDetection": {
      "$ref": "#/components/schemas/AdminConfigNsfwDetectionDto",
      "default": {
        "device": "AUTO",
        "enabled": false,
        "hideFromLibrary": false,
        "modelName": "onnx-community/nsfw_image_detection-ONNX",
        "threshold": 0.85
      }
    },
    "ocr": {
      "$ref": "#/components/schemas/AdminConfigOcrDto"
    },
    "urls": {
      "description": "ML service URLs",
      "items": {
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "availabilityChecks",
    "clip",
    "duplicateDetection",
    "enabled",
    "facialRecognition",
    "ocr",
    "urls"
  ],
  "type": "object"
}
```

## AdminConfigMapDto


```json
{
  "properties": {
    "darkStyle": {
      "description": "Dark map style URL",
      "format": "uri",
      "type": "string"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "lightStyle": {
      "description": "Light map style URL",
      "format": "uri",
      "type": "string"
    }
  },
  "required": [
    "darkStyle",
    "enabled",
    "lightStyle"
  ],
  "type": "object"
}
```

## AdminConfigMetadataDto

Related models: [AdminConfigFacesDto](models-01.md#adminconfigfacesdto).

```json
{
  "properties": {
    "faces": {
      "$ref": "#/components/schemas/AdminConfigFacesDto"
    }
  },
  "required": [
    "faces"
  ],
  "type": "object"
}
```

## AdminConfigNewVersionCheckDto

Related models: [ReleaseChannel](models-28.md#releasechannel), [VersionCheckFrequency](models-38.md#versioncheckfrequency).

```json
{
  "properties": {
    "channel": {
      "$ref": "#/components/schemas/ReleaseChannel"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "frequency": {
      "$ref": "#/components/schemas/VersionCheckFrequency",
      "default": "daily"
    }
  },
  "required": [
    "channel",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigNightlyTasksDto


```json
{
  "properties": {
    "clusterNewFaces": {
      "description": "Cluster new faces",
      "type": "boolean"
    },
    "databaseCleanup": {
      "description": "Database cleanup",
      "type": "boolean"
    },
    "generateMemories": {
      "description": "Generate memories",
      "type": "boolean"
    },
    "missingThumbnails": {
      "description": "Missing thumbnails",
      "type": "boolean"
    },
    "startTime": {
      "description": "Start time (HH:MM)",
      "pattern": "^(?:[01]\\d|2[0-3]):[0-5]\\d$",
      "type": "string"
    },
    "syncQuotaUsage": {
      "description": "Sync quota usage",
      "type": "boolean"
    }
  },
  "required": [
    "clusterNewFaces",
    "databaseCleanup",
    "generateMemories",
    "missingThumbnails",
    "startTime",
    "syncQuotaUsage"
  ],
  "type": "object"
}
```

## AdminConfigNotificationsDto

Related models: [AdminConfigSmtpDto](models-02.md#adminconfigsmtpdto).

```json
{
  "properties": {
    "smtp": {
      "$ref": "#/components/schemas/AdminConfigSmtpDto"
    }
  },
  "required": [
    "smtp"
  ],
  "type": "object"
}
```

## AdminConfigNsfwDetectionDto


```json
{
  "properties": {
    "device": {
      "description": "Hardware device to use",
      "type": "string"
    },
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "hideFromLibrary": {
      "description": "Hide NSFW assets from library views unless the session has PIN-elevated access",
      "type": "boolean"
    },
    "modelName": {
      "description": "Name of the model to use",
      "type": "string"
    },
    "threshold": {
      "description": "Minimum score required to mark an image as NSFW",
      "format": "double",
      "maximum": 1,
      "minimum": 0.01,
      "type": "number"
    }
  },
  "required": [
    "device",
    "enabled",
    "hideFromLibrary",
    "modelName",
    "threshold"
  ],
  "type": "object"
}
```

## AdminConfigOAuthDto

Related models: [OAuthTokenEndpointAuthMethod](models-18.md#oauthtokenendpointauthmethod).

```json
{
  "properties": {
    "accountManagementUrl": {
      "default": "",
      "description": "Account management URL",
      "type": "string"
    },
    "allowInsecureRequests": {
      "description": "Allow insecure requests",
      "type": "boolean"
    },
    "autoLaunch": {
      "description": "Auto launch",
      "type": "boolean"
    },
    "autoRegister": {
      "description": "Auto register",
      "type": "boolean"
    },
    "buttonText": {
      "description": "Button text",
      "type": "string"
    },
    "clientId": {
      "description": "Client ID",
      "type": "string"
    },
    "clientSecret": {
      "description": "Client secret (write-only; empty preserves the existing secret)",
      "type": "string"
    },
    "clientSecretConfigured": {
      "description": "Read-only indicator that a client secret is stored. Set by the server; ignored on write.",
      "type": "boolean"
    },
    "defaultStorageQuota": {
      "description": "Default storage quota",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "endSessionEndpoint": {
      "description": "End session endpoint",
      "type": "string"
    },
    "issuerUrl": {
      "description": "Issuer URL",
      "type": "string"
    },
    "mobileOverrideEnabled": {
      "description": "Mobile override enabled",
      "type": "boolean"
    },
    "mobileRedirectUri": {
      "description": "Mobile redirect URI (set to empty string to disable)",
      "type": "string"
    },
    "profileSigningAlgorithm": {
      "description": "Profile signing algorithm",
      "type": "string"
    },
    "prompt": {
      "description": "OAuth prompt parameter (e.g. select_account, login, consent)",
      "type": "string"
    },
    "roleClaim": {
      "description": "Role claim",
      "type": "string"
    },
    "scope": {
      "description": "Scope",
      "type": "string"
    },
    "signingAlgorithm": {
      "description": "Signing algorithm",
      "type": "string"
    },
    "storageLabelClaim": {
      "description": "Storage label claim",
      "type": "string"
    },
    "storageQuotaClaim": {
      "description": "Storage quota claim",
      "type": "string"
    },
    "timeout": {
      "description": "Timeout",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "tokenEndpointAuthMethod": {
      "$ref": "#/components/schemas/OAuthTokenEndpointAuthMethod"
    }
  },
  "required": [
    "allowInsecureRequests",
    "autoLaunch",
    "autoRegister",
    "buttonText",
    "clientId",
    "clientSecret",
    "defaultStorageQuota",
    "enabled",
    "endSessionEndpoint",
    "issuerUrl",
    "mobileOverrideEnabled",
    "mobileRedirectUri",
    "profileSigningAlgorithm",
    "prompt",
    "roleClaim",
    "scope",
    "signingAlgorithm",
    "storageLabelClaim",
    "storageQuotaClaim",
    "timeout",
    "tokenEndpointAuthMethod"
  ],
  "type": "object"
}
```

## AdminConfigOcrDto


```json
{
  "properties": {
    "documentFields": {
      "default": false,
      "description": "Suggest receipt and document fields (dates, totals, references) from recognized text",
      "type": "boolean"
    },
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "maxResolution": {
      "description": "Maximum resolution for OCR processing",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "minDetectionScore": {
      "description": "Minimum confidence score for text detection",
      "format": "double",
      "maximum": 1,
      "minimum": 0.1,
      "type": "number"
    },
    "minRecognitionScore": {
      "description": "Minimum confidence score for text recognition",
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
    "maxResolution",
    "minDetectionScore",
    "minRecognitionScore",
    "modelName"
  ],
  "type": "object"
}
```

## AdminConfigPasswordLoginDto


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

## AdminConfigReverseGeocodingDto


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

## AdminConfigRevisionResponseDto

Related models: [AdminConfigDto](models-01.md#adminconfigdto).

```json
{
  "properties": {
    "config": {
      "$ref": "#/components/schemas/AdminConfigDto"
    },
    "revision": {
      "description": "Changes whenever a saved setting changes; send it back as expectedRevision so a save made against older settings is refused",
      "type": "string"
    }
  },
  "required": [
    "config",
    "revision"
  ],
  "type": "object"
}
```

## AdminConfigRevisionUpdateDto

Related models: [AdminConfigDto](models-01.md#adminconfigdto).

```json
{
  "properties": {
    "config": {
      "$ref": "#/components/schemas/AdminConfigDto"
    },
    "expectedRevision": {
      "description": "The revision the changes were made against. When the saved settings no longer match it the update is refused with 409 and nothing is changed",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "config",
    "expectedRevision"
  ],
  "type": "object"
}
```

## AdminConfigServerDto


```json
{
  "properties": {
    "externalDomain": {
      "description": "External domain",
      "type": "string"
    },
    "lanDiscovery": {
      "description": "Advertise this server on the local network (DNS-SD `_frameleaf._tcp`) so apps on the same Wi-Fi can find it without typing an address. Turning this off does not require additional sign-in steps or block direct connections - it only stops the broadcast. While on, any device on this network can see that a Frameleaf server exists here and its display name.",
      "type": "boolean"
    },
    "loginPageMessage": {
      "description": "Login page message",
      "type": "string"
    },
    "name": {
      "description": "Server name shown in settings; empty uses the host name",
      "maxLength": 100,
      "type": "string"
    },
    "publicUsers": {
      "description": "Public users",
      "type": "boolean"
    }
  },
  "required": [
    "externalDomain",
    "lanDiscovery",
    "loginPageMessage",
    "name",
    "publicUsers"
  ],
  "type": "object"
}
```

## AdminConfigSmartAlbumBuiltInDto

Related models: [AdminConfigSmartAlbumKindDto](models-02.md#adminconfigsmartalbumkinddto).

```json
{
  "properties": {
    "documents": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    },
    "food": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    },
    "nature": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    },
    "pets": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    },
    "screenshots": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    },
    "travel": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumKindDto"
    }
  },
  "required": [
    "documents",
    "food",
    "nature",
    "pets",
    "screenshots",
    "travel"
  ],
  "type": "object"
}
```

## AdminConfigSmartAlbumKindDto


```json
{
  "properties": {
    "clipQueries": {
      "description": "CLIP query phrases used when no tag trigger matches",
      "items": {
        "maxLength": 256,
        "type": "string"
      },
      "type": "array"
    },
    "enabled": {
      "description": "Whether this smart album is active",
      "type": "boolean"
    },
    "name": {
      "description": "User-visible album name",
      "maxLength": 256,
      "type": "string"
    },
    "tagTriggers": {
      "description": "Tags that mark an asset as belonging to this album",
      "items": {
        "maxLength": 256,
        "type": "string"
      },
      "type": "array"
    },
    "threshold": {
      "description": "CLIP similarity threshold",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "clipQueries",
    "enabled",
    "name",
    "tagTriggers",
    "threshold"
  ],
  "type": "object"
}
```

## AdminConfigSmartAlbumRulesDto

Related models: [ClassificationRuleAction](models-08.md#classificationruleaction).

```json
{
  "properties": {
    "defaultAction": {
      "$ref": "#/components/schemas/ClassificationRuleAction",
      "description": "The action a new rule starts with"
    },
    "visualCategories": {
      "description": "Whether rules may match visual category phrases",
      "type": "boolean"
    }
  },
  "required": [
    "defaultAction",
    "visualCategories"
  ],
  "type": "object"
}
```

## AdminConfigSmartAlbumsDto

Related models: [AdminConfigSmartAlbumBuiltInDto](models-02.md#adminconfigsmartalbumbuiltindto), [AdminConfigSmartAlbumRulesDto](models-02.md#adminconfigsmartalbumrulesdto).

```json
{
  "properties": {
    "builtIn": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumBuiltInDto"
    },
    "enabled": {
      "description": "Master smart-album enabled toggle",
      "type": "boolean"
    },
    "rules": {
      "$ref": "#/components/schemas/AdminConfigSmartAlbumRulesDto"
    }
  },
  "required": [
    "builtIn",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigSmtpDto

Related models: [AdminConfigSmtpTransportDto](models-02.md#adminconfigsmtptransportdto).

```json
{
  "properties": {
    "enabled": {
      "description": "Whether SMTP email notifications are enabled",
      "type": "boolean"
    },
    "from": {
      "description": "Email address to send from",
      "type": "string"
    },
    "replyTo": {
      "description": "Email address for replies",
      "type": "string"
    },
    "transport": {
      "$ref": "#/components/schemas/AdminConfigSmtpTransportDto"
    }
  },
  "required": [
    "enabled",
    "from",
    "replyTo",
    "transport"
  ],
  "type": "object"
}
```

## AdminConfigSmtpTransportDto


```json
{
  "properties": {
    "host": {
      "description": "SMTP server hostname",
      "type": "string"
    },
    "ignoreCert": {
      "description": "Whether to ignore SSL certificate errors",
      "type": "boolean"
    },
    "password": {
      "description": "SMTP password (write-only; empty preserves the existing password)",
      "type": "string"
    },
    "passwordConfigured": {
      "description": "Read-only indicator that an SMTP password is stored. Set by the server; ignored on write.",
      "type": "boolean"
    },
    "port": {
      "description": "SMTP server port",
      "maximum": 65535,
      "minimum": 0,
      "type": "integer"
    },
    "secure": {
      "description": "Whether to use secure connection (TLS/SSL)",
      "type": "boolean"
    },
    "username": {
      "description": "SMTP username",
      "type": "string"
    }
  },
  "required": [
    "host",
    "ignoreCert",
    "password",
    "port",
    "secure",
    "username"
  ],
  "type": "object"
}
```

## AdminConfigStorageTemplateDto


```json
{
  "properties": {
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    },
    "hashVerificationEnabled": {
      "description": "Hash verification enabled",
      "type": "boolean"
    },
    "template": {
      "description": "Template",
      "type": "string"
    }
  },
  "required": [
    "enabled",
    "hashVerificationEnabled",
    "template"
  ],
  "type": "object"
}
```

## AdminConfigTemplateEmailsDto


```json
{
  "properties": {
    "albumInviteTemplate": {
      "description": "Album invite template",
      "type": "string"
    },
    "albumUpdateTemplate": {
      "description": "Album update template",
      "type": "string"
    },
    "welcomeTemplate": {
      "description": "Welcome template",
      "type": "string"
    }
  },
  "required": [
    "albumInviteTemplate",
    "albumUpdateTemplate",
    "welcomeTemplate"
  ],
  "type": "object"
}
```

## AdminConfigTemplatesDto

Related models: [AdminConfigTemplateEmailsDto](models-02.md#adminconfigtemplateemailsdto).

```json
{
  "properties": {
    "email": {
      "$ref": "#/components/schemas/AdminConfigTemplateEmailsDto"
    }
  },
  "required": [
    "email"
  ],
  "type": "object"
}
```

## AdminConfigThemeDto


```json
{
  "properties": {
    "customCss": {
      "description": "Custom CSS for theming",
      "type": "string"
    }
  },
  "required": [
    "customCss"
  ],
  "type": "object"
}
```

## AdminConfigTrashDto


```json
{
  "properties": {
    "days": {
      "description": "Days",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "enabled": {
      "description": "Enabled",
      "type": "boolean"
    }
  },
  "required": [
    "days",
    "enabled"
  ],
  "type": "object"
}
```

## AdminConfigUserDto


```json
{
  "properties": {
    "deleteDelay": {
      "description": "Delete delay",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "deleteDelay"
  ],
  "type": "object"
}
```

## AdminConfigZeroShotTaggingDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether zero-shot auto-tagging is enabled",
      "type": "boolean"
    },
    "maxTags": {
      "description": "Maximum number of zero-shot tags applied per asset",
      "maximum": 20,
      "minimum": 1,
      "type": "integer"
    },
    "minSimilarity": {
      "description": "Cosine similarity above which a label is applied as a tag",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "enabled",
    "maxTags",
    "minSimilarity"
  ],
  "type": "object"
}
```

## AdminOnboardingUpdateDto


```json
{
  "properties": {
    "isOnboarded": {
      "description": "Is admin onboarded",
      "type": "boolean"
    }
  },
  "required": [
    "isOnboarded"
  ],
  "type": "object"
}
```

## AlbumCollectionResponseDto

Related models: [AlbumResponseDto](models-02.md#albumresponsedto).

```json
{
  "properties": {
    "albumCount": {
      "description": "Number of albums inside the collection",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "albums": {
      "description": "Albums inside the collection, in display order",
      "items": {
        "$ref": "#/components/schemas/AlbumResponseDto"
      },
      "type": "array"
    },
    "assetCount": {
      "description": "Items in the collection and its albums (sum, not deduplicated)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "collection": {
      "$ref": "#/components/schemas/AlbumResponseDto"
    }
  },
  "required": [
    "albumCount",
    "albums",
    "assetCount",
    "collection"
  ],
  "type": "object"
}
```

## AlbumDescendantCountResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of descendant albums (children, grandchildren, etc.)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count"
  ],
  "type": "object"
}
```

## AlbumIconCatalogueResponseDto

Related models: [AlbumIconGroupResponseDto](models-02.md#albumicongroupresponsedto).

```json
{
  "properties": {
    "names": {
      "description": "Every valid icon name, sorted",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "suggested": {
      "description": "Categorised suggested set offered first",
      "items": {
        "$ref": "#/components/schemas/AlbumIconGroupResponseDto"
      },
      "type": "array"
    },
    "version": {
      "description": "Material Design Icons catalogue version the names come from",
      "type": "string"
    }
  },
  "required": [
    "names",
    "suggested",
    "version"
  ],
  "type": "object"
}
```

## AlbumIconGroupResponseDto

Related models: [AlbumIconSuggestionResponseDto](models-02.md#albumiconsuggestionresponsedto).

```json
{
  "properties": {
    "icons": {
      "description": "Suggested icons in this category",
      "items": {
        "$ref": "#/components/schemas/AlbumIconSuggestionResponseDto"
      },
      "type": "array"
    },
    "label": {
      "description": "Category label",
      "type": "string"
    }
  },
  "required": [
    "icons",
    "label"
  ],
  "type": "object"
}
```

## AlbumIconSuggestionResponseDto


```json
{
  "properties": {
    "label": {
      "description": "Human label for search and accessibility",
      "type": "string"
    },
    "name": {
      "description": "Material Design Icons name, e.g. mdiCameraOutline",
      "type": "string"
    }
  },
  "required": [
    "label",
    "name"
  ],
  "type": "object"
}
```

## AlbumKind


```json
{
  "description": "Album kind: album (holds photos), collection (groups albums one level deep) or space (shared, top level)",
  "enum": [
    "album",
    "collection",
    "space"
  ],
  "type": "string"
}
```

## AlbumOrderDto


```json
{
  "properties": {
    "albumIds": {
      "description": "Every item of the group, in the order to show them. Must be exactly the group as it is now; a group that changed since the client loaded it is refused with 409.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 5000,
      "minItems": 1,
      "type": "array"
    },
    "parentId": {
      "description": "Collection whose albums are ordered, or null for a top-level group (collections, albums on their own, or shared spaces)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumIds",
    "parentId"
  ],
  "type": "object"
}
```

## AlbumResponseDto

Related models: [AlbumKind](models-02.md#albumkind), [AlbumUserResponseDto](models-02.md#albumuserresponsedto), [AssetOrder](models-06.md#assetorder), [ContributorCountResponseDto](models-10.md#contributorcountresponsedto), [PartnerOriginDto](models-18.md#partnerorigindto), [SmartAlbumBuiltInKind](models-31.md#smartalbumbuiltinkind).

```json
{
  "properties": {
    "albumName": {
      "description": "Album name",
      "type": "string"
    },
    "albumThumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "albumUsers": {
      "description": "First entry is always the album owner. Second entry is the auth user, if it differs from the owner. The rest are ordered alphabetically.",
      "items": {
        "$ref": "#/components/schemas/AlbumUserResponseDto"
      },
      "minItems": 1,
      "type": "array"
    },
    "assetCount": {
      "description": "Number of assets",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "contributorCounts": {
      "items": {
        "$ref": "#/components/schemas/ContributorCountResponseDto"
      },
      "type": "array"
    },
    "coverFollowsNewest": {
      "description": "True when the cover always follows the newest item. Populated by GET /albums/{id} and PATCH /albums/{id}.",
      "type": "boolean"
    },
    "createdAt": {
      "description": "Creation date",
      "format": "date-time",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "An empty string is returned instead of null for backwards compatibility; null will be returned in v4."
        }
      ]
    },
    "endDate": {
      "description": "End date (latest asset)",
      "format": "date-time",
      "type": "string"
    },
    "hasSharedLink": {
      "description": "Has shared link",
      "type": "boolean"
    },
    "icon": {
      "description": "Icon: a Material Design Icons name or legacy key (null = default icon)",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Activity feed enabled",
      "type": "boolean"
    },
    "isSmart": {
      "description": "True when the album is filled by smart album rules. Populated by GET /albums/tree and GET /albums/{id}.",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumKind"
    },
    "lastModifiedAssetTimestamp": {
      "description": "Last modified asset timestamp",
      "format": "date-time",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "origin": {
      "$ref": "#/components/schemas/PartnerOriginDto",
      "description": "FL-326: present on your own album when partner sharing copied it from another library"
    },
    "parentId": {
      "description": "Collection this album belongs to (null = top-level)",
      "nullable": true,
      "type": "string"
    },
    "shared": {
      "description": "Is shared album",
      "type": "boolean"
    },
    "smartKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/SmartAlbumBuiltInKind"
        }
      ],
      "description": "Built-in smart album kind behind this album, when it is a built-in smart album",
      "nullable": true
    },
    "smartRuleId": {
      "description": "Your classification rule behind this smart album, when it is one of yours",
      "nullable": true,
      "type": "string"
    },
    "sortOrder": {
      "description": "Sibling display position. Lower values appear first.",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "startDate": {
      "description": "Start date (earliest asset)",
      "format": "date-time",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albumName",
    "albumThumbnailAssetId",
    "albumUsers",
    "assetCount",
    "createdAt",
    "description",
    "hasSharedLink",
    "icon",
    "id",
    "isActivityEnabled",
    "kind",
    "parentId",
    "shared",
    "sortOrder",
    "updatedAt"
  ],
  "type": "object"
}
```

## AlbumSourceDto

Related models: [AlbumSourceKind](models-02.md#albumsourcekind).

```json
{
  "properties": {
    "deviceKey": {
      "description": "Set only when sourceId is device-local (an iOS localIdentifier, an Android bucket); null otherwise",
      "maxLength": 256,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumSourceKind"
    },
    "name": {
      "description": "The name of the album or folder on the phone",
      "maxLength": 255,
      "minLength": 1,
      "type": "string"
    },
    "sourceId": {
      "description": "The source on the phone: the iOS album PHCloudIdentifier when available, else its localIdentifier; on Android \"<bucketId>:<relativePath>\"",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "kind",
    "name",
    "sourceId"
  ],
  "type": "object"
}
```

## AlbumSourceKind


```json
{
  "description": "Where the source lives: an iOS Photos album or an Android folder",
  "enum": [
    "ios-photos",
    "android-folder"
  ],
  "type": "string"
}
```

## AlbumSourceLinkResponseDto

Related models: [AlbumSourceKind](models-02.md#albumsourcekind).

```json
{
  "properties": {
    "albumId": {
      "description": "The server album the source is linked to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "albumName": {
      "description": "The server album name",
      "type": "string"
    },
    "createdAt": {
      "description": "When the link was made",
      "format": "date-time",
      "type": "string"
    },
    "deviceKey": {
      "description": "The device the source id belongs to, when it is device-local",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Link ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumSourceKind"
    },
    "lastSourceName": {
      "description": "The phone name the server album last followed (the rename guard)",
      "type": "string"
    },
    "sourceId": {
      "description": "The source on the phone",
      "type": "string"
    },
    "updatedAt": {
      "description": "When the link last changed",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "albumName",
    "createdAt",
    "deviceKey",
    "id",
    "kind",
    "lastSourceName",
    "sourceId",
    "updatedAt"
  ],
  "type": "object"
}
```

## AlbumSourceOutcome


```json
{
  "description": "existing: the source was already linked; merged: linked to an existing album with the same name; created: a new album",
  "enum": [
    "existing",
    "merged",
    "created"
  ],
  "type": "string"
}
```

## AlbumSourceResolveDto

Related models: [AlbumSourceDto](models-02.md#albumsourcedto).

```json
{
  "properties": {
    "sources": {
      "description": "The phone albums or folders to resolve",
      "items": {
        "$ref": "#/components/schemas/AlbumSourceDto"
      },
      "maxItems": 500,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "sources"
  ],
  "type": "object"
}
```

## AlbumSourceResolveResponseDto

Related models: [AlbumSourceResolvedDto](models-02.md#albumsourceresolveddto).

```json
{
  "properties": {
    "links": {
      "description": "One link per requested source, in request order",
      "items": {
        "$ref": "#/components/schemas/AlbumSourceResolvedDto"
      },
      "type": "array"
    }
  },
  "required": [
    "links"
  ],
  "type": "object"
}
```

## AlbumSourceResolvedDto

Related models: [AlbumSourceKind](models-02.md#albumsourcekind), [AlbumSourceOutcome](models-02.md#albumsourceoutcome).

```json
{
  "properties": {
    "albumId": {
      "description": "The server album the source is linked to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "albumName": {
      "description": "The server album name",
      "type": "string"
    },
    "createdAt": {
      "description": "When the link was made",
      "format": "date-time",
      "type": "string"
    },
    "deviceKey": {
      "description": "The device the source id belongs to, when it is device-local",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Link ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumSourceKind"
    },
    "lastSourceName": {
      "description": "The phone name the server album last followed (the rename guard)",
      "type": "string"
    },
    "outcome": {
      "$ref": "#/components/schemas/AlbumSourceOutcome"
    },
    "sourceId": {
      "description": "The source on the phone",
      "type": "string"
    },
    "updatedAt": {
      "description": "When the link last changed",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "albumName",
    "createdAt",
    "deviceKey",
    "id",
    "kind",
    "lastSourceName",
    "outcome",
    "sourceId",
    "updatedAt"
  ],
  "type": "object"
}
```

## AlbumSourceUpdateDto


```json
{
  "properties": {
    "name": {
      "description": "The new name of the album or folder on the phone",
      "maxLength": 255,
      "minLength": 1,
      "type": "string"
    },
    "sourceId": {
      "description": "Re-key the link to a new source id with the same kind and device (an Android folder rename changes its bucket)",
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## AlbumSourceUpdateResponseDto

Related models: [AlbumSourceKind](models-02.md#albumsourcekind).

```json
{
  "properties": {
    "albumId": {
      "description": "The server album the source is linked to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "albumName": {
      "description": "The server album name",
      "type": "string"
    },
    "createdAt": {
      "description": "When the link was made",
      "format": "date-time",
      "type": "string"
    },
    "deviceKey": {
      "description": "The device the source id belongs to, when it is device-local",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Link ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumSourceKind"
    },
    "lastSourceName": {
      "description": "The phone name the server album last followed (the rename guard)",
      "type": "string"
    },
    "renamed": {
      "description": "Whether the server album was renamed (only while its name still equalled lastSourceName)",
      "type": "boolean"
    },
    "sourceId": {
      "description": "The source on the phone",
      "type": "string"
    },
    "updatedAt": {
      "description": "When the link last changed",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "albumName",
    "createdAt",
    "deviceKey",
    "id",
    "kind",
    "lastSourceName",
    "renamed",
    "sourceId",
    "updatedAt"
  ],
  "type": "object"
}
```

## AlbumStatisticsResponseDto


```json
{
  "properties": {
    "notShared": {
      "description": "Number of non-shared albums",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "owned": {
      "description": "Number of owned albums",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shared": {
      "description": "Number of shared albums",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "notShared",
    "owned",
    "shared"
  ],
  "type": "object"
}
```

## AlbumTreeResponseDto

Related models: [AlbumCollectionResponseDto](models-02.md#albumcollectionresponsedto), [AlbumResponseDto](models-02.md#albumresponsedto).

```json
{
  "properties": {
    "albums": {
      "description": "Albums that stand on their own (not inside a visible collection)",
      "items": {
        "$ref": "#/components/schemas/AlbumResponseDto"
      },
      "type": "array"
    },
    "collections": {
      "description": "Collections visible to the user with their albums",
      "items": {
        "$ref": "#/components/schemas/AlbumCollectionResponseDto"
      },
      "type": "array"
    },
    "spaces": {
      "description": "Shared spaces, always top level",
      "items": {
        "$ref": "#/components/schemas/AlbumResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "albums",
    "collections",
    "spaces"
  ],
  "type": "object"
}
```

## AlbumUserAddDto

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole",
      "default": "editor",
      "description": "Album user role"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "userId"
  ],
  "type": "object"
}
```

## AlbumUserCreateDto

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "role",
    "userId"
  ],
  "type": "object"
}
```

## AlbumUserResponseDto

Related models: [AlbumUserRole](models-02.md#albumuserrole), [UserResponseDto](models-38.md#userresponsedto).

```json
{
  "properties": {
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    },
    "user": {
      "$ref": "#/components/schemas/UserResponseDto"
    }
  },
  "required": [
    "role",
    "user"
  ],
  "type": "object"
}
```

## AlbumUserRole


```json
{
  "description": "Album user role",
  "enum": [
    "editor",
    "owner",
    "viewer"
  ],
  "type": "string"
}
```

## AlbumsAddAssetsDto


```json
{
  "properties": {
    "albumIds": {
      "description": "Album IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "albumIds",
    "assetIds"
  ],
  "type": "object"
}
```

## AlbumsAddAssetsResponseDto

Related models: [BulkIdErrorReason](models-07.md#bulkiderrorreason).

```json
{
  "properties": {
    "error": {
      "$ref": "#/components/schemas/BulkIdErrorReason"
    },
    "success": {
      "description": "Operation success",
      "type": "boolean"
    }
  },
  "required": [
    "success"
  ],
  "type": "object"
}
```

## AlbumsResponse

Related models: [AssetOrder](models-06.md#assetorder).

```json
{
  "properties": {
    "defaultAssetOrder": {
      "$ref": "#/components/schemas/AssetOrder"
    }
  },
  "required": [
    "defaultAssetOrder"
  ],
  "type": "object"
}
```

## AlbumsUpdate

Related models: [AssetOrder](models-06.md#assetorder).

```json
{
  "description": "Album preferences",
  "properties": {
    "defaultAssetOrder": {
      "$ref": "#/components/schemas/AssetOrder"
    }
  },
  "type": "object"
}
```

## AnalyticsAlbumDto


```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "owned": {
      "type": "boolean"
    },
    "ownerName": {
      "type": "string"
    },
    "shared": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "name",
    "owned",
    "ownerName",
    "shared"
  ],
  "type": "object"
}
```

## AnalyticsAlbumsDto

Related models: [AnalyticsAlbumDto](models-02.md#analyticsalbumdto).

```json
{
  "properties": {
    "albums": {
      "description": "Albums the viewer owns or belongs to",
      "items": {
        "$ref": "#/components/schemas/AnalyticsAlbumDto"
      },
      "type": "array"
    },
    "notShared": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "owned": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "ownedShared": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shared": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unlisted": {
      "description": "Albums counted but not listed, because the viewer neither owns nor belongs to them",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "albums",
    "notShared",
    "owned",
    "ownedShared",
    "shared",
    "total",
    "unlisted"
  ],
  "type": "object"
}
```

## AnalyticsBucketDto


```json
{
  "properties": {
    "completed": {
      "description": "Completed processing attempts; null when not available for this scope",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "failed": {
      "description": "Failed processing attempts; null when not available for this scope",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "from": {
      "format": "date",
      "type": "string"
    },
    "items": {
      "description": "Library items at the last observation in this period; null when none",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "key": {
      "description": "YYYY-MM for a month, the Monday for a week",
      "type": "string"
    },
    "logicalBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "observedAt": {
      "description": "When the growth values were read; null for a gap",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "partial": {
      "description": "Cut short by the edge of the selected dates",
      "type": "boolean"
    },
    "photos": {
      "description": "Photos added in this period and still in the library",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "physicalBytes": {
      "description": "Bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "through": {
      "format": "date",
      "type": "string"
    },
    "videos": {
      "description": "Videos added in this period and still in the library",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "completed",
    "failed",
    "from",
    "items",
    "key",
    "logicalBytes",
    "observedAt",
    "partial",
    "photos",
    "physicalBytes",
    "through",
    "videos"
  ],
  "type": "object"
}
```

## AnalyticsCameraDto

Related models: [AnalyticsCameraKind](models-02.md#analyticscamerakind).

```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "$ref": "#/components/schemas/AnalyticsCameraKind"
    },
    "name": {
      "description": "Camera model; null for the other and unknown rows",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "count",
    "kind",
    "name"
  ],
  "type": "object"
}
```

## AnalyticsCameraKind


```json
{
  "enum": [
    "model",
    "other",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsCoverageDto


```json
{
  "description": "Out of summary.items minus hiddenItems",
  "properties": {
    "facesChecked": {
      "description": "Items face detection has run on",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "searchIndexed": {
      "description": "Items with a smart-search embedding",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "facesChecked",
    "searchIndexed"
  ],
  "type": "object"
}
```

## AnalyticsDayDto


```json
{
  "properties": {
    "captured": {
      "description": "Items taken on this local date",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "date": {
      "format": "date",
      "type": "string"
    },
    "uploaded": {
      "description": "Items added on this UTC date",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "captured",
    "date",
    "uploaded"
  ],
  "type": "object"
}
```

## AnalyticsFocalLengthDto

Related models: [AnalyticsFocalLengthDtoKey](models-02.md#analyticsfocallengthdtokey).

```json
{
  "description": "Items per recorded focal length (mm)",
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "key": {
      "$ref": "#/components/schemas/AnalyticsFocalLengthDtoKey"
    }
  },
  "required": [
    "count",
    "key"
  ],
  "type": "object"
}
```

## AnalyticsFocalLengthDtoKey


```json
{
  "enum": [
    "0-16",
    "17-28",
    "29-40",
    "41-70",
    "71-135",
    "136-300",
    "301+",
    "unknown"
  ],
  "type": "string"
}
```

## AnalyticsGrain


```json
{
  "description": "Analytics grain",
  "enum": [
    "snapshot",
    "day"
  ],
  "type": "string"
}
```

## AnalyticsHdrDto


```json
{
  "properties": {
    "dolbyVisionVideos": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "hdrVideos": {
      "description": "PQ or HLG transfer, or Dolby Vision",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "probedVideos": {
      "description": "Videos whose stream metadata has been read; the only ones HDR can be told for",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "dolbyVisionVideos",
    "hdrVideos",
    "probedVideos"
  ],
  "type": "object"
}
```

## AnalyticsHistoryDto

Related models: [AnalyticsState](models-03.md#analyticsstate).

```json
{
  "properties": {
    "dayRetentionDays": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "lastObservedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "staleAfterHours": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "state": {
      "$ref": "#/components/schemas/AnalyticsState",
      "description": "unknown: never collected; stale: last collection is too old"
    },
    "weekRetentionDays": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "dayRetentionDays",
    "lastObservedAt",
    "staleAfterHours",
    "state",
    "weekRetentionDays"
  ],
  "type": "object"
}
```
