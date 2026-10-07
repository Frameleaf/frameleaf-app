# Server API — Assets 3

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## downloadVideoEditVersion

`GET /api/assets/{id}/edit-versions/{versionId}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-media.controller.ts#L123).

Download a video version master

Permission: `asset.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/edit-versions/:versionId/download')
@FileResponse()
@Authenticated({ permission: Permission.AssetDownload })
@OriginalTransfer()
@Endpoint({
    summary: 'Download a video version master',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "downloadVideoEditVersion",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "versionId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Download a video version master",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.download",
  "x-immich-state": "Beta"
}
```

## restoreVideoEditVersion

`POST /api/assets/{id}/edit-versions/{versionId}/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L362).

Restore a saved video version

Permission: `asset.edit.create`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/edit-versions/:versionId/restore')
@Authenticated({ permission: Permission.AssetEditCreate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({ summary: 'Restore a saved video version', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "restoreVideoEditVersion",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "versionId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Restore a saved video version",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Beta"
}
```

## removeAssetEdits

`DELETE /api/assets/{id}/edits`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L381).

Remove edits from an existing asset

Permission: `asset.edit.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/edits')
@Authenticated({ permission: Permission.AssetEditDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove edits from an existing asset',
    description: 'Removes all edit actions (crop, rotate, mirror) associated with the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes all edit actions (crop, rotate, mirror) associated with the specified asset.",
  "operationId": "removeAssetEdits",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Remove edits from an existing asset",
  "tags": [
    "Assets"
  ],
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
  "x-immich-permission": "asset.edit.delete",
  "x-immich-state": "Beta"
}
```

## getAssetEdits

`GET /api/assets/{id}/edits`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L303).

Retrieve edits for an existing asset

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetEditsResponseDto](models-05.md#asseteditsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/edits')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'Retrieve edits for an existing asset',
    description: 'Retrieve a series of edit actions (crop, rotate, mirror) associated with the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a series of edit actions (crop, rotate, mirror) associated with the specified asset.",
  "operationId": "getAssetEdits",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetEditsResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve edits for an existing asset",
  "tags": [
    "Assets"
  ],
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
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Beta"
}
```

## editAsset

`PUT /api/assets/{id}/edits`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L326).

Apply edits to an existing asset

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetEditsCreateDto](models-05.md#asseteditscreatedto), [AssetEditsResponseDto](models-05.md#asseteditsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id/edits')
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Apply edits to an existing asset',
    description: 'Apply a series of edit actions (crop, rotate, mirror) to the specified asset.',
    history: new HistoryBuilder().added('v2.5.0').beta('v2.5.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Apply a series of edit actions (crop, rotate, mirror) to the specified asset.",
  "operationId": "editAsset",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetEditsCreateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetEditsResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Apply edits to an existing asset",
  "tags": [
    "Assets"
  ],
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
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Beta"
}
```

## getAssetEditKeyframes

`GET /api/assets/{id}/edits/keyframes`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L314).

List the original video's keyframes

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetEditKeyframesResponseDto](models-05.md#asseteditkeyframesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/edits/keyframes')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: "List the original video's keyframes",
    description:
      "The keyframe times of the original video, so an editor can show where a fast (keyframe) trim actually cuts. Owner's edit permission only; never the edited version.",
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The keyframe times of the original video, so an editor can show where a fast (keyframe) trim actually cuts. Owner's edit permission only; never the edited version.",
  "operationId": "getAssetEditKeyframes",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetEditKeyframesResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "List the original video's keyframes",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Beta"
}
```

## getAssetImageEnrichment

`GET /api/assets/{id}/image-enrichment`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L143).

Get image enrichment metadata

Permission: `asset.update`. Admin only: `false`.

Models: [AssetImageEnrichmentResponseDto](models-05.md#assetimageenrichmentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/image-enrichment')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Get image enrichment metadata',
    description: 'Retrieve private image description, tag, and NSFW detection metadata for a specific asset.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve private image description, tag, and NSFW detection metadata for a specific asset.",
  "operationId": "getAssetImageEnrichment",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetImageEnrichmentResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Get image enrichment metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Beta"
}
```

## updateAssetImageEnrichment

`PUT /api/assets/{id}/image-enrichment`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L157).

Update image enrichment metadata

Permission: `asset.update`. Admin only: `false`.

Models: [AssetImageEnrichmentActionRequestDto](models-05.md#assetimageenrichmentactionrequestdto), [AssetImageEnrichmentResponseDto](models-05.md#assetimageenrichmentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id/image-enrichment')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Update image enrichment metadata',
    description: 'Run repair actions for generated image descriptions, tags, and NSFW detection metadata.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Run repair actions for generated image descriptions, tags, and NSFW detection metadata.",
  "operationId": "updateAssetImageEnrichment",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetImageEnrichmentActionRequestDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetImageEnrichmentResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Update image enrichment metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Beta"
}
```

## getAssetMetadata

`GET /api/assets/{id}/metadata`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L240).

Get asset metadata

Permission: `asset.read`. Admin only: `false`.

Models: [AssetMetadataResponseDto](models-05.md#assetmetadataresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/metadata')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get asset metadata',
    description: 'Retrieve all metadata key-value pairs associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all metadata key-value pairs associated with the specified asset.",
  "operationId": "getAssetMetadata",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetMetadataResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Get asset metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## updateAssetMetadata

`PUT /api/assets/{id}/metadata`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L262).

Update asset metadata

Permission: `asset.update`. Admin only: `false`.

Models: [AssetMetadataResponseDto](models-05.md#assetmetadataresponsedto), [AssetMetadataUpsertDto](models-05.md#assetmetadataupsertdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id/metadata')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Update asset metadata',
    description: 'Update or add metadata key-value pairs for the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update or add metadata key-value pairs for the specified asset.",
  "operationId": "updateAssetMetadata",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetMetadataUpsertDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetMetadataResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Update asset metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Stable"
}
```

## deleteAssetMetadata

`DELETE /api/assets/{id}/metadata/{key}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L291).

