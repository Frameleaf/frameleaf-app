# Server API models 16

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## MediaOperationDuplicateGroupDto

Related models: [DuplicateDecisionKind](models-11.md#duplicatedecisionkind).

```json
{
  "properties": {
    "decision": {
      "$ref": "#/components/schemas/DuplicateDecisionKind"
    },
    "decisionId": {
      "description": "For `undo-duplicates`: the recorded decision to reverse",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "description": "Photos to keep; the first is a stack cover. Other members of a `keepers` group are trashed",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "memberIds": {
      "description": "Every photo of the group, as reviewed",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "minItems": 2,
      "type": "array"
    }
  },
  "required": [
    "decision",
    "duplicateId",
    "keepAssetIds",
    "memberIds"
  ],
  "type": "object"
}
```

## MediaOperationEstimateDto


```json
{
  "properties": {
    "cloudCost": {
      "additionalProperties": {},
      "description": "Configured cloud rate detail, when one applies",
      "nullable": true,
      "type": "object"
    },
    "seconds": {
      "description": "Measured estimate of remaining work",
      "format": "double",
      "type": "number"
    },
    "sizeBytes": {
      "description": "Estimated output size",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "cloudCost",
    "seconds",
    "sizeBytes"
  ],
  "type": "object"
}
```

## MediaOperationItemStatus


```json
{
  "description": "Per-item outcome of a bulk media operation",
  "enum": [
    "ok",
    "skipped",
    "failed"
  ],
  "type": "string"
}
```

## MediaOperationKind


```json
{
  "description": "Media operation kind",
  "enum": [
    "studio_export",
    "studio_preview",
    "studio_reverse_conform",
    "studio_preview_stream",
    "restoration",
    "restoration_preview",
    "quick_edit",
    "bulk",
    "studio_bundle_export",
    "studio_bundle_import",
    "enrichment_plan",
    "media_health",
    "icloud_sync",
    "takeout_import",
    "physical_deduplication",
    "library_scan",
    "preservation_export",
    "preservation_verify",
    "preservation_review",
    "preservation_restore",
    "studio_export_publish",
    "cloud_description_batch",
    "cloud_ml_job",
    "cloud_backup",
    "cloud_restore",
    "buddy_backup",
    "buddy_restore"
  ],
  "type": "string"
}
```

## MediaOperationListResponseDto

Related models: [MediaOperationDto](models-15.md#mediaoperationdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Matching jobs, before paging",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "total"
  ],
  "type": "object"
}
```

## MediaOperationLivePhotoPairDto


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

## MediaOperationMediaHealthEntryDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidateId": {
      "description": "Reviewed candidate ID, for a relink or a recovery",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "findingId": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "findingId"
  ],
  "type": "object"
}
```

## MediaOperationStatisticsDto

