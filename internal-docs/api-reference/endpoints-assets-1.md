# Server API — Assets 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getArchiveOperations

`GET /api/archive-operations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L59).

List recent archive operations

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Get()
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({ summary: 'List recent archive operations', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getArchiveOperations",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "List recent archive operations",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## createArchiveOperation

`POST /api/archive-operations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L27).

Archive a selection in the background

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationCreateDto](models-03.md#archiveoperationcreatedto), [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Post()
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Archive a selection in the background',
    description:
      'Freezes the selection and hands it to a durable bulk job. Undo later restores only items nothing has changed since.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Freezes the selection and hands it to a durable bulk job. Undo later restores only items nothing has changed since.",
  "operationId": "createArchiveOperation",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ArchiveOperationCreateDto"
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
            "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "Archive a selection in the background",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## prepareArchiveOperation

`POST /api/archive-operations/prepare`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L43).

Count and freeze every matching Timeline asset

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationPrepareDto](models-03.md#archiveoperationpreparedto), [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Post('prepare')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Count and freeze every matching Timeline asset',
    description:
      'Counts and freezes, in one transaction, every asset of your own normal Timeline this session can see. Nothing changes until the count is confirmed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Counts and freezes, in one transaction, every asset of your own normal Timeline this session can see. Nothing changes until the count is confirmed.",
  "operationId": "prepareArchiveOperation",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ArchiveOperationPrepareDto"
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
            "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "Count and freeze every matching Timeline asset",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## getArchiveOperation

`GET /api/archive-operations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L66).

Retrieve an archive operation

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Get(':id')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({ summary: 'Retrieve an archive operation', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getArchiveOperation",
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
            "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "Retrieve an archive operation",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## confirmArchiveOperation

`POST /api/archive-operations/{id}/confirm`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L73).

Confirm a prepared archive selection

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationConfirmDto](models-03.md#archiveoperationconfirmdto), [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Post(':id/confirm')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({ summary: 'Confirm a prepared archive selection', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "confirmArchiveOperation",
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
          "$ref": "#/components/schemas/ArchiveOperationConfirmDto"
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
            "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "Confirm a prepared archive selection",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## undoArchiveOperation

`POST /api/archive-operations/{id}/undo`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/archive-operation.controller.ts#L85).

Undo an archive operation

Permission: `asset.update`. Admin only: `false`.

Models: [ArchiveOperationResponseDto](models-03.md#archiveoperationresponsedto), [ArchiveOperationUndoDto](models-03.md#archiveoperationundodto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('archive-operations')
@Post(':id/undo')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Undo an archive operation',
    description:
      'Restores, in the background, every item the archive changed that nothing has changed since. A running archive is stopped first.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Restores, in the background, every item the archive changed that nothing has changed since. A running archive is stopped first.",
  "operationId": "undoArchiveOperation",
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
          "$ref": "#/components/schemas/ArchiveOperationUndoDto"
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
            "$ref": "#/components/schemas/ArchiveOperationResponseDto"
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
  "summary": "Undo an archive operation",
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## deleteAssets

`DELETE /api/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L94).

Delete assets

Permission: `asset.delete`. Admin only: `false`.

Models: [AssetBulkDeleteDto](models-04.md#assetbulkdeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete()
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete assets',
    description: 'Deletes multiple assets at the same time.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes multiple assets at the same time.",
  "operationId": "deleteAssets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetBulkDeleteDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Delete assets",
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Stable"
}
```

## uploadAsset

`POST /api/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-media.controller.ts#L81).

Upload asset

Permission: `asset.upload`. Admin only: `false`.

Models: [AssetMediaCreateDto](models-05.md#assetmediacreatedto), [AssetMediaResponseDto](models-05.md#assetmediaresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post()
@Authenticated({ permission: Permission.AssetUpload, sharedLink: true })
@UseInterceptors(AssetUploadInterceptor, FileUploadInterceptor)
@ApiConsumes('multipart/form-data')
@ApiHeader({
    name: ImmichHeader.Checksum,
    description:
      'SHA-256 checksum (preferred) or SHA-1 checksum (legacy) for duplicate detection before upload; hex or base64-encoded',
    required: false,
  })
@ApiBody({ description: 'Asset Upload Information', type: AssetMediaCreateDto })
@ApiResponse({
    status: 200,
    description: 'Asset is a duplicate',
    type: AssetMediaResponseDto,
  })
@ApiResponse({
    status: 201,
    description: 'Asset uploaded successfully',
    type: AssetMediaResponseDto,
  })
@Endpoint({
    summary: 'Upload asset',
    description: 'Uploads a new asset to the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Uploads a new asset to the server.",
  "operationId": "uploadAsset",
  "parameters": [
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
    },
    {
      "name": "x-immich-checksum",
      "in": "header",
      "description": "SHA-256 checksum (preferred) or SHA-1 checksum (legacy) for duplicate detection before upload; hex or base64-encoded",
      "required": false,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/AssetMediaCreateDto"
        }
      }
    },
    "description": "Asset Upload Information",
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetMediaResponseDto"
          }
        }
      },
      "description": "Asset is a duplicate"
    },
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetMediaResponseDto"
          }
        }
      },
      "description": "Asset uploaded successfully"
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
  "summary": "Upload asset",
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Stable"
}
```

## updateAssets

`PUT /api/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L70).

