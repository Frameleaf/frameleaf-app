# Server API models 14

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## KnownAssetDevelopRecipe

Related models: [AssetDevelopCleanup](models-04.md#assetdevelopcleanup), [AssetDevelopMask](models-04.md#assetdevelopmask), [AssetDevelopPreset](models-04.md#assetdeveloppreset), [KnownAssetDevelopCrop](models-13.md#knownassetdevelopcrop).

```json
{
  "properties": {
    "blacks": {
      "default": 0,
      "description": "Black point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "brilliance": {
      "default": 0,
      "description": "FL-233: opens the shadows and holds back the highlights (positive), or the reverse (negative), with a slight colour lift; see the develop recipe protocol",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "clarity": {
      "default": 0,
      "description": "Local contrast in the midtones",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "cleanup": {
      "default": [],
      "description": "FL-233: Clean Up operations, applied in order to the original before every other step",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopCleanup"
      },
      "maxItems": 32,
      "type": "array"
    },
    "contrast": {
      "default": 0,
      "description": "Contrast around middle grey",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "crop": {
      "$ref": "#/components/schemas/KnownAssetDevelopCrop",
      "default": {
        "h": 1,
        "w": 1,
        "x": 0,
        "y": 0
      }
    },
    "dehaze": {
      "default": 0,
      "description": "Haze removal (positive) or addition (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "default": 0,
      "description": "Exposure in EV; each whole stop doubles the light",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "flipHorizontal": {
      "default": false,
      "description": "Mirror left to right",
      "type": "boolean"
    },
    "flipVertical": {
      "default": false,
      "description": "Mirror top to bottom",
      "type": "boolean"
    },
    "grain": {
      "default": 0,
      "description": "Film grain amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "highlights": {
      "default": 0,
      "description": "Highlight recovery (negative) or lift (positive)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "masks": {
      "default": [],
      "description": "Selective adjustments, applied in order after the global develop",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopMask"
      },
      "maxItems": 8,
      "type": "array"
    },
    "noiseReduction": {
      "default": 0,
      "description": "Luminance noise reduction amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "preset": {
      "$ref": "#/components/schemas/AssetDevelopPreset",
      "default": "Original"
    },
    "presetStrength": {
      "default": 100,
      "description": "How much of the preset is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "rotation": {
      "default": 0,
      "description": "Quarter-turn rotation in degrees, clockwise",
      "maximum": 270,
      "minimum": 0,
      "type": "integer"
    },
    "saturation": {
      "default": 0,
      "description": "Global saturation",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "default": 0,
      "description": "Shadow lift (positive) or deepening (negative)",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "sharpen": {
      "default": 0,
      "description": "Detail sharpening amount",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "straighten": {
      "default": 0,
      "description": "Straighten angle in degrees, applied before the crop",
      "format": "double",
      "maximum": 45,
      "minimum": -45,
      "type": "number"
    },
    "temperature": {
      "default": 0,
      "description": "Warm (positive) or cool (negative) white balance shift",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "default": 0,
      "description": "Magenta (positive) or green (negative) tint",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "version": {
      "description": "Recipe contract version",
      "enum": [
        1
      ],
      "format": "double",
      "type": "number"
    },
    "vibrance": {
      "default": 0,
      "description": "Saturation weighted towards muted colours",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vignette": {
      "default": 0,
      "description": "Darkened (positive) or lightened (negative) edges",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "default": 0,
      "description": "White point",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "required": [
    "version"
  ],
  "type": "object"
}
```

## LibraryImportPathReason


```json
{
  "description": "Why an import folder was accepted or refused",
  "enum": [
    "valid",
    "not_absolute",
    "invalid_characters",
    "parent_traversal",
    "upload_folder",
    "contains_upload_folder",
    "not_found",
    "not_directory",
    "not_readable",
    "unavailable",
    "duplicate",
    "nested",
    "other_library"
  ],
  "type": "string"
}
```

## LibraryRemovalDto


```json
{
  "properties": {
    "confirmName": {
      "description": "The library name, typed to confirm",
      "maxLength": 160,
      "minLength": 1,
      "type": "string"
    },
    "reviewToken": {
      "description": "The token from the removal review",
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "confirmName",
    "reviewToken"
  ],
  "type": "object"
}
```

## LibraryRemovalReviewDto


```json
{
  "properties": {
    "albums": {
      "description": "Albums that lose items",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "faces": {
      "description": "Detected faces that will be removed with their items",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "libraryId": {
      "description": "Library ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "Library name, to be typed to confirm",
      "type": "string"
    },
    "offline": {
      "description": "Items already offline",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "originalsKept": {
      "description": "Source files in the import folders are never deleted",
      "type": "boolean"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "photos": {
      "description": "Indexed photos that will be removed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "reviewToken": {
      "description": "Present this to confirm the removal",
      "type": "string"
    },
    "scanActive": {
      "description": "A scan is running and will be stopped",
      "type": "boolean"
    },
    "sharedLinks": {
      "description": "Shared links that lose items",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "description": "Indexed items that will be removed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usage": {
      "description": "Original bytes those items reference",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Indexed videos that will be removed",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "albums",
    "faces",
    "libraryId",
    "name",
    "offline",
    "originalsKept",
    "ownerId",
    "photos",
    "reviewToken",
    "scanActive",
    "sharedLinks",
    "total",
    "usage",
    "videos"
  ],
  "type": "object"
}
```

## LibraryResponseDto

Related models: [LibraryScanResponseDto](models-14.md#libraryscanresponsedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "When removal was confirmed; set while removal is in progress",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "exclusionPatterns": {
      "description": "Exclusion patterns",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "id": {
      "description": "Library ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "importPaths": {
      "description": "Import paths",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "name": {
      "description": "Library name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "refreshedAt": {
      "description": "Last refresh date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "scan": {
      "allOf": [
        {
          "$ref": "#/components/schemas/LibraryScanResponseDto"
        }
      ],
      "description": "The latest scan, or null if the library was never scanned",
      "nullable": true
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "createdAt",
    "deletedAt",
    "exclusionPatterns",
    "id",
    "importPaths",
    "name",
    "ownerId",
    "refreshedAt",
    "scan",
    "updatedAt"
  ],
  "type": "object"
}
```

## LibraryScanPhase


```json
{
  "description": "Scan phase",
  "enum": [
    "crawl",
    "check",
    "done"
  ],
  "type": "string"
}
```

## LibraryScanResponseDto

Related models: [LibraryScanPhase](models-14.md#libraryscanphase), [LibraryScanStopReason](models-14.md#libraryscanstopreason), [MediaOperationStatus](models-15.md#mediaoperationstatus).

```json
{
  "properties": {
    "added": {
      "description": "New items indexed",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "checked": {
      "description": "Indexed items checked against their folder",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the scan was asked for",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "error": {
      "description": "Failure detail for the administrator",
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "description": "Stable failure code",
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "description": "When the scan ended",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "offlined": {
      "description": "Items whose file is missing, marked offline",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "onlined": {
      "description": "Offline items whose file is back",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "operationId": {
      "description": "The scan job, a media operation of kind library_scan",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "pauseRequested": {
      "description": "A pause was asked for and the scan has not reached it yet",
      "type": "boolean"
    },
    "phase": {
      "$ref": "#/components/schemas/LibraryScanPhase"
    },
    "processedUnits": {
      "description": "Files and items handled so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "progress": {
      "description": "Progress, 0 to 100",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "retrying": {
      "description": "The scan failed once and waits for its automatic retry",
      "type": "boolean"
    },
    "startedAt": {
      "description": "When the scan first started",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "stopReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/LibraryScanStopReason"
        }
      ],
      "nullable": true
    },
    "totalUnits": {
      "description": "Files and items known so far; grows while the folders are read",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "updated": {
      "description": "Items whose file changed and are read again",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "added",
    "checked",
    "createdAt",
    "error",
    "errorCode",
    "finishedAt",
    "offlined",
    "onlined",
    "operationId",
    "pauseRequested",
    "phase",
    "processedUnits",
    "progress",
    "retrying",
    "startedAt",
    "status",
    "stopReason",
    "totalUnits",
    "updated"
  ],
  "type": "object"
}
```

## LibraryScanStopReason


```json
{
  "description": "Why the server stopped a scan on its own",
  "enum": [
    "paths_changed",
    "library_removed",
    "owner_deleted"
  ],
  "type": "string"
}
```

## LibrarySetupStatusDto


```json
{
  "properties": {
    "canFinish": {
      "type": "boolean"
    },
    "installation": {
      "type": "string"
    },
    "origin": {
      "enum": [
        "new_import",
        "new_library",
        "restored_library"
      ],
      "type": "string"
    },
    "phase": {
      "enum": [
        "awaiting-account",
        "rescanning",
        "verifying",
        "needs-attention",
        "complete"
      ],
      "type": "string"
    },
    "regeneration": {
      "nullable": true,
      "properties": {
        "blocked": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "completed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "failed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "needsAttention": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "preparedAt": {
          "nullable": true,
          "type": "string"
        },
        "reasons": {
          "items": {
            "type": "string"
          },
          "type": "array"
        },
        "runId": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "startedAt": {
          "nullable": true,
          "type": "string"
        },
        "state": {
          "type": "string"
        },
        "total": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "runId",
        "state",
        "preparedAt",
        "startedAt",
        "completed",
        "total",
        "failed",
        "blocked",
        "needsAttention",
        "reasons"
      ],
      "type": "object"
    },
    "rescanComplete": {
      "type": "boolean"
    },
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "setupRequired": {
      "type": "boolean"
    },
    "sync": {
      "properties": {
        "authenticated": {
          "type": "boolean"
        },
        "catalogComplete": {
          "type": "boolean"
        },
        "previewsReady": {
          "type": "boolean"
        }
      },
      "required": [
        "authenticated",
        "catalogComplete",
        "previewsReady"
      ],
      "type": "object"
    },
    "verificationPassed": {
      "type": "boolean"
    }
  },
  "required": [
    "canFinish",
    "installation",
    "origin",
    "phase",
    "rescanComplete",
    "revision",
    "setupRequired",
    "sync",
    "verificationPassed"
  ],
  "type": "object"
}
```

## LibraryStatsResponseDto


```json
{
  "properties": {
    "photos": {
      "description": "Number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "description": "Total number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usage": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usagePhysical": {
      "description": "Storage usage in bytes, counting each distinct original file once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "photos",
    "total",
    "usage",
    "usagePhysical",
    "videos"
  ],
  "type": "object"
}
```

## LicenseActivateDto


```json
{
  "properties": {
    "key": {
      "description": "A licence key, FL-KXXX-XXXX-XXXX",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "key"
  ],
  "type": "object"
}
```

## LicenseCertificateDto


```json
{
  "properties": {
    "certificate": {
      "description": "The contents of a licence file: the signed certificate, or a JSON file holding it",
      "maxLength": 65536,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "certificate"
  ],
  "type": "object"
}
```

## LicenseEntitlementsDto


```json
{
  "properties": {
    "cloudBackup": {
      "type": "boolean"
    },
    "cloudMl": {
      "type": "boolean"
    },
    "frameleafCloud": {
      "type": "boolean"
    },
    "remoteAccess": {
      "type": "boolean"
    },
    "supporter": {
      "type": "boolean"
    }
  },
  "required": [
    "cloudBackup",
    "cloudMl",
    "frameleafCloud",
    "remoteAccess",
    "supporter"
  ],
  "type": "object"
}
```

## LicenseKind


```json
{
  "description": "server or individual supporter key, or a Frameleaf Cloud plan",
  "enum": [
    "server",
    "individual",
    "plan"
  ],
  "type": "string"
}
```

## LicenseLinkCodeDto


```json
{
  "properties": {
    "code": {
      "description": "A one-time link code from the Frameleaf account site: flc_ and 26 lower-case base32 symbols",
      "pattern": "^flc_[a-z2-7]{26}$",
      "type": "string"
    }
  },
  "required": [
    "code"
  ],
  "type": "object"
}
```

## LicenseLinkCodeKind


```json
{
  "description": "A server key (this server) or a personal key (this account)",
  "enum": [
    "server",
    "individual"
  ],
  "type": "string"
}
```

## LicenseLinkCodeResponseDto

Related models: [LicenseLinkCodeKind](models-14.md#licenselinkcodekind).

```json
{
  "properties": {
    "keyHint": {
      "description": "Last four symbols of the key",
      "nullable": true,
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/LicenseLinkCodeKind"
    }
  },
  "required": [
    "keyHint",
    "kind"
  ],
  "type": "object"
}
```

## LicenseProductDto


```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "kind": {
      "enum": [
        "plan",
        "supporter",
        "credit"
      ],
      "type": "string"
    },
    "period": {
      "enum": [
        "month",
        "year",
        "one-time"
      ],
      "type": "string"
    },
    "priceUsd": {
      "format": "double",
      "type": "number"
    },
    "storeUrl": {
      "description": "Where to buy it; null when no store is configured",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "id",
    "kind",
    "period",
    "priceUsd",
    "storeUrl"
  ],
  "type": "object"
}
```

## LicenseProductsResponseDto

Related models: [LicenseProductDto](models-14.md#licenseproductdto).

```json
{
  "properties": {
    "backup": {
      "description": "Cloud backup a plan includes, and the blocks and monthly rate for more",
      "properties": {
        "blockTb": {
          "format": "double",
          "type": "number"
        },
        "includedTb": {
          "format": "double",
          "type": "number"
        },
        "usdPerTbMonth": {
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "includedTb",
        "blockTb",
        "usdPerTbMonth"
      ],
      "type": "object"
    },
    "credit": {
      "description": "AI credit top-ups the store accepts; credit is never discounted",
      "properties": {
        "maximumUsd": {
          "format": "double",
          "type": "number"
        },
        "minimumUsd": {
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "minimumUsd",
        "maximumUsd"
      ],
      "type": "object"
    },
    "currency": {
      "enum": [
        "USD"
      ],
      "type": "string"
    },
    "licensedDiscount": {
      "description": "Share taken off plans on a licensed server: what Frameleaf Cloud last published, else the bundled share. Never AI credit or extra backup",
      "format": "double",
      "type": "number"
    },
    "pricesVersion": {
      "description": "Version of the plan prices in force: published by Frameleaf Cloud, else the bundled snapshot",
      "type": "string"
    },
    "products": {
      "items": {
        "$ref": "#/components/schemas/LicenseProductDto"
      },
      "type": "array"
    },
    "storeUrl": {
      "description": "The store this server was deployed with; null when there is none",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "backup",
    "credit",
    "currency",
    "licensedDiscount",
    "pricesVersion",
    "products",
    "storeUrl"
  ],
  "type": "object"
}
```

## LicenseResponseDto

Related models: [UserLicense](models-36.md#userlicense).

```json
{
  "$ref": "#/components/schemas/UserLicense"
}
```

## LicenseSlotDto

Related models: [LicenseKind](models-14.md#licensekind), [LicenseState](models-14.md#licensestate).

```json
{
  "properties": {
    "activatedAt": {
      "description": "When this server received the certificate",
      "type": "string"
    },
    "expiresAt": {
      "description": "When the certificate or its period ends; null for a lifetime key",
      "nullable": true,
      "type": "string"
    },
    "graceUntil": {
      "nullable": true,
      "type": "string"
    },
    "keyHint": {
      "description": "Last four symbols of the key, for a key activation",
      "nullable": true,
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/LicenseKind"
    },
    "refreshedAt": {
      "nullable": true,
      "type": "string"
    },
    "source": {
      "description": "Activated by key, installed from a file, or from the account",
      "enum": [
        "key",
        "file",
        "account"
      ],
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/LicenseState"
    }
  },
  "required": [
    "activatedAt",
    "expiresAt",
    "graceUntil",
    "keyHint",
    "kind",
    "refreshedAt",
    "source",
    "state"
  ],
  "type": "object"
}
```

## LicenseState


```json
{
  "description": "none: no licence; active; grace: renewal failed and cloud features keep working until graceUntil; expired: cloud features are paused, local features are unaffected; invalid: the stored certificate no longer verifies",
  "enum": [
    "none",
    "active",
    "grace",
    "expired",
    "invalid"
  ],
  "type": "string"
}
```

## LicenseStatusResponseDto

Related models: [LicenseEntitlementsDto](models-14.md#licenseentitlementsdto), [LicenseKind](models-14.md#licensekind), [LicenseSlotDto](models-14.md#licenseslotdto), [LicenseState](models-14.md#licensestate).

```json
{
  "properties": {
    "configured": {
      "description": "Frameleaf Cloud is set up on this server (FRAMELEAF_CLOUD_URL)",
      "type": "boolean"
    },
    "entitlements": {
      "$ref": "#/components/schemas/LicenseEntitlementsDto"
    },
    "expiresAt": {
      "nullable": true,
      "type": "string"
    },
    "fingerprint": {
      "description": "What a licence is bound to: this server’s instance ID and key thumbprint",
      "properties": {
        "instanceId": {
          "nullable": true,
          "type": "string"
        },
        "jkt": {
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "instanceId",
        "jkt"
      ],
      "type": "object"
    },
    "graceUntil": {
      "nullable": true,
      "type": "string"
    },
    "key": {
      "allOf": [
        {
          "$ref": "#/components/schemas/LicenseSlotDto"
        }
      ],
      "description": "The supporter key held by this server",
      "nullable": true
    },
    "keyHint": {
      "nullable": true,
      "type": "string"
    },
    "kind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/LicenseKind"
        }
      ],
      "nullable": true
    },
    "licensed": {
      "description": "A supporter key or plan is active or in grace; plans then cost less by licensedDiscount on license/products",
      "type": "boolean"
    },
    "linked": {
      "description": "This server is linked to a Frameleaf account",
      "type": "boolean"
    },
    "offline": {
      "description": "The licence came from a file and is not refreshed online",
      "type": "boolean"
    },
    "plan": {
      "allOf": [
        {
          "$ref": "#/components/schemas/LicenseSlotDto"
        }
      ],
      "description": "The Frameleaf Cloud plan held by this server",
      "nullable": true
    },
    "refresh": {
      "description": "The daily certificate refresh",
      "properties": {
        "lastError": {
          "nullable": true,
          "type": "string"
        },
        "nextRefreshAt": {
          "nullable": true,
          "type": "string"
        },
        "refreshedAt": {
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "refreshedAt",
        "nextRefreshAt",
        "lastError"
      ],
      "type": "object"
    },
    "state": {
      "$ref": "#/components/schemas/LicenseState",
      "description": "The overall state: the plan’s when there is one, else the key’s"
    }
  },
  "required": [
    "configured",
    "entitlements",
    "expiresAt",
    "fingerprint",
    "graceUntil",
    "key",
    "keyHint",
    "kind",
    "licensed",
    "linked",
    "offline",
    "plan",
    "refresh",
    "state"
  ],
  "type": "object"
}
```

## LivePhotoCandidateDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [LivePhotoMatchConfidence](models-14.md#livephotomatchconfidence).

```json
{
  "properties": {
    "confidence": {
      "$ref": "#/components/schemas/LivePhotoMatchConfidence"
    },
    "matchReason": {
      "description": "Why these two assets are believed to be a separated live photo pair",
      "type": "string"
    },
    "photo": {
      "$ref": "#/components/schemas/AssetResponseDto"
    },
    "video": {
      "$ref": "#/components/schemas/AssetResponseDto"
    }
  },
  "required": [
    "confidence",
    "matchReason",
    "photo",
    "video"
  ],
  "type": "object"
}
```

## LivePhotoCandidatesResponseDto

Related models: [LivePhotoCandidateDto](models-14.md#livephotocandidatedto).

```json
{
  "properties": {
    "candidates": {
      "items": {
        "$ref": "#/components/schemas/LivePhotoCandidateDto"
      },
      "type": "array"
    },
    "suggestionsEnabled": {
      "description": "Library care suggests Live Photo pairs; when false no pairs are looked for",
      "type": "boolean"
    },
    "total": {
      "description": "Total number of candidate pairs found",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "candidates",
    "suggestionsEnabled",
    "total"
  ],
  "type": "object"
}
```

## LivePhotoMatchConfidence


```json
{
  "enum": [
    "high",
    "low"
  ],
  "type": "string"
}
```

## LivePhotoRelinkDto

Related models: [LivePhotoRelinkItemDto](models-14.md#livephotorelinkitemdto).

```json
{
  "properties": {
    "pairs": {
      "items": {
        "$ref": "#/components/schemas/LivePhotoRelinkItemDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "pairs"
  ],
  "type": "object"
}
```

## LivePhotoRelinkItemDto


```json
{
  "properties": {
    "photoId": {
      "description": "Still image asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "videoId": {
      "description": "Motion video asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "photoId",
    "videoId"
  ],
  "type": "object"
}
```

## LivePhotoRelinkResponseDto

Related models: [LivePhotoRelinkResultDto](models-14.md#livephotorelinkresultdto).

```json
{
  "properties": {
    "results": {
      "items": {
        "$ref": "#/components/schemas/LivePhotoRelinkResultDto"
      },
      "type": "array"
    }
  },
  "required": [
    "results"
  ],
  "type": "object"
}
```

## LivePhotoRelinkResultDto


```json
{
  "properties": {
    "error": {
      "type": "string"
    },
    "photoId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "success": {
      "type": "boolean"
    },
    "videoId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "photoId",
    "success",
    "videoId"
  ],
  "type": "object"
}
```

## LivePhotoUploadCommitDto


```json
{
  "properties": {
    "stillResourceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "videoResourceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "stillResourceId",
    "videoResourceId"
  ],
  "type": "object"
}
```

## LivePhotoUploadResultDto

Related models: [AssetUploadResultDto](models-06.md#assetuploadresultdto).

```json
{
  "properties": {
    "still": {
      "$ref": "#/components/schemas/AssetUploadResultDto"
    },
    "video": {
      "$ref": "#/components/schemas/AssetUploadResultDto"
    }
  },
  "required": [
    "still",
    "video"
  ],
  "type": "object"
}
```

## LogLevel


```json
{
  "description": "Log level",
  "enum": [
    "verbose",
    "debug",
    "log",
    "warn",
    "error",
    "fatal"
  ],
  "type": "string"
}
```

## LoginCredentialDto


```json
{
  "properties": {
    "email": {
      "description": "User email",
      "example": "testuser@email.com",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "password": {
      "description": "User password",
      "example": "password",
      "type": "string"
    },
    "rememberMe": {
      "description": "Persist authentication cookies across browser sessions (default true)",
      "type": "boolean"
    }
  },
  "required": [
    "email",
    "password"
  ],
  "type": "object"
}
```

## LoginResponseDto


```json
{
  "properties": {
    "accessToken": {
      "description": "Access token",
      "type": "string"
    },
    "isAdmin": {
      "description": "Is admin user",
      "type": "boolean"
    },
    "isOnboarded": {
      "description": "Is onboarded",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    },
    "shouldChangePassword": {
      "description": "Should change password",
      "type": "boolean"
    },
    "userEmail": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "accessToken",
    "isAdmin",
    "isOnboarded",
    "name",
    "profileImagePath",
    "shouldChangePassword",
    "userEmail",
    "userId"
  ],
  "type": "object"
}
```

## LogoutResponseDto


```json
{
  "properties": {
    "redirectUri": {
      "description": "Redirect URI",
      "type": "string"
    },
    "successful": {
      "description": "Logout successful",
      "type": "boolean"
    }
  },
  "required": [
    "redirectUri",
    "successful"
  ],
  "type": "object"
}
```

## LookParameters


```json
{
  "properties": {
    "intensity": {
      "default": 100,
      "description": "Filter or effect intensity",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "name": {
      "description": "Filter or effect name",
      "maxLength": 64,
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

## MachineLearningHardwareAcceleration


```json
{
  "description": "Machine learning hardware acceleration backend",
  "enum": [
    "auto",
    "openvino",
    "cuda"
  ],
  "type": "string"
}
```

## MachineLearningHardwareResponseDto

Related models: [MachineLearningHardwareAcceleration](models-14.md#machinelearninghardwareacceleration).

```json
{
  "properties": {
    "cudaDeviceCount": {
      "description": "Available PyTorch CUDA device count",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "openvinoDeviceIds": {
      "description": "Available OpenVINO device IDs",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "preferredAcceleration": {
      "$ref": "#/components/schemas/MachineLearningHardwareAcceleration",
      "description": "Detected preferred hardware acceleration"
    },
    "providers": {
      "description": "Available ONNX Runtime providers",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "torchCudaAvailable": {
      "description": "Whether PyTorch CUDA is available",
      "type": "boolean"
    }
  },
  "required": [
    "cudaDeviceCount",
    "openvinoDeviceIds",
    "preferredAcceleration",
    "providers",
    "torchCudaAvailable"
  ],
  "type": "object"
}
```

## MaintenanceAction


```json
{
  "description": "Maintenance action",
  "enum": [
    "start",
    "end",
    "select_database_restore",
    "restore_database"
  ],
  "type": "string"
}
```

## MaintenanceAuthDto


```json
{
  "properties": {
    "username": {
      "description": "Maintenance username",
      "type": "string"
    }
  },
  "required": [
    "username"
  ],
  "type": "object"
}
```

## MaintenanceDetectInstallResponseDto

Related models: [MaintenanceDetectInstallStorageFolderDto](models-14.md#maintenancedetectinstallstoragefolderdto).

```json
{
  "properties": {
    "storage": {
      "items": {
        "$ref": "#/components/schemas/MaintenanceDetectInstallStorageFolderDto"
      },
      "type": "array"
    }
  },
  "required": [
    "storage"
  ],
  "type": "object"
}
```

## MaintenanceDetectInstallStorageFolderDto

Related models: [StorageFolder](models-31.md#storagefolder).

```json
{
  "properties": {
    "files": {
      "description": "Number of files in the folder",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "folder": {
      "$ref": "#/components/schemas/StorageFolder"
    },
    "readable": {
      "description": "Whether the folder is readable",
      "type": "boolean"
    },
    "writable": {
      "description": "Whether the folder is writable",
      "type": "boolean"
    }
  },
  "required": [
    "files",
    "folder",
    "readable",
    "writable"
  ],
  "type": "object"
}
```

## MaintenanceLoginDto


```json
{
  "properties": {
    "token": {
      "description": "Maintenance token",
      "type": "string"
    }
  },
  "type": "object"
}
```

## MaintenanceStatusResponseDto

Related models: [MaintenanceAction](models-14.md#maintenanceaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MaintenanceAction"
    },
    "active": {
      "type": "boolean"
    },
    "error": {
      "type": "string"
    },
    "progress": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "reason": {
      "description": "Why the server is in maintenance, as set by the administrator (public)",
      "type": "string"
    },
    "task": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "active"
  ],
  "type": "object"
}
```

## ManagedUploadsStatsResponseDto


```json
{
  "properties": {
    "ownerId": {
      "description": "Account whose uploads these are",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "photos": {
      "description": "Number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "description": "Total number of assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usage": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "usagePhysical": {
      "description": "Storage usage in bytes, counting each distinct original file once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "videos": {
      "description": "Number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "ownerId",
    "photos",
    "total",
    "usage",
    "usagePhysical",
    "videos"
  ],
  "type": "object"
}
```

## ManualJobName


```json
{
  "description": "Manual job name",
  "enum": [
    "person-cleanup",
    "tag-cleanup",
    "user-cleanup",
    "memory-cleanup",
    "memory-create",
    "backup-database",
    "best-photos-backfill",
    "physical-deduplication-dry-run",
    "physical-deduplication-apply",
    "integrity-missing-files",
    "integrity-untracked-files",
    "integrity-checksum-mismatch",
    "integrity-missing-files-refresh",
    "integrity-untracked-files-refresh",
    "integrity-checksum-mismatch-refresh",
    "integrity-missing-files-delete-all",
    "integrity-untracked-files-delete-all",
    "integrity-checksum-mismatch-delete-all",
    "analytics-collect"
  ],
  "type": "string"
}
```

## MapMarkerResponseDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "city": {
      "description": "City name",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name",
      "nullable": true,
      "type": "string"
    },
    "fileCreatedAt": {
      "description": "UTC timestamp when the asset was captured",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "lat": {
      "description": "Latitude",
      "format": "double",
      "type": "number"
    },
    "localDateTime": {
      "description": "Capture date and time in the local time zone where it was taken, encoded as UTC",
      "format": "date-time",
      "type": "string"
    },
    "lon": {
      "description": "Longitude",
      "format": "double",
      "type": "number"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "state": {
      "description": "State/Province name",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    }
  },
  "required": [
    "city",
    "country",
    "id",
    "lat",
    "lon",
    "state"
  ],
  "type": "object"
}
```

## MapReverseGeocodeResponseDto


```json
{
  "properties": {
    "city": {
      "description": "City name",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "description": "State/Province name",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "city",
    "country",
    "state"
  ],
  "type": "object"
}
```

## MapStatisticsResponseDto


```json
{
  "properties": {
    "archived": {
      "description": "The viewer's own located archived items",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "partner": {
      "description": "Always 0: partners' items arrive as the viewer's own copies (kept for older clients)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "unlocated": {
      "description": "The viewer's own timeline items without a location",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "archived",
    "partner",
    "unlocated"
  ],
  "type": "object"
}
```

## MediaHealthActivityAction


```json
{
  "description": "What the job did",
  "enum": [
    "scan",
    "locate",
    "relink-missing-media",
    "recover-damaged-media",
    "trash-damaged-media"
  ],
  "type": "string"
}
```

## MediaHealthActivityDto

Related models: [MediaHealthActivityAction](models-14.md#mediahealthactivityaction), [MediaOperationStatus](models-15.md#mediaoperationstatus).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaHealthActivityAction"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "items": {
      "description": "Items the job covered",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "action",
    "createdAt",
    "finishedAt",
    "id",
    "items",
    "status"
  ],
  "type": "object"
}
```

## MediaHealthBucketDto

Related models: [MediaHealthItemDto](models-15.md#mediahealthitemdto).

```json
{
  "properties": {
    "count": {
      "description": "Number of findings in the bucket",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthItemDto"
      },
      "type": "array"
    },
    "timeBucket": {
      "description": "Timeline bucket date",
      "type": "string"
    }
  },
  "required": [
    "count",
    "items",
    "timeBucket"
  ],
  "type": "object"
}
```

## MediaHealthBulkActionDto


```json
{
  "properties": {
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```
