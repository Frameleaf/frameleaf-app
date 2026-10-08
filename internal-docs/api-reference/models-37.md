# Server API models 37

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## TakeoutResponseDto

Related models: [TakeoutAction](models-36.md#takeoutaction), [TakeoutAlbumDto](models-36.md#takeoutalbumdto), [TakeoutCountsDto](models-36.md#takeoutcountsdto), [TakeoutOptionsResponseDto](models-36.md#takeoutoptionsresponsedto), [TakeoutPhase](models-36.md#takeoutphase), [TakeoutSourceResponseDto](models-37.md#takeoutsourceresponsedto), [TakeoutState](models-37.md#takeoutstate).

```json
{
  "properties": {
    "action": {
      "allOf": [
        {
          "$ref": "#/components/schemas/TakeoutAction"
        }
      ],
      "description": "What the latest job did or is doing",
      "nullable": true
    },
    "albums": {
      "items": {
        "$ref": "#/components/schemas/TakeoutAlbumDto"
      },
      "type": "array"
    },
    "counts": {
      "$ref": "#/components/schemas/TakeoutCountsDto"
    },
    "createdAt": {
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "operationId": {
      "description": "The latest job, as Activity lists it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "options": {
      "$ref": "#/components/schemas/TakeoutOptionsResponseDto"
    },
    "phase": {
      "$ref": "#/components/schemas/TakeoutPhase"
    },
    "processed": {
      "description": "Units the latest job has finished",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sources": {
      "items": {
        "$ref": "#/components/schemas/TakeoutSourceResponseDto"
      },
      "type": "array"
    },
    "state": {
      "$ref": "#/components/schemas/TakeoutState"
    },
    "total": {
      "description": "Units the latest job knows of so far; grows while a scan reads its sources",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "updatedAt": {
      "type": "string"
    }
  },
  "required": [
    "action",
    "albums",
    "counts",
    "createdAt",
    "error",
    "errorCode",
    "id",
    "name",
    "operationId",
    "options",
    "phase",
    "processed",
    "sources",
    "state",
    "total",
    "updatedAt"
  ],
  "type": "object"
}
```

## TakeoutRootDto


```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "path": {
      "description": "The directory the administrator permitted",
      "type": "string"
    }
  },
  "required": [
    "id",
    "path"
  ],
  "type": "object"
}
```

## TakeoutRootsResponseDto

Related models: [TakeoutRootDto](models-37.md#takeoutrootdto).

```json
{
  "properties": {
    "roots": {
      "items": {
        "$ref": "#/components/schemas/TakeoutRootDto"
      },
      "type": "array"
    }
  },
  "required": [
    "roots"
  ],
  "type": "object"
}
```

## TakeoutSidecarCandidateDto

Related models: [TakeoutMetadataDto](models-36.md#takeoutmetadatadto).

```json
{
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "metadata": {
      "$ref": "#/components/schemas/TakeoutMetadataDto"
    },
    "path": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "metadata",
    "path"
  ],
  "type": "object"
}
```

## TakeoutSourceKind


```json
{
  "description": "An uploaded archive or a server directory",
  "enum": [
    "zip",
    "directory"
  ],
  "type": "string"
}
```

## TakeoutSourceResponseDto

Related models: [TakeoutSourceKind](models-37.md#takeoutsourcekind).

```json
{
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/TakeoutSourceKind"
    },
    "name": {
      "description": "The archive’s file name, or the directory’s name",
      "type": "string"
    },
    "received": {
      "description": "Bytes staged so far; an upload resumes here",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "rejected": {
      "description": "Entries refused: unsafe names, links or encryption",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "scanned": {
      "description": "Every entry has been read",
      "type": "boolean"
    },
    "size": {
      "description": "Declared archive size in bytes; zero for a directory",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "id",
    "kind",
    "name",
    "received",
    "rejected",
    "scanned",
    "size"
  ],
  "type": "object"
}
```

## TakeoutState


```json
{
  "description": "Where the import is: staging sources, a scan or import job at work, awaiting review, or done",
  "enum": [
    "sources",
    "queued",
    "scanning",
    "review",
    "importing",
    "paused",
    "cancelling",
    "cancelled",
    "failed",
    "completed"
  ],
  "type": "string"
}
```

## TakeoutVerifyChunkDto


```json
{
  "properties": {
    "offset": {
      "description": "Byte offset of the range",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sha256": {
      "description": "SHA-256 of the range, hex",
      "pattern": "^[a-f0-9]{64}$",
      "type": "string"
    },
    "size": {
      "description": "Length of the range",
      "maximum": 8388608,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "offset",
    "sha256",
    "size"
  ],
  "type": "object"
}
```

## TakeoutWarning


```json
{
  "description": "Why an item needs attention",
  "enum": [
    "ambiguous_sidecar",
    "no_sidecar",
    "invalid_sidecar",
    "trashed",
    "locked"
  ],
  "type": "string"
}
```

## TemplateDto


```json
{
  "properties": {
    "template": {
      "description": "Template name",
      "type": "string"
    }
  },
  "required": [
    "template"
  ],
  "type": "object"
}
```

## TemplateResponseDto


```json
{
  "properties": {
    "html": {
      "description": "Template HTML content",
      "type": "string"
    },
    "name": {
      "description": "Template name",
      "type": "string"
    }
  },
  "required": [
    "html",
    "name"
  ],
  "type": "object"
}
```

## TestEmailResponseDto


```json
{
  "properties": {
    "messageId": {
      "description": "Email message ID",
      "type": "string"
    }
  },
  "required": [
    "messageId"
  ],
  "type": "object"
}
```

## TextOverlayParameters

Related models: [TextOverlayPosition](models-37.md#textoverlayposition).

```json
{
  "properties": {
    "color": {
      "default": "#ffffff",
      "description": "Text color in hex format",
      "pattern": "^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$",
      "type": "string"
    },
    "endMs": {
      "description": "Overlay end time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "position": {
      "$ref": "#/components/schemas/TextOverlayPosition"
    },
    "shadow": {
      "description": "Draw a soft drop shadow behind the text",
      "type": "boolean"
    },
    "size": {
      "default": 0.06,
      "description": "Font size as a percentage of video height",
      "format": "double",
      "maximum": 0.2,
      "minimum": 0.01,
      "type": "number"
    },
    "startMs": {
      "description": "Overlay start time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "text": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "x": {
      "description": "Horizontal position as a percentage of video width",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Vertical position as a percentage of video height",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "text",
    "x",
    "y"
  ],
  "type": "object"
}
```

## TextOverlayPosition


```json
{
  "description": "Anchor on a 3 × 3 grid; when set, the text is aligned to it and x/y are ignored",
  "enum": [
    "top-left",
    "top",
    "top-right",
    "left",
    "center",
    "right",
    "bottom-left",
    "bottom",
    "bottom-right"
  ],
  "type": "string"
}
```

## TimeBucketAssetResponseDto

Related models: [AssetLockReason](models-05.md#assetlockreason), [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "city": {
      "description": "Array of city names extracted from EXIF GPS data",
      "items": {
        "nullable": true,
        "type": "string"
      },
      "type": "array"
    },
    "country": {
      "description": "Array of country names extracted from EXIF GPS data",
      "items": {
        "nullable": true,
        "type": "string"
      },
      "type": "array"
    },
    "createdAt": {
      "description": "Array of UTC timestamps when each asset was originally uploaded to Frameleaf",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "duration": {
      "description": "Array of video/gif durations in milliseconds (null for static images)",
      "items": {
        "maximum": 2147483647,
        "minimum": 0,
        "nullable": true,
        "type": "integer"
      },
      "type": "array"
    },
    "endCursor": {
      "description": "Last ordered item cursor; absent for time buckets",
      "nullable": true,
      "type": "string"
    },
    "fileCreatedAt": {
      "description": "Array of file creation timestamps in UTC",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "fileSizeInByte": {
      "description": "Array of file sizes in bytes (null when unknown). Omitted for shared links that hide EXIF",
      "items": {
        "maximum": 9007199254740991,
        "minimum": -9007199254740991,
        "nullable": true,
        "type": "integer"
      },
      "type": "array"
    },
    "height": {
      "description": "Array of heights in pixels (null when unknown). Omitted for shared links that hide EXIF",
      "items": {
        "maximum": 2147483647,
        "minimum": -2147483648,
        "nullable": true,
        "type": "integer"
      },
      "type": "array"
    },
    "id": {
      "description": "Array of asset IDs in the time bucket",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "isFavorite": {
      "description": "Array indicating whether each asset is favorited",
      "items": {
        "type": "boolean"
      },
      "type": "array"
    },
    "isImage": {
      "description": "Array indicating whether each asset is an image (false for videos)",
      "items": {
        "type": "boolean"
      },
      "type": "array"
    },
    "isOffline": {
      "description": "Array indicating whether each asset is offline (its file is missing from an external library)",
      "items": {
        "type": "boolean"
      },
      "type": "array"
    },
    "isTrashed": {
      "description": "Array indicating whether each asset is in the trash",
      "items": {
        "type": "boolean"
      },
      "type": "array"
    },
    "latitude": {
      "description": "Array of latitude coordinates extracted from EXIF GPS data",
      "items": {
        "format": "double",
        "nullable": true,
        "type": "number"
      },
      "type": "array"
    },
    "livePhotoVideoId": {
      "description": "Array of live photo video asset IDs (null for non-live photos)",
      "items": {
        "nullable": true,
        "type": "string"
      },
      "type": "array"
    },
    "localOffsetHours": {
      "description": "Array of UTC offset hours at the time each photo was taken. Positive values are east of UTC, negative values are west of UTC. Values may be fractional (e.g., 5.5 for +05:30, -9.75 for -09:45). Applying this offset to 'fileCreatedAt' will give you the time the photo was taken from the photographer's perspective.",
      "items": {
        "format": "double",
        "type": "number"
      },
      "type": "array"
    },
    "lockReason": {
      "description": "Why each asset is locked, or null when it is not. Returned with visibility LOCKED and for the timeline of an elevated owner, which reveals their marked and detected items",
      "items": {
        "allOf": [
          {
            "$ref": "#/components/schemas/AssetLockReason"
          }
        ],
        "nullable": true
      },
      "type": "array"
    },
    "longitude": {
      "description": "Array of longitude coordinates extracted from EXIF GPS data",
      "items": {
        "format": "double",
        "nullable": true,
        "type": "number"
      },
      "type": "array"
    },
    "originalFileName": {
      "description": "Array of original file names. Omitted for shared links that hide EXIF",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "ownerId": {
      "description": "Array of owner IDs for each asset",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "projectionType": {
      "description": "Array of projection types for 360° content (e.g., \"EQUIRECTANGULAR\", \"CUBEFACE\", \"CYLINDRICAL\")",
      "items": {
        "nullable": true,
        "type": "string"
      },
      "type": "array"
    },
    "rating": {
      "description": "Array of star ratings from EXIF (-1 rejected, 0 unrated, 1-5 stars; null when unknown). Omitted for shared links that hide EXIF",
      "items": {
        "maximum": 5,
        "minimum": -1,
        "nullable": true,
        "type": "integer"
      },
      "type": "array"
    },
    "ratio": {
      "description": "Array of aspect ratios (width/height) for each asset",
      "items": {
        "format": "double",
        "type": "number"
      },
      "type": "array"
    },
    "stack": {
      "description": "Array of stack information as [stackId, assetCount] tuples (null for non-stacked assets)",
      "items": {
        "items": {
          "type": "string"
        },
        "maxItems": 2,
        "minItems": 2,
        "nullable": true,
        "type": "array"
      },
      "type": "array"
    },
    "startCursor": {
      "description": "First ordered item cursor; absent for time buckets",
      "nullable": true,
      "type": "string"
    },
    "thumbhash": {
      "description": "Array of BlurHash strings for generating asset previews (base64 encoded)",
      "items": {
        "nullable": true,
        "type": "string"
      },
      "type": "array"
    },
    "visibility": {
      "description": "Array of visibility statuses for each asset (e.g., ARCHIVE, TIMELINE, HIDDEN, LOCKED)",
      "items": {
        "$ref": "#/components/schemas/AssetVisibility"
      },
      "type": "array"
    },
    "width": {
      "description": "Array of widths in pixels (null when unknown). Omitted for shared links that hide EXIF",
      "items": {
        "maximum": 2147483647,
        "minimum": -2147483648,
        "nullable": true,
        "type": "integer"
      },
      "type": "array"
    }
  },
  "required": [
    "createdAt",
    "duration",
    "fileCreatedAt",
    "id",
    "isFavorite",
    "isImage",
    "isTrashed",
    "livePhotoVideoId",
    "localOffsetHours",
    "ownerId",
    "projectionType",
    "ratio",
    "thumbhash",
    "visibility"
  ],
  "type": "object"
}
```

## TimeBucketDateType


```json
{
  "description": "Date source for timeline bucket grouping",
  "enum": [
    "added",
    "taken"
  ],
  "type": "string"
}
```

## TimeBucketsResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of assets in this time bucket",
      "example": 42,
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "timeBucket": {
      "description": "Time bucket identifier in YYYY-MM-DD format representing the start of the time period",
      "example": "2024-01-01",
      "type": "string"
    }
  },
  "required": [
    "count",
    "timeBucket"
  ],
  "type": "object"
}
```

## TimelineHighlightGrouping


```json
{
  "default": "month",
  "description": "One card per year or per month",
  "enum": [
    "year",
    "month"
  ],
  "type": "string"
}
```

## TimelineHighlightResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of assets in this year or month, the same as the time buckets report",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "highlightAssetIds": {
      "description": "The next best assets in capture order (month cards only), never including the key photo",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "keyAssetId": {
      "description": "Key photo: highest Best Photos score, then highest star rating, then most recent capture",
      "nullable": true,
      "type": "string"
    },
    "places": {
      "description": "Up to three most frequent places (city, else state, else country), busiest first. Empty when the viewer may not see locations",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "timeBucket": {
      "description": "First day of the year or month in YYYY-MM-DD format, as in GET /timeline/buckets",
      "example": "2024-01-01",
      "type": "string"
    }
  },
  "required": [
    "count",
    "highlightAssetIds",
    "keyAssetId",
    "places",
    "timeBucket"
  ],
  "type": "object"
}
```

## TimelineOrderedSort


```json
{
  "description": "filename: by original file name (locale-aware), then newest capture; rating: highest star rating first (unrated counts as 0), then newest capture",
  "enum": [
    "filename",
    "rating"
  ],
  "type": "string"
}
```

## ToggleParameters


```json
{
  "properties": {
    "enabled": {
      "default": true,
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## ToneMapping


```json
{
  "description": "Tone mapping",
  "enum": [
    "hable",
    "mobius",
    "reinhard",
    "disabled"
  ],
  "type": "string"
}
```

## TranscodeHWAccel


```json
{
  "description": "Transcode hardware acceleration",
  "enum": [
    "nvenc",
    "qsv",
    "vaapi",
    "rkmpp",
    "disabled"
  ],
  "type": "string"
}
```

## TranscodePolicy


```json
{
  "description": "Transcode policy",
  "enum": [
    "all",
    "optimal",
    "bitrate",
    "required",
    "disabled"
  ],
  "type": "string"
}
```

## TrashApplyDto

Related models: [TrashReviewAction](models-37.md#trashreviewaction), [UtilityActivityTool](models-38.md#utilityactivitytool).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "ids": {
      "description": "The chosen items, for trash, restore and delete. Ignored by restore-all and empty.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "source": {
      "$ref": "#/components/schemas/UtilityActivityTool",
      "description": "The utility the change was made from. A move to the trash or a restore from Large files is kept in its activity history."
    },
    "token": {
      "description": "The token returned by the review",
      "maxLength": 128,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "action",
    "token"
  ],
  "type": "object"
}
```

## TrashItemResponseDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "fileSizeInByte": {
      "description": "Size of the original, in bytes, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isLocked": {
      "description": "Locked media; only listed for its owner in an unlocked session",
      "type": "boolean"
    },
    "isOffline": {
      "description": "The library scan found this external original missing and manages it; trash actions do not change it",
      "type": "boolean"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "trashedAt": {
      "description": "When the item was moved to the trash",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    }
  },
  "required": [
    "fileSizeInByte",
    "id",
    "isLocked",
    "isOffline",
    "originalFileName",
    "trashedAt",
    "type"
  ],
  "type": "object"
}
```

## TrashItemSort


```json
{
  "description": "Trash order: most recently deleted, largest original, or file name",
  "enum": [
    "recent",
    "size",
    "name"
  ],
  "type": "string"
}
```

## TrashItemsResponseDto

Related models: [TrashItemResponseDto](models-37.md#trashitemresponsedto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/TrashItemResponseDto"
      },
      "type": "array"
    },
    "nextPage": {
      "description": "The next page number, or null on the last page",
      "nullable": true,
      "type": "string"
    },
    "total": {
      "description": "Items matching the filters",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "nextPage",
    "total"
  ],
  "type": "object"
}
```

## TrashResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of items in trash",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "count"
  ],
  "type": "object"
}
```

## TrashReviewAction


```json
{
  "description": "A reviewed change to items in, or into, the trash",
  "enum": [
    "trash",
    "restore",
    "restore-all",
    "delete",
    "empty"
  ],
  "type": "string"
}
```

## TrashReviewDto

Related models: [TrashReviewAction](models-37.md#trashreviewaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "ids": {
      "description": "The chosen items, for trash, restore and delete. Ignored by restore-all and empty.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## TrashReviewResponseDto

Related models: [TrashReviewAction](models-37.md#trashreviewaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TrashReviewAction"
    },
    "bytes": {
      "description": "Combined size of their originals, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "count": {
      "description": "Items the action will change",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "names": {
      "description": "The first file names, alphabetically",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "retainedBytes": {
      "description": "Size of those shared originals, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedOriginals": {
      "description": "Items whose original another item still uses; deleting them does not free that file",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "token": {
      "description": "Fingerprint of the reviewed set; apply refuses when the set has changed",
      "type": "string"
    }
  },
  "required": [
    "action",
    "bytes",
    "count",
    "names",
    "retainedBytes",
    "retainedOriginals",
    "token"
  ],
  "type": "object"
}
```

## TrashSummaryResponseDto


```json
{
  "properties": {
    "bytes": {
      "description": "Combined size of their originals, in bytes. Not the space deleting them frees.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "count": {
      "description": "Items in your trash this session can see",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "offline": {
      "description": "Of those, external-library originals that went missing; the library scan manages them",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "pendingDeletion": {
      "description": "Items already permanently deleted whose files are still being removed from storage",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "bytes",
    "count",
    "offline",
    "pendingDeletion"
  ],
  "type": "object"
}
```

## TrimParameters

Related models: [VideoTrimMode](models-38.md#videotrimmode).

```json
{
  "properties": {
    "endMs": {
      "description": "Trim end time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "mode": {
      "$ref": "#/components/schemas/VideoTrimMode"
    },
    "startMs": {
      "description": "Trim start time in milliseconds",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "endMs",
    "startMs"
  ],
  "type": "object"
}
```

## UpdateAlbumDto

Related models: [AssetOrder](models-05.md#assetorder).

```json
{
  "properties": {
    "albumName": {
      "description": "Album name",
      "type": "string"
    },
    "albumThumbnailAssetId": {
      "description": "Album thumbnail asset ID. Picking an item stops the cover following the newest item.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "coverFollowsNewest": {
      "description": "Always use the newest item as the cover (true), or keep the current cover from now on (false). Cannot be true together with albumThumbnailAssetId.",
      "type": "boolean"
    },
    "description": {
      "description": "Album description",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Sending an empty string is deprecated; send null instead. Empty strings will no longer be coerced to null in v4."
        }
      ]
    },
    "icon": {
      "description": "Icon: any Material Design Icons name (null = clear / use default icon)",
      "maxLength": 80,
      "nullable": true,
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Enable activity feed",
      "type": "boolean"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "parentId": {
      "description": "Collection to move the album into (null = move to top-level, omit = no change)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sortOrder": {
      "description": "Sibling display position. Lower values appear first. Computed by the client as a midpoint.",
      "format": "double",
      "type": "number"
    }
  },
  "type": "object"
}
```

## UpdateAlbumUserDto

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    }
  },
  "required": [
    "role"
  ],
  "type": "object"
}
```

## UpdateAssetDto

Related models: [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "city": {
      "description": "City name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "dateTimeOriginal": {
      "description": "Original date and time",
      "type": "string"
    },
    "description": {
      "description": "Asset description",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "latitude": {
      "description": "Latitude coordinate; null together with a null longitude removes the location",
      "format": "double",
      "maximum": 90,
      "minimum": -90,
      "nullable": true,
      "type": "number"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "longitude": {
      "description": "Longitude coordinate; null together with a null latitude removes the location",
      "format": "double",
      "maximum": 180,
      "minimum": -180,
      "nullable": true,
      "type": "number"
    },
    "rating": {
      "description": "Rating in range [1-5] (starred), -1 (rejected), or null (unrated)",
      "maximum": 5,
      "minimum": -1,
      "nullable": true,
      "type": "integer",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Using 0 as a rating is no longer valid."
        }
      ],
      "x-immich-state": "Stable"
    },
    "state": {
      "description": "State or region name; kept over reverse geocoding until the item is moved again",
      "maxLength": 255,
      "nullable": true,
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    }
  },
  "type": "object"
}
```

## UpdateLibraryDto


```json
{
  "properties": {
    "exclusionPatterns": {
      "description": "Exclusion patterns (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    },
    "importPaths": {
      "description": "Import paths (max 128)",
      "items": {
        "maxLength": 1024,
        "type": "string"
      },
      "maxItems": 128,
      "type": "array"
    },
    "name": {
      "description": "Library name",
      "maxLength": 160,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## UsageByUserDto


```json
{
  "properties": {
    "photos": {
      "description": "Number of photos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "quotaSizeInBytes": {
      "description": "User quota size in bytes (null if unlimited)",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "usage": {
      "description": "Total storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
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
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "userName": {
      "description": "User name",
      "type": "string"
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
    "quotaSizeInBytes",
    "usage",
    "usagePhotos",
    "usageVideos",
    "userId",
    "userName",
    "videos"
  ],
  "type": "object"
}
```

## UserAdminCreateDto

Related models: [UserAvatarColor](models-37.md#useravatarcolor).

```json
{
  "properties": {
    "avatarColor": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserAvatarColor"
        }
      ],
      "nullable": true
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Grant admin privileges",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "notify": {
      "description": "Send notification email",
      "type": "boolean"
    },
    "password": {
      "description": "User password",
      "type": "string"
    },
    "pinCode": {
      "description": "PIN code",
      "example": "123456",
      "nullable": true,
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "email",
    "name",
    "password"
  ],
  "type": "object"
}
```

## UserAdminDeleteDto


```json
{
  "properties": {
    "confirmEmail": {
      "description": "The account's email as the administrator typed it to confirm; when sent, the delete is refused unless it matches (case-insensitive)",
      "maxLength": 320,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "force": {
      "description": "Force delete even if user has assets",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## UserAdminHistoryEventResponseDto

Related models: [AdminAuditAction](models-01.md#adminauditaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AdminAuditAction"
    },
    "actorId": {
      "description": "The administrator who did it; null once that account is gone",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "actorName": {
      "description": "That administrator's name; null once that account is gone",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "When it happened",
      "format": "date-time",
      "type": "string"
    },
    "detail": {
      "description": "What the action carries: a quota in bytes, a storage label, a recovery period in days, a device name or the changed preference sections; null otherwise",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Event ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "libraryId": {
      "description": "The library a library event is about; null for account events and once the library is gone",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "subject": {
      "description": "The account's or library's name at the time",
      "type": "string"
    }
  },
  "required": [
    "action",
    "actorId",
    "actorName",
    "createdAt",
    "detail",
    "id",
    "libraryId",
    "subject"
  ],
  "type": "object"
}
```

## UserAdminHistoryResponseDto

Related models: [UserAdminHistoryEventResponseDto](models-37.md#useradminhistoryeventresponsedto).

```json
{
  "properties": {
    "events": {
      "description": "Newest first",
      "items": {
        "$ref": "#/components/schemas/UserAdminHistoryEventResponseDto"
      },
      "type": "array"
    },
    "hasMore": {
      "description": "True when older events exist beyond this page",
      "type": "boolean"
    }
  },
  "required": [
    "events",
    "hasMore"
  ],
  "type": "object"
}
```

## UserAdminPinCodeStateResponseDto


```json
{
  "properties": {
    "pinCode": {
      "description": "Whether the account has a PIN set",
      "type": "boolean"
    }
  },
  "required": [
    "pinCode"
  ],
  "type": "object"
}
```

## UserAdminResponseDto

Related models: [UserAvatarColor](models-37.md#useravatarcolor), [UserLicense](models-38.md#userlicense), [UserStatus](models-38.md#userstatus).

```json
{
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
    },
    "clusterGroupId": {
      "description": "Cluster group the user is a member of",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deletion date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Is admin user",
      "type": "boolean"
    },
    "license": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserLicense"
        }
      ],
      "nullable": true
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "OAuth ID",
      "type": "string"
    },
    "profileChangedAt": {
      "description": "Profile change date",
      "format": "date-time",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Storage usage in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "status": {
      "$ref": "#/components/schemas/UserStatus"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
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
    "avatarColor",
    "clusterGroupId",
    "createdAt",
    "deletedAt",
    "email",
    "id",
    "isAdmin",
    "license",
    "name",
    "oauthId",
    "profileChangedAt",
    "profileImagePath",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "shouldChangePassword",
    "status",
    "storageLabel",
    "updatedAt"
  ],
  "type": "object"
}
```

## UserAdminUpdateDto

Related models: [UserAvatarColor](models-37.md#useravatarcolor).

```json
{
  "properties": {
    "avatarColor": {
      "allOf": [
        {
          "$ref": "#/components/schemas/UserAvatarColor"
        }
      ],
      "nullable": true
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "isAdmin": {
      "description": "Grant admin privileges",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "password": {
      "description": "User password",
      "type": "string"
    },
    "pinCode": {
      "description": "PIN code",
      "example": "123456",
      "nullable": true,
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Storage quota in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "shouldChangePassword": {
      "description": "Require password change on next login",
      "type": "boolean"
    },
    "storageLabel": {
      "description": "Storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## UserAvatarColor


```json
{
  "description": "User avatar color",
  "enum": [
    "primary",
    "pink",
    "red",
    "yellow",
    "blue",
    "green",
    "purple",
    "orange",
    "gray",
    "amber"
  ],
  "type": "string"
}
```

## UserConfigClipDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigDto

Related models: [UserConfigFFmpegDto](models-37.md#userconfigffmpegdto), [UserConfigFrameleafCloudDto](models-37.md#userconfigframeleafclouddto), [UserConfigImageDto](models-37.md#userconfigimagedto), [UserConfigMachineLearningDto](models-38.md#userconfigmachinelearningdto), [UserConfigMapDto](models-38.md#userconfigmapdto), [UserConfigOAuthDto](models-38.md#userconfigoauthdto), [UserConfigPasswordLoginDto](models-38.md#userconfigpasswordlogindto), [UserConfigReverseGeocodingDto](models-38.md#userconfigreversegeocodingdto), [UserConfigServerDto](models-38.md#userconfigserverdto), [UserConfigThemeDto](models-38.md#userconfigthemedto), [UserConfigTrashDto](models-38.md#userconfigtrashdto), [UserConfigUserDto](models-38.md#userconfiguserdto).

```json
{
  "description": "Configuration properties that are visible to a logged user",
  "properties": {
    "ffmpeg": {
      "$ref": "#/components/schemas/UserConfigFFmpegDto"
    },
    "frameleafCloud": {
      "$ref": "#/components/schemas/UserConfigFrameleafCloudDto"
    },
    "image": {
      "$ref": "#/components/schemas/UserConfigImageDto"
    },
    "machineLearning": {
      "$ref": "#/components/schemas/UserConfigMachineLearningDto"
    },
    "map": {
      "$ref": "#/components/schemas/UserConfigMapDto"
    },
    "oauth": {
      "$ref": "#/components/schemas/UserConfigOAuthDto"
    },
    "passwordLogin": {
      "$ref": "#/components/schemas/UserConfigPasswordLoginDto"
    },
    "reverseGeocoding": {
      "$ref": "#/components/schemas/UserConfigReverseGeocodingDto"
    },
    "server": {
      "$ref": "#/components/schemas/UserConfigServerDto"
    },
    "theme": {
      "$ref": "#/components/schemas/UserConfigThemeDto"
    },
    "trash": {
      "$ref": "#/components/schemas/UserConfigTrashDto"
    },
    "user": {
      "$ref": "#/components/schemas/UserConfigUserDto"
    }
  },
  "required": [
    "ffmpeg",
    "frameleafCloud",
    "image",
    "machineLearning",
    "map",
    "oauth",
    "passwordLogin",
    "reverseGeocoding",
    "server",
    "theme",
    "trash",
    "user"
  ],
  "type": "object"
}
```

## UserConfigDuplicateDetectionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigFFmpegDto

Related models: [UserConfigFFmpegRealtimeDto](models-37.md#userconfigffmpegrealtimedto).

```json
{
  "properties": {
    "realtime": {
      "$ref": "#/components/schemas/UserConfigFFmpegRealtimeDto"
    }
  },
  "required": [
    "realtime"
  ],
  "type": "object"
}
```

## UserConfigFFmpegRealtimeDto

Related models: [HlsVideoResolution](models-13.md#hlsvideoresolution), [VideoCodec](models-38.md#videocodec).

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

## UserConfigFacialRecognitionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    },
    "minFaces": {
      "description": "Minimum number of faces required for recognition",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "enabled",
    "minFaces"
  ],
  "type": "object"
}
```

## UserConfigFrameleafCloudDto

Related models: [UserConfigFrameleafSignInDto](models-37.md#userconfigframeleafsignindto).

```json
{
  "properties": {
    "signIn": {
      "$ref": "#/components/schemas/UserConfigFrameleafSignInDto"
    }
  },
  "required": [
    "signIn"
  ],
  "type": "object"
}
```

## UserConfigFrameleafSignInDto


```json
{
  "properties": {
    "buttonText": {
      "description": "Sign in with Frameleaf button text",
      "maxLength": 100,
      "type": "string"
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

## UserConfigGeneratedFullsizeImageDto


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

## UserConfigGeneratedImageDto


```json
{
  "properties": {
    "size": {
      "description": "Size",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "size"
  ],
  "type": "object"
}
```

## UserConfigImageDescriptionDto


```json
{
  "properties": {
    "enabled": {
      "description": "Whether the task is enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## UserConfigImageDto

Related models: [UserConfigGeneratedFullsizeImageDto](models-37.md#userconfiggeneratedfullsizeimagedto), [UserConfigGeneratedImageDto](models-37.md#userconfiggeneratedimagedto).

```json
{
  "properties": {
    "fullsize": {
      "$ref": "#/components/schemas/UserConfigGeneratedFullsizeImageDto"
    },
    "preview": {
      "$ref": "#/components/schemas/UserConfigGeneratedImageDto"
    },
    "thumbnail": {
      "$ref": "#/components/schemas/UserConfigGeneratedImageDto"
    }
  },
  "required": [
    "fullsize",
    "preview",
    "thumbnail"
  ],
  "type": "object"
}
```
