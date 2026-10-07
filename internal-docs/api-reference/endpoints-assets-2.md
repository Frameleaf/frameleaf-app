# Server API — Assets 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAssetUploadResourceOffset

`HEAD /api/assets/uploads/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-upload-resource.controller.ts#L180).

Get durable upload offset

Permission: `asset.upload`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Head(':id')
@Authenticated({ permission: Permission.AssetUpload })
@ApiResponse({
    status: 204,
    description: 'Durable acknowledged offset; completion only after final processing',
    headers: {
      'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
      'Upload-Complete': { schema: { type: 'string', enum: ['?0', '?1'] } },
    },
  })
@Endpoint({ summary: 'Get durable upload offset', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "getAssetUploadResourceOffset",
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
      "description": "Durable acknowledged offset; completion only after final processing",
      "headers": {
        "Upload-Complete": {
          "schema": {
            "enum": [
              "?0",
              "?1"
            ],
            "type": "string"
          }
        },
        "Upload-Offset": {
          "schema": {
            "minimum": 0,
            "type": "integer"
          }
        }
      }
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
  "summary": "Get durable upload offset",
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Beta"
}
```

## appendAssetUploadResource

`PATCH /api/assets/uploads/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-upload-resource.controller.ts#L197).

Append immutable upload bytes

Permission: `asset.upload`. Admin only: `false`.

Models: [AssetUploadResultDto](models-06.md#assetuploadresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Patch(':id')
@Authenticated({ permission: Permission.AssetUpload })
@ApiConsumes('application/partial-upload')
@ApiHeader({ name: 'Upload-Draft-Interop-Version', required: true, schema: { type: 'string', enum: ['9'] } })
@ApiHeader({ name: 'Upload-Offset', required: true, schema: { type: 'integer', minimum: 0 } })
@ApiHeader({ name: 'Upload-Complete', required: true, schema: { type: 'string', enum: ['?0', '?1'] } })
@ApiBody({ schema: { type: 'string', format: 'binary' } })
@ApiResponse({ status: 200, type: AssetUploadResultDto })
@ApiResponse({
    status: 204,
    description: 'Immutable append durably acknowledged',
    headers: {
      'Upload-Offset': { schema: { type: 'integer', minimum: 0 } },
      'Upload-Complete': { schema: { type: 'string', enum: ['?0', '?1'] } },
    },
  })
@ApiResponse({
    status: 202,
    description: 'Same upload is pending final ingestion; retry empty completion at the durable offset',
  })
@ApiResponse({ status: 409, description: 'Offset or state conflict; HEAD returns the durable acknowledged offset' })
@Endpoint({ summary: 'Append immutable upload bytes', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "appendAssetUploadResource",
  "parameters": [
    {
      "name": "Upload-Complete",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "enum": [
          "?0",
          "?1"
        ]
      }
    },
    {
      "name": "Upload-Draft-Interop-Version",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "enum": [
          "9"
        ]
      }
    },
    {
      "name": "Upload-Offset",
      "in": "header",
      "required": true,
      "schema": {
        "type": "integer",
        "minimum": 0
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
    }
  ],
  "requestBody": {
    "content": {
      "application/partial-upload": {
        "schema": {
          "format": "binary",
          "type": "string"
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
            "$ref": "#/components/schemas/AssetUploadResultDto"
          }
        }
      },
      "description": ""
    },
    "202": {
      "description": "Same upload is pending final ingestion; retry empty completion at the durable offset"
    },
    "204": {
      "description": "Immutable append durably acknowledged",
      "headers": {
        "Upload-Complete": {
          "schema": {
            "enum": [
              "?0",
              "?1"
            ],
            "type": "string"
          }
        },
        "Upload-Offset": {
          "schema": {
            "minimum": 0,
            "type": "integer"
          }
        }
      }
    },
    "409": {
      "description": "Offset or state conflict; HEAD returns the durable acknowledged offset"
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
  "summary": "Append immutable upload bytes",
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Beta"
}
```

## getAssetUploadResourceResult

`GET /api/assets/uploads/{id}/result`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-upload-resource.controller.ts#L243).

Recover a completed upload result

Permission: `asset.upload`. Admin only: `false`.