Related models: [MediaOperationAggregateDto](models-15.md#mediaoperationaggregatedto).

```json
{
  "properties": {
    "active": {
      "description": "Jobs the server is still working on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "buckets": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationAggregateDto"
      },
      "type": "array"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "unreleasedRemote": {
      "description": "Remote jobs whose cleanup has not been acknowledged",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "buckets",
    "failed",
    "unreleasedRemote"
  ],
  "type": "object"
}
```

## MediaOperationStatus


```json
{
  "description": "Media operation status",
  "enum": [
    "queued",
    "preparing",
    "rendering",
    "validating",
    "completed",
    "cancelling",
    "cancelled",
    "failed",
    "paused"
  ],
  "type": "string"
}
```

## MemoriesResponse


```json
{
  "properties": {
    "duration": {
      "description": "Memory duration in seconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "enabled": {
      "description": "Whether memories are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether memories appear in web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "duration",
    "enabled",
    "sidebarWeb"
  ],
  "type": "object"
}
```

## MemoriesUpdate


```json
{
  "properties": {
    "duration": {
      "description": "Memory duration in seconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "enabled": {
      "description": "Whether memories are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether memories appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## MemoryCreateDto

Related models: [MemoryData](models-16.md#memorydata), [MemoryType](models-16.md#memorytype).

```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs to associate with memory",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "data": {
      "$ref": "#/components/schemas/MemoryData"
    },
    "hideAt": {
      "description": "Date when memory should be hidden",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v2.6.0",
          "state": "Added"
        },
        {
          "version": "v2.6.0",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isSaved": {
      "description": "Is memory saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "seenAt": {
      "description": "Date when memory was seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Date when memory should be shown",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v2.6.0",
          "state": "Added"
        },
        {
          "version": "v2.6.0",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
    }
  },
  "required": [
    "data",
    "memoryAt",
    "type"
  ],
  "type": "object"
}
```

## MemoryData

Related models: [BirthdayMemoryDto](models-06.md#birthdaymemorydto), [EventStoryDto](models-11.md#eventstorydto), [OnThisDayDto](models-18.md#onthisdaydto), [PersonRecapDto](models-18.md#personrecapdto), [PetStoryDto](models-19.md#petstorydto), [YearInReviewDto](models-39.md#yearinreviewdto).

```json
{
  "anyOf": [
    {
      "$ref": "#/components/schemas/EventStoryDto"
    },
    {
      "$ref": "#/components/schemas/YearInReviewDto"
    },
    {
      "$ref": "#/components/schemas/PetStoryDto"
    },
    {
      "$ref": "#/components/schemas/BirthdayMemoryDto"
    },
    {
      "$ref": "#/components/schemas/PersonRecapDto"
    },
    {
      "$ref": "#/components/schemas/OnThisDayDto"
    }
  ],
  "description": "Memory data"
}
```

## MemoryExportCreateDto

Related models: [MemoryExportFormat](models-16.md#memoryexportformat), [MemoryHighlightOptionsDto](models-16.md#memoryhighlightoptionsdto).

```json
{
  "properties": {
    "format": {
      "$ref": "#/components/schemas/MemoryExportFormat",
      "description": "Export format, defaults to an archive of the originals"
    },
    "highlight": {
      "$ref": "#/components/schemas/MemoryHighlightOptionsDto",
      "description": "Options for a `highlight` export",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    }
  },
  "type": "object"
}
```

## MemoryExportFormat


```json
{
  "description": "Memory export format",
  "enum": [
    "archive",
    "highlight"
  ],
  "type": "string"
}
```

## MemoryExportResponseDto

Related models: [MemoryExportFormat](models-16.md#memoryexportformat), [MemoryExportStatus](models-16.md#memoryexportstatus), [MemoryHighlightResponseDto](models-16.md#memoryhighlightresponsedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets in the export",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the export was requested",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "error": {
      "description": "Failure reason, when the export failed",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "When the archive is deleted",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "finishedAt": {
      "description": "When the export reached a terminal state",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "format": {
      "$ref": "#/components/schemas/MemoryExportFormat"
    },
    "highlight": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MemoryHighlightResponseDto"
        }
      ],
      "description": "The highlight video settings and render state, for a `highlight` export",
      "nullable": true,
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "id": {
      "description": "Export ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isDownloadable": {
      "description": "Whether the archive can be downloaded right now",
      "type": "boolean"
    },
    "memoryId": {
      "description": "Memory the export was requested for",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "processedAssets": {
      "description": "Number of assets written so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sizeInBytes": {
      "description": "Size of the finished archive",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "startedAt": {
      "description": "When the worker picked the export up",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MemoryExportStatus"
    },
    "title": {
      "description": "The memory's title when the export was requested",
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
    "assetCount",
    "createdAt",
    "error",
    "expiresAt",
    "finishedAt",
    "format",
    "highlight",
    "id",
    "isDownloadable",
    "memoryId",
    "ownerId",
    "processedAssets",
    "sizeInBytes",
    "startedAt",
    "status",
    "title",
    "updatedAt"
  ],
  "type": "object"
}
```

## MemoryExportStatus


```json
{
  "description": "Memory export status",
  "enum": [
    "pending",
    "running",
    "ready",
    "failed",
    "cancelling",
    "cancelled"
  ],
  "type": "string"
}
```

## MemoryHighlightAudio


```json
{
  "description": "Sound of a memory highlight video",
  "enum": [
    "original",
    "silent"
  ],
  "type": "string"
}
```

## MemoryHighlightDestination


```json
{
  "description": "Where the highlight renders: this server or another computer on your home network",
  "enum": [
    "local",
    "lan"
  ],
  "type": "string"
}
```

## MemoryHighlightOptionsDto

