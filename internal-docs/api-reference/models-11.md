# Server API models 11

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## DocumentRegionDto


```json
{
  "description": "Where the text is in the photo as it is shown, edits applied",
  "properties": {
    "x1": {
      "description": "Normalized x coordinate of corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x2": {
      "description": "Normalized x coordinate of corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x3": {
      "description": "Normalized x coordinate of corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "x4": {
      "description": "Normalized x coordinate of corner 4 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y1": {
      "description": "Normalized y coordinate of corner 1 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y2": {
      "description": "Normalized y coordinate of corner 2 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y3": {
      "description": "Normalized y coordinate of corner 3 (0-1)",
      "format": "double",
      "type": "number"
    },
    "y4": {
      "description": "Normalized y coordinate of corner 4 (0-1)",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "x1",
    "x2",
    "x3",
    "x4",
    "y1",
    "y2",
    "y3",
    "y4"
  ],
  "type": "object"
}
```

## DocumentResponseDto

Related models: [DocumentFieldResponseDto](models-10.md#documentfieldresponsedto), [DocumentLineDto](models-10.md#documentlinedto), [DocumentRecognitionDto](models-10.md#documentrecognitiondto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "canEdit": {
      "description": "The caller owns the photo and may correct its text",
      "type": "boolean"
    },
    "fields": {
      "items": {
        "$ref": "#/components/schemas/DocumentFieldResponseDto"
      },
      "type": "array"
    },
    "fieldsEnabled": {
      "description": "Field suggestions are switched on",
      "type": "boolean"
    },
    "lines": {
      "items": {
        "$ref": "#/components/schemas/DocumentLineDto"
      },
      "type": "array"
    },
    "recognition": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DocumentRecognitionDto"
        }
      ],
      "description": "Whether the photo can be read again; owner only",
      "nullable": true
    },
    "recognizedAt": {
      "description": "When the text was last read",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "canEdit",
    "fields",
    "fieldsEnabled",
    "lines",
    "recognition",
    "recognizedAt"
  ],
  "type": "object"
}
```

## DocumentSearchResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "nextPage": {
      "nullable": true,
      "type": "string"
    },
    "total": {
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

## DownloadArchiveDto


```json
{
  "properties": {
    "archiveName": {
      "description": "The name of the archive to download, without extension",
      "type": "string"
    },
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "edited": {
      "description": "Download edited asset if available",
      "type": "boolean"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## DownloadArchiveInfo


```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs in this archive",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "size": {
      "description": "Archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assetIds",
    "size"
  ],
  "type": "object"
}
```

## DownloadInfoDto


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID to download",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "archiveSize": {
      "description": "Archive size limit in bytes",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "assetIds": {
      "description": "Asset IDs to download",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "userId": {
      "description": "User ID to download assets from",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## DownloadResponse


```json
{
  "properties": {
    "archiveSize": {
      "description": "Maximum archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "includeEmbeddedVideos": {
      "description": "Whether to include embedded videos in downloads",
      "type": "boolean"
    }
  },
  "required": [
    "archiveSize",
    "includeEmbeddedVideos"
  ],
  "type": "object"
}
```

## DownloadResponseDto

Related models: [DownloadArchiveInfo](models-11.md#downloadarchiveinfo).

```json
{
  "properties": {
    "archives": {
      "description": "Archive information",
      "items": {
        "$ref": "#/components/schemas/DownloadArchiveInfo"
      },
      "type": "array"
    },
    "totalSize": {
      "description": "Total size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "archives",
    "totalSize"
  ],
  "type": "object"
}
```

## DownloadUpdate


```json
{
  "properties": {
    "archiveSize": {
      "description": "Maximum archive size in bytes",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "includeEmbeddedVideos": {
      "description": "Whether to include embedded videos in downloads",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## DuplicateActiveGroupDto


```json
{
  "properties": {
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memberIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "duplicateId",
    "memberIds"
  ],
  "type": "object"
}
```

## DuplicateActiveOperationDto

Related models: [DuplicateActiveGroupDto](models-11.md#duplicateactivegroupdto), [MediaOperationBulkAction](models-16.md#mediaoperationbulkaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "groups": {
      "items": {
        "$ref": "#/components/schemas/DuplicateActiveGroupDto"
      },
      "type": "array"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "action",
    "groups",
    "operationId"
  ],
  "type": "object"
}
```

## DuplicateDecisionBatchDto

Related models: [DuplicateDecisionGroupDto](models-11.md#duplicatedecisiongroupdto).

```json
{
  "properties": {
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "groups": {
      "items": {
        "$ref": "#/components/schemas/DuplicateDecisionGroupDto"
      },
      "type": "array"
    },
    "operationId": {
      "description": "The durable job that applied these decisions",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "undoable": {
      "description": "Every decision of the job is applied and none has been undone",
      "type": "boolean"
    }
  },
  "required": [
    "createdAt",
    "groups",
    "operationId",
    "undoable"
  ],
  "type": "object"
}
```

## DuplicateDecisionGroupDto

Related models: [DuplicateDecisionKind](models-11.md#duplicatedecisionkind).

```json
{
  "properties": {
    "applied": {
      "type": "boolean"
    },
    "decision": {
      "$ref": "#/components/schemas/DuplicateDecisionKind"
    },
    "decisionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "memberIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "trashAssetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "undoing": {
      "description": "An undo job has started on this decision",
      "type": "boolean"
    },
    "undone": {
      "type": "boolean"
    }
  },
  "required": [
    "applied",
    "decision",
    "decisionId",
    "duplicateId",
    "keepAssetIds",
    "memberIds",
    "trashAssetIds",
    "undoing",
    "undone"
  ],
  "type": "object"
}
```

## DuplicateDecisionHistoryDto

Related models: [DuplicateActiveOperationDto](models-11.md#duplicateactiveoperationdto), [DuplicateDecisionBatchDto](models-11.md#duplicatedecisionbatchdto).

```json
{
  "properties": {
    "active": {
      "description": "Decision and undo jobs still running",
      "items": {
        "$ref": "#/components/schemas/DuplicateActiveOperationDto"
      },
      "type": "array"
    },
    "recent": {
      "description": "The most recent decision jobs, newest first",
      "items": {
        "$ref": "#/components/schemas/DuplicateDecisionBatchDto"
      },
      "type": "array"
    }
  },
  "required": [
    "active",
    "recent"
  ],
  "type": "object"
}
```

## DuplicateDecisionKind


```json
{
  "description": "What the owner decided for a duplicate group",
  "enum": [
    "keepers",
    "keep-all",
    "stack"
  ],
  "type": "string"
}
```

## DuplicateGroupBlock


```json
{
  "description": "Why a duplicate group cannot be decided from this session",
  "enum": [
    "hidden-members",
    "other-owner"
  ],
  "type": "string"
}
```

## DuplicateGroupKind


```json
{
  "description": "Whether a duplicate group holds copies of one photo or frames of a burst",
  "enum": [
    "duplicates",
    "burst"
  ],
  "type": "string"
}
```

## DuplicateQualityReason


```json
{
  "description": "Evidence behind a duplicate keeper suggestion",
  "enum": [
    "original-format",
    "largest-file",
    "highest-resolution",
    "most-metadata",
    "compressed-copy",
    "lower-resolution"
  ],
  "type": "string"
}
```

## DuplicateResolveDto

Related models: [DuplicateResolveGroupDto](models-11.md#duplicateresolvegroupdto).

```json
{
  "properties": {
    "groups": {
      "description": "List of duplicate groups to resolve",
      "items": {
        "$ref": "#/components/schemas/DuplicateResolveGroupDto"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "groups"
  ],
  "type": "object"
}
```

## DuplicateResolveGroupDto


```json
{
  "properties": {
    "duplicateId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "description": "Asset IDs to keep",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "trashAssetIds": {
      "description": "Asset IDs to trash or delete",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "duplicateId",
    "keepAssetIds",
    "trashAssetIds"
  ],
  "type": "object"
}
```

## DuplicateResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto).

```json
{
  "properties": {
    "assets": {
      "description": "Duplicate assets",
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reviewRequiredReasons": {
      "description": "Safety reasons that prevent unattended disposal of the non-suggested copies",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "suggestedKeepAssetIds": {
      "description": "Suggested asset IDs to keep based on format preference (RAW, HEIC/HEIF/HIF, then other formats), file size and EXIF data",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "assets",
    "duplicateId",
    "suggestedKeepAssetIds"
  ],
  "type": "object"
}
```

## DuplicateReviewGroupDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [DuplicateGroupBlock](models-11.md#duplicategroupblock), [DuplicateGroupKind](models-11.md#duplicategroupkind), [DuplicateReviewQualityDto](models-11.md#duplicatereviewqualitydto).

```json
{
  "properties": {
    "assets": {
      "description": "The photos of the group this session may see",
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "blockedReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/DuplicateGroupBlock"
        }
      ],
      "nullable": true
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "editable": {
      "description": "Whether this session may decide the group",
      "type": "boolean"
    },
    "hiddenMemberCount": {
      "description": "Photos of the group this session does not see",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "$ref": "#/components/schemas/DuplicateGroupKind"
    },
    "otherOwnerNames": {
      "description": "Display names of the other accounts owning photos of a group blocked by another owner",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "qualities": {
      "items": {
        "$ref": "#/components/schemas/DuplicateReviewQualityDto"
      },
      "type": "array"
    },
    "reviewRequiredReasons": {
      "description": "Safety reasons requiring review before duplicate disposal",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "suggestedKeepAssetIds": {
      "description": "The suggested keeper, from format preference, file size and metadata. Never set for a burst",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "totalBytes": {
      "description": "Size of the originals shown, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "assets",
    "blockedReason",
    "duplicateId",
    "editable",
    "hiddenMemberCount",
    "kind",
    "qualities",
    "suggestedKeepAssetIds",
    "totalBytes"
  ],
  "type": "object"
}
```

## DuplicateReviewQualityDto

Related models: [DuplicateQualityReason](models-11.md#duplicatequalityreason).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reasons": {
      "description": "Evidence for or against keeping this copy",
      "items": {
        "$ref": "#/components/schemas/DuplicateQualityReason"
      },
      "type": "array"
    }
  },
  "required": [
    "assetId",
    "reasons"
  ],
  "type": "object"
}
```

## EmailNotificationsResponse


```json
{
  "properties": {
    "albumInvite": {
      "description": "Whether to receive email notifications for album invites",
      "type": "boolean"
    },
    "albumUpdate": {
      "description": "Whether to receive email notifications for album updates",
      "type": "boolean"
    },
    "enabled": {
      "description": "Whether email notifications are enabled",
      "type": "boolean"
    }
  },
  "required": [
    "albumInvite",
    "albumUpdate",
    "enabled"
  ],
  "type": "object"
}
```

## EmailNotificationsUpdate


```json
{
  "properties": {
    "albumInvite": {
      "description": "Whether to receive email notifications for album invites",
      "type": "boolean"
    },
    "albumUpdate": {
      "description": "Whether to receive email notifications for album updates",
      "type": "boolean"
    },
    "enabled": {
      "description": "Whether email notifications are enabled",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## EnrichmentDestinationAdmissionDto


```json
{
  "properties": {
    "admitted": {
      "type": "boolean"
    },
    "refusal": {
      "description": "Stable refusal code when it would not",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "admitted",
    "refusal"
  ],
  "type": "object"
}
```

## EnrichmentDestinationOptionDto

Related models: [EnrichmentDestinationAdmissionDto](models-11.md#enrichmentdestinationadmissiondto), [MlDestinationHealth](models-18.md#mldestinationhealth), [MlDestinationKind](models-18.md#mldestinationkind).

```json
{
  "properties": {
    "cloud": {
      "description": "Sends media off this network; needs recorded consent",
      "type": "boolean"
    },
    "enrichment": {
      "$ref": "#/components/schemas/EnrichmentDestinationAdmissionDto"
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
    "name": {
      "type": "string"
    },
    "search": {
      "$ref": "#/components/schemas/EnrichmentDestinationAdmissionDto"
    }
  },
  "required": [
    "cloud",
    "enrichment",
    "health",
    "id",
    "kind",
    "name",
    "search"
  ],
  "type": "object"
}
```

## EnrichmentItemState


```json
{
  "description": "Enrichment plan item state",
  "enum": [
    "queued",
    "running",
    "skipped",
    "failed",
    "completed",
    "cancelled"
  ],
  "type": "string"
}
```

## EnrichmentOptionsResponseDto

Related models: [EnrichmentDestinationOptionDto](models-11.md#enrichmentdestinationoptiondto), [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "defaultStages": {
      "description": "Stages a new plan starts with; never moment captions",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "descriptionEnabled": {
      "type": "boolean"
    },
    "destinations": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentDestinationOptionDto"
      },
      "type": "array"
    },
    "framesPerVideo": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "lockedCheckEnabled": {
      "type": "boolean"
    },
    "maxAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxSamples": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "modelName": {
      "description": "Saved description model",
      "type": "string"
    },
    "routes": {
      "description": "The destinations library work is routed to; a plan uses these unless another is chosen",
      "properties": {
        "enrichment": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        },
        "search": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
          "type": "string"
        }
      },
      "required": [
        "enrichment",
        "search"
      ],
      "type": "object"
    },
    "searchEnabled": {
      "type": "boolean"
    },
    "searchModelName": {
      "description": "Saved search model",
      "type": "string"
    }
  },
  "required": [
    "defaultStages",
    "descriptionEnabled",
    "destinations",
    "framesPerVideo",
    "lockedCheckEnabled",
    "maxAssets",
    "maxSamples",
    "modelName",
    "routes",
    "searchEnabled",
    "searchModelName"
  ],
  "type": "object"
}
```

## EnrichmentPlanCountsDto


```json
{
  "properties": {
    "cancelled": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "completed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "queued": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "running": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "cancelled",
    "completed",
    "failed",
    "queued",
    "running",
    "skipped",
    "total"
  ],
  "type": "object"
}
```

## EnrichmentPlanCreateDto

Related models: [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "assetIds": {
      "description": "The frozen set, in order; never re-resolved",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "destinationId": {
      "description": "Destination for descriptions, checks and captions",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "requestKey": {
      "description": "Client idempotency key; submitting the same key again returns the existing plan",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "searchDestinationId": {
      "description": "Destination for search embeddings",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stages": {
      "description": "Chosen stages; the ones they need are added",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "assetIds",
    "stages"
  ],
  "type": "object"
}
```

## EnrichmentPlanDestinationDto


```json
{
  "properties": {
    "cloud": {
      "type": "boolean"
    },
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
    "cloud",
    "id",
    "name"
  ],
  "type": "object"
}
```

## EnrichmentPlanItemDto

Related models: [EnrichmentItemState](models-11.md#enrichmentitemstate), [EnrichmentPlanStageOutcomeDto](models-11.md#enrichmentplanstageoutcomedto).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "retryPending": {
      "description": "Waiting for its one automatic retry",
      "type": "boolean"
    },
    "stages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPlanStageOutcomeDto"
      },
      "type": "array"
    },
    "state": {
      "$ref": "#/components/schemas/EnrichmentItemState"
    }
  },
  "required": [
    "assetId",
    "retryPending",
    "stages",
    "state"
  ],
  "type": "object"
}
```

## EnrichmentPlanResponseDto

Related models: [EnrichmentPlanCountsDto](models-11.md#enrichmentplancountsdto), [EnrichmentPlanDestinationDto](models-11.md#enrichmentplandestinationdto), [EnrichmentPlanItemDto](models-11.md#enrichmentplanitemdto), [EnrichmentStage](models-11.md#enrichmentstage), [MediaOperationDto](models-16.md#mediaoperationdto).

```json
{
  "properties": {
    "addedStages": {
      "description": "Stages run only because a chosen stage needs them",
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "configHash": {
      "type": "string"
    },
    "counts": {
      "$ref": "#/components/schemas/EnrichmentPlanCountsDto"
    },
    "enrichmentDestination": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentPlanDestinationDto"
        }
      ],
      "nullable": true
    },
    "hiddenCount": {
      "description": "Locked items not listed because this session is not unlocked",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPlanItemDto"
      },
      "type": "array"
    },
    "modelName": {
      "type": "string"
    },
    "operation": {
      "$ref": "#/components/schemas/MediaOperationDto"
    },
    "requestedStages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    },
    "searchDestination": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentPlanDestinationDto"
        }
      ],
      "nullable": true
    },
    "searchModelName": {
      "type": "string"
    },
    "stages": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentStage"
      },
      "type": "array"
    }
  },
  "required": [
    "addedStages",
    "configHash",
    "counts",
    "enrichmentDestination",
    "hiddenCount",
    "items",
    "modelName",
    "operation",
    "requestedStages",
    "searchDestination",
    "searchModelName",
    "stages"
  ],
  "type": "object"
}
```

## EnrichmentPlanStageOutcomeDto

Related models: [EnrichmentItemState](models-11.md#enrichmentitemstate), [EnrichmentStage](models-11.md#enrichmentstage).

```json
{
  "properties": {
    "at": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "message": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "stage": {
      "$ref": "#/components/schemas/EnrichmentStage"
    },
    "state": {
      "$ref": "#/components/schemas/EnrichmentItemState"
    }
  },
  "required": [
    "at",
    "message",
    "reasonKey",
    "stage",
    "state"
  ],
  "type": "object"
}
```

## EnrichmentPreviewRequestDto

Related models: [AdminConfigImageDescriptionPromptDto](models-01.md#adminconfigimagedescriptionpromptdto).

```json
{
  "properties": {
    "assetIds": {
      "description": "Samples to describe; run one at a time",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 6,
      "minItems": 1,
      "type": "array"
    },
    "destinationId": {
      "description": "Destination to run on; the routed one when omitted",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "fallbackModelName": {
      "type": "string"
    },
    "modelName": {
      "description": "Draft model; the saved one when omitted",
      "minLength": 1,
      "type": "string"
    },
    "prompt": {
      "$ref": "#/components/schemas/AdminConfigImageDescriptionPromptDto",
      "description": "Draft prompt; the saved one when omitted"
    }
  },
  "required": [
    "assetIds"
  ],
  "type": "object"
}
```

## EnrichmentPreviewResponseDto

Related models: [EnrichmentPreviewSampleDto](models-11.md#enrichmentpreviewsampledto).

```json
{
  "properties": {
    "cloud": {
      "type": "boolean"
    },
    "destinationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "destinationName": {
      "type": "string"
    },
    "modelName": {
      "type": "string"
    },
    "samples": {
      "items": {
        "$ref": "#/components/schemas/EnrichmentPreviewSampleDto"
      },
      "type": "array"
    }
  },
  "required": [
    "cloud",
    "destinationId",
    "destinationName",
    "modelName",
    "samples"
  ],
  "type": "object"
}
```

## EnrichmentPreviewSampleDto

Related models: [EnrichmentPreviewStatus](models-11.md#enrichmentpreviewstatus).

```json
{
  "properties": {
    "ambiguousReferences": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidate": {
      "description": "What the draft produced; stored nowhere",
      "nullable": true,
      "type": "string"
    },
    "current": {
      "description": "The stored generated description, unchanged",
      "nullable": true,
      "type": "string"
    },
    "durationMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "frameCount": {
      "description": "Video frames the draft saw; 0 for a photo",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "hallucinatedNames": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "message": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/EnrichmentPreviewStatus"
    },
    "tags": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "warnings": {
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "ambiguousReferences",
    "assetId",
    "candidate",
    "current",
    "durationMs",
    "frameCount",
    "hallucinatedNames",
    "message",
    "reasonKey",
    "status",
    "tags",
    "warnings"
  ],
  "type": "object"
}
```

## EnrichmentPreviewStatus


```json
{
  "description": "Enrichment preview sample status",
  "enum": [
    "success",
    "failed",
    "skipped"
  ],
  "type": "string"
}
```

## EnrichmentStage


```json
{
  "description": "Enrichment plan stage",
  "enum": [
    "frames",
    "locked-check",
    "description",
    "moment-index",
    "moment-captions"
  ],
  "type": "string"
}
```

## EnrichmentStaleReason


```json
{
  "description": "Why a generated result is out of date",
  "enum": [
    "source-changed",
    "identity-changed",
    "config-changed"
  ],
  "type": "string"
}
```

## EnumFilterAssetType

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "eq": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "in": {
      "items": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      },
      "minItems": 1,
      "type": "array"
    },
    "ne": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "notIn": {
      "items": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## EnumFilterAssetVisibility

Related models: [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "eq": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "in": {
      "items": {
        "$ref": "#/components/schemas/AssetVisibility"
      },
      "minItems": 1,
      "type": "array"
    },
    "ne": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "notIn": {
      "items": {
        "$ref": "#/components/schemas/AssetVisibility"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## EventStoryDto

Related models: [MemoryStoryPlaceDto](models-17.md#memorystoryplacedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets the event held before the diversity pass",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "dayCount": {
      "description": "Number of distinct local days the event covers",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "endDate": {
      "description": "Last local day of the event, 'yyyy-MM-dd'",
      "type": "string"
    },
    "kind": {
      "description": "Discriminator for an event story",
      "enum": [
        "event_story"
      ],
      "type": "string"
    },
    "place": {
      "$ref": "#/components/schemas/MemoryStoryPlaceDto"
    },
    "startDate": {
      "description": "First local day of the event, 'yyyy-MM-dd'",
      "type": "string"
    },
    "title": {
      "description": "Place label for the event, when it has one",
      "type": "string"
    },
    "year": {
      "description": "Year the event started",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "dayCount",
    "endDate",
    "kind",
    "startDate",
    "year"
  ],
  "type": "object"
}
```