Delete asset metadata by key

Permission: `asset.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/metadata/:key')
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete asset metadata by key',
    description: 'Delete a specific metadata key-value pair associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific metadata key-value pair associated with the specified asset.",
  "operationId": "deleteAssetMetadata",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "key",
      "required": true,
      "in": "path",
      "description": "Metadata key",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Delete asset metadata by key",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Stable"
}
```

## getAssetMetadataByKey

`GET /api/assets/{id}/metadata/{key}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L277).

Retrieve asset metadata by key

Permission: `asset.read`. Admin only: `false`.

Models: [AssetMetadataResponseDto](models-05.md#assetmetadataresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/metadata/:key')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve asset metadata by key',
    description: 'Retrieve the value of a specific metadata key associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the value of a specific metadata key associated with the specified asset.",
  "operationId": "getAssetMetadataByKey",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "key",
      "required": true,
      "in": "path",
      "description": "Metadata key",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetMetadataResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve asset metadata by key",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## getAssetOcr

`GET /api/assets/{id}/ocr`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset.controller.ts#L251).

Retrieve asset OCR data

Permission: `asset.read`. Admin only: `false`.

Models: [AssetOcrResponseDto](models-05.md#assetocrresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/ocr')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve asset OCR data',
    description: 'Retrieve all OCR (Optical Character Recognition) data associated with the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all OCR (Optical Character Recognition) data associated with the specified asset.",
  "operationId": "getAssetOcr",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetOcrResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve asset OCR data",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## downloadAsset

`GET /api/assets/{id}/original`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-media.controller.ts#L141).

Download original asset

Permission: `asset.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/original')
@FileResponse()
@Authenticated({ permission: Permission.AssetDownload, sharedLink: true })
@OriginalTransfer()
@Endpoint({
    summary: 'Download original asset',
    description: 'Downloads the original file of the specified asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Downloads the original file of the specified asset.",
  "operationId": "downloadAsset",
  "parameters": [
    {
      "name": "edited",
      "required": false,
      "in": "query",
      "description": "Return edited asset if available",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "slug",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Download original asset",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.download",
  "x-immich-state": "Stable"
}
```

## getAssetRestorations

`GET /api/assets/{id}/restorations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L53).

List restorations of an asset

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetRestorationListResponseDto](models-06.md#assetrestorationlistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/restorations')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'List restorations of an asset',
    description:
      'Every restoration of the asset, newest first, with its lifecycle state, the destination it was bound to and which result the owner chose as the playback version.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Every restoration of the asset, newest first, with its lifecycle state, the destination it was bound to and which result the owner chose as the playback version.",
  "operationId": "getAssetRestorations",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetRestorationListResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "List restorations of an asset",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Alpha"
}
```

## requestAssetRestoration

`POST /api/assets/{id}/restorations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L81).

