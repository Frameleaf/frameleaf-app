# Server API models 32

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## SearchSuggestionType


```json
{
  "description": "Suggestion type",
  "enum": [
    "country",
    "state",
    "city",
    "camera-make",
    "camera-model",
    "camera-lens-model"
  ],
  "type": "string"
}
```

## ServerAboutResponseDto


```json
{
  "properties": {
    "build": {
      "description": "Build identifier",
      "type": "string"
    },
    "buildImage": {
      "description": "Build image name",
      "type": "string"
    },
    "buildImageUrl": {
      "description": "Build image URL",
      "type": "string"
    },
    "buildUrl": {
      "description": "Build URL",
      "type": "string"
    },
    "exiftool": {
      "description": "ExifTool version",
      "type": "string"
    },
    "ffmpeg": {
      "description": "FFmpeg version",
      "type": "string"
    },
    "imagemagick": {
      "description": "ImageMagick version",
      "type": "string"
    },
    "libraw": {
      "description": "LibRaw/dcraw_emu version",
      "type": "string"
    },
    "libvips": {
      "description": "libvips version",
      "type": "string"
    },
    "licensed": {
      "description": "Whether the server is licensed",
      "type": "boolean"
    },
    "nodejs": {
      "description": "Node.js version",
      "type": "string"
    },
    "repository": {
      "description": "Repository name",
      "type": "string"
    },
    "repositoryUrl": {
      "description": "Repository URL",
      "type": "string"
    },
    "sourceCommit": {
      "description": "Source commit hash",
      "type": "string"
    },
    "sourceRef": {
      "description": "Source reference (branch/tag)",
      "type": "string"
    },
    "sourceUrl": {
      "description": "Source URL",
      "type": "string"
    },
    "thirdPartyBugFeatureUrl": {
      "description": "Third-party bug/feature URL",
      "type": "string"
    },
    "thirdPartyDocumentationUrl": {
      "description": "Third-party documentation URL",
      "type": "string"
    },
    "thirdPartySourceUrl": {
      "description": "Third-party source URL",
      "type": "string"
    },
    "thirdPartySupportUrl": {
      "description": "Third-party support URL",
      "type": "string"
    },
    "version": {
      "description": "Server version",
      "type": "string"
    },
    "versionUrl": {
      "description": "URL to version information",
      "type": "string"
    }
  },
  "required": [
    "licensed",
    "version",
    "versionUrl"
  ],
  "type": "object"
}
```

## ServerApkLinksDto


```json
{
  "properties": {
    "arm64v8a": {
      "description": "APK download link for ARM64 v8a architecture",
      "type": "string"
    },
    "armeabiv7a": {
      "description": "APK download link for ARM EABI v7a architecture",
      "type": "string"
    },
    "universal": {
      "description": "APK download link for universal architecture",
      "type": "string"
    },
    "x86_64": {
      "description": "APK download link for x86_64 architecture",
      "type": "string"
    }
  },
  "required": [
    "arm64v8a",
    "armeabiv7a",
    "universal",
    "x86_64"
  ],
  "type": "object"
}
```

## ServerAppReleasesResponseDto