Models: [AssetUploadResultDto](models-06.md#assetuploadresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Get(':id/result')
@Authenticated({ permission: Permission.AssetUpload })
@ApiResponse({ status: 200, type: AssetUploadResultDto })
@ApiResponse({ status: 202, description: 'Ingestion pending; retry this same resource' })
@Endpoint({
    summary: 'Recover a completed upload result',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getAssetUploadResourceResult",
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
            "$ref": "#/components/schemas/AssetUploadResultDto"
          }
        }
      },
      "description": ""
    },
    "202": {
      "description": "Ingestion pending; retry this same resource"
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
  "summary": "Recover a completed upload result",
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Beta"
}
```

## getAssetInfo

`GET /api/assets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset.controller.ts#L132).

Retrieve an asset

Permission: `asset.read`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id')
@Authenticated({ permission: Permission.AssetRead, sharedLink: true })
@Endpoint({
    summary: 'Retrieve an asset',
    description: 'Retrieve detailed information about a specific asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve detailed information about a specific asset.",
  "operationId": "getAssetInfo",
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
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetResponseDto"
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
  "summary": "Retrieve an asset",
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

## updateAsset

`PUT /api/assets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset.controller.ts#L210).

Update an asset

Permission: `asset.update`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto), [UpdateAssetDto](models-36.md#updateassetdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Update an asset',
    description: 'Update information of a specific asset.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateAsset' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update information of a specific asset.",
  "operationId": "updateAsset",
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
          "$ref": "#/components/schemas/UpdateAssetDto"
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
            "$ref": "#/components/schemas/AssetResponseDto"
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
  "summary": "Update an asset",
  "tags": [
    "Assets",
    "Deprecated"
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
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateAsset"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Deprecated"
}
```

## getAssetDevelop

`GET /api/assets/{id}/develop`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L51).

List develop versions of an asset

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetDevelopResponseDto](models-05.md#assetdevelopresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/develop')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'List develop versions of an asset',
    description:
      'Every saved still-image edit recipe for the asset, newest first, with its render state and which one is current.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Every saved still-image edit recipe for the asset, newest first, with its render state and which one is current.",
  "operationId": "getAssetDevelop",
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
            "$ref": "#/components/schemas/AssetDevelopResponseDto"
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
  "summary": "List develop versions of an asset",
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

## saveAssetDevelop

`PUT /api/assets/{id}/develop`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L63).

Save a develop recipe as a new version

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopRevisionResponseDto](models-05.md#assetdeveloprevisionresponsedto), [AssetDevelopSaveDto](models-05.md#assetdevelopsavedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put(':id/develop')
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Save a develop recipe as a new version',
    description:
      'Stores the recipe as the next revision of the asset and, by default, queues the edited master render. The original file is never changed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Stores the recipe as the next revision of the asset and, by default, queues the edited master render. The original file is never changed.",
  "operationId": "saveAssetDevelop",
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
          "$ref": "#/components/schemas/AssetDevelopSaveDto"
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
            "$ref": "#/components/schemas/AssetDevelopRevisionResponseDto"
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
  "summary": "Save a develop recipe as a new version",
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

## uploadAssetDevelopArtifact

`POST /api/assets/{id}/develop/artifacts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/photo-tools.controller.ts#L178).

Upload a develop artifact

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopArtifactResponseDto](models-04.md#assetdevelopartifactresponsedto), [AssetDevelopArtifactUploadDto](models-04.md#assetdevelopartifactuploaddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Post(`${RouteKey.Asset}/:id/develop/artifacts`)
@Authenticated({ permission: Permission.AssetEditCreate })
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A mask bitmap or a generated fill for this photo', type: AssetDevelopArtifactUploadDto })
@UseInterceptors(
    FileInterceptor('file', { storage: importStorage, limits: { files: 1, fileSize: DEVELOP_ARTIFACT_MAX_BYTES } }),
  )
@Endpoint({
    summary: 'Upload a develop artifact',
    description:
      'FL-233: keeps a subject, sky or background mask bitmap (greyscale, covering the whole original) or a Clean Up fill (RGBA, covering its area) that a client computed for this photo. Recipes reference it by the returned id, the SHA-256 of the stored PNG, so every client and the server render the same result. Uploading the same bitmap again returns the same id. A recipe that references an artifact this photo does not have is refused with `develop_artifact_missing`.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "FL-233: keeps a subject, sky or background mask bitmap (greyscale, covering the whole original) or a Clean Up fill (RGBA, covering its area) that a client computed for this photo. Recipes reference it by the returned id, the SHA-256 of the stored PNG, so every client and the server render the same result. Uploading the same bitmap again returns the same id. A recipe that references an artifact this photo does not have is refused with `develop_artifact_missing`.",
  "operationId": "uploadAssetDevelopArtifact",
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
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/AssetDevelopArtifactUploadDto"
        }
      }
    },
    "description": "A mask bitmap or a generated fill for this photo",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetDevelopArtifactResponseDto"
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
  "summary": "Upload a develop artifact",
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

## getAssetDevelopExports

`GET /api/assets/{id}/develop/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/photo-tools.controller.ts#L133).

List exports of an original for editing elsewhere

Permission: `asset.edit.get`. Admin only: `false`.

Models: [DevelopExportResponseDto](models-10.md#developexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Get(`${RouteKey.Asset}/:id/develop/exports`)
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'List exports of an original for editing elsewhere',
    description: 'Every recorded export of the original, newest first, and whether the original still matches it.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Every recorded export of the original, newest first, and whether the original still matches it.",
  "operationId": "getAssetDevelopExports",
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
              "$ref": "#/components/schemas/DevelopExportResponseDto"
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
  "summary": "List exports of an original for editing elsewhere",
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

## createAssetDevelopExport

`POST /api/assets/{id}/develop/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/photo-tools.controller.ts#L144).

Export an original for editing elsewhere

Permission: `asset.edit.create`. Admin only: `false`.

Models: [DevelopExportResponseDto](models-10.md#developexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Post(`${RouteKey.Asset}/:id/develop/exports`)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Export an original for editing elsewhere',
    description:
      'Records the SHA-256 of the original now, so a file developed from it in another application can be brought back and checked. Download the original through the ordinary download route.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Records the SHA-256 of the original now, so a file developed from it in another application can be brought back and checked. Download the original through the ordinary download route.",
  "operationId": "createAssetDevelopExport",
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
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/DevelopExportResponseDto"
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
  "summary": "Export an original for editing elsewhere",
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

## importAssetDevelopRendition

`POST /api/assets/{id}/develop/imports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/photo-tools.controller.ts#L156).

Bring back a file developed elsewhere

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopImportDto](models-04.md#assetdevelopimportdto), [AssetDevelopRevisionResponseDto](models-05.md#assetdeveloprevisionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Post(`${RouteKey.Asset}/:id/develop/imports`)
@Authenticated({ permission: Permission.AssetEditCreate })
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'The developed file and the original it was made from', type: AssetDevelopImportDto })
@UseInterceptors(
    FileInterceptor('file', { storage: importStorage, limits: { files: 1, fileSize: DEVELOP_IMPORT_MAX_BYTES } }),
  )