Request a restoration preview

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetRestorationRequestDto](models-06.md#assetrestorationrequestdto), [AssetRestorationResponseDto](models-06.md#assetrestorationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/restorations')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Request a restoration preview',
    description:
      'Creates the next restoration revision of the asset and queues a small preview on the named destination. The destination is admitted now; a refusal (no consent, disabled, over budget, unhealthy) is returned instead of another destination being used.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Creates the next restoration revision of the asset and queues a small preview on the named destination. The destination is admitted now; a refusal (no consent, disabled, over budget, unhealthy) is returned instead of another destination being used.",
  "operationId": "requestAssetRestoration",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetRestorationRequestDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetRestorationResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Request a restoration preview",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Alpha"
}
```

## setCurrentAssetRestoration

`PUT /api/assets/{id}/restorations/current`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L98).

Choose the restoration used for playback

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetRestorationListResponseDto](models-06.md#assetrestorationlistresponsedto), [AssetRestorationSelectDto](models-06.md#assetrestorationselectdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id/restorations/current')
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Choose the restoration used for playback',
    description:
      'Makes a finished restoration the version the asset plays back, or the original when none is named. Explicit and reversible; a finished job never makes this choice.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Makes a finished restoration the version the asset plays back, or the original when none is named. Explicit and reversible; a finished job never makes this choice.",
  "operationId": "setCurrentAssetRestoration",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetRestorationSelectDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetRestorationListResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Choose the restoration used for playback",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Alpha"
}
```

## getAssetRestorationOptions

`GET /api/assets/{id}/restorations/options`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L65).

Get restoration options for an asset

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationOptionsDto](models-06.md#assetrestorationoptionsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/restorations/options')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'Get restoration options for an asset',
    description:
      'The output size after the 4K cap and every processing destination with whether it would admit the workload right now, whether media would leave the network, and a measured time estimate per destination.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The output size after the 4K cap and every processing destination with whether it would admit the workload right now, whether media would leave the network, and a measured time estimate per destination.",
  "operationId": "getAssetRestorationOptions",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "mode",
      "required": false,
      "in": "query",
      "schema": {
        "default": "faithful",
        "$ref": "#/components/schemas/AssetRestorationMode"
      }
    },
    {
      "name": "upscale",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": -9007199254740991,
        "maximum": 9007199254740991,
        "default": 2,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetRestorationOptionsDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Get restoration options for an asset",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Alpha"
}
```

## discardAssetRestoration

`DELETE /api/assets/{id}/restorations/{restorationId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L145).

Discard a restoration

Permission: `asset.edit.create`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/restorations/:restorationId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Discard a restoration',
    description:
      'Cancels anything still running, stops using the result for playback and removes every file the restoration produced. The record stays as history.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Cancels anything still running, stops using the result for playback and removes every file the restoration produced. The record stays as history.",
  "operationId": "discardAssetRestoration",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "restorationId",
      "required": true,
      "in": "path",
      "description": "Restoration ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Discard a restoration",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Alpha"
}
```

## acceptAssetRestoration

`POST /api/assets/{id}/restorations/{restorationId}/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L114).

Accept a restoration preview

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetRestorationResponseDto](models-06.md#assetrestorationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/restorations/:restorationId/accept')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Accept a restoration preview',
    description:
      'Queues the full-resolution render bound to exactly what was previewed: same destination, model, mode and size. Refused when the original changed since the preview or the destination no longer admits the workload.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues the full-resolution render bound to exactly what was previewed: same destination, model, mode and size. Refused when the original changed since the preview or the destination no longer admits the workload.",
  "operationId": "acceptAssetRestoration",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "restorationId",
      "required": true,
      "in": "path",
      "description": "Restoration ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetRestorationResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Accept a restoration preview",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.create",
  "x-immich-state": "Alpha"
}
```

## viewAssetRestorationFile

`GET /api/assets/{id}/restorations/{restorationId}/file`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/asset-restoration.controller.ts#L161).

View a restoration file

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetRestorationFileKind](models-06.md#assetrestorationfilekind).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/restorations/:restorationId/file')
@FileResponse()
@Authenticated({ permission: Permission.AssetEditGet })
@OriginalTransfer()
@Endpoint({
    summary: 'View a restoration file',
    description: 'Streams the preview input, the restored preview, the full result or its playback rendition.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Streams the preview input, the restored preview, the full result or its playback rendition.",
  "operationId": "viewAssetRestorationFile",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "kind",
      "required": false,
      "in": "query",
      "schema": {
        "default": "after",
        "$ref": "#/components/schemas/AssetRestorationFileKind"
      }
    },
    {
      "name": "restorationId",
      "required": true,
      "in": "path",
      "description": "Restoration ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "View a restoration file",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Alpha"
}
```
