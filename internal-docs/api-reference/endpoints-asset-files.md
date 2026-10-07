# Server API — Asset files

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchAssetFiles

`GET /api/asset-files`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-file.controller.ts#L22).

Search asset files

Permission: `assetFile.read`. Admin only: `false`.

Models: [AssetFileResponseDto](models-05.md#assetfileresponsedto), [AssetFileType](models-05.md#assetfiletype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AssetFiles)
@Controller('asset-files')
@Get()
@Authenticated({ permission: Permission.AssetFileRead })
@Endpoint({
    summary: 'Search asset files',
    description: 'Returns all matching asset files.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns all matching asset files.",
  "operationId": "searchAssetFiles",
  "parameters": [
    {
      "name": "assetId",
      "required": true,
      "in": "query",
      "description": "Asset ID to filter files by",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "isEdited",
      "required": false,
      "in": "query",
      "description": "The file was generated from an edit",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isProgressive",
      "required": false,
      "in": "query",
      "description": "The file is a progressively encoded JPEG",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTransparent",
      "required": false,
      "in": "query",
      "description": "The file is transparent",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "description": "Filter by type of file",
      "schema": {
        "$ref": "#/components/schemas/AssetFileType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetFileResponseDto"
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
  "summary": "Search asset files",
  "tags": [
    "Asset files"
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
  "x-immich-permission": "assetFile.read",
  "x-immich-state": "Alpha"
}
```

## deleteAssetFile

`DELETE /api/asset-files/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-file.controller.ts#L44).

Delete an asset file

Permission: `assetFile.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.AssetFiles)
@Controller('asset-files')
@Delete(':id')
@Authenticated({ permission: Permission.AssetFileDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete an asset file',
    description: 'Delete a file and remove it from the database.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a file and remove it from the database.",
  "operationId": "deleteAssetFile",
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
  "summary": "Delete an asset file",
  "tags": [
    "Asset files"
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
  "x-immich-permission": "assetFile.delete",
  "x-immich-state": "Alpha"
}
```

## getAssetFile

`GET /api/asset-files/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-file.controller.ts#L33).

Retrieve an asset file

Permission: `assetFile.read`. Admin only: `false`.

Models: [AssetFileResponseDto](models-05.md#assetfileresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AssetFiles)
@Controller('asset-files')
@Get(':id')
@Authenticated({ permission: Permission.AssetFileRead })
@Endpoint({
    summary: 'Retrieve an asset file',
    description: 'Returns metadata about a specific asset file.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns metadata about a specific asset file.",
  "operationId": "getAssetFile",
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
            "$ref": "#/components/schemas/AssetFileResponseDto"
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
  "summary": "Retrieve an asset file",
  "tags": [
    "Asset files"
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
  "x-immich-permission": "assetFile.read",
  "x-immich-state": "Alpha"
}
```

## downloadAssetFile

`GET /api/asset-files/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/asset-file.controller.ts#L56).

Download an asset file

Permission: `assetFile.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.AssetFiles)
@Controller('asset-files')
@Get(':id/download')
@FileResponse()
@Authenticated({ permission: Permission.AssetFileDownload })
@Endpoint({
    summary: 'Download an asset file',
    description: 'Serve the contents of a specific asset file.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Serve the contents of a specific asset file.",
  "operationId": "downloadAssetFile",
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
  "summary": "Download an asset file",
  "tags": [
    "Asset files"
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
  "x-immich-permission": "assetFile.download",
  "x-immich-state": "Alpha"
}
```