@Endpoint({
    summary: 'Bring back a file developed elsewhere',
    description:
      'Checks that the file arrived intact and was developed from the original the photo has now, then keeps it as a new version and renders its preview. Nothing is kept when a check fails; the original is never changed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Checks that the file arrived intact and was developed from the original the photo has now, then keeps it as a new version and renders its preview. Nothing is kept when a check fails; the original is never changed.",
  "operationId": "importAssetDevelopRendition",
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
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/AssetDevelopImportDto"
        }
      }
    },
    "description": "The developed file and the original it was made from",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetDevelopRevisionResponseDto"
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
  "summary": "Bring back a file developed elsewhere",
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

## proposeAssetDevelopMask

`POST /api/assets/{id}/develop/masks/propose`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L113).

Suggest a subject or sky mask locally

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopArtifactResponseDto](models-04.md#assetdevelopartifactresponsedto), [AssetDevelopSemanticMaskDto](models-05.md#assetdevelopsemanticmaskdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/develop/masks/propose')
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({ summary: 'Suggest a subject or sky mask locally', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "proposeAssetDevelopMask",
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
          "$ref": "#/components/schemas/AssetDevelopSemanticMaskDto"
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
            "$ref": "#/components/schemas/AssetDevelopArtifactResponseDto"
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
  "summary": "Suggest a subject or sky mask locally",
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

## previewAssetDevelop

`POST /api/assets/{id}/develop/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L79).

Render a develop preview

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetDevelopPreviewDto](models-04.md#assetdeveloppreviewdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/develop/preview')
@HttpCode(HttpStatus.OK)
@FileResponse()
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'Render a develop preview',
    description: 'Renders the recipe from the original at preview size and returns the image; nothing is stored.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Renders the recipe from the original at preview size and returns the image; nothing is stored.",
  "operationId": "previewAssetDevelop",
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
          "$ref": "#/components/schemas/AssetDevelopPreviewDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Render a develop preview",
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

## revertAssetDevelop

`POST /api/assets/{id}/develop/revert`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L133).

Revert to the original or an earlier develop version

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopResponseDto](models-05.md#assetdevelopresponsedto), [AssetDevelopRevertDto](models-05.md#assetdeveloprevertdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/develop/revert')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Revert to the original or an earlier develop version',
    description:
      'Makes the named rendered version current, or the original when no version is named. History and files are kept.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Makes the named rendered version current, or the original when no version is named. History and files are kept.",
  "operationId": "revertAssetDevelop",
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
          "$ref": "#/components/schemas/AssetDevelopRevertDto"
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
            "$ref": "#/components/schemas/AssetDevelopResponseDto"
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
  "summary": "Revert to the original or an earlier develop version",
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

## viewAssetDevelopFile

`GET /api/assets/{id}/develop/revisions/{revisionId}/file`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L181).

View a rendered develop file

Permission: `asset.edit.get`. Admin only: `false`.

Models: [AssetDevelopFileKind](models-04.md#assetdevelopfilekind).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/develop/revisions/:revisionId/file')
@FileResponse()
@Authenticated({ permission: Permission.AssetEditGet })
@OriginalTransfer()
@Endpoint({
    summary: 'View a rendered develop file',
    description: 'Streams the edited master or the preview rendered for the version.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Streams the edited master or the preview rendered for the version.",
  "operationId": "viewAssetDevelopFile",
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
        "default": "preview",
        "$ref": "#/components/schemas/AssetDevelopFileKind"
      }
    },
    {
      "name": "revisionId",
      "required": true,
      "in": "path",
      "description": "Develop revision ID",
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
  "summary": "View a rendered develop file",
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

## cancelAssetDevelopRender

`DELETE /api/assets/{id}/develop/revisions/{revisionId}/render`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L165).

Cancel a develop render

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopRevisionResponseDto](models-05.md#assetdeveloprevisionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/develop/revisions/:revisionId/render')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Cancel a develop render',
    description:
      'Stops a queued or running render of the version. Files already rendered for other versions are untouched.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Stops a queued or running render of the version. Files already rendered for other versions are untouched.",
  "operationId": "cancelAssetDevelopRender",
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
      "name": "revisionId",
      "required": true,
      "in": "path",
      "description": "Develop revision ID",
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
            "$ref": "#/components/schemas/AssetDevelopRevisionResponseDto"
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
  "summary": "Cancel a develop render",
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

## renderAssetDevelopRevision

`POST /api/assets/{id}/develop/revisions/{revisionId}/render`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-develop.controller.ts#L150).

Render a develop version

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetDevelopRevisionResponseDto](models-05.md#assetdeveloprevisionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/develop/revisions/:revisionId/render')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Render a develop version',
    description: 'Queues (or re-queues after a failure or cancellation) the edited master render of a saved version.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues (or re-queues after a failure or cancellation) the edited master render of a saved version.",
  "operationId": "renderAssetDevelopRevision",
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
      "name": "revisionId",
      "required": true,
      "in": "path",
      "description": "Develop revision ID",
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
            "$ref": "#/components/schemas/AssetDevelopRevisionResponseDto"
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
  "summary": "Render a develop version",
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

## getVideoEditVersions

`GET /api/assets/{id}/edit-versions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset.controller.ts#L341).

List saved video versions

Permission: `asset.edit.get`. Admin only: `false`.

Models: [VideoEditVersionResponseDto](models-37.md#videoeditversionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/edit-versions')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({ summary: 'List saved video versions', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "getVideoEditVersions",
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
              "$ref": "#/components/schemas/VideoEditVersionResponseDto"
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
  "summary": "List saved video versions",
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

## exportVideoEditVersion

`POST /api/assets/{id}/edit-versions/export`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset.controller.ts#L348).

Export the current video version

Permission: `asset.edit.create`. Admin only: `false`.

Models: [VideoEditExportDto](models-37.md#videoeditexportdto), [VideoEditVersionResponseDto](models-37.md#videoeditversionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/edit-versions/export')
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Export the current video version',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "exportVideoEditVersion",
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
          "$ref": "#/components/schemas/VideoEditExportDto"
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
            "$ref": "#/components/schemas/VideoEditVersionResponseDto"
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
  "summary": "Export the current video version",
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

## pruneVideoEditVersion

`DELETE /api/assets/{id}/edit-versions/{versionId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset.controller.ts#L370).

Prune an unselected video version

Permission: `asset.edit.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/edit-versions/:versionId')
@Authenticated({ permission: Permission.AssetEditDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Prune an unselected video version',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "pruneVideoEditVersion",
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
  "summary": "Prune an unselected video version",
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
  "x-immich-permission": "asset.edit.delete",
  "x-immich-state": "Beta"
}
```
