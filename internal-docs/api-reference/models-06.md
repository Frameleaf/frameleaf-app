# Server API models 6

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## AssetOrder


```json
{
  "description": "Asset sort order",
  "enum": [
    "asc",
    "desc"
  ],
  "type": "string"
}
```

## AssetOrderBy


```json
{
  "description": "Asset sorting property",
  "enum": [
    "takenAt",
    "createdAt"
  ],
  "type": "string"
}
```

## AssetRejectReason


```json
{
  "description": "Rejection reason if rejected",
  "enum": [
    "duplicate",
    "unsupported-format"
  ],
  "type": "string"
}
```

## AssetResponseDto

Related models: [AssetStackResponseDto](models-06.md#assetstackresponsedto), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ExifResponseDto](models-11.md#exifresponsedto), [ImageEncodingInfo](models-14.md#imageencodinginfo), [LandmarkSummaryDto](models-15.md#landmarksummarydto), [PartnerOriginDto](models-19.md#partnerorigindto), [PersonResponseDto](models-19.md#personresponsedto), [TagResponseDto](models-38.md#tagresponsedto), [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "checksum": {
      "description": "Base64-encoded file checksum. SHA-256 (44 chars) for assets uploaded after the SHA-256 transition; SHA-1 (28 chars) for legacy assets. Use the asset `checksumAlgorithm` field to disambiguate when length-based detection is insufficient.",
      "type": "string"
    },
    "createdAt": {
      "description": "The UTC timestamp when the asset was originally uploaded to Frameleaf.",
      "format": "date-time",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duration": {
      "description": "Video/gif duration in milliseconds (null for static images)",
      "maximum": 2147483647,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exifInfo": {
      "$ref": "#/components/schemas/ExifResponseDto"
    },
    "fileCreatedAt": {
      "description": "The actual UTC timestamp when the file was created/captured, preserving timezone information. This is the authoritative timestamp for chronological sorting within timeline groups. Combined with timezone data, this can be used to determine the exact moment the photo was taken.",
      "format": "date-time",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "The UTC timestamp when the file was last modified on the filesystem. This reflects the last time the physical file was changed, which may be different from when the photo was originally taken.",
      "format": "date-time",
      "type": "string"
    },
    "hasMetadata": {
      "description": "Whether asset has metadata",
      "type": "boolean"
    },
    "height": {
      "description": "Asset height",
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
    "imageEncoding": {
      "$ref": "#/components/schemas/ImageEncodingInfo",
      "description": "Source image color encoding; unprocessed or unavailable evidence remains unknown"
    },
    "imageRenditions": {
      "description": "Available current still renditions; omitted when file evidence was not loaded",
      "properties": {
        "hdrFullsize": {
          "type": "boolean"
        },
        "hdrPreview": {
          "type": "boolean"
        },
        "sdrFullsize": {
          "type": "boolean"
        },
        "sdrPreview": {
          "type": "boolean"
        }
      },
      "required": [
        "sdrPreview",
        "sdrFullsize",
        "hdrPreview",
        "hdrFullsize"
      ],
      "type": "object"
    },
    "isArchived": {
      "description": "Is archived",
      "type": "boolean"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v2.5.0",
          "state": "Added"
        },
        {
          "version": "v2.5.0",
          "state": "Beta"
        }
      ],
      "x-immich-state": "Beta"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "isOffline": {
      "description": "Is offline",
      "type": "boolean"
    },
    "isTrashed": {
      "description": "Is trashed",
      "type": "boolean"
    },
    "landmarks": {
      "description": "Landmarks this asset was taken at, the most specific first. Only on the single-asset response.",
      "items": {
        "$ref": "#/components/schemas/LandmarkSummaryDto"
      },
      "type": "array"
    },
    "libraryId": {
      "description": "Library ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "The local date and time when the photo/video was taken, derived from EXIF metadata. This represents the photographer's local time regardless of timezone, stored as a timezone-agnostic timestamp. Used for timeline grouping by \"local\" days and months.",
      "format": "date-time",
      "type": "string"
    },
    "origin": {
      "$ref": "#/components/schemas/PartnerOriginDto",
      "description": "FL-326: present on your own asset when partner sharing copied it from another library (GET /assets/{id})"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "originalMimeType": {
      "description": "Original MIME type",
      "type": "string"
    },
    "originalPath": {
      "description": "Original file path",
      "type": "string"
    },
    "owner": {
      "$ref": "#/components/schemas/UserResponseDto"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "people": {
      "items": {
        "$ref": "#/components/schemas/PersonResponseDto"
      },
      "type": "array"
    },
    "resized": {
      "description": "Is resized",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1.113.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "stack": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AssetStackResponseDto"
        }
      ],
      "nullable": true
    },
    "tags": {
      "items": {
        "$ref": "#/components/schemas/TagResponseDto"
      },
      "type": "array"
    },
    "thumbhash": {
      "description": "Thumbhash for thumbnail generation (base64) also used as the c query param for thumbnail cache busting.",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "updatedAt": {
      "description": "The UTC timestamp when the asset record was last updated in the database. This is automatically maintained by the database and reflects when any field in the asset was last modified.",
      "format": "date-time",
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "checksum",
    "createdAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "hasMetadata",
    "height",
    "id",
    "isArchived",
    "isEdited",
    "isFavorite",
    "isOffline",
    "isTrashed",
    "localDateTime",
    "originalFileName",
    "originalPath",
    "ownerId",
    "thumbhash",
    "type",
    "updatedAt",
    "visibility",
    "width"
  ],
  "type": "object"
}
```

## AssetRestorationDestinationDto

Related models: [AssetRestorationEstimateDto](models-06.md#assetrestorationestimatedto), [MlAdmissionRefusal](models-18.md#mladmissionrefusal), [MlDestinationHealth](models-18.md#mldestinationhealth), [MlDestinationKind](models-18.md#mldestinationkind).

```json
{
  "properties": {
    "available": {
      "description": "The server would admit this workload on this destination right now",
      "type": "boolean"
    },
    "consentGranted": {
      "description": "True when no consent is needed or an administrator recorded it",
      "type": "boolean"
    },
    "consentRequired": {
      "type": "boolean"
    },
    "estimate": {
      "$ref": "#/components/schemas/AssetRestorationEstimateDto"
    },
    "gpu": {
      "description": "The GPU a home restoration worker reported at its last check, for the model slider (FL-159); null otherwise",
      "nullable": true,
      "properties": {
        "memoryTotalBytes": {
          "format": "double",
          "type": "number"
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "name",
        "memoryTotalBytes"
      ],
      "type": "object"
    },
    "health": {
      "$ref": "#/components/schemas/MlDestinationHealth"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "leavesNetwork": {
      "description": "Media sent to this destination leaves the network",
      "type": "boolean"
    },
    "name": {
      "type": "string"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlAdmissionRefusal"
        }
      ],
      "description": "Why the destination cannot be chosen, or null",
      "nullable": true
    },
    "refusalDetail": {
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "available",
    "consentGranted",
    "consentRequired",
    "estimate",
    "gpu",
    "health",
    "id",
    "kind",
    "leavesNetwork",
    "name",
    "refusal",
    "refusalDetail"
  ],
  "type": "object"
}
```

## AssetRestorationEstimateDto


```json
{
  "properties": {
    "bytesPerSecond": {
      "description": "Measured upload throughput for this destination and workload, or null with no samples",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fullBytes": {
      "description": "Approximate bytes the full render sends",
      "format": "double",
      "type": "number"
    },
    "fullSeconds": {
      "description": "Estimated full render time from measured throughput, or null when nothing is measured",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "previewBytes": {
      "description": "Approximate bytes the preview sends",
      "format": "double",
      "type": "number"
    },
    "previewSeconds": {
      "description": "Estimated preview time from measured throughput, or null when nothing is measured",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "sampleCount": {
      "description": "Successful requests the throughput was measured from",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "windowDays": {
      "description": "Length of the measurement window",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "bytesPerSecond",
    "fullBytes",
    "fullSeconds",
    "previewBytes",
    "previewSeconds",
    "sampleCount",
    "windowDays"
  ],
  "type": "object"
}
```

## AssetRestorationFileKind


```json
{
  "description": "Which file of a restoration to fetch",
  "enum": [
    "before",
    "after",
    "result",
    "result_preview"
  ],
  "type": "string"
}
```

## AssetRestorationListResponseDto

Related models: [AssetRestorationResponseDto](models-06.md#assetrestorationresponsedto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "currentRestorationId": {
      "description": "The restoration the owner chose as the playback version; null means the original",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "items": {
      "description": "Every restoration of the asset, newest first",
      "items": {
        "$ref": "#/components/schemas/AssetRestorationResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "assetId",
    "currentRestorationId",
    "items"
  ],
  "type": "object"
}
```

## AssetRestorationMode


```json
{
  "description": "Restoration model family",
  "enum": [
    "faithful",
    "creative",
    "smooth_motion"
  ],
  "type": "string"
}
```

## AssetRestorationOptionsDto

Related models: [AssetRestorationDestinationDto](models-06.md#assetrestorationdestinationdto), [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationRoute](models-06.md#assetrestorationroute), [AssetRestorationSourceType](models-06.md#assetrestorationsourcetype), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "adapterInstalled": {
      "description": "Always true since the restoration adapter ships with the server; whether a model can run is reported per destination.",
      "type": "boolean"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "destinations": {
      "items": {
        "$ref": "#/components/schemas/AssetRestorationDestinationDto"
      },
      "type": "array"
    },
    "durationSeconds": {
      "description": "Video length; null for stills",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode"
    },
    "outputHeight": {
      "description": "Height the full render would produce after the 4K cap",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "outputWidth": {
      "description": "Width the full render would produce after the 4K cap",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "previewSeconds": {
      "description": "Length of a video preview clip; null for stills",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "route": {
      "$ref": "#/components/schemas/AssetRestorationRoute",
      "description": "Where each job runs for this kind of work: Local only, Both or Cloud only (FL-159). Frameleaf Cloud is never chosen silently."
    },
    "sourceHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sourceType": {
      "$ref": "#/components/schemas/AssetRestorationSourceType"
    },
    "sourceWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "upscale": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "adapterInstalled",
    "assetId",
    "destinations",
    "durationSeconds",
    "mode",
    "outputHeight",
    "outputWidth",
    "previewSeconds",
    "route",
    "sourceHeight",
    "sourceType",
    "sourceWidth",
    "upscale",
    "workload"
  ],
  "type": "object"
}
```

## AssetRestorationRegionDto


```json
{
  "properties": {
    "h": {
      "description": "Preview area height as a fraction of the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0.1,
      "type": "number"
    },
    "startSeconds": {
      "description": "Video only: where the preview clip starts. Ignored for stills.",
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "w": {
      "description": "Preview area width as a fraction of the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0.1,
      "type": "number"
    },
    "x": {
      "description": "Left edge of the preview area as a fraction of the frame width",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Top edge of the preview area as a fraction of the frame height",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "h",
    "w",
    "x",
    "y"
  ],
  "type": "object"
}
```

## AssetRestorationRequestDto

Related models: [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationRegionDto](models-06.md#assetrestorationregiondto).

```json
{
  "properties": {
    "destinationId": {
      "description": "The processing destination this restoration runs on. Required; never inferred.",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepGrain": {
      "default": false,
      "description": "Preserve fine film grain instead of smoothing it",
      "type": "boolean"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode"
    },
    "region": {
      "$ref": "#/components/schemas/AssetRestorationRegionDto",
      "default": {
        "h": 0.5,
        "w": 0.5,
        "x": 0.25,
        "y": 0.25
      }
    },
    "smoothMotionFactor": {
      "anyOf": [
        {
          "type": "number",
          "format": "double",
          "enum": [
            2
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            4
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            8
          ]
        }
      ],
      "description": "Smooth motion only (FL-162): how many frames each frame becomes. Required for smooth_motion, refused otherwise."
    },
    "upscale": {
      "anyOf": [
        {
          "type": "number",
          "format": "double",
          "enum": [
            1
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            2
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            4
          ]
        }
      ],
      "default": 2,
      "description": "Upscale factor. Output is additionally capped at 4K."
    }
  },
  "required": [
    "destinationId",
    "mode"
  ],
  "type": "object"
}
```

## AssetRestorationResponseDto

Related models: [AssetRestorationEstimateDto](models-06.md#assetrestorationestimatedto), [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationRegionDto](models-06.md#assetrestorationregiondto), [AssetRestorationSourceType](models-06.md#assetrestorationsourcetype), [AssetRestorationStatus](models-06.md#assetrestorationstatus), [MlDestinationKind](models-18.md#mldestinationkind), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "activeOperationId": {
      "description": "The job currently running for this restoration, for cancel and retry; null when idle",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "destinationId": {
      "description": "The bound destination, or null once an administrator removed it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "destinationKind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "destinationName": {
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "estimate": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AssetRestorationEstimateDto"
        }
      ],
      "nullable": true
    },
    "fullOperationId": {
      "description": "The durable job that renders the full result",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "hasPreview": {
      "description": "Both preview files exist",
      "type": "boolean"
    },
    "hasResult": {
      "description": "The full-resolution result exists",
      "type": "boolean"
    },
    "id": {
      "description": "Restoration ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isCurrent": {
      "description": "The owner chose this result as the asset’s playback version",
      "type": "boolean"
    },
    "keepGrain": {
      "type": "boolean"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode"
    },
    "modelName": {
      "description": "Model the adapter reported, for provenance",
      "nullable": true,
      "type": "string"
    },
    "modelVersion": {
      "nullable": true,
      "type": "string"
    },
    "outputHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "outputWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "previewExpiresAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "previewOperationId": {
      "description": "The durable job that rendered the preview",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "previewReadyAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "previewRegion": {
      "$ref": "#/components/schemas/AssetRestorationRegionDto"
    },
    "restoredAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "resultExpiresAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "reviewedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "revision": {
      "description": "Per-asset sequence number, 1 for the first restoration",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "smoothMotionFactor": {
      "description": "Smooth motion: how many frames each source frame became (2, 4 or 8); null for a restoration",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "sourceDurationSeconds": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "sourceHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sourceType": {
      "$ref": "#/components/schemas/AssetRestorationSourceType"
    },
    "sourceWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/AssetRestorationStatus"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "upscale": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "activeOperationId",
    "assetId",
    "createdAt",
    "destinationId",
    "destinationKind",
    "destinationName",
    "error",
    "estimate",
    "fullOperationId",
    "hasPreview",
    "hasResult",
    "id",
    "isCurrent",
    "keepGrain",
    "mode",
    "modelName",
    "modelVersion",
    "outputHeight",
    "outputWidth",
    "previewExpiresAt",
    "previewOperationId",
    "previewReadyAt",
    "previewRegion",
    "restoredAt",
    "resultExpiresAt",
    "reviewedAt",
    "revision",
    "smoothMotionFactor",
    "sourceDurationSeconds",
    "sourceHeight",
    "sourceType",
    "sourceWidth",
    "status",
    "updatedAt",
    "upscale",
    "workload"
  ],
  "type": "object"
}
```

## AssetRestorationRoute


```json
{
  "enum": [
    "local",
    "both",
    "cloud"
  ],
  "type": "string"
}
```

## AssetRestorationSelectDto


```json
{
  "properties": {
    "restorationId": {
      "description": "Restored revision to use as the playback version; omitted, the original is used",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## AssetRestorationSourceType


```json
{
  "description": "Whether the restored source is a still image or a video",
  "enum": [
    "image",
    "video"
  ],
  "type": "string"
}
```

## AssetRestorationStatus


```json
{
  "description": "Lifecycle state of a restoration",
  "enum": [
    "preview_queued",
    "preview_rendering",
    "preview_ready",
    "preview_failed",
    "preview_cancelled",
    "accepted",
    "restoring",
    "restored",
    "restore_failed",
    "restore_cancelled",
    "rejected",
    "discarded",
    "expired"
  ],
  "type": "string"
}
```

## AssetSafetyDto


```json
{
  "properties": {
    "cloudBackup": {
      "properties": {
        "lastVerifiedRunAt": {
          "description": "Last completed successful GET + SHA-256 run for this current indexed object; HEAD + size never qualifies",
          "format": "date-time",
          "nullable": true,
          "type": "string"
        },
        "since": {
          "description": "Earliest retained complete backup run containing the current original hash",
          "format": "date-time",
          "nullable": true,
          "type": "string"
        },
        "state": {
          "enum": [
            "unavailable",
            "not-backed-up",
            "completed"
          ],
          "type": "string"
        }
      },
      "required": [
        "state",
        "since",
        "lastVerifiedRunAt"
      ],
      "type": "object"
    },
    "deliveredBy": {
      "description": "First recorded delivery of this current original: icloud-sync:<connectionId> or device:<deviceKey>; null when unknown. This is provenance, not integrity or audit proof",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "integrityResult": {
      "enum": [
        "unknown",
        "passed",
        "mismatched",
        "missing",
        "unreadable"
      ],
      "type": "string"
    },
    "lastIntegrityAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "onServerSince": {
      "description": "When this current asset was registered on the server; not checksum proof",
      "format": "date-time",
      "type": "string"
    },
    "sha256": {
      "type": "string"
    }
  },
  "required": [
    "cloudBackup",
    "deliveredBy",
    "id",
    "integrityResult",
    "lastIntegrityAt",
    "onServerSince",
    "sha256"
  ],
  "type": "object"
}
```

## AssetStackResponseDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets in stack",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "description": "Stack ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "primaryAssetId": {
      "description": "Primary asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "id",
    "primaryAssetId"
  ],
  "type": "object"
}
```

## AssetStatsResponseDto


```json
{
  "properties": {
    "images": {
      "description": "Number of images",
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
    "videos": {
      "description": "Number of videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "images",
    "total",
    "videos"
  ],
  "type": "object"
}
```

## AssetTypeEnum


```json
{
  "description": "Asset type",
  "enum": [
    "IMAGE",
    "VIDEO",
    "AUDIO",
    "OTHER"
  ],
  "type": "string"
}
```

## AssetUploadAction


```json
{
  "description": "Upload action",
  "enum": [
    "accept",
    "reject"
  ],
  "type": "string"
}
```

## AssetUploadResultDto

Related models: [AssetMediaStatus](models-05.md#assetmediastatus).

```json
{
  "properties": {
    "id": {
      "description": "Created or duplicate asset ID; nil UUID if current privacy suppresses it",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sha256": {
      "description": "Verified SHA-256 of the complete uploaded representation",
      "pattern": "^[a-f0-9]{64}$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/AssetMediaStatus"
    }
  },
  "required": [
    "id",
    "sha256",
    "status"
  ],
  "type": "object"
}
```

## AssetVisibility


```json
{
  "description": "Asset visibility",
  "enum": [
    "archive",
    "timeline",
    "hidden",
    "locked"
  ],
  "type": "string"
}
```

## AssetWaveformChannelDto


```json
{
  "properties": {
    "max": {
      "description": "Highest sample in each bucket, -1 to 1",
      "items": {
        "format": "double",
        "type": "number"
      },
      "type": "array"
    },
    "min": {
      "description": "Lowest sample in each bucket, -1 to 1",
      "items": {
        "format": "double",
        "type": "number"
      },
      "type": "array"
    }
  },
  "required": [
    "max",
    "min"
  ],
  "type": "object"
}
```

## AssetWaveformChannelMode


```json
{
  "description": "mono downmixes every channel into one; all returns each channel (up to 8)",
  "enum": [
    "mono",
    "all"
  ],
  "type": "string"
}
```

## AssetWaveformResponseDto

Related models: [AssetWaveformChannelDto](models-06.md#assetwaveformchanneldto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "bucketCount": {
      "description": "Peak pairs per channel",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bucketDurationMs": {
      "description": "Audio time each bucket covers, in milliseconds",
      "format": "double",
      "type": "number"
    },
    "channels": {
      "description": "One entry for mono, otherwise one per channel",
      "items": {
        "$ref": "#/components/schemas/AssetWaveformChannelDto"
      },
      "type": "array"
    },
    "durationMs": {
      "description": "Duration of the decoded audio, in milliseconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "hasAudio": {
      "description": "false for a video without an audio track; channels is then empty",
      "type": "boolean"
    },
    "version": {
      "description": "Changes whenever the video changes",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "bucketCount",
    "bucketDurationMs",
    "channels",
    "durationMs",
    "hasAudio",
    "version"
  ],
  "type": "object"
}
```

## AudioCodec


```json
{
  "description": "Target audio codec",
  "enum": [
    "mp3",
    "aac",
    "libopus",
    "opus",
    "pcm_s16le"
  ],
  "type": "string"
}
```

## AudioParameters


```json
{
  "properties": {
    "limit": {
      "description": "Limit a gain above 1 so it cannot clip (the Frameleaf quick editor). Absent or false keeps the earlier unlimited gain",
      "type": "boolean"
    },
    "muted": {
      "type": "boolean"
    },
    "volume": {
      "description": "Audio volume multiplier",
      "format": "double",
      "maximum": 2,
      "minimum": 0,
      "type": "number"
    }
  },
  "type": "object"
}
```

## AuthStatusResponseDto


```json
{
  "properties": {
    "expiresAt": {
      "description": "Session expiration date",
      "type": "string"
    },
    "isElevated": {
      "description": "Is elevated session",
      "type": "boolean"
    },
    "password": {
      "description": "Has password set",
      "type": "boolean"
    },
    "pinCode": {
      "description": "Has PIN code set",
      "type": "boolean"
    },
    "pinExpiresAt": {
      "description": "PIN expiration date",
      "type": "string"
    }
  },
  "required": [
    "isElevated",
    "password",
    "pinCode"
  ],
  "type": "object"
}
```

## AvatarUpdate

Related models: [UserAvatarColor](models-39.md#useravatarcolor).

```json
{
  "properties": {
    "color": {
      "$ref": "#/components/schemas/UserAvatarColor"
    }
  },
  "type": "object"
}
```

## BackupDeviceDto


```json
{
  "properties": {
    "appVersion": {
      "type": "string"
    },
    "deviceKey": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "displayName": {
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "lastSuccessfulBackupAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "model": {
      "type": "string"
    },
    "ownerId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "pendingCount": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "platform": {
      "type": "string"
    },
    "quietForDays": {
      "description": "Elapsed whole days since reported success; null if never reported",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "reportedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "appVersion",
    "deviceKey",
    "displayName",
    "id",
    "lastSuccessfulBackupAt",
    "model",
    "ownerId",
    "pendingCount",
    "platform",
    "quietForDays",
    "reportedAt"
  ],
  "type": "object"
}
```

## BackupDeviceListDto

Related models: [BackupDeviceDto](models-06.md#backupdevicedto).

```json
{
  "properties": {
    "devices": {
      "items": {
        "$ref": "#/components/schemas/BackupDeviceDto"
      },
      "type": "array"
    },
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "devices",
    "nextOffset"
  ],
  "type": "object"
}
```

## BackupDeviceWriteDto


```json
{
  "properties": {
    "appVersion": {
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "deviceKey": {
      "description": "Stable random client device identity, scoped to this owner",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "displayName": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "lastSuccessfulBackupAt": {
      "description": "Device-reported success; not server verification",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "model": {
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "pendingCount": {
      "maximum": 2147483647,
      "minimum": 0,
      "type": "integer"
    },
    "platform": {
      "maxLength": 50,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "appVersion",
    "deviceKey",
    "displayName",
    "lastSuccessfulBackupAt",
    "model",
    "pendingCount",
    "platform"
  ],
  "type": "object"
}
```

## BackupRestoreVerificationRecordDto


```json
{
  "properties": {
    "metadata": {
      "description": "The database restored and was checked",
      "type": "boolean"
    },
    "originals": {
      "description": "Original files restored and their checksums were verified",
      "type": "boolean"
    }
  },
  "required": [
    "metadata",
    "originals"
  ],
  "type": "object"
}
```

## BackupRestoreVerificationResponseDto


```json
{
  "properties": {
    "dueAt": {
      "description": "When the next test is due; null when a part has never been proved",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "intervalDays": {
      "description": "How often a restore test is due",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "metadataVerifiedAt": {
      "description": "When restoring the database was last proved",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "originalsVerifiedAt": {
      "description": "When restoring the original files was last proved",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "overdue": {
      "description": "Whether a restore test is due",
      "type": "boolean"
    },
    "verifiedBy": {
      "description": "The administrator who recorded the last test; null once that account is gone",
      "nullable": true,
      "properties": {
        "id": {
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "name": {
          "type": "string"
        }
      },
      "required": [
        "id",
        "name"
      ],
      "type": "object"
    }
  },
  "required": [
    "dueAt",
    "intervalDays",
    "metadataVerifiedAt",
    "originalsVerifiedAt",
    "overdue",
    "verifiedBy"
  ],
  "type": "object"
}
```

## BestPhotoAssetResponseDto

Related models: [AssetStackResponseDto](models-06.md#assetstackresponsedto), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [BestPhotoScoreDto](models-07.md#bestphotoscoredto), [ExifResponseDto](models-11.md#exifresponsedto), [ImageEncodingInfo](models-14.md#imageencodinginfo), [LandmarkSummaryDto](models-15.md#landmarksummarydto), [PartnerOriginDto](models-19.md#partnerorigindto), [PersonResponseDto](models-19.md#personresponsedto), [TagResponseDto](models-38.md#tagresponsedto), [UserResponseDto](models-39.md#userresponsedto).

```json
{
  "properties": {
    "bestPhotoScore": {
      "$ref": "#/components/schemas/BestPhotoScoreDto"
    },
    "checksum": {
      "description": "Base64-encoded file checksum. SHA-256 (44 chars) for assets uploaded after the SHA-256 transition; SHA-1 (28 chars) for legacy assets. Use the asset `checksumAlgorithm` field to disambiguate when length-based detection is insufficient.",
      "type": "string"
    },
    "createdAt": {
      "description": "The UTC timestamp when the asset was originally uploaded to Frameleaf.",
      "format": "date-time",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duration": {
      "description": "Video/gif duration in milliseconds (null for static images)",
      "maximum": 2147483647,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exifInfo": {
      "$ref": "#/components/schemas/ExifResponseDto"
    },
    "fileCreatedAt": {
      "description": "The actual UTC timestamp when the file was created/captured, preserving timezone information. This is the authoritative timestamp for chronological sorting within timeline groups. Combined with timezone data, this can be used to determine the exact moment the photo was taken.",
      "format": "date-time",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "The UTC timestamp when the file was last modified on the filesystem. This reflects the last time the physical file was changed, which may be different from when the photo was originally taken.",
      "format": "date-time",
      "type": "string"
    },
    "hasMetadata": {
      "description": "Whether asset has metadata",
      "type": "boolean"
    },
    "height": {
      "description": "Asset height",
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
    "imageEncoding": {
      "$ref": "#/components/schemas/ImageEncodingInfo",
      "description": "Source image color encoding; unprocessed or unavailable evidence remains unknown"
    },
    "imageRenditions": {
      "description": "Available current still renditions; omitted when file evidence was not loaded",
      "properties": {
        "hdrFullsize": {
          "type": "boolean"
        },
        "hdrPreview": {
          "type": "boolean"
        },
        "sdrFullsize": {
          "type": "boolean"
        },
        "sdrPreview": {
          "type": "boolean"
        }
      },
      "required": [
        "sdrPreview",
        "sdrFullsize",
        "hdrPreview",
        "hdrFullsize"
      ],
      "type": "object"
    },
    "isArchived": {
      "description": "Is archived",
      "type": "boolean"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v2.5.0",
          "state": "Added"
        },
        {
          "version": "v2.5.0",
          "state": "Beta"
        }
      ],
      "x-immich-state": "Beta"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "isOffline": {
      "description": "Is offline",
      "type": "boolean"
    },
    "isTrashed": {
      "description": "Is trashed",
      "type": "boolean"
    },
    "landmarks": {
      "description": "Landmarks this asset was taken at, the most specific first. Only on the single-asset response.",
      "items": {
        "$ref": "#/components/schemas/LandmarkSummaryDto"
      },
      "type": "array"
    },
    "libraryId": {
      "description": "Library ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "The local date and time when the photo/video was taken, derived from EXIF metadata. This represents the photographer's local time regardless of timezone, stored as a timezone-agnostic timestamp. Used for timeline grouping by \"local\" days and months.",
      "format": "date-time",
      "type": "string"
    },
    "origin": {
      "$ref": "#/components/schemas/PartnerOriginDto",
      "description": "FL-326: present on your own asset when partner sharing copied it from another library (GET /assets/{id})"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "originalMimeType": {
      "description": "Original MIME type",
      "type": "string"
    },
    "originalPath": {
      "description": "Original file path",
      "type": "string"
    },
    "owner": {
      "$ref": "#/components/schemas/UserResponseDto"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "people": {
      "items": {
        "$ref": "#/components/schemas/PersonResponseDto"
      },
      "type": "array"
    },
    "resized": {
      "description": "Is resized",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v1.113.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "stack": {
      "allOf": [
        {
          "$ref": "#/components/schemas/AssetStackResponseDto"
        }
      ],
      "nullable": true
    },
    "tags": {
      "items": {
        "$ref": "#/components/schemas/TagResponseDto"
      },
      "type": "array"
    },
    "thumbhash": {
      "description": "Thumbhash for thumbnail generation (base64) also used as the c query param for thumbnail cache busting.",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "updatedAt": {
      "description": "The UTC timestamp when the asset record was last updated in the database. This is automatically maintained by the database and reflects when any field in the asset was last modified.",
      "format": "date-time",
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "bestPhotoScore",
    "checksum",
    "createdAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "hasMetadata",
    "height",
    "id",
    "isArchived",
    "isEdited",
    "isFavorite",
    "isOffline",
    "isTrashed",
    "localDateTime",
    "originalFileName",
    "originalPath",
    "ownerId",
    "thumbhash",
    "type",
    "updatedAt",
    "visibility",
    "width"
  ],
  "type": "object"
}
```
