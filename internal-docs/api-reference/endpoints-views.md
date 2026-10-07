# Server API — Views

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getBestPhotos

`GET /api/best-photos`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/best-photos.controller.ts#L15).

Retrieve best photos

Permission: `asset.read`. Admin only: `false`.

Models: [BestPhotosResponseDto](models-06.md#bestphotosresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Views)
@Controller('best-photos')
@Get()
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve best photos',
    description: 'Retrieve visible photo assets ranked by the locally computed Best Photos score.',
    history: new HistoryBuilder().added('v2.7.0').beta('v2.7.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve visible photo assets ranked by the locally computed Best Photos score.",
  "operationId": "getBestPhotos",
  "parameters": [
    {
      "name": "includeArchived",
      "required": false,
      "in": "query",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "limit",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 500,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "minScore",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 1,
        "format": "double",
        "type": "number"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BestPhotosResponseDto"
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
  "summary": "Retrieve best photos",
  "tags": [
    "Views"
  ],
  "x-immich-history": [
    {
      "version": "v2.7.0",
      "state": "Added"
    },
    {
      "version": "v2.7.0",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Beta"
}
```

## getAssetsByOriginalPath

`GET /api/view/folder`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/view.controller.ts#L39).

Retrieve assets by original path

Permission: `folder.read`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Views)
@Controller('view')
@Get('folder')
@Authenticated({ permission: Permission.FolderRead })
@Endpoint({
    summary: 'Retrieve assets by original path',
    description: 'Retrieve assets that are children of a specific folder.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve assets that are children of a specific folder.",
  "operationId": "getAssetsByOriginalPath",
  "parameters": [
    {
      "name": "path",
      "required": true,
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
            "items": {
              "$ref": "#/components/schemas/AssetResponseDto"
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
  "summary": "Retrieve assets by original path",
  "tags": [
    "Views"
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
  "x-immich-permission": "folder.read",
  "x-immich-state": "Stable"
}
```

## getFolderSummary

`GET /api/view/folder/summary`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/view.controller.ts#L27).

Retrieve folder summaries

Permission: `folder.read`. Admin only: `false`.

Models: [FolderSummaryResponseDto](models-11.md#foldersummaryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Views)
@Controller('view')
@Get('folder/summary')
@Authenticated({ permission: Permission.FolderRead })
@Endpoint({
    summary: 'Retrieve folder summaries',
    description:
      'Retrieve, for each folder, how many originals it holds directly and their size in bytes, counting only the Timeline items the folder views list.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve, for each folder, how many originals it holds directly and their size in bytes, counting only the Timeline items the folder views list.",
  "operationId": "getFolderSummary",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/FolderSummaryResponseDto"
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
  "summary": "Retrieve folder summaries",
  "tags": [
    "Views"
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
  "x-immich-permission": "folder.read",
  "x-immich-state": "Alpha"
}
```

## getUniqueOriginalPaths

`GET /api/view/folder/unique-paths`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/view.controller.ts#L16).

Retrieve unique paths

Permission: `folder.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Views)
@Controller('view')
@Get('folder/unique-paths')
@Authenticated({ permission: Permission.FolderRead })
@Endpoint({
    summary: 'Retrieve unique paths',
    description: 'Retrieve a list of unique folder paths from asset original paths.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of unique folder paths from asset original paths.",
  "operationId": "getUniqueOriginalPaths",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "type": "string"
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
  "summary": "Retrieve unique paths",
  "tags": [
    "Views"
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
  "x-immich-permission": "folder.read",
  "x-immich-state": "Stable"
}
```