Related models: [MemoryHighlightAudio](models-16.md#memoryhighlightaudio), [MemoryHighlightDestination](models-16.md#memoryhighlightdestination), [StudioExportResolution](models-33.md#studioexportresolution).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/MemoryHighlightAudio",
      "description": "Sound policy, each video's own sound by default"
    },
    "destination": {
      "$ref": "#/components/schemas/MemoryHighlightDestination",
      "description": "Where it renders, this server by default"
    },
    "lengthSeconds": {
      "description": "Target length in seconds, 60 by default",
      "maximum": 300,
      "minimum": 15,
      "type": "integer"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution",
      "description": "Output resolution, 2160p by default"
    }
  },
  "type": "object"
}
```

## MemoryHighlightResponseDto

Related models: [MemoryHighlightAudio](models-16.md#memoryhighlightaudio), [MemoryHighlightDestination](models-16.md#memoryhighlightdestination), [StudioExportResolution](models-33.md#studioexportresolution).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/MemoryHighlightAudio"
    },
    "destination": {
      "$ref": "#/components/schemas/MemoryHighlightDestination"
    },
    "lengthSeconds": {
      "description": "Target length in seconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progress": {
      "description": "Render progress, 0 to 100",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution"
    },
    "savedAssetId": {
      "description": "The library asset the highlight was saved as, once saved",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "audio",
    "destination",
    "lengthSeconds",
    "progress",
    "resolution",
    "savedAssetId"
  ],
  "type": "object"
}
```

## MemoryResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [MemoryData](models-16.md#memorydata), [MemoryType](models-16.md#memorytype).

```json
{
  "properties": {
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
    "data": {
      "$ref": "#/components/schemas/MemoryData"
    },
    "deletedAt": {
      "description": "Deletion date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "hideAt": {
      "description": "Date when memory should be hidden",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isHidden": {
      "description": "Hidden by the owner; shown only in the hidden memories list",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "isSaved": {
      "description": "Is memory saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "seenAt": {
      "description": "Date when memory was seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Date when memory should be shown",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "The owner's own title, when they set one",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
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
    "assets",
    "createdAt",
    "data",
    "id",
    "isHidden",
    "isSaved",
    "memoryAt",
    "ownerId",
    "title",
    "type",
    "updatedAt"
  ],
  "type": "object"
}
```

## MemorySearchOrder


```json
{
  "description": "Sort order",
  "enum": [
    "asc",
    "desc",
    "random"
  ],
  "type": "string"
}
```

## MemoryShowLessDto

Related models: [MemoryShowLessKind](models-16.md#memoryshowlesskind).

```json
{
  "properties": {
    "kind": {
      "$ref": "#/components/schemas/MemoryShowLessKind"
    },
    "value": {
      "description": "A person or pet id, a date as 'MM-dd', or a memory type",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "kind",
    "value"
  ],
  "type": "object"
}
```

## MemoryShowLessKind


```json
{
  "description": "What a memories show-less rule names",
  "enum": [
    "person",
    "pet",
    "date",
    "type"
  ],
  "type": "string"
}
```

## MemoryShowLessResponseDto

Related models: [MemoryShowLessKind](models-16.md#memoryshowlesskind).

```json
{
  "properties": {
    "createdAt": {
      "description": "When the rule was added",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MemoryShowLessKind"
    },
    "name": {
      "description": "The person's or pet's name, for person and pet rules",
      "nullable": true,
      "type": "string"
    },
    "value": {
      "description": "A person or pet id, a date as 'MM-dd', or a memory type",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "kind",
    "name",
    "value"
  ],
  "type": "object"
}
```

## MemoryStatisticsResponseDto


```json
{
  "properties": {
    "total": {
      "description": "Total number of memories",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "total"
  ],
  "type": "object"
}
```

## MemoryStoryPlaceDto


```json
{
  "properties": {
    "city": {
      "description": "City",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "description": "Country",
      "nullable": true,
      "type": "string"
    },
    "state": {
      "description": "State or region",
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

## MemoryType


```json
{
  "description": "Memory type",
  "enum": [
    "on_this_day",
    "event_story",
    "year_in_review",
    "pet_story",
    "birthday",
    "person_recap"
  ],
  "type": "string"
}
```

## MemoryUpdateDto


```json
{
  "properties": {
    "assetOrder": {
      "description": "The memory's items in the order the owner chose; items not listed follow in capture order",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 5000,
      "type": "array",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "isHidden": {
      "description": "Hide the memory from the memories list; false restores it",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "isSaved": {
      "description": "Is memory saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "seenAt": {
      "description": "Date when memory was seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "The owner's own title for the memory; null returns to the generated one",
      "maxLength": 200,
      "minLength": 1,
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    }
  },
  "type": "object"
}
```

## MergePersonDto


```json
{
  "properties": {
    "ids": {
      "description": "Person IDs to merge",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## MergeSuggestionsResponseDto

Related models: [PersonMergeSuggestionDto](models-18.md#personmergesuggestiondto).

```json
{
  "properties": {
    "suggestions": {
      "description": "Suggested pairs of people that may be the same person",
      "items": {
        "$ref": "#/components/schemas/PersonMergeSuggestionDto"
      },
      "type": "array"
    }
  },
  "required": [
    "suggestions"
  ],
  "type": "object"
}
```