Update assets

Permission: `asset.update`. Admin only: `false`.

Models: [AssetBulkUpdateDto](models-04.md#assetbulkupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put()
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Update assets',
    description: 'Updates multiple assets at the same time.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateAssets' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Updates multiple assets at the same time.",
  "operationId": "updateAssets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetBulkUpdateDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Update assets",
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
      "replacementId": "updateAssets"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Deprecated"
}
```

## checkBulkUpload

`POST /api/assets/bulk-upload-check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-media.controller.ts#L276).

Check bulk upload

Permission: `asset.upload`. Admin only: `false`.

Models: [AssetBulkUploadCheckDto](models-04.md#assetbulkuploadcheckdto), [AssetBulkUploadCheckResponseDto](models-04.md#assetbulkuploadcheckresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post('bulk-upload-check')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Check bulk upload',
    description: 'Determine which assets have already been uploaded to the server based on their SHA1 checksums.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
@HttpCode(HttpStatus.OK)
```

Complete operation contract:

```json
{
  "description": "Determine which assets have already been uploaded to the server based on their SHA1 checksums.",
  "operationId": "checkBulkUpload",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetBulkUploadCheckDto"
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
            "$ref": "#/components/schemas/AssetBulkUploadCheckResponseDto"
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
  "summary": "Check bulk upload",
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Stable"
}
```

## copyAsset

`PUT /api/assets/copy`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L172).

Copy asset

Permission: `asset.copy`. Admin only: `false`.

Models: [AssetCopyDto](models-04.md#assetcopydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put('copy')
@Authenticated({ permission: Permission.AssetCopy })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Copy asset',
    description: 'Copy asset information like albums, tags, etc. from one asset to another.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Copy asset information like albums, tags, etc. from one asset to another.",
  "operationId": "copyAsset",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetCopyDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Copy asset",
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
  "x-immich-permission": "asset.copy",
  "x-immich-state": "Stable"
}
```

## runAssetJobs

`POST /api/assets/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L58).

Run an asset job

Permission: `job.create`. Admin only: `false`.

Models: [AssetJobsDto](models-05.md#assetjobsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post('jobs')
@Authenticated({ permission: Permission.JobCreate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Run an asset job',
    description: 'Run a specific job on a set of assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Run a specific job on a set of assets.",
  "operationId": "runAssetJobs",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetJobsDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Run an asset job",
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
  "x-immich-permission": "job.create",
  "x-immich-state": "Stable"
}
```

## lockAssets

`POST /api/assets/lock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L106).

Lock assets

Permission: `asset.update`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post('lock')
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Lock assets',
    description:
      'Locks assets: they keep their albums and organization, are hidden from every view except the Locked view of their owner in a PIN-unlocked session, and stacks and live photos lock as a whole.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Locks assets: they keep their albums and organization, are hidden from every view except the Locked view of their owner in a PIN-unlocked session, and stacks and live photos lock as a whole.",
  "operationId": "lockAssets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BulkIdsDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Lock assets",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.update"
}
```

## deleteBulkAssetMetadata

`DELETE /api/assets/metadata`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L198).

Delete asset metadata

Permission: `asset.update`. Admin only: `false`.