Related models: [ServerApkLinksDto](models-32.md#serverapklinksdto).

```json
{
  "properties": {
    "android": {
      "description": "Android application",
      "properties": {
        "appId": {
          "description": "Android package id of the signed release",
          "type": "string"
        },
        "available": {
          "description": "Whether a signed Android release is configured for this server",
          "type": "boolean"
        },
        "links": {
          "$ref": "#/components/schemas/ServerApkLinksDto",
          "description": "Signed APK downloads for this server version"
        },
        "signingCertificateSha256": {
          "description": "SHA-256 fingerprint of the release signing certificate, as AA:BB:...",
          "type": "string"
        },
        "storeUrl": {
          "description": "Store listing of the Android app, when the operator configured one (FL-135)",
          "type": "string"
        }
      },
      "required": [
        "available"
      ],
      "type": "object"
    },
    "ios": {
      "description": "iOS application",
      "properties": {
        "available": {
          "description": "Whether an iOS release is configured for this server",
          "type": "boolean"
        },
        "url": {
          "description": "App Store or TestFlight page",
          "type": "string"
        }
      },
      "required": [
        "available"
      ],
      "type": "object"
    }
  },
  "required": [
    "android",
    "ios"
  ],
  "type": "object"
}
```

## ServerConfigDto

Related models: [ServerFrameleafConfigDto](models-32.md#serverframeleafconfigdto).

```json
{
  "properties": {
    "defaultImageDescriptionRawPromptTemplate": {
      "description": "Canonical default for the image-description advanced raw prompt template",
      "type": "string"
    },
    "externalDomain": {
      "description": "External domain URL",
      "type": "string"
    },
    "frameleaf": {
      "$ref": "#/components/schemas/ServerFrameleafConfigDto"
    },
    "isInitialized": {
      "description": "Whether the server has been initialized",
      "type": "boolean"
    },
    "isOnboarded": {
      "description": "Whether the admin has completed onboarding",
      "type": "boolean"
    },
    "loginPageMessage": {
      "description": "Login page message",
      "type": "string"
    },
    "maintenanceMode": {
      "description": "Whether maintenance mode is active",
      "type": "boolean"
    },
    "mapDarkStyleUrl": {
      "description": "Map dark style URL",
      "type": "string"
    },
    "mapLightStyleUrl": {
      "description": "Map light style URL",
      "type": "string"
    },
    "minFaces": {
      "description": "People min faces server default",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "oauthAccountManagementUrl": {
      "default": "",
      "description": "OAuth account management URL",
      "type": "string"
    },
    "oauthButtonText": {
      "description": "OAuth button text",
      "type": "string"
    },
    "publicUsers": {
      "description": "Whether public user registration is enabled",
      "type": "boolean"
    },
    "serverName": {
      "description": "Server name set by an administrator; empty when none is set",
      "type": "string"
    },
    "trashDays": {
      "description": "Number of days before trashed assets are permanently deleted",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "userDeleteDelay": {
      "description": "Delay in days before deleted users are permanently removed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "defaultImageDescriptionRawPromptTemplate",
    "externalDomain",
    "frameleaf",
    "isInitialized",
    "isOnboarded",
    "loginPageMessage",
    "maintenanceMode",
    "mapDarkStyleUrl",
    "mapLightStyleUrl",
    "minFaces",
    "oauthButtonText",
    "publicUsers",
    "serverName",
    "trashDays",
    "userDeleteDelay"
  ],
  "type": "object"
}
```

## ServerFeaturesDto

Related models: [ImageCapabilitiesDto](models-14.md#imagecapabilitiesdto).

```json
{
  "properties": {
    "askSearch": {
      "description": "Whether Ask Search (natural-language questions about the library) is enabled and can answer",
      "type": "boolean"
    },
    "cloudBackup": {
      "description": "Whether the Frameleaf Cloud plan includes cloud backup (FL-156)",
      "type": "boolean"
    },
    "cloudMl": {
      "description": "Whether the Frameleaf Cloud plan includes cloud processing (FL-156)",
      "type": "boolean"
    },
    "configFile": {
      "description": "Whether config file is available",
      "type": "boolean"
    },
    "duplicateDetection": {
      "description": "Whether duplicate detection is enabled",
      "type": "boolean"
    },
    "email": {
      "description": "Whether email notifications are enabled",
      "type": "boolean"
    },
    "facialRecognition": {
      "description": "Whether facial recognition is enabled",
      "type": "boolean"
    },
    "frameleafCloud": {
      "description": "Whether this server is linked to Frameleaf Cloud (FL-156)",
      "type": "boolean"
    },
    "imageCapabilities": {
      "$ref": "#/components/schemas/ImageCapabilitiesDto"
    },
    "imageDescription": {
      "description": "Whether image description and tag generation is enabled",
      "type": "boolean"
    },
    "importFaces": {
      "description": "Whether face import is enabled",
      "type": "boolean"
    },
    "map": {
      "description": "Whether map feature is enabled",
      "type": "boolean"
    },
    "nsfwDetection": {
      "description": "Whether NSFW detection is enabled",
      "type": "boolean"
    },
    "nsfwHiding": {
      "description": "Whether NSFW-tagged assets are hidden from non-elevated library views",
      "type": "boolean"
    },
    "oauth": {
      "description": "Whether OAuth is enabled",
      "type": "boolean"
    },
    "oauthAutoLaunch": {
      "description": "Whether OAuth auto-launch is enabled",
      "type": "boolean"
    },
    "ocr": {
      "description": "Whether OCR is enabled",
      "type": "boolean"
    },
    "passwordLogin": {
      "description": "Whether password login is enabled",
      "type": "boolean"
    },
    "physicalDeduplication": {
      "description": "Whether physical file deduplication is enabled",
      "type": "boolean"
    },
    "realtimeTranscoding": {
      "description": "Whether real-time transcoding is enabled",
      "type": "boolean"
    },
    "remoteAccess": {
      "description": "Whether the Frameleaf Cloud plan includes remote access (FL-156)",
      "type": "boolean"
    },
    "reverseGeocoding": {
      "description": "Whether reverse geocoding is enabled",
      "type": "boolean"
    },
    "search": {
      "description": "Whether search is enabled",
      "type": "boolean"
    },
    "sidecar": {
      "description": "Whether sidecar files are supported",
      "type": "boolean"
    },
    "smartSearch": {
      "description": "Whether smart search is enabled",
      "type": "boolean"
    },
    "supporter": {
      "description": "Whether this server carries a Frameleaf supporter licence (FL-156)",
      "type": "boolean"
    },
    "trash": {
      "description": "Whether trash feature is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "askSearch",
    "cloudBackup",
    "cloudMl",
    "configFile",
    "duplicateDetection",
    "email",
    "facialRecognition",
    "frameleafCloud",
    "imageDescription",
    "importFaces",
    "map",
    "nsfwDetection",
    "nsfwHiding",
    "oauth",
    "oauthAutoLaunch",
    "ocr",
    "passwordLogin",
    "physicalDeduplication",
    "realtimeTranscoding",
    "remoteAccess",
    "reverseGeocoding",
    "search",
    "sidecar",
    "smartSearch",
    "supporter",
    "trash"
  ],
  "type": "object"
}
```

## ServerFrameleafConfigDto

Related models: [FrameleafVia](models-12.md#frameleafvia).

```json
{
  "description": "Frameleaf remote access and sign-in, for this request",
  "properties": {
    "cloudConfigured": {
      "description": "Whether the deployment names a Frameleaf Cloud address (FRAMELEAF_CLOUD_URL), so setup can offer to link; nothing is contacted",
      "type": "boolean"
    },
    "publicUrl": {
      "description": "The address Frameleaf Cloud published for this server, while it is linked",
      "nullable": true,
      "type": "string"
    },
    "signInAvailable": {
      "description": "Whether Sign in with Frameleaf is available (the server is linked)",
      "type": "boolean"
    },
    "signInRequired": {
      "description": "Whether this request arrived through remote access, where a Frameleaf sign-in is required",
      "type": "boolean"
    },
    "via": {
      "allOf": [
        {
          "$ref": "#/components/schemas/FrameleafVia"
        }
      ],
      "description": "How the request arrived; null when the edge worker did not vouch for it",
      "nullable": true
    }
  },
  "required": [
    "cloudConfigured",
    "publicUrl",
    "signInAvailable",
    "signInRequired",
    "via"
  ],
  "type": "object"
}
```

## ServerMediaTypesResponseDto


```json
{
  "properties": {
    "image": {
      "description": "Supported image MIME types",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sidecar": {
      "description": "Supported sidecar MIME types",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "video": {
      "description": "Supported video MIME types",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "image",
    "sidecar",
    "video"
  ],
  "type": "object"
}
```

## ServerPingResponse


```json
{
  "properties": {
    "cloud": {
      "description": "Whether this server can link to Frameleaf Cloud (FRAMELEAF_CLOUD_URL is set)",
      "enum": [
        "available",
        "unavailable"
      ],
      "type": "string"
    },
    "id": {
      "description": "This server's identity: the Frameleaf Cloud instance id while linked, else a stable local id",
      "example": "018f5e7a-6b1e-7f6e-9c2e-1a2b3c4d5e6f",
      "type": "string"
    },
    "linked": {
      "description": "Whether `id` is a Frameleaf Cloud instance id (true) or a local-only id (false)",
      "type": "boolean"
    },
    "name": {
      "description": "The server's display name (the admin-set server name, or a default)",
      "type": "string"
    },
    "res": {
      "example": "pong",
      "type": "string"
    },
    "setup": {
      "description": "`needed` while the server has no administrator: the Frameleaf app can set it up from the home network",
      "enum": [
        "needed",
        "complete"
      ],
      "type": "string"
    }
  },
  "required": [
    "cloud",
    "id",
    "linked",
    "name",
    "res",
    "setup"
  ],
  "type": "object"
}
```

## ServerRole


```json
{
  "description": "Your role on this server. `owner` (the administrator whose Frameleaf account owns this server) and `admin` administer it; `user` has their own library, as does everyone Frameleaf Cloud invited to this server. What others share with you (items, albums, spaces) appears under Spaces.",
  "enum": [
    "owner",
    "admin",
    "user"
  ],
  "type": "string"
}
```

## ServerStatsResponseDto

Related models: [UsageByUserDto](models-39.md#usagebyuserdto).

```json
{
  "properties": {
    "photos": {
      "description": "Total number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usage": {
      "description": "Total storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usageByUser": {
      "description": "Array of usage for each user",
      "items": {
        "$ref": "#/components/schemas/UsageByUserDto"
      },
      "type": "array"
    },
    "usagePhotos": {
      "description": "Storage usage for photos in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usageVideos": {
      "description": "Storage usage for videos in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Total number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "photos",
    "usage",
    "usageByUser",
    "usagePhotos",
    "usageVideos",
    "videos"
  ],
  "type": "object"
}
```

## ServerStorageResponseDto


```json
{
  "properties": {
    "diskAvailable": {
      "description": "Available disk space (human-readable format)",
      "type": "string"
    },
    "diskAvailableRaw": {
      "description": "Available disk space in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "diskSize": {
      "description": "Total disk size (human-readable format)",
      "type": "string"
    },
    "diskSizeRaw": {
      "description": "Total disk size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "diskUsagePercentage": {
      "description": "Disk usage percentage (0-100)",
      "format": "double",
      "type": "number"
    },
    "diskUse": {
      "description": "Used disk space (human-readable format)",
      "type": "string"
    },
    "diskUseRaw": {
      "description": "Used disk space in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "diskAvailable",
    "diskAvailableRaw",
    "diskSize",
    "diskSizeRaw",
    "diskUsagePercentage",
    "diskUse",
    "diskUseRaw"
  ],
  "type": "object"
}
```

## ServerVersionHistoryResponseDto


```json
{
  "properties": {
    "createdAt": {
      "description": "When this version was first seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Version history entry ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "version": {
      "description": "Version string",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "id",
    "version"
  ],
  "type": "object"
}
```

## ServerVersionResponseDto


```json
{
  "properties": {
    "major": {
      "description": "Major version number",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "minor": {
      "description": "Minor version number",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "patch": {
      "description": "Patch version number",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "prerelease": {
      "description": "Pre-release version number",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer",
      "x-immich-history": [
        {
          "version": "v3.0.0",
          "state": "Added"
        }
      ]
    },
    "prereleaseName": {
      "description": "Full pre-release identifier (for example rc.1 or beta.2), present only for a pre-release (FL-80)",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    }
  },
  "required": [
    "major",
    "minor",
    "patch",
    "prerelease"
  ],
  "type": "object"
}
```

## SessionCreateDto


```json
{
  "properties": {
    "deviceOS": {
      "description": "Device OS",
      "type": "string"
    },
    "deviceType": {
      "description": "Device type",
      "type": "string"
    },
    "duration": {
      "description": "Session duration in seconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "type": "object"
}
```

## SessionCreateResponseDto


```json
{
  "properties": {
    "appVersion": {
      "description": "App version",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "type": "string"
    },
    "current": {
      "description": "Is current session",
      "type": "boolean"
    },
    "deviceOS": {
      "description": "Device OS",
      "type": "string"
    },
    "deviceType": {
      "description": "Device type",
      "type": "string"
    },
    "expiresAt": {
      "description": "Expiration date",
      "type": "string"
    },
    "id": {
      "description": "Session ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isPendingSyncReset": {
      "description": "Is pending sync reset",
      "type": "boolean"
    },
    "token": {
      "description": "Session token",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "type": "string"
    }
  },
  "required": [
    "appVersion",
    "createdAt",
    "current",
    "deviceOS",
    "deviceType",
    "id",
    "isPendingSyncReset",
    "token",
    "updatedAt"
  ],
  "type": "object"
}
```

## SessionResponseDto


```json
{
  "properties": {
    "appVersion": {
      "description": "App version",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "type": "string"
    },
    "current": {
      "description": "Is current session",
      "type": "boolean"
    },
    "deviceOS": {
      "description": "Device OS",
      "type": "string"
    },
    "deviceType": {
      "description": "Device type",
      "type": "string"
    },
    "expiresAt": {
      "description": "Expiration date",
      "type": "string"
    },
    "id": {
      "description": "Session ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isPendingSyncReset": {
      "description": "Is pending sync reset",
      "type": "boolean"
    },
    "updatedAt": {
      "description": "Last update date",
      "type": "string"
    }
  },
  "required": [
    "appVersion",
    "createdAt",
    "current",
    "deviceOS",
    "deviceType",
    "id",
    "isPendingSyncReset",
    "updatedAt"
  ],
  "type": "object"
}
```

## SessionUnlockDto


```json
{
  "properties": {
    "password": {
      "description": "User password (required if PIN code is not provided)",
      "example": "password",
      "type": "string"
    },
    "pinCode": {
      "description": "New PIN code (4-6 digits)",
      "example": "123456",
      "pattern": "^\\d{6}$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## SessionUpdateDto


```json
{
  "properties": {
    "isPendingSyncReset": {
      "description": "Reset pending sync state",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## SetMaintenanceModeDto

Related models: [MaintenanceAction](models-16.md#maintenanceaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MaintenanceAction"
    },
    "buddyRecoveryId": {
      "description": "A verified, locally staged Buddy recovery",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "keepSafetyBackup": {
      "description": "Keep the safety backup of the current database that a restore makes first (default true); it is always kept when the restore fails",
      "type": "boolean"
    },
    "reason": {
      "description": "Why the server is in maintenance, shown to everyone on the maintenance screen (max 200 characters). Omit to keep the current reason; null or an empty string clears it",
      "maxLength": 200,
      "nullable": true,
      "type": "string"
    },
    "restoreBackupFilename": {
      "description": "Restore backup filename",
      "type": "string"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## SharedLinkCreateDto

Related models: [SharedLinkType](models-32.md#sharedlinktype).

```json
{
  "properties": {
    "albumId": {
      "description": "Album ID (for album sharing)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "allowDownload": {
      "default": true,
      "description": "Allow downloads",
      "type": "boolean"
    },
    "allowUpload": {
      "description": "Allow uploads",
      "type": "boolean"
    },
    "assetIds": {
      "description": "Asset IDs (for individual assets)",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "description": {
      "description": "Link description",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "Expiration date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "password": {
      "description": "Link password",
      "nullable": true,
      "type": "string"
    },
    "showMetadata": {
      "default": true,
      "description": "Show metadata",
      "type": "boolean"
    },
    "slug": {
      "description": "Custom URL slug",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/SharedLinkType"
    }
  },
  "required": [
    "type"
  ],
  "type": "object"
}
```

## SharedLinkEditDto


```json
{
  "properties": {
    "allowDownload": {
      "description": "Allow downloads",
      "type": "boolean"
    },
    "allowUpload": {
      "description": "Allow uploads",
      "type": "boolean"
    },
    "description": {
      "description": "Link description",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "Expiration date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "password": {
      "description": "Link password",
      "nullable": true,
      "type": "string"
    },
    "showMetadata": {
      "description": "Show metadata",
      "type": "boolean"
    },
    "slug": {
      "description": "Custom URL slug",
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## SharedLinkLoginDto


```json
{
  "properties": {
    "password": {
      "description": "Shared link password",
      "example": "password",
      "type": "string"
    }
  },
  "required": [
    "password"
  ],
  "type": "object"
}
```

## SharedLinkOwnerResponseDto


```json
{
  "description": "Public details of the shared link owner",
  "properties": {
    "name": {
      "description": "Display name of the user who created the link",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## SharedLinkResponseDto

Related models: [AlbumResponseDto](models-02.md#albumresponsedto), [AssetResponseDto](models-06.md#assetresponsedto), [SharedLinkOwnerResponseDto](models-32.md#sharedlinkownerresponsedto), [SharedLinkType](models-32.md#sharedlinktype).

```json
{
  "description": "Shared link response",
  "properties": {
    "album": {
      "$ref": "#/components/schemas/AlbumResponseDto"
    },
    "allowDownload": {
      "description": "Allow downloads",
      "type": "boolean"
    },
    "allowUpload": {
      "description": "Allow uploads",
      "type": "boolean"
    },
    "assets": {
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Link description",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "Expiration date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Shared link ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Encryption key (base64url)",
      "type": "string"
    },
    "owner": {
      "$ref": "#/components/schemas/SharedLinkOwnerResponseDto",
      "description": "Display name of the user who created the link, for \"Shared by\" on the public page"
    },
    "password": {
      "description": "Has password: a fixed mask when the link has one, never the password itself",
      "nullable": true,
      "type": "string"
    },
    "showMetadata": {
      "description": "Show metadata",
      "type": "boolean"
    },
    "slug": {
      "description": "Custom URL slug",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/SharedLinkType"
    },
    "url": {
      "description": "The link's public address: the server's external domain, then /s/<slug> (URL-encoded) or /share/<key>. Null when no external domain is set; a client then puts the same path after the address it uses.",
      "nullable": true,
      "type": "string"
    },
    "userId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "allowDownload",
    "allowUpload",
    "assets",
    "createdAt",
    "description",
    "expiresAt",
    "id",
    "key",
    "password",
    "showMetadata",
    "slug",
    "type",
    "url",
    "userId"
  ],
  "type": "object"
}
```

## SharedLinkType


```json
{
  "description": "Shared link type",
  "enum": [
    "ALBUM",
    "INDIVIDUAL"
  ],
  "type": "string"
}
```

## SharedLinksResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether shared links are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether shared links appear in web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "sidebarWeb"
  ],
  "type": "object"
}
```

## SharedLinksUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether shared links are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether shared links appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## SharedSpaceActivityResponseDto

Related models: [SharedSpaceEventResponseDto](models-32.md#sharedspaceeventresponsedto).

```json
{
  "properties": {
    "events": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/SharedSpaceEventResponseDto"
      },
      "type": "array"
    },
    "hasMore": {
      "description": "True when older events exist beyond this page",
      "type": "boolean"
    },
    "lastVisitedAt": {
      "description": "When this member last marked the shared space seen; null if they never have",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "unreadCount": {
      "description": "Events by other members since then that this member may see. Capped at 500.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "events",
    "hasMore",
    "lastVisitedAt",
    "unreadCount"
  ],
  "type": "object"
}
```

## SharedSpaceAlbumResponseDto

Related models: [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "albumName": {
      "description": "The linked album name",
      "type": "string"
    },
    "assetCount": {
      "description": "Items that are in both this album and the shared space. Media marked sensitive, and Locked media, are not counted.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "canUnlink": {
      "description": "True when the caller may remove this link",
      "type": "boolean"
    },
    "icon": {
      "description": "Icon: a Material Design Icons name (null = default icon)",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "The linked album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "linkedAt": {
      "description": "When the album was linked",
      "format": "date-time",
      "type": "string"
    },
    "linkedBy": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserResponseDto"
        }
      ],
      "description": "The member who linked this album",
      "nullable": true
    },
    "thumbnailAssetId": {
      "description": "An item that is already in the shared space, used as the tile picture",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumName",
    "assetCount",
    "canUnlink",
    "icon",
    "id",
    "linkedAt",
    "linkedBy",
    "thumbnailAssetId"
  ],
  "type": "object"
}
```

## SharedSpaceAlbumsResponseDto

Related models: [SharedSpaceAlbumResponseDto](models-32.md#sharedspacealbumresponsedto).

```json
{
  "properties": {
    "albums": {
      "description": "Albums linked into the shared space, by name",
      "items": {
        "$ref": "#/components/schemas/SharedSpaceAlbumResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "albums"
  ],
  "type": "object"
}
```

## SharedSpaceCommentCreateDto


```json
{
  "properties": {
    "assetId": {
      "description": "The item to comment on. Left out, the comment is on the space itself.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "comment": {
      "description": "The text. Mention a member with @{userId}; every mention must name a current member.",
      "maxLength": 4000,
      "minLength": 1,
      "type": "string"
    },
    "parentId": {
      "description": "Reply to this comment. Replying to a reply joins the same thread, under its top-level comment. A reply is on the same item as the comment it answers.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "comment"
  ],
  "type": "object"
}
```

## SharedSpaceCommentResponseDto

Related models: [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "assetId": {
      "description": "The item commented on; null for a comment on the space itself",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "canDelete": {
      "description": "True when the caller may remove the comment",
      "type": "boolean"
    },
    "canEdit": {
      "description": "True when the caller may change the text",
      "type": "boolean"
    },
    "comment": {
      "description": "The text, with @{userId} mention tokens",
      "type": "string"
    },
    "createdAt": {
      "description": "When it was written",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Comment ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "mentions": {
      "description": "Members named in the comment",
      "items": {
        "$ref": "#/components/schemas/UserResponseDto"
      },
      "type": "array"
    },
    "parentId": {
      "description": "The top-level comment this reply answers; null for a top-level comment",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "replyCount": {
      "description": "How many replies this comment has that the caller can see; always 0 for a reply",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "updatedAt": {
      "description": "When it was last edited",
      "format": "date-time",
      "type": "string"
    },
    "user": {
      "$ref": "#/components/schemas/UserResponseDto",
      "description": "The author"
    }
  },
  "required": [
    "assetId",
    "canDelete",
    "canEdit",
    "comment",
    "createdAt",
    "id",
    "mentions",
    "parentId",
    "replyCount",
    "updatedAt",
    "user"
  ],
  "type": "object"
}
```

## SharedSpaceCommentUpdateDto


```json
{
  "properties": {
    "comment": {
      "description": "The text. Mention a member with @{userId}; every mention must name a current member.",
      "maxLength": 4000,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "comment"
  ],
  "type": "object"
}
```

## SharedSpaceCommentsResponseDto

Related models: [SharedSpaceCommentResponseDto](models-32.md#sharedspacecommentresponsedto).

```json
{
  "properties": {
    "comments": {
      "description": "Oldest first",
      "items": {
        "$ref": "#/components/schemas/SharedSpaceCommentResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "comments"
  ],
  "type": "object"
}
```

## SharedSpaceEventResponseDto

Related models: [SharedSpaceEventType](models-32.md#sharedspaceeventtype), [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "activityId": {
      "description": "The comment or like this event announces, if any",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "actor": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserResponseDto"
        }
      ],
      "description": "Who did it; null once that account is gone",
      "nullable": true
    },
    "assetCount": {
      "description": "How many of the items this event is about the reader may see",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "assetIds": {
      "description": "The items this event is about that the reader may see and that are still in the shared space. Empty for a removal.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "comment": {
      "description": "The comment text, for a comment or reply event. Mentions are @{userId} tokens.",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "When it happened",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Event ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "mentions": {
      "description": "Members named in the comment",
      "items": {
        "$ref": "#/components/schemas/UserResponseDto"
      },
      "type": "array"
    },
    "subject": {
      "description": "A linked album's or person's name as the space knew it, or the new role; null otherwise",
      "nullable": true,
      "type": "string"
    },
    "targetUser": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserResponseDto"
        }
      ],
      "description": "The member a member event is about, or the author of the comment a reply answers; null otherwise",
      "nullable": true
    },
    "type": {
      "$ref": "#/components/schemas/SharedSpaceEventType"
    }
  },
  "required": [
    "activityId",
    "actor",
    "assetCount",
    "assetIds",
    "comment",
    "createdAt",
    "id",
    "mentions",
    "subject",
    "targetUser",
    "type"
  ],
  "type": "object"
}
```

## SharedSpaceEventType


```json
{
  "description": "Shared space event type",
  "enum": [
    "AssetsAdded",
    "AssetsRemoved",
    "AlbumLinked",
    "AlbumUnlinked",
    "PersonLinked",
    "PersonUnlinked",
    "MemberJoined",
    "MemberLeft",
    "MemberRemoved",
    "MemberRoleChanged",
    "Comment",
    "Reply",
    "Like"
  ],
  "type": "string"
}
```

## SharedSpaceMemberResponseDto

Related models: [AlbumUserRole](models-02.md#albumuserrole), [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "invitedAt": {
      "description": "When a pending invitation was sent",
      "format": "date-time",
      "type": "string"
    },
    "pending": {
      "description": "True while the invitation has not been accepted",
      "type": "boolean"
    },
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    },
    "user": {
      "$ref": "#/components/schemas/UserResponseDto"
    }
  },
  "required": [
    "pending",
    "role",
    "user"
  ],
  "type": "object"
}
```

## SharedSpaceMembersResponseDto

Related models: [SharedSpaceMemberResponseDto](models-32.md#sharedspacememberresponsedto).

```json
{
  "properties": {
    "members": {
      "description": "Members and pending invitations, owner first",
      "items": {
        "$ref": "#/components/schemas/SharedSpaceMemberResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "members"
  ],
  "type": "object"
}
```

## SharedSpaceNewResponseDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Items other members added since then",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "assetIds": {
      "description": "Up to 500 of those items, so the timeline can show exactly what is new",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "lastVisitedAt": {
      "description": "When this member last marked the shared space seen; null if they never have",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "assetIds",
    "lastVisitedAt"
  ],
  "type": "object"
}
```

## SharedSpacePeopleResponseDto

Related models: [PersonResponseDto](models-19.md#personresponsedto), [SharedSpacePersonResponseDto](models-32.md#sharedspacepersonresponsedto).

```json
{
  "properties": {
    "candidates": {
      "description": "People of the caller's own that appear in the shared space and are not linked yet. Only the caller's own people are ever listed here.",
      "items": {
        "$ref": "#/components/schemas/PersonResponseDto"
      },
      "type": "array"
    },
    "linked": {
      "description": "People published into the shared space",
      "items": {
        "$ref": "#/components/schemas/SharedSpacePersonResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "candidates",
    "linked"
  ],
  "type": "object"
}
```

## SharedSpacePersonLinkDto


```json
{
  "properties": {
    "name": {
      "description": "The name the shared space will use. Defaults to the caller's own name for them.",
      "maxLength": 255,
      "type": "string"
    },
    "personId": {
      "description": "A person of the caller's own to publish into the shared space",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "personId"
  ],
  "type": "object"
}
```

## SharedSpacePersonResponseDto

Related models: [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Items in the shared space that show this person. Media marked sensitive, and Locked media, are not counted.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "canUnlink": {
      "description": "True when the caller may remove this link",
      "type": "boolean"
    },
    "coverAssetId": {
      "description": "An item already in the shared space that shows this person, used as the tile picture",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "The link ID. Not a person ID: a person is never disclosed across a space.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "linkedAt": {
      "description": "When the person was linked",
      "format": "date-time",
      "type": "string"
    },
    "linkedBy": {
      "$ref": "#/components/schemas/UserResponseDto",
      "description": "The member who linked this person"
    },
    "name": {
      "description": "The name this shared space uses, independent of the owner's own name for them",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "canUnlink",
    "coverAssetId",
    "id",
    "linkedAt",
    "linkedBy",
    "name"
  ],
  "type": "object"
}
```
