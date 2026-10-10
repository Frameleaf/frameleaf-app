# Server API models 36

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## StudioTranscriptionResultDto

Related models: [StudioTranscriptionCue](models-35.md#studiotranscriptioncue), [StudioTranscriptionWord](models-36.md#studiotranscriptionword).

```json
{
  "properties": {
    "cues": {
      "description": "Ready for `captions.set`: `{ start, end, text }` only",
      "items": {
        "$ref": "#/components/schemas/StudioTranscriptionCue"
      },
      "type": "array"
    },
    "language": {
      "description": "The Whisper language code the speech was transcribed in",
      "type": "string"
    },
    "languageProbability": {
      "description": "How sure detection was; 1 when the language was given",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "model": {
      "description": "The Whisper model the worker used",
      "type": "string"
    },
    "words": {
      "description": "Word timings, for word-by-word caption styles",
      "items": {
        "$ref": "#/components/schemas/StudioTranscriptionWord"
      },
      "type": "array"
    }
  },
  "required": [
    "cues",
    "language",
    "languageProbability",
    "model",
    "words"
  ],
  "type": "object"
}
```

## StudioTranscriptionTime


```json
{
  "description": "Exact seconds on the main sequence, reduced",
  "properties": {
    "den": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "num": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "den",
    "num"
  ],
  "type": "object"
}
```

## StudioTranscriptionWord

Related models: [StudioTranscriptionTime](models-36.md#studiotranscriptiontime).

```json
{
  "properties": {
    "cue": {
      "description": "Index of the cue the word belongs to",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "end": {
      "$ref": "#/components/schemas/StudioTranscriptionTime"
    },
    "start": {
      "$ref": "#/components/schemas/StudioTranscriptionTime"
    },
    "text": {
      "type": "string"
    }
  },
  "required": [
    "cue",
    "end",
    "start",
    "text"
  ],
  "type": "object"
}
```

## StudioUnsupportedSourceDto

Related models: [DecodeRefusal](models-10.md#decoderefusal).

```json
{
  "properties": {
    "assetId": {
      "description": "The library video placed in the project",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reason": {
      "description": "Why, in plain words",
      "type": "string"
    },
    "refusal": {
      "$ref": "#/components/schemas/DecodeRefusal"
    }
  },
  "required": [
    "assetId",
    "reason",
    "refusal"
  ],
  "type": "object"
}
```

## StudioWorkerCapability


```json
{
  "description": "A Studio worker capability, as the command catalogue names it",
  "enum": [
    "analysisWorker",
    "generationWorker",
    "gpuWorker",
    "renderWorker",
    "restorationWorker",
    "transcriptionWorker"
  ],
  "type": "string"
}
```

## StudioWorkspaceDto


```json
{
  "properties": {
    "engineRevision": {
      "description": "The engine revision that wrote the layout",
      "nullable": true,
      "type": "string"
    },
    "layout": {
      "additionalProperties": {},
      "description": "The engine layout as the same JSON value it was saved as (key order and spacing are not kept); null when none is stored",
      "nullable": true,
      "type": "object"
    },
    "savedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "engineRevision",
    "layout",
    "savedAt"
  ],
  "type": "object"
}
```

## StudioWorkspaceSaveDto


```json
{
  "properties": {
    "engineRevision": {
      "description": "The pinned engine revision writing it",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "layout": {
      "additionalProperties": {},
      "description": "The engine layout; stored and returned as the same JSON value (key order and spacing are not kept)",
      "type": "object"
    }
  },
  "required": [
    "engineRevision",
    "layout"
  ],
  "type": "object"
}
```

## SuppressionResponse

Related models: [SuppressionScope](models-36.md#suppressionscope).

```json
{
  "properties": {
    "personIds": {
      "description": "Person IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "petIds": {
      "description": "Pet IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "scope": {
      "$ref": "#/components/schemas/SuppressionScope",
      "description": "Whether suppression applies only to owned assets or all visible assets"
    },
    "tagIds": {
      "description": "Tag IDs to suppress from locked browsing sessions",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "personIds",
    "petIds",
    "scope",
    "tagIds"
  ],
  "type": "object"
}
```

## SuppressionScope


```json
{
  "enum": [
    "owned",
    "visible"
  ],
  "type": "string"
}
```

## SuppressionUpdate

Related models: [SuppressionScope](models-36.md#suppressionscope).

```json
{
  "properties": {
    "personIds": {
      "description": "Person IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "petIds": {
      "description": "Pet IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "scope": {
      "$ref": "#/components/schemas/SuppressionScope",
      "description": "Whether suppression applies only to owned assets or all visible assets"
    },
    "tagIds": {
      "description": "Tag IDs to suppress from locked browsing sessions",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "type": "object"
}
```

## SyncAckDeleteDto

Related models: [SyncEntityType](models-37.md#syncentitytype).

```json
{
  "properties": {
    "types": {
      "description": "Sync entity types to delete acks for",
      "items": {
        "$ref": "#/components/schemas/SyncEntityType"
      },
      "type": "array"
    }
  },
  "type": "object"
}
```

## SyncAckDto


```json
{
  "properties": {
    "ack": {
      "description": "Acknowledgment ID",
      "type": "string"
    },
    "type": {
      "enum": [
        "AlbumAssetAccessV1",
        "AlbumAssetAccessDeleteV1",
        "PartnerAssetAccessV1",
        "PartnerAssetAccessDeleteV1",
        "PinnedCollectionV1",
        "PinnedCollectionDeleteV1",
        "AssetTrashStateV1",
        "AssetTrashStateDeleteV1",
        "DuplicateGroupV1",
        "DuplicateGroupDeleteV1",
        "SharedSpaceV1",
        "SharedSpaceDeleteV1",
        "SharedSpaceMemberV1",
        "SharedSpaceMemberDeleteV1",
        "SharedSpaceAlbumV1",
        "SharedSpaceAlbumDeleteV1",
        "SharedSpacePersonV1",
        "SharedSpacePersonDeleteV1",
        "PetV1",
        "PetDeleteV1",
        "PetObservationV1",
        "PetObservationDeleteV1",
        "TagV1",
        "TagDeleteV1",
        "AssetTagV1",
        "AssetTagDeleteV1",
        "AuthUserV1",
        "AuthUserV2",
        "UserV1",
        "UserDeleteV1",
        "AssetV1",
        "AssetV2",
        "AssetV3",
        "AssetBootstrapV1",
        "AssetDeleteV2",
        "AssetDeleteV1",
        "AssetExifV1",
        "AssetEditV1",
        "AssetEditDeleteV1",
        "AssetMetadataV1",
        "AssetMetadataDeleteV1",
        "AssetOcrV1",
        "AssetOcrDeleteV1",
        "PartnerV1",
        "PartnerDeleteV1",
        "PartnerAssetV1",
        "PartnerAssetV2",
        "PartnerAssetBackfillV1",
        "PartnerAssetBackfillV2",
        "PartnerAssetDeleteV1",
        "PartnerAssetExifV1",
        "PartnerAssetExifBackfillV1",
        "PartnerStackBackfillV1",
        "PartnerStackDeleteV1",
        "PartnerStackV1",
        "AlbumV1",
        "AlbumV2",
        "AlbumV3",
        "AlbumBootstrapV1",
        "AlbumDeleteV2",
        "AlbumDeleteV1",
        "AlbumUserV1",
        "AlbumUserBackfillV1",
        "AlbumUserDeleteV1",
        "AlbumAssetCreateV1",
        "AlbumAssetCreateV2",
        "AlbumAssetUpdateV1",
        "AlbumAssetUpdateV2",
        "AlbumAssetBackfillV1",
        "AlbumAssetBackfillV2",
        "AlbumAssetExifCreateV1",
        "AlbumAssetExifUpdateV1",
        "AlbumAssetExifBackfillV1",
        "AlbumToAssetV1",
        "AlbumToAssetDeleteV1",
        "AlbumToAssetBackfillV1",
        "MemoryV1",
        "MemoryDeleteV1",
        "MemoryToAssetV1",
        "MemoryToAssetDeleteV1",
        "StackV1",
        "StackDeleteV1",
        "PersonV1",
        "PersonDeleteV1",
        "AssetFaceV1",
        "AssetFaceV2",
        "AssetFaceV3",
        "AssetFaceDeleteV1",
        "UserMetadataV1",
        "PinnedCollectionsV1",
        "UserMetadataDeleteV1",
        "SyncAckV1",
        "SyncResetV1",
        "SyncCompleteV1"
      ],
      "type": "string"
    }
  },
  "required": [
    "ack",
    "type"
  ],
  "type": "object"
}
```

## SyncAckSetDto


```json
{
  "properties": {
    "acks": {
      "description": "Acknowledgment IDs (max 1000)",
      "items": {
        "type": "string"
      },
      "maxItems": 1000,
      "type": "array"
    }
  },
  "required": [
    "acks"
  ],
  "type": "object"
}
```

## SyncAckV1


```json
{
  "properties": {},
  "type": "object"
}
```

## SyncAckV2Dto

Related models: [SyncEntityType](models-37.md#syncentitytype).

```json
{
  "properties": {
    "ack": {
      "description": "Acknowledgment ID",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/SyncEntityType"
    }
  },
  "required": [
    "ack",
    "type"
  ],
  "type": "object"
}
```

## SyncAlbumAssetAccessDeleteV1


```json
{
  "description": "Drop this album-source asset and its descriptive mirror data, preserving independently authorized sources.",
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumAssetAccessV1

Related models: [SyncAssetV2](models-37.md#syncassetv2).

```json
{
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "asset": {
      "$ref": "#/components/schemas/SyncAssetV2"
    }
  },
  "required": [
    "albumId",
    "asset"
  ],
  "type": "object"
}
```

## SyncAlbumDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId"
  ],
  "type": "object"
}
```

## SyncAlbumSourceLinkDeleteV1


```json
{
  "properties": {
    "linkId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "linkId"
  ],
  "type": "object"
}
```

## SyncAlbumSourceLinkV1

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

## SyncAlbumToAssetDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumToAssetV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetId"
  ],
  "type": "object"
}
```

## SyncAlbumUserDeleteV1


```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    "albumId",
    "userId"
  ],
  "type": "object"
}
```

## SyncAlbumUserV1

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "properties": {
    "albumId": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
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
    "albumId",
    "role",
    "userId"
  ],
  "type": "object"
}
```

## SyncAlbumV1

Related models: [AssetOrder](models-06.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "id",
    "isActivityEnabled",
    "name",
    "order",
    "ownerId",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAlbumV2

Related models: [AssetOrder](models-06.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "id": {
      "description": "Album ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isActivityEnabled": {
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "id",
    "isActivityEnabled",
    "name",
    "order",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAlbumV3

Related models: [AlbumKind](models-02.md#albumkind), [AssetOrder](models-06.md#assetorder).

```json
{
  "properties": {
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Album description",
      "type": "string"
    },
    "icon": {
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
      "description": "Is activity enabled",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/AlbumKind"
    },
    "name": {
      "description": "Album name",
      "type": "string"
    },
    "order": {
      "$ref": "#/components/schemas/AssetOrder"
    },
    "parentId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sortOrder": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "thumbnailAssetId": {
      "description": "Thumbnail asset ID",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "Updated at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "deletedAt",
    "description",
    "icon",
    "id",
    "isActivityEnabled",
    "kind",
    "name",
    "order",
    "parentId",
    "sortOrder",
    "thumbnailAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncAssetDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## SyncAssetEditDeleteV1


```json
{
  "properties": {
    "editId": {
      "description": "Edit ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "editId"
  ],
  "type": "object"
}
```

## SyncAssetEditV1


```json
{
  "properties": {
    "action": {
      "description": "Edit action; future values pass through unchanged",
      "type": "string"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Edit ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "parameters": {
      "additionalProperties": {},
      "description": "Edit parameters",
      "type": "object"
    },
    "sequence": {
      "description": "Edit sequence",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "action",
    "assetId",
    "id",
    "parameters",
    "sequence"
  ],
  "type": "object"
}
```

## SyncAssetExifV1

Related models: [ImageEncodingInfo](models-14.md#imageencodinginfo).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
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
    "dateTimeOriginal": {
      "description": "Date time original",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "description": "Description",
      "nullable": true,
      "type": "string"
    },
    "exifImageHeight": {
      "description": "Exif image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "exifImageWidth": {
      "description": "Exif image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "exposureTime": {
      "description": "Exposure time",
      "nullable": true,
      "type": "string"
    },
    "fNumber": {
      "description": "F number",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fileSizeInByte": {
      "description": "File size in byte",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "focalLength": {
      "description": "Focal length",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "fps": {
      "description": "FPS",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "imageEncoding": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ImageEncodingInfo"
        }
      ],
      "nullable": true
    },
    "iso": {
      "description": "ISO",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "latitude": {
      "description": "Latitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "lensModel": {
      "description": "Lens model",
      "nullable": true,
      "type": "string"
    },
    "longitude": {
      "description": "Longitude",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "make": {
      "description": "Make",
      "nullable": true,
      "type": "string"
    },
    "model": {
      "description": "Model",
      "nullable": true,
      "type": "string"
    },
    "modifyDate": {
      "description": "Modify date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "orientation": {
      "description": "Orientation",
      "nullable": true,
      "type": "string"
    },
    "profileDescription": {
      "description": "Profile description",
      "nullable": true,
      "type": "string"
    },
    "projectionType": {
      "description": "Projection type",
      "nullable": true,
      "type": "string"
    },
    "rating": {
      "description": "Rating",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "state": {
      "description": "State",
      "nullable": true,
      "type": "string"
    },
    "timeZone": {
      "description": "Time zone",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "city",
    "country",
    "dateTimeOriginal",
    "description",
    "exifImageHeight",
    "exifImageWidth",
    "exposureTime",
    "fNumber",
    "fileSizeInByte",
    "focalLength",
    "fps",
    "iso",
    "latitude",
    "lensModel",
    "longitude",
    "make",
    "model",
    "modifyDate",
    "orientation",
    "profileDescription",
    "projectionType",
    "rating",
    "state",
    "timeZone"
  ],
  "type": "object"
}
```

## SyncAssetFaceDeleteV1


```json
{
  "properties": {
    "assetFaceId": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetFaceId"
  ],
  "type": "object"
}
```

## SyncAssetFaceV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Bounding box X1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Bounding box X2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Bounding box Y1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Bounding box Y2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "personId": {
      "description": "Person ID",
      "nullable": true,
      "type": "string"
    },
    "sourceType": {
      "description": "Source type",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "id",
    "imageHeight",
    "imageWidth",
    "personId",
    "sourceType"
  ],
  "type": "object"
}
```

## SyncAssetFaceV2

Related models: [SyncAssetFaceV3](models-36.md#syncassetfacev3).

```json
{
  "$ref": "#/components/schemas/SyncAssetFaceV3"
}
```

## SyncAssetFaceV3


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boundingBoxX1": {
      "description": "Bounding box X1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxX2": {
      "description": "Bounding box X2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY1": {
      "description": "Bounding box Y1",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "boundingBoxY2": {
      "description": "Bounding box Y2",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "deletedAt": {
      "description": "Face deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Asset face ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "imageHeight": {
      "description": "Image height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "imageWidth": {
      "description": "Image width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "isVisible": {
      "description": "Is the face visible in the asset",
      "type": "boolean"
    },
    "personId": {
      "description": "Person ID",
      "nullable": true,
      "type": "string"
    },
    "sourceType": {
      "description": "Source type",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "boundingBoxX1",
    "boundingBoxX2",
    "boundingBoxY1",
    "boundingBoxY2",
    "deletedAt",
    "id",
    "imageHeight",
    "imageWidth",
    "isVisible",
    "personId",
    "sourceType"
  ],
  "type": "object"
}
```

## SyncAssetMetadataDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Key",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "key"
  ],
  "type": "object"
}
```

## SyncAssetMetadataV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "key": {
      "description": "Key",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "Value",
      "type": "object"
    }
  },
  "required": [
    "assetId",
    "key",
    "value"
  ],
  "type": "object"
}
```

## SyncAssetOcrDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Original asset ID of the deleted OCR entry",
      "type": "string"
    },
    "deletedAt": {
      "description": "Timestamp when the OCR entry was deleted",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Audit row ID of the deleted OCR entry",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "deletedAt",
    "id"
  ],
  "type": "object"
}
```

## SyncAssetOcrV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "boxScore": {
      "description": "Confidence score of the bounding box",
      "format": "double",
      "type": "number"
    },
    "id": {
      "description": "OCR entry ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isVisible": {
      "description": "Whether the OCR entry is visible",
      "type": "boolean"
    },
    "text": {
      "description": "Recognized text content",
      "type": "string"
    },
    "textScore": {
      "description": "Confidence score of the recognized text",
      "format": "double",
      "type": "number"
    },
    "x1": {
      "description": "Top-left X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x2": {
      "description": "Top-right X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x3": {
      "description": "Bottom-right X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "x4": {
      "description": "Bottom-left X coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y1": {
      "description": "Top-left Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y2": {
      "description": "Top-right Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y3": {
      "description": "Bottom-right Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    },
    "y4": {
      "description": "Bottom-left Y coordinate (normalized 0–1)",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "assetId",
    "boxScore",
    "id",
    "isVisible",
    "text",
    "textScore",
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

## SyncAssetTagDeleteV1

Related models: [SyncAssetTagV1](models-36.md#syncassettagv1).

```json
{
  "$ref": "#/components/schemas/SyncAssetTagV1"
}
```

## SyncAssetTagV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "tagId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "tagId"
  ],
  "type": "object"
}
```

## SyncAssetTrashStateDeleteV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## SyncAssetTrashStateV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "deletedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "isOffline": {
      "type": "boolean"
    },
    "status": {
      "enum": [
        "active",
        "trashed",
        "deleted"
      ],
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "deletedAt",
    "isOffline",
    "status"
  ],
  "type": "object"
}
```

## SyncAssetV1

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "checksum": {
      "description": "Checksum",
      "type": "string"
    },
    "createdAt": {
      "description": "Uploaded to Frameleaf at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "deletedAt": {
      "description": "Deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "duration": {
      "description": "Duration",
      "nullable": true,
      "type": "string"
    },
    "fileCreatedAt": {
      "description": "File created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "fileModifiedAt": {
      "description": "File modified at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "height": {
      "description": "Asset height",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isEdited": {
      "description": "Is edited",
      "type": "boolean"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "libraryId": {
      "description": "Library ID",
      "nullable": true,
      "type": "string"
    },
    "livePhotoVideoId": {
      "description": "Live photo video ID",
      "nullable": true,
      "type": "string"
    },
    "localDateTime": {
      "description": "Local date time",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "originalFileName": {
      "description": "Original file name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stackId": {
      "description": "Stack ID",
      "nullable": true,
      "type": "string"
    },
    "thumbhash": {
      "description": "Thumbhash",
      "nullable": true,
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    },
    "width": {
      "description": "Asset width",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "checksum",
    "createdAt",
    "deletedAt",
    "duration",
    "fileCreatedAt",
    "fileModifiedAt",
    "height",
    "id",
    "isEdited",
    "isFavorite",
    "libraryId",
    "livePhotoVideoId",
    "localDateTime",
    "originalFileName",
    "ownerId",
    "stackId",
    "thumbhash",
    "type",
    "visibility",
    "width"
  ],
  "type": "object"
}
```
