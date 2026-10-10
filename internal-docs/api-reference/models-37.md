# Server API models 37

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## TagResponseDto


```json
{
  "properties": {
    "color": {
      "description": "Tag color (hex)",
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Tag ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "Tag name",
      "type": "string"
    },
    "parentId": {
      "description": "Parent tag ID",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string"
    },
    "value": {
      "description": "Tag value (full path)",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "id",
    "name",
    "updatedAt",
    "value"
  ],
  "type": "object"
}
```

## TagStatisticsResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Timeline items tagged with exactly this tag",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "description": "Tag ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "total": {
      "description": "Timeline items tagged with this tag or any tag nested under it",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "id",
    "total"
  ],
  "type": "object"
}
```

## TagUpdateDto


```json
{
  "properties": {
    "color": {
      "description": "Tag color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "name": {
      "description": "Tag name",
      "pattern": "^[^/]*$",
      "type": "string"
    },
    "parentId": {
      "description": "Move the tag under this parent tag; null moves it to the top level. The tag and all its descendants take the new path",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## TagUpsertDto


```json
{
  "properties": {
    "tags": {
      "description": "Tag names to upsert",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "tags"
  ],
  "type": "object"
}
```

## TagsResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether tags are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether tags appear in web sidebar",
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

## TagsUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether tags are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether tags appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## TakeoutAction


```json
{
  "description": "The step a job carries out",
  "enum": [
    "scan",
    "import"
  ],
  "type": "string"
}
```

## TakeoutAlbumDto


```json
{
  "properties": {
    "count": {
      "description": "Items in the folder",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "folder": {
      "description": "The export folder",
      "type": "string"
    },
    "name": {
      "description": "The album name it becomes",
      "type": "string"
    },
    "selected": {
      "description": "Recreated by the next import",
      "type": "boolean"
    },
    "year": {
      "description": "One of Google’s automatic year folders",
      "type": "boolean"
    }
  },
  "required": [
    "count",
    "folder",
    "name",
    "selected",
    "year"
  ],
  "type": "object"
}
```

## TakeoutArchiveCreateDto


```json
{
  "properties": {
    "name": {
      "description": "The archive’s file name",
      "maxLength": 255,
      "minLength": 1,
      "type": "string"
    },
    "size": {
      "description": "The archive’s size in bytes",
      "maximum": 1099511627776,
      "minimum": 22,
      "type": "integer"
    }
  },
  "required": [
    "name",
    "size"
  ],
  "type": "object"
}
```

## TakeoutControlAction


```json
{
  "description": "What to do with the running job",
  "enum": [
    "pause",
    "resume",
    "cancel"
  ],
  "type": "string"
}
```

## TakeoutControlDto

Related models: [TakeoutControlAction](models-37.md#takeoutcontrolaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/TakeoutControlAction"
    }
  },
  "required": [
    "action"
  ],
  "type": "object"
}
```

## TakeoutCountsDto


```json
{
  "properties": {
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "files": {
      "description": "Files found in the sources",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "hiddenLocked": {
      "description": "Items going into Locked, not listed until Locked is unlocked",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imported": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "importing": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "description": "Photos and videos",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "matched": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "matchedOriginals": {
      "description": "Items already in the library, whose album memberships are restored",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "newAssets": {
      "description": "Items still to import that are not in the library yet",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "ready": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "rejected": {
      "description": "Archive entries refused",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "review": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "suggestedPairs": {
      "description": "Possible Live Photo pairs awaiting a decision",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "unresolvedPairs": {
      "description": "Live Photo pairs that could not be linked",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "failed",
    "files",
    "hiddenLocked",
    "imported",
    "importing",
    "items",
    "matched",
    "matchedOriginals",
    "newAssets",
    "ready",
    "rejected",
    "review",
    "skipped",
    "suggestedPairs",
    "unresolvedPairs"
  ],
  "type": "object"
}
```

## TakeoutCreateDto


```json
{
  "properties": {
    "directory": {
      "description": "Administrators only: the directory inside the root, relative to it; empty for the root itself",
      "maxLength": 4096,
      "type": "string"
    },
    "name": {
      "description": "A name for this import",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "rootId": {
      "description": "Administrators only: the permitted import root to read a server directory from",
      "maxLength": 32,
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## TakeoutItemKind


```json
{
  "description": "Photo or video",
  "enum": [
    "image",
    "video"
  ],
  "type": "string"
}
```

## TakeoutItemResponseDto

Related models: [TakeoutItemKind](models-37.md#takeoutitemkind), [TakeoutItemState](models-37.md#takeoutitemstate), [TakeoutMetadataDto](models-37.md#takeoutmetadatadto), [TakeoutSidecarCandidateDto](models-37.md#takeoutsidecarcandidatedto), [TakeoutWarning](models-37.md#takeoutwarning).

```json
{
  "properties": {
    "albums": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "assetId": {
      "description": "The library item it became or matched, when this session may open it",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "candidates": {
      "items": {
        "$ref": "#/components/schemas/TakeoutSidecarCandidateDto"
      },
      "type": "array"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "folder": {
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/TakeoutItemKind"
    },
    "locked": {
      "type": "boolean"
    },
    "metadata": {
      "$ref": "#/components/schemas/TakeoutMetadataDto"
    },
    "path": {
      "description": "Path inside the export",
      "type": "string"
    },
    "sidecarId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "size": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "source": {
      "description": "The archive or directory the file came from",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/TakeoutItemState"
    },
    "warnings": {
      "items": {
        "$ref": "#/components/schemas/TakeoutWarning"
      },
      "type": "array"
    }
  },
  "required": [
    "albums",
    "assetId",
    "candidates",
    "error",
    "folder",
    "id",
    "kind",
    "locked",
    "metadata",
    "path",
    "sidecarId",
    "size",
    "source",
    "state",
    "warnings"
  ],
  "type": "object"
}
```

## TakeoutItemState


```json
{
  "description": "What happened to one photo or video",
  "enum": [
    "ready",
    "review",
    "importing",
    "imported",
    "matched",
    "skipped",
    "failed"
  ],
  "type": "string"
}
```

## TakeoutItemsResponseDto

Related models: [TakeoutItemResponseDto](models-37.md#takeoutitemresponsedto).

```json
{
  "properties": {
    "hiddenLocked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/TakeoutItemResponseDto"
      },
      "type": "array"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "hiddenLocked",
    "items",
    "total"
  ],
  "type": "object"
}
```

## TakeoutMetadataDto


```json
{
  "properties": {
    "archived": {
      "description": "Archived in Google Photos",
      "type": "boolean"
    },
    "createdAt": {
      "description": "When Google Photos received the photo (ISO 8601)",
      "type": "string"
    },
    "description": {
      "description": "Description",
      "type": "string"
    },
    "favorite": {
      "description": "Favorite in Google Photos",
      "type": "boolean"
    },
    "latitude": {
      "description": "Latitude",
      "format": "double",
      "type": "number"
    },
    "locked": {
      "description": "In the Google Photos Locked Folder; imported into Locked",
      "type": "boolean"
    },
    "longitude": {
      "description": "Longitude",
      "format": "double",
      "type": "number"
    },
    "takenAt": {
      "description": "When the photo was taken (ISO 8601)",
      "type": "string"
    },
    "title": {
      "description": "File name Google Photos recorded",
      "type": "string"
    },
    "trashed": {
      "description": "In the Google Photos trash; not imported",
      "type": "boolean"
    }
  },
  "required": [
    "title"
  ],
  "type": "object"
}
```

## TakeoutOptionsDto


```json
{
  "properties": {
    "albums": {
      "default": true,
      "description": "Recreate album memberships, including for photos already in the library",
      "type": "boolean"
    },
    "archive": {
      "default": true,
      "description": "Bring over archived photos as archived",
      "type": "boolean"
    },
    "dates": {
      "default": true,
      "description": "Bring over the dates photos were taken",
      "type": "boolean"
    },
    "descriptions": {
      "default": true,
      "description": "Bring over descriptions",
      "type": "boolean"
    },
    "favorites": {
      "default": true,
      "description": "Bring over favorites",
      "type": "boolean"
    },
    "locations": {
      "default": true,
      "description": "Bring over locations",
      "type": "boolean"
    },
    "selectedAlbums": {
      "description": "Album folders to recreate; omitted means every folder that is not a year folder",
      "items": {
        "maxLength": 4096,
        "type": "string"
      },
      "maxItems": 20000,
      "type": "array"
    },
    "sidecarReview": {
      "default": true,
      "description": "Hold items whose metadata sidecars disagree for a decision; off imports them without a sidecar",
      "type": "boolean"
    },
    "updateMatchedMetadata": {
      "default": false,
      "description": "Fill metadata missing from photos already in the library; values already there are never replaced",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## TakeoutOptionsResponseDto


```json
{
  "properties": {
    "albums": {
      "type": "boolean"
    },
    "archive": {
      "type": "boolean"
    },
    "dates": {
      "type": "boolean"
    },
    "descriptions": {
      "type": "boolean"
    },
    "favorites": {
      "type": "boolean"
    },
    "locations": {
      "type": "boolean"
    },
    "selectedAlbums": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "sidecarReview": {
      "type": "boolean"
    },
    "updateMatchedMetadata": {
      "type": "boolean"
    }
  },
  "required": [
    "albums",
    "archive",
    "dates",
    "descriptions",
    "favorites",
    "locations",
    "sidecarReview",
    "updateMatchedMetadata"
  ],
  "type": "object"
}
```

## TakeoutPairDecisionDto


```json
{
  "properties": {
    "approve": {
      "description": "True links them as one Live Photo; false keeps them separate",
      "type": "boolean"
    },
    "photoItemId": {
      "description": "The still photo",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "videoItemId": {
      "description": "The motion video",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "approve",
    "photoItemId",
    "videoItemId"
  ],
  "type": "object"
}
```

## TakeoutPairResponseDto

Related models: [TakeoutPairState](models-37.md#takeoutpairstate).

```json
{
  "properties": {
    "error": {
      "nullable": true,
      "type": "string"
    },
    "photoItemId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "photoPath": {
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/TakeoutPairState"
    },
    "videoItemId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "videoPath": {
      "type": "string"
    }
  },
  "required": [
    "error",
    "photoItemId",
    "photoPath",
    "state",
    "videoItemId",
    "videoPath"
  ],
  "type": "object"
}
```

## TakeoutPairState


```json
{
  "description": "A possible Live Photo pair and the owner’s decision",
  "enum": [
    "suggested",
    "approved",
    "skipped",
    "linked",
    "failed"
  ],
  "type": "string"
}
```

## TakeoutPairsResponseDto

Related models: [TakeoutPairResponseDto](models-37.md#takeoutpairresponsedto).

```json
{
  "properties": {
    "pairs": {
      "items": {
        "$ref": "#/components/schemas/TakeoutPairResponseDto"
      },
      "type": "array"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "pairs",
    "total"
  ],
  "type": "object"
}
```

## TakeoutPhase


```json
{
  "description": "The step the import has reached",
  "enum": [
    "sources",
    "scanning",
    "review",
    "importing",
    "completed"
  ],
  "type": "string"
}
```

## TakeoutResolveDto


```json
{
  "properties": {
    "sidecarId": {
      "description": "The sidecar to use; null imports without one",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "skip": {
      "description": "True leaves the item out of the import; false brings it back",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## TakeoutResponseDto

Related models: [TakeoutAction](models-37.md#takeoutaction), [TakeoutAlbumDto](models-37.md#takeoutalbumdto), [TakeoutCountsDto](models-37.md#takeoutcountsdto), [TakeoutOptionsResponseDto](models-37.md#takeoutoptionsresponsedto), [TakeoutPhase](models-37.md#takeoutphase), [TakeoutSourceResponseDto](models-37.md#takeoutsourceresponsedto), [TakeoutState](models-37.md#takeoutstate).

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

Related models: [TakeoutMetadataDto](models-37.md#takeoutmetadatadto).

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

Related models: [VideoTrimMode](models-39.md#videotrimmode).

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

Related models: [AssetOrder](models-06.md#assetorder).

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
