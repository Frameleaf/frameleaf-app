# Server API models 36

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## SyncAuthUserV2

Related models: [UserAvatarColor](models-38.md#useravatarcolor).

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
    "deletedAt": {
      "description": "User deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "type": "string"
    },
    "hasProfileImage": {
      "description": "User has profile image",
      "type": "boolean"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isAdmin": {
      "description": "User is admin",
      "type": "boolean"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "oauthId": {
      "description": "User OAuth ID",
      "nullable": true,
      "type": "string"
    },
    "pinCode": {
      "description": "User pin code",
      "nullable": true,
      "type": "string"
    },
    "profileChangedAt": {
      "description": "User profile changed at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "quotaSizeInBytes": {
      "description": "Quota size in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "quotaUsageInBytes": {
      "description": "Quota usage in bytes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "storageLabel": {
      "description": "User storage label",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "deletedAt",
    "email",
    "hasProfileImage",
    "id",
    "isAdmin",
    "name",
    "oauthId",
    "pinCode",
    "profileChangedAt",
    "quotaSizeInBytes",
    "quotaUsageInBytes",
    "storageLabel"
  ],
  "type": "object"
}
```

## SyncCompleteV1


```json
{
  "properties": {},
  "type": "object"
}
```

## SyncDuplicateGroupDeleteV1


```json
{
  "properties": {
    "groupId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "groupId"
  ],
  "type": "object"
}
```

## SyncDuplicateGroupV1


```json
{
  "properties": {
    "assetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "minItems": 2,
      "type": "array"
    },
    "groupId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetIds",
    "groupId"
  ],
  "type": "object"
}
```

## SyncEntityType


```json
{
  "description": "Sync entity type",
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
    "AlbumSourceLinkV1",
    "AlbumSourceLinkDeleteV1",
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
```

## SyncMemoryAssetDeleteV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryAssetV1


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryDeleteV1


```json
{
  "properties": {
    "memoryId": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "memoryId"
  ],
  "type": "object"
}
```

## SyncMemoryV1

Related models: [MemoryType](models-17.md#memorytype).

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
    "data": {
      "additionalProperties": {},
      "description": "Data",
      "type": "object"
    },
    "deletedAt": {
      "description": "Deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "hideAt": {
      "description": "Hide at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isSaved": {
      "description": "Is saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "seenAt": {
      "description": "Seen at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Show at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
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
    "data",
    "deletedAt",
    "hideAt",
    "id",
    "isSaved",
    "memoryAt",
    "ownerId",
    "seenAt",
    "showAt",
    "type",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncPartnerAssetAccessDeleteV1


```json
{
  "description": "Drop this partner-source asset and its descriptive mirror data, preserving independently authorized sources.",
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "sharedById": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "sharedById"
  ],
  "type": "object"
}
```

## SyncPartnerAssetAccessV1

Related models: [SyncAssetV2](models-35.md#syncassetv2).

```json
{
  "properties": {
    "asset": {
      "$ref": "#/components/schemas/SyncAssetV2"
    },
    "sharedById": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "asset",
    "sharedById"
  ],
  "type": "object"
}
```

## SyncPartnerDeleteV1


```json
{
  "properties": {
    "sharedById": {
      "description": "Shared by ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sharedWithId": {
      "description": "Shared with ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "sharedById",
    "sharedWithId"
  ],
  "type": "object"
}
```

## SyncPartnerV1


```json
{
  "properties": {
    "inTimeline": {
      "description": "In timeline",
      "type": "boolean"
    },
    "sharedById": {
      "description": "Shared by ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sharedWithId": {
      "description": "Shared with ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "inTimeline",
    "sharedById",
    "sharedWithId"
  ],
  "type": "object"
}
```

## SyncPersonDeleteV1


```json
{
  "properties": {
    "personId": {
      "description": "Person ID",
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

## SyncPersonV1


```json
{
  "properties": {
    "birthDate": {
      "description": "Birth date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "color": {
      "description": "Color",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "description": "Created at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "faceAssetId": {
      "description": "Face asset ID",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    "birthDate",
    "color",
    "createdAt",
    "faceAssetId",
    "id",
    "isFavorite",
    "isHidden",
    "name",
    "ownerId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncPetDeleteV1


```json
{
  "properties": {
    "petId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "petId"
  ],
  "type": "object"
}
```

## SyncPetObservationDeleteV1


```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "observationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "petId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "observationId",
    "petId"
  ],
  "type": "object"
}
```

## SyncPetObservationV1

Related models: [PetObservationResponseDto](models-19.md#petobservationresponsedto).

```json
{
  "$ref": "#/components/schemas/PetObservationResponseDto"
}
```

## SyncPetV1

Related models: [PetResponseDto](models-19.md#petresponsedto).

```json
{
  "$ref": "#/components/schemas/PetResponseDto"
}
```

## SyncPinnedCollectionDeleteV1


```json
{
  "description": "Remove available mirror hydration only. The opaque stored pin may remain as an unavailable V1 snapshot placeholder.",
  "properties": {
    "pinId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "pinId"
  ],
  "type": "object"
}
```

## SyncPinnedCollectionV1


```json
{
  "description": "Current authorized pin hydration at its complete-list position. Unavailable pins retain their V1 snapshot placeholder but have no event hydration.",
  "properties": {
    "count": {
      "description": "Current access-filtered item count; null when unavailable",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "countCapped": {
      "description": "Whether a semantic saved-search count reached the existing smart-search cap",
      "type": "boolean"
    },
    "coverAssetId": {
      "description": "Current readable cover asset; null when unavailable or empty",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "enum": [
        "album",
        "smart-album",
        "saved-search",
        "person",
        "pet",
        "memory",
        "builtin"
      ],
      "type": "string"
    },
    "position": {
      "maximum": 49,
      "minimum": 0,
      "type": "integer"
    },
    "targetId": {
      "type": "string"
    },
    "title": {
      "description": "Current access-filtered title; null when unavailable",
      "nullable": true,
      "type": "string"
    },
    "unavailable": {
      "enum": [
        false
      ],
      "type": "boolean"
    }
  },
  "required": [
    "count",
    "countCapped",
    "coverAssetId",
    "id",
    "kind",
    "position",
    "targetId",
    "title",
    "unavailable"
  ],
  "type": "object"
}
```

## SyncPinnedCollectionsV1

Related models: [PinnedCollection](models-26.md#pinnedcollection).

```json
{
  "properties": {
    "pins": {
      "description": "Complete replacement snapshot in user order, including unavailable pins",
      "items": {
        "$ref": "#/components/schemas/PinnedCollection"
      },
      "type": "array"
    },
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "userId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "pins",
    "revision",
    "userId"
  ],
  "type": "object"
}
```

## SyncRequestType


```json
{
  "description": "Sync request type",
  "enum": [
    "AlbumAssetAccessV1",
    "PartnerAssetAccessV1",
    "PinnedCollectionEventsV1",
    "AssetTrashStatesV1",
    "DuplicateGroupsV1",
    "SharedSpacesV1",
    "SharedSpaceMembersV1",
    "SharedSpaceAlbumsV1",
    "SharedSpacePeopleV1",
    "PetsV1",
    "PetObservationsV1",
    "TagsV1",
    "AssetTagsV1",
    "AlbumsV1",
    "AlbumsV2",
    "AlbumsV3",
    "AlbumUsersV1",
    "AlbumToAssetsV1",
    "AlbumAssetsV1",
    "AlbumAssetsV2",
    "AlbumAssetExifsV1",
    "AssetsV1",
    "AssetsV2",
    "AssetsV3",
    "AssetExifsV1",
    "AssetEditsV1",
    "AssetMetadataV1",
    "AssetOcrV1",
    "AuthUsersV1",
    "AuthUsersV2",
    "MemoriesV1",
    "MemoryToAssetsV1",
    "PartnersV1",
    "PartnerAssetsV1",
    "PartnerAssetsV2",
    "PartnerAssetExifsV1",
    "PartnerStacksV1",
    "StacksV1",
    "UsersV1",
    "PeopleV1",
    "AssetFacesV1",
    "AssetFacesV2",
    "AssetFacesV3",
    "UserMetadataV1",
    "PinnedCollectionsV1",
    "AlbumSourceLinksV1"
  ],
  "type": "string"
}
```

## SyncResetV1


```json
{
  "properties": {},
  "type": "object"
}
```

## SyncSharedSpaceAlbumDeleteV1


```json
{
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "spaceId"
  ],
  "type": "object"
}
```

## SyncSharedSpaceAlbumV1


```json
{
  "description": "Published album reference only; does not grant target AlbumRead access",
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "assetCount": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "icon": {
      "nullable": true,
      "type": "string"
    },
    "linkedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "thumbnailAssetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "albumId",
    "assetCount",
    "icon",
    "linkedAt",
    "name",
    "spaceId",
    "thumbnailAssetId"
  ],
  "type": "object"
}
```

## SyncSharedSpaceDeleteV1


```json
{
  "properties": {
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "spaceId"
  ],
  "type": "object"
}
```

## SyncSharedSpaceMemberDeleteV1


```json
{
  "properties": {
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "userId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "spaceId",
    "userId"
  ],
  "type": "object"
}
```

## SyncSharedSpaceMemberV1

Related models: [AlbumUserRole](models-02.md#albumuserrole).

```json
{
  "description": "Accepted membership only; pending invitations confer no sync access",
  "properties": {
    "createdAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "role": {
      "$ref": "#/components/schemas/AlbumUserRole"
    },
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "updatedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "userId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "role",
    "spaceId",
    "updatedAt",
    "userId"
  ],
  "type": "object"
}
```

## SyncSharedSpacePersonDeleteV1


```json
{
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "id",
    "spaceId"
  ],
  "type": "object"
}
```

## SyncSharedSpacePersonV1


```json
{
  "description": "Published link identity only; excludes the underlying private person",
  "properties": {
    "assetCount": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "coverAssetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "linkedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "spaceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "coverAssetId",
    "id",
    "linkedAt",
    "name",
    "spaceId"
  ],
  "type": "object"
}
```

## SyncSharedSpaceV1


```json
{
  "properties": {
    "createdAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "description": {
      "nullable": true,
      "type": "string"
    },
    "icon": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "enum": [
        "space"
      ],
      "type": "string"
    },
    "name": {
      "type": "string"
    },
    "updatedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "icon",
    "id",
    "kind",
    "name",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncStackDeleteV1


```json
{
  "properties": {
    "stackId": {
      "description": "Stack ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "stackId"
  ],
  "type": "object"
}
```

## SyncStackV1


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
    "id": {
      "description": "Stack ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "primaryAssetId": {
      "description": "Primary asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    "id",
    "ownerId",
    "primaryAssetId",
    "updatedAt"
  ],
  "type": "object"
}
```

## SyncStreamDto

Related models: [SyncRequestType](models-36.md#syncrequesttype).

```json
{
  "properties": {
    "reset": {
      "description": "Reset sync state",
      "type": "boolean"
    },
    "types": {
      "description": "Sync request types",
      "items": {
        "$ref": "#/components/schemas/SyncRequestType"
      },
      "type": "array"
    }
  },
  "required": [
    "types"
  ],
  "type": "object"
}
```

## SyncTagDeleteV1


```json
{
  "properties": {
    "tagId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "tagId"
  ],
  "type": "object"
}
```

## SyncTagV1


```json
{
  "properties": {
    "color": {
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "parentId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "updatedAt": {
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "userId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "value": {
      "type": "string"
    }
  },
  "required": [
    "color",
    "createdAt",
    "id",
    "parentId",
    "updatedAt",
    "userId",
    "value"
  ],
  "type": "object"
}
```

## SyncUserDeleteV1


```json
{
  "properties": {
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

## SyncUserMetadataDeleteV1

Related models: [UserMetadataKey](models-38.md#usermetadatakey).

```json
{
  "properties": {
    "key": {
      "$ref": "#/components/schemas/UserMetadataKey"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "key",
    "userId"
  ],
  "type": "object"
}
```

## SyncUserMetadataV1

Related models: [UserMetadataKey](models-38.md#usermetadatakey).

```json
{
  "properties": {
    "key": {
      "$ref": "#/components/schemas/UserMetadataKey"
    },
    "userId": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "value": {
      "additionalProperties": {},
      "description": "User metadata value",
      "type": "object"
    }
  },
  "required": [
    "key",
    "userId",
    "value"
  ],
  "type": "object"
}
```

## SyncUserV1

Related models: [UserAvatarColor](models-38.md#useravatarcolor).

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
    "deletedAt": {
      "description": "User deleted at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "email": {
      "description": "User email",
      "type": "string"
    },
    "hasProfileImage": {
      "description": "User has profile image",
      "type": "boolean"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "profileChangedAt": {
      "description": "User profile changed at",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "deletedAt",
    "email",
    "hasProfileImage",
    "id",
    "name",
    "profileChangedAt"
  ],
  "type": "object"
}
```

## SystemConfigHistoryChangeDto

Related models: [SystemConfigHistoryCredentialChange](models-36.md#systemconfighistorycredentialchange).

```json
{
  "properties": {
    "after": {
      "description": "The value after the change, JSON encoded; null for a credential",
      "nullable": true,
      "type": "string"
    },
    "before": {
      "description": "The value before the change, JSON encoded; null for a credential",
      "nullable": true,
      "type": "string"
    },
    "credential": {
      "$ref": "#/components/schemas/SystemConfigHistoryCredentialChange"
    },
    "path": {
      "description": "The changed setting, as a dotted path such as trash.days",
      "type": "string"
    }
  },
  "required": [
    "after",
    "before",
    "path"
  ],
  "type": "object"
}
```

## SystemConfigHistoryCredentialChange


```json
{
  "description": "Set for a write-only credential: whether it was replaced or cleared. Its value is never recorded",
  "enum": [
    "replaced",
    "cleared"
  ],
  "type": "string"
}
```

## SystemConfigHistoryEntryDto

Related models: [SystemConfigHistoryChangeDto](models-36.md#systemconfighistorychangedto), [SystemConfigHistoryKind](models-36.md#systemconfighistorykind), [SystemConfigHistorySource](models-36.md#systemconfighistorysource).

```json
{
  "properties": {
    "actorId": {
      "description": "The administrator who saved the change",
      "nullable": true,
      "type": "string"
    },
    "actorName": {
      "description": "The administrator's name when the change was saved",
      "nullable": true,
      "type": "string"
    },
    "changes": {
      "description": "Every changed setting",
      "items": {
        "$ref": "#/components/schemas/SystemConfigHistoryChangeDto"
      },
      "type": "array"
    },
    "createdAt": {
      "description": "When the change was saved (ISO 8601)",
      "type": "string"
    },
    "id": {
      "description": "Entry ID",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/SystemConfigHistoryKind"
    },
    "omittedChanges": {
      "description": "Changed settings left out because the entry reached its limit",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "source": {
      "$ref": "#/components/schemas/SystemConfigHistorySource"
    },
    "title": {
      "description": "The entry title, such as \"Updated email server password\"; absent for a settings save",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "actorId",
    "actorName",
    "changes",
    "createdAt",
    "id",
    "omittedChanges"
  ],
  "type": "object"
}
```

## SystemConfigHistoryKind


```json
{
  "description": "What the entry records; absent for entries saved before it was recorded",
  "enum": [
    "settings",
    "credential",
    "review"
  ],
  "type": "string"
}
```

## SystemConfigHistoryResponseDto

Related models: [SystemConfigHistoryEntryDto](models-36.md#systemconfighistoryentrydto).

```json
{
  "properties": {
    "entries": {
      "description": "The newest settings changes first",
      "items": {
        "$ref": "#/components/schemas/SystemConfigHistoryEntryDto"
      },
      "type": "array"
    }
  },
  "required": [
    "entries"
  ],
  "type": "object"
}
```

## SystemConfigHistorySource


```json
{
  "description": "Where a change came from when it was not an ordinary settings save: the server command line, or the Frameleaf Cloud settings and actions (with the administrator, when one made it)",
  "enum": [
    "server-cli",
    "frameleaf-cloud"
  ],
  "type": "string",
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ]
}
```

## SystemConfigTemplateStorageOptionDto


```json
{
  "properties": {
    "dayOptions": {
      "description": "Available day format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "hourOptions": {
      "description": "Available hour format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "minuteOptions": {
      "description": "Available minute format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "monthOptions": {
      "description": "Available month format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "presetOptions": {
      "description": "Available preset template options",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "secondOptions": {
      "description": "Available second format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "weekOptions": {
      "description": "Available week format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "yearOptions": {
      "description": "Available year format options for storage template",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "dayOptions",
    "hourOptions",
    "minuteOptions",
    "monthOptions",
    "presetOptions",
    "secondOptions",
    "weekOptions",
    "yearOptions"
  ],
  "type": "object"
}
```

## TagBulkAssetsDto


```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "tagIds": {
      "description": "Tag IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "assetIds",
    "tagIds"
  ],
  "type": "object"
}
```

## TagBulkAssetsResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of assets tagged",
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

## TagCreateDto


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
      "description": "Parent tag ID",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```