Models: [AssetMetadataBulkDeleteDto](models-05.md#assetmetadatabulkdeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete('metadata')
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete asset metadata',
    description: 'Delete metadata key-value pairs for multiple assets.',
    history: new HistoryBuilder().added('v1').beta('v2.5.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete metadata key-value pairs for multiple assets.",
  "operationId": "deleteBulkAssetMetadata",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetMetadataBulkDeleteDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Delete asset metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Beta"
}
```

## updateBulkAssetMetadata

`PUT /api/assets/metadata`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L184).

Upsert asset metadata

Permission: `asset.update`. Admin only: `false`.

Models: [AssetMetadataBulkResponseDto](models-05.md#assetmetadatabulkresponsedto), [AssetMetadataBulkUpsertDto](models-05.md#assetmetadatabulkupsertdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Put('metadata')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Upsert asset metadata',
    description: 'Upsert metadata key-value pairs for multiple assets.',
    history: new HistoryBuilder().added('v1').beta('v2.5.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Upsert metadata key-value pairs for multiple assets.",
  "operationId": "updateBulkAssetMetadata",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetMetadataBulkUpsertDto"
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
              "$ref": "#/components/schemas/AssetMetadataBulkResponseDto"
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
  "summary": "Upsert asset metadata",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Beta"
}
```

## getAssetSafety

`POST /api/assets/safety/lookup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/safety.controller.ts#L15).

Look up own asset safety by SHA-256

Permission: `asset.read`. Admin only: `false`.

Models: [SafetyLookupDto](models-29.md#safetylookupdto), [SafetyLookupResponseDto](models-29.md#safetylookupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/safety')
@Post('lookup')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Look up own asset safety by SHA-256',
    description:
      'Up to 2000 hashes. Current own accessible assets only, including for admins; shared and partner assets omitted. Completed membership and GET + SHA-256 verification are separate facts. No bucket credentials/settings.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to 2000 hashes. Current own accessible assets only, including for admins; shared and partner assets omitted. Completed membership and GET + SHA-256 verification are separate facts. No bucket credentials/settings.",
  "operationId": "getAssetSafety",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SafetyLookupDto"
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
            "$ref": "#/components/schemas/SafetyLookupResponseDto"
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
  "summary": "Look up own asset safety by SHA-256",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.read"
}
```

## getSafetySummary

`GET /api/assets/safety/summary`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/safety.controller.ts#L28).

Summarize own library safety

Permission: `asset.read`. Admin only: `false`.

Models: [SafetySummaryDto](models-29.md#safetysummarydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/safety')
@Get('summary')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Summarize own library safety',
    description:
      'Same current owner/access scope as lookup. Percentages use only this accessible server library, not unknown device-only items. Backup counts are null when unavailable; HEAD size is not SHA-256 verification.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Same current owner/access scope as lookup. Percentages use only this accessible server library, not unknown device-only items. Backup counts are null when unavailable; HEAD size is not SHA-256 verification.",
  "operationId": "getSafetySummary",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SafetySummaryDto"
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
  "summary": "Summarize own library safety",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.read"
}
```

## getAssetStatistics

`GET /api/assets/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L47).

Get asset statistics

Permission: `asset.statistics`. Admin only: `false`.

