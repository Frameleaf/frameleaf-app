# Server API — Assets 3

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## renderAssetDevelopRevision

`POST /api/assets/{id}/develop/revisions/{revisionId}/render`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-develop.controller.ts#L194).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L341).

List saved video versions

Permission: `asset.edit.get`. Admin only: `false`.

Models: [VideoEditVersionResponseDto](models-40.md#videoeditversionresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L348).

Export the current video version

Permission: `asset.edit.create`. Admin only: `false`.

Models: [VideoEditExportDto](models-40.md#videoeditexportdto), [VideoEditVersionResponseDto](models-40.md#videoeditversionresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L370).

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

## downloadVideoEditVersion

`GET /api/assets/{id}/edit-versions/{versionId}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-media.controller.ts#L127).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L362).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L381).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L303).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L326).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L314).

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

## getAssetFilmstrip

`GET /api/assets/{id}/filmstrip`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-media.controller.ts#L32).

Get video filmstrip

Permission: `asset.view`. Admin only: `false`.

Models: [AssetFilmstripFormat](models-05.md#assetfilmstripformat), [AssetFilmstripResponseDto](models-05.md#assetfilmstripresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets')
@Get(':id/filmstrip')
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Endpoint({
    summary: 'Get video filmstrip',
    description:
      'The index of a filmstrip sprite sheet for a Studio timeline: `count` frames sampled at the centre of equal slices of the video, each `height` pixels high, laid out left to right and top to bottom. Returns each frame timestamp and its position in the sprite; fetch the image from `/assets/{id}/filmstrip/sprite` with the same parameters and `version`. Made on first request from the playback rendition, cached, and remade when the video changes. 404 for anything that is not a video.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "The index of a filmstrip sprite sheet for a Studio timeline: `count` frames sampled at the centre of equal slices of the video, each `height` pixels high, laid out left to right and top to bottom. Returns each frame timestamp and its position in the sprite; fetch the image from `/assets/{id}/filmstrip/sprite` with the same parameters and `version`. Made on first request from the playback rendition, cached, and remade when the video changes. 404 for anything that is not a video.",
  "operationId": "getAssetFilmstrip",
  "parameters": [
    {
      "name": "count",
      "required": false,
      "in": "query",
      "description": "Frames to sample, rounded up to 1, 2, 4, 20, 60 or 120 (default 20)",
      "schema": {
        "minimum": 1,
        "maximum": 120,
        "default": 20,
        "type": "integer"
      }
    },
    {
      "name": "format",
      "required": false,
      "in": "query",
      "schema": {
        "default": "jpeg",
        "$ref": "#/components/schemas/AssetFilmstripFormat"
      }
    },
    {
      "name": "height",
      "required": false,
      "in": "query",
      "description": "Frame height in pixels, rounded up to 32, 90, 180 or 240 (default 90); the width follows the aspect ratio",
      "schema": {
        "minimum": 32,
        "maximum": 240,
        "default": 90,
        "type": "integer"
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
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetFilmstripResponseDto"
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
  "summary": "Get video filmstrip",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## viewAssetFilmstripSprite

`GET /api/assets/{id}/filmstrip/sprite`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-media.controller.ts#L48).

View video filmstrip sprite

Permission: `asset.view`. Admin only: `false`.

Models: [AssetFilmstripFormat](models-05.md#assetfilmstripformat).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('assets')
@Get(':id/filmstrip/sprite')
@FileResponse()
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Endpoint({
    summary: 'View video filmstrip sprite',
    description:
      'The filmstrip sprite sheet (JPEG or WebP) the filmstrip index describes, for the same `count`, `height` and `format`. With `version`, 404 when the video changed since that index was read.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "The filmstrip sprite sheet (JPEG or WebP) the filmstrip index describes, for the same `count`, `height` and `format`. With `version`, 404 when the video changed since that index was read.",
  "operationId": "viewAssetFilmstripSprite",
  "parameters": [
    {
      "name": "count",
      "required": false,
      "in": "query",
      "description": "Frames to sample, rounded up to 1, 2, 4, 20, 60 or 120 (default 20)",
      "schema": {
        "minimum": 1,
        "maximum": 120,
        "default": 20,
        "type": "integer"
      }
    },
    {
      "name": "format",
      "required": false,
      "in": "query",
      "schema": {
        "default": "jpeg",
        "$ref": "#/components/schemas/AssetFilmstripFormat"
      }
    },
    {
      "name": "height",
      "required": false,
      "in": "query",
      "description": "Frame height in pixels, rounded up to 32, 90, 180 or 240 (default 90); the width follows the aspect ratio",
      "schema": {
        "minimum": 32,
        "maximum": 240,
        "default": 90,
        "type": "integer"
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
    },
    {
      "name": "version",
      "required": false,
      "in": "query",
      "description": "The `version` from the filmstrip index. When given and the video changed since, 404 is returned",
      "schema": {
        "pattern": "^[0-9a-f]{16}$",
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
  "summary": "View video filmstrip sprite",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## getAssetImageEnrichment

`GET /api/assets/{id}/image-enrichment`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L143).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L157).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L240).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L262).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L291).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L277).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L251).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-media.controller.ts#L145).

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
    description: 'Downloads the original file, selected edit, or an explicitly requested still-image export.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Downloads the original file, selected edit, or an explicitly requested still-image export.",
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
      "name": "format",
      "required": false,
      "in": "query",
      "description": "Explicit still export from an unedited photo; omission returns the untouched original or selected edit",
      "schema": {
        "type": "string",
        "enum": [
          "sdr-jpeg",
          "hdr-jpeg",
          "hdr-heic"
        ]
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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-restoration.controller.ts#L53).

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
