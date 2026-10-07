# Server API models 35

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

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

Related models: [SyncRequestType](models-34.md#syncrequesttype).

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

Related models: [UserMetadataKey](models-37.md#usermetadatakey).

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

Related models: [UserMetadataKey](models-37.md#usermetadatakey).

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

Related models: [UserAvatarColor](models-36.md#useravatarcolor).

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

Related models: [SystemConfigHistoryCredentialChange](models-35.md#systemconfighistorycredentialchange).

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

Related models: [SystemConfigHistoryChangeDto](models-35.md#systemconfighistorychangedto), [SystemConfigHistoryKind](models-35.md#systemconfighistorykind), [SystemConfigHistorySource](models-35.md#systemconfighistorysource).

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

Related models: [SystemConfigHistoryEntryDto](models-35.md#systemconfighistoryentrydto).

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

Related models: [TakeoutControlAction](models-35.md#takeoutcontrolaction).

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

Related models: [TakeoutItemKind](models-35.md#takeoutitemkind), [TakeoutItemState](models-35.md#takeoutitemstate), [TakeoutMetadataDto](models-35.md#takeoutmetadatadto), [TakeoutSidecarCandidateDto](models-35.md#takeoutsidecarcandidatedto), [TakeoutWarning](models-35.md#takeoutwarning).

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

Related models: [TakeoutItemResponseDto](models-35.md#takeoutitemresponsedto).

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

Related models: [TakeoutPairState](models-35.md#takeoutpairstate).

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

Related models: [TakeoutPairResponseDto](models-35.md#takeoutpairresponsedto).

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

Related models: [TakeoutAction](models-35.md#takeoutaction), [TakeoutAlbumDto](models-35.md#takeoutalbumdto), [TakeoutCountsDto](models-35.md#takeoutcountsdto), [TakeoutOptionsResponseDto](models-35.md#takeoutoptionsresponsedto), [TakeoutPhase](models-35.md#takeoutphase), [TakeoutSourceResponseDto](models-35.md#takeoutsourceresponsedto), [TakeoutState](models-35.md#takeoutstate).

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

Related models: [TakeoutRootDto](models-35.md#takeoutrootdto).

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

Related models: [TakeoutMetadataDto](models-35.md#takeoutmetadatadto).

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

Related models: [TakeoutSourceKind](models-35.md#takeoutsourcekind).

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