Models: [AssetStatsResponseDto](models-06.md#assetstatsresponsedto), [AssetVisibility](models-06.md#assetvisibility).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get('statistics')
@Authenticated({ permission: Permission.AssetStatistics })
@Endpoint({
    summary: 'Get asset statistics',
    description: 'Retrieve various statistics about the assets owned by the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve various statistics about the assets owned by the authenticated user.",
  "operationId": "getAssetStatistics",
  "parameters": [
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetStatsResponseDto"
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
  "summary": "Get asset statistics",
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
  "x-immich-permission": "asset.statistics",
  "x-immich-state": "Stable"
}
```

## unlockAssets

`POST /api/assets/unlock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset.controller.ts#L119).

Unlock assets

Permission: `asset.update`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post('unlock')
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Unlock assets',
    description:
      'Unlocks assets the caller owns, whatever locked them, returning each exactly where it was. Requires a PIN-unlocked session.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Unlocks assets the caller owns, whatever locked them, returning each exactly where it was. Requires a PIN-unlocked session.",
  "operationId": "unlockAssets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BulkIdsDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Unlock assets",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.update"
}
```

## getAssetUploadResourceLimits

`OPTIONS /api/assets/uploads`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-upload-resource.controller.ts#L80).

Get resumable asset upload limits

Permission: `asset.upload`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Options()
@ApiResponse({ status: 204, description: 'Resumable upload limits' })
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Get resumable asset upload limits',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getAssetUploadResourceLimits",
  "parameters": [],
  "responses": {
    "204": {
      "description": "Resumable upload limits"
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
  "summary": "Get resumable asset upload limits",
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

## createAssetUploadResource

`POST /api/assets/uploads`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-upload-resource.controller.ts#L92).

Create resumable asset upload

Permission: `asset.upload`. Admin only: `false`.

Models: [AssetUploadResultDto](models-06.md#assetuploadresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Post()
@Authenticated({ permission: Permission.AssetUpload })
@ApiConsumes('image/*', 'video/*', 'audio/*')
@ApiHeader({ name: 'Upload-Draft-Interop-Version', required: true, schema: { type: 'string', enum: ['9'] } })
@ApiHeader({ name: 'Upload-Complete', required: true, schema: { type: 'string', enum: ['?0', '?1'] } })
@ApiHeader({
    name: 'Upload-Length',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: ASSET_UPLOAD_LIMITS.maxSize },
  })
@ApiHeader({
    name: 'Repr-Digest',
    required: true,
    description: 'RFC 9530 single sha-256=:base64: digest of the entire file, required before any publication',
  })
@ApiHeader({
    name: 'Asset-Metadata',
    required: true,
    description:
      'Canonical base64url UTF-8 JSON: filename, fileCreatedAt, fileModifiedAt; optional duration (integer milliseconds), isFavorite (JSON boolean; the strings "true" and "false" are also accepted), visibility, metadata array and publication: live-photo to defer publication until atomic pair commit. No sidecar or pre-existing asset references.',
  })
@ApiBody({ schema: { type: 'string', format: 'binary' } })
@ApiResponse({
    status: 104,
    description: 'Committed private upload resource exists; Location identifies resumable state',
  })
@ApiResponse({ status: 201, description: 'Private upload resource created, incomplete bytes are never an asset' })
@ApiResponse({ status: 202, description: 'Complete bytes verified; ingestion remains pending' })
@ApiResponse({ status: 200, type: AssetUploadResultDto })
@Endpoint({
    summary: 'Create resumable asset upload',
    description:
      'IETF resumable upload draft 12 / interop 9 prerequisite. Single resources publish by default; explicitly declared Live Photo resources stay private until pair commit.',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "IETF resumable upload draft 12 / interop 9 prerequisite. Single resources publish by default; explicitly declared Live Photo resources stay private until pair commit.",
  "operationId": "createAssetUploadResource",
  "parameters": [
    {
      "name": "Asset-Metadata",
      "in": "header",
      "description": "Canonical base64url UTF-8 JSON: filename, fileCreatedAt, fileModifiedAt; optional duration (integer milliseconds), isFavorite (JSON boolean; the strings \"true\" and \"false\" are also accepted), visibility, metadata array and publication: live-photo to defer publication until atomic pair commit. No sidecar or pre-existing asset references.",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "Repr-Digest",
      "in": "header",
      "description": "RFC 9530 single sha-256=:base64: digest of the entire file, required before any publication",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
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
      "name": "Upload-Length",
      "in": "header",
      "required": false,
      "schema": {
        "type": "integer",
        "minimum": 1,
        "maximum": 2147483648
      }
    }
  ],
  "requestBody": {
    "content": {
      "audio/*": {
        "schema": {
          "format": "binary",
          "type": "string"
        }
      },
      "image/*": {
        "schema": {
          "format": "binary",
          "type": "string"
        }
      },
      "video/*": {
        "schema": {
          "format": "binary",
          "type": "string"
        }
      }
    },
    "required": true
  },
  "responses": {
    "104": {
      "description": "Committed private upload resource exists; Location identifies resumable state"
    },
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
    "201": {
      "description": "Private upload resource created, incomplete bytes are never an asset"
    },
    "202": {
      "description": "Complete bytes verified; ingestion remains pending"
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
  "summary": "Create resumable asset upload",
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

## commitLivePhotoUpload

`POST /api/assets/uploads/live-photo/commit`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-upload-resource.controller.ts#L161).

Commit two verified Live Photo upload resources atomically

Permission: `asset.upload`. Admin only: `false`.

Models: [LivePhotoUploadCommitDto](models-14.md#livephotouploadcommitdto), [LivePhotoUploadResultDto](models-14.md#livephotouploadresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Post('live-photo/commit')
@Authenticated({ permission: Permission.AssetUpload })
@ApiResponse({ status: 200, type: LivePhotoUploadResultDto })
@ApiResponse({ status: 202, description: 'Both assets committed atomically; required ingestion remains pending' })
@ApiResponse({ status: 409, description: 'Incompatible pair, existing unrelated duplicate, or concurrent request' })
@Endpoint({
    summary: 'Commit two verified Live Photo upload resources atomically',
    history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "commitLivePhotoUpload",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LivePhotoUploadCommitDto"
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
            "$ref": "#/components/schemas/LivePhotoUploadResultDto"
          }
        }
      },
      "description": ""
    },
    "202": {
      "description": "Both assets committed atomically; required ingestion remains pending"
    },
    "409": {
      "description": "Incompatible pair, existing unrelated duplicate, or concurrent request"
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
  "summary": "Commit two verified Live Photo upload resources atomically",
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

## cancelAssetUploadResource

`DELETE /api/assets/uploads/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/asset-upload-resource.controller.ts#L262).

Cancel an unpublished upload

Permission: `asset.upload`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets/uploads')
@Delete(':id')
@ApiResponse({ status: 204, description: 'Upload cancelled' })
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Cancel an unpublished upload', history: new HistoryBuilder().added('v3.2.0').beta('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "cancelAssetUploadResource",
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
      "description": "Upload cancelled"
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
  "summary": "Cancel an unpublished upload",
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