## ExifResponseDto


```json
{
  "description": "EXIF response",
  "properties": {
    "bitsPerSample": {
      "default": null,
      "description": "Bits per sample",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "city": {
      "default": null,
      "description": "City name",
      "nullable": true,
      "type": "string"
    },
    "colorspace": {
      "default": null,
      "description": "Recorded color space",
      "nullable": true,
      "type": "string"
    },
    "country": {
      "default": null,
      "description": "Country name",
      "nullable": true,
      "type": "string"
    },
    "dateTimeOriginal": {
      "default": null,
      "description": "Original date/time",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "description": {
      "default": null,
      "description": "Image description",
      "nullable": true,
      "type": "string"
    },
    "exifImageHeight": {
      "default": null,
      "description": "Image height in pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exifImageWidth": {
      "default": null,
      "description": "Image width in pixels",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "exposureTime": {
      "default": null,
      "description": "Exposure time",
      "nullable": true,
      "type": "string"
    },
    "fNumber": {
      "default": null,
      "description": "F-number (aperture)",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fileSizeInByte": {
      "default": null,
      "description": "File size in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "focalLength": {
      "default": null,
      "description": "Focal length in mm",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fps": {
      "default": null,
      "description": "Video frame rate (frames per second)",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "isRejected": {
      "default": null,
      "description": "Whether the stored rating is rejected",
      "nullable": true,
      "type": "boolean"
    },
    "iso": {
      "default": null,
      "description": "ISO sensitivity",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "latitude": {
      "default": null,
      "description": "GPS latitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "lensModel": {
      "default": null,
      "description": "Lens model",
      "nullable": true,
      "type": "string"
    },
    "longitude": {
      "default": null,
      "description": "GPS longitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "make": {
      "default": null,
      "description": "Camera make",
      "nullable": true,
      "type": "string"
    },
    "model": {
      "default": null,
      "description": "Camera model",
      "nullable": true,
      "type": "string"
    },
    "modifyDate": {
      "default": null,
      "description": "Modification date/time",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "orientation": {
      "default": null,
      "description": "Image orientation",
      "nullable": true,
      "type": "string"
    },
    "profileDescription": {
      "default": null,
      "description": "Color profile description",
      "nullable": true,
      "type": "string"
    },
    "projectionType": {
      "default": null,
      "description": "Projection type",
      "nullable": true,
      "type": "string"
    },
    "rating": {
      "default": null,
      "description": "Rating",
      "maximum": 5,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "state": {
      "default": null,
      "description": "State/province name",
      "nullable": true,
      "type": "string"
    },
    "timeZone": {
      "default": null,
      "description": "Time zone",
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## FaceDto


```json
{
  "properties": {
    "id": {
      "description": "Face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
}
```

## FaceEvidenceDto


```json
{
  "properties": {
    "assetId": {
      "description": "The complete photo the face is in",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "box": {
      "description": "Where the face is in the photo",
      "nullable": true,
      "properties": {
        "height": {
          "description": "Height, as a fraction of the photo height",
          "format": "double",
          "type": "number"
        },
        "width": {
          "description": "Width, as a fraction of the photo width",
          "format": "double",
          "type": "number"
        },
        "x": {
          "description": "Left edge, as a fraction of the photo width",
          "format": "double",
          "type": "number"
        },
        "y": {
          "description": "Top edge, as a fraction of the photo height",
          "format": "double",
          "type": "number"
        }
      },
      "required": [
        "x",
        "y",
        "width",
        "height"
      ],
      "type": "object"
    },
    "faceId": {
      "description": "The face, when it still exists",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "box",
    "faceId"
  ],
  "type": "object"
}
```

## FileTrashItemResponseDto


```json
{
  "properties": {
    "checksum": {
      "description": "Hex-encoded SHA-256 checksum of the file",
      "type": "string"
    },
    "id": {
      "description": "File trash entry id",
      "type": "string"
    },
    "lastAssetId": {
      "description": "Asset that held the file last, when known",
      "nullable": true,
      "type": "string"
    },
    "lastOwnerId": {
      "description": "Account whose library held the file last, when known",
      "nullable": true,
      "type": "string"
    },
    "lastOwnerName": {
      "description": "Name of that account, while it exists",
      "nullable": true,
      "type": "string"
    },
    "originalFileName": {
      "description": "Name of the file when it was last in a library",
      "type": "string"
    },
    "sizeInBytes": {
      "description": "Size of the file in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "trashedAt": {
      "description": "When the file was moved to the file trash",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "checksum",
    "id",
    "lastAssetId",
    "lastOwnerId",
    "lastOwnerName",
    "originalFileName",
    "sizeInBytes",
    "trashedAt"
  ],
  "type": "object"
}
```

## FileTrashResponseDto

Related models: [FileTrashItemResponseDto](models-11.md#filetrashitemresponsedto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/FileTrashItemResponseDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Entries in the file trash",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "totalBytes": {
      "description": "Disk space the file trash holds, in bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "total",
    "totalBytes"
  ],
  "type": "object"
}
```

## FileTrashRestoreResponseDto


```json
{
  "properties": {
    "assetId": {
      "description": "The new asset the file was restored as, in its last owner’s library",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## FinishLibrarySetupDto


```json
{
  "additionalProperties": false,
  "properties": {
    "previewsReady": {
      "enum": [
        true
      ],
      "type": "boolean"
    },
    "receipt": {
      "pattern": "^[a-f0-9]{64}$",
      "type": "string"
    },
    "revision": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "previewsReady",
    "receipt",
    "revision"
  ],
  "type": "object"
}
```

## FolderSummaryResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Originals directly in this folder",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "path": {
      "description": "Folder path, without a trailing slash",
      "type": "string"
    },
    "size": {
      "description": "Bytes of the originals directly in this folder",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "path",
    "size"
  ],
  "type": "object"
}
```

## FoldersResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether folders are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether folders appear in web sidebar",
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

## FoldersUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether folders are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether folders appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## FrameleafAccountLinkResponseDto


```json
{
  "properties": {
    "available": {
      "description": "Sign in with Frameleaf is available on this server (it is linked)",
      "type": "boolean"
    },
    "email": {
      "description": "The linked Frameleaf account’s email",
      "nullable": true,
      "type": "string"
    },
    "lastSignInAt": {
      "nullable": true,
      "type": "string"
    },
    "linked": {
      "type": "boolean"
    },
    "linkedAt": {
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "available",
    "email",
    "lastSignInAt",
    "linked",
    "linkedAt"
  ],
  "type": "object"
}
```

## FrameleafHandoffCreateDto


```json
{
  "properties": {
    "returnTo": {
      "description": "The home address to sign in on; only an address this server published for its home network",
      "maxLength": 2048,
      "type": "string"
    }
  },
  "type": "object"
}
```

## FrameleafHandoffRedeemDto


```json
{
  "properties": {
    "code": {
      "description": "The code from POST oauth/frameleaf/handoff",
      "maxLength": 200,
      "minLength": 16,
      "type": "string"
    },
    "rememberMe": {
      "type": "boolean"
    }
  },
  "required": [
    "code"
  ],
  "type": "object"
}
```

## FrameleafHandoffResponseDto


```json
{
  "properties": {
    "code": {
      "description": "A single-use code for signing in on another address of this server",
      "type": "string"
    },
    "expiresAt": {
      "type": "string"
    },
    "url": {
      "description": "Where to continue with the code: the home address asked for, when this server published it",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "code",
    "expiresAt",
    "url"
  ],
  "type": "object"
}
```

## FrameleafLinkConfirmDto


```json
{
  "properties": {
    "confirmToken": {
      "description": "The token a preview returned",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "confirmToken"
  ],
  "type": "object"
}
```

## FrameleafLinkDto


```json
{
  "properties": {
    "codeVerifier": {
      "description": "OAuth code verifier (PKCE)",
      "type": "string"
    },
    "preview": {
      "description": "Report what linking would change (for example becoming an administrator) without linking yet",
      "type": "boolean"
    },
    "rememberMe": {
      "description": "Persist authentication cookies across browser sessions (default true)",
      "type": "boolean"
    },
    "state": {
      "description": "OAuth state parameter",
      "type": "string"
    },
    "url": {
      "description": "OAuth callback URL",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```
