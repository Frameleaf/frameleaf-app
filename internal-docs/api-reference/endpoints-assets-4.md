# Server API — Assets 4

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## discardAssetRestoration

`DELETE /api/assets/{id}/restorations/{restorationId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-restoration.controller.ts#L145).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-restoration.controller.ts#L114).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-restoration.controller.ts#L161).

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

## rejectAssetRestoration

`POST /api/assets/{id}/restorations/{restorationId}/reject`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-restoration.controller.ts#L130).

Reject a restoration preview

Permission: `asset.edit.create`. Admin only: `false`.

Models: [AssetRestorationResponseDto](models-06.md#assetrestorationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Post(':id/restorations/:restorationId/reject')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetEditCreate })
@Endpoint({
    summary: 'Reject a restoration preview',
    description: 'Records the rejection. The preview files are kept briefly for comparison and then removed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Records the rejection. The preview files are kept briefly for comparison and then removed.",
  "operationId": "rejectAssetRestoration",
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
  "summary": "Reject a restoration preview",
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

## viewAsset

`GET /api/assets/{id}/thumbnail`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-media.controller.ts#L172).

View asset thumbnail

Permission: `asset.view`. Admin only: `false`.

Models: [AssetMediaSize](models-05.md#assetmediasize).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/thumbnail')
@FileResponse()
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@RemoteMediaCeiling()
@Endpoint({
    summary: 'View asset thumbnail',
    description:
      'Retrieve the thumbnail image for the specified asset. Viewing the fullsize thumbnail might redirect to downloadAsset, which requires a different permission.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the thumbnail image for the specified asset. Viewing the fullsize thumbnail might redirect to downloadAsset, which requires a different permission.",
  "operationId": "viewAsset",
  "parameters": [
    {
      "name": "dynamicRange",
      "required": false,
      "in": "query",
      "description": "Defaults to compatible SDR. Auto prefers an available HDR derivative; explicit HDR fails when unavailable.",
      "schema": {
        "type": "string",
        "enum": [
          "auto",
          "sdr",
          "hdr"
        ]
      }
    },
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
      "name": "faceSource",
      "required": false,
      "in": "query",
      "description": "Return the ordinary edited preview used for face coordinates",
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
      "name": "size",
      "required": false,
      "in": "query",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Updated",
          "description": "Specifying 'original' is deprecated. Use the original endpoint directly instead"
        }
      ],
      "schema": {
        "$ref": "#/components/schemas/AssetMediaSize"
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
  "summary": "View asset thumbnail",
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
  "x-immich-permission": "asset.view",
  "x-immich-state": "Stable"
}
```

## playAssetVideo

`GET /api/assets/{id}/video/playback`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-media.controller.ts#L247).

Play asset video

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/video/playback')
@FileResponse()
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Endpoint({
    summary: 'Play asset video',
    description: 'Streams the video file for the specified asset. This endpoint also supports byte range requests.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Streams the video file for the specified asset. This endpoint also supports byte range requests.",
  "operationId": "playAssetVideo",
  "parameters": [
    {
      "name": "edited",
      "required": false,
      "in": "query",
      "description": "Play the edited version when one exists (default). false plays the unedited source for the asset's owner, as the quick editor needs; everyone else is always given the edited version",
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
  "summary": "Play asset video",
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
  "x-immich-permission": "asset.view",
  "x-immich-state": "Stable"
}
```

## getMainPlaylist

`GET /api/assets/{id}/video/stream/main.m3u8`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/video-stream.controller.ts#L30).

Get HLS main playlist

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/video/stream/main.m3u8')
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Header('Cache-Control', 'no-cache')
@Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
@ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
@Endpoint({
    summary: 'Get HLS main playlist',
    description: 'Returns an HLS main playlist with all available variants for the asset.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns an HLS main playlist with all available variants for the asset.",
  "operationId": "getMainPlaylist",
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
        "application/vnd.apple.mpegurl": {
          "schema": {
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
  "summary": "Get HLS main playlist",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## endSession

`DELETE /api/assets/{id}/video/stream/{sessionId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/video-stream.controller.ts#L95).

End HLS streaming session

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Delete(':id/video/stream/:sessionId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Endpoint({
    summary: 'End HLS streaming session',
    description: 'Releases server resources for the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Releases server resources for the streaming session.",
  "operationId": "endSession",
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
      "name": "sessionId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
  "summary": "End HLS streaming session",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## getMediaPlaylist

`GET /api/assets/{id}/video/stream/{sessionId}/{variantIndex}/playlist.m3u8`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/video-stream.controller.ts#L44).

Get HLS media playlist

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/video/stream/:sessionId/:variantIndex/playlist.m3u8')
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Header('Cache-Control', 'no-cache')
@Header('Content-Type', HLS_PLAYLIST_CONTENT_TYPE)
@ApiProduces(HLS_PLAYLIST_CONTENT_TYPE)
@Endpoint({
    summary: 'Get HLS media playlist',
    description: 'Returns an HLS media playlist for one variant of the streaming session.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns an HLS media playlist for one variant of the streaming session.",
  "operationId": "getMediaPlaylist",
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
      "name": "sessionId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
      "name": "variantIndex",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "x-immich-hls-pos",
      "required": false,
      "in": "header",
      "schema": {
        "minimum": 0,
        "type": "number"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/vnd.apple.mpegurl": {
          "schema": {
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
  "summary": "Get HLS media playlist",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## getSegment

`GET /api/assets/{id}/video/stream/{sessionId}/{variantIndex}/{filename}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/video-stream.controller.ts#L67).

Get HLS segment or init file

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/video/stream/:sessionId/:variantIndex/:filename')
@FileResponse()
@Authenticated({ permission: Permission.AssetView, sharedLink: true })
@Endpoint({
    summary: 'Get HLS segment or init file',
    description: 'Streams an HLS init segment (init.mp4) or media segment (seg_N.m4s).',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Streams an HLS init segment (init.mp4) or media segment (seg_N.m4s).",
  "operationId": "getSegment",
  "parameters": [
    {
      "name": "filename",
      "required": true,
      "in": "path",
      "schema": {
        "pattern": "^(init\\.mp4|seg_\\d+\\.m4s)$",
        "type": "string"
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
      "name": "sessionId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
      "name": "variantIndex",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "x-immich-hls-msn",
      "required": false,
      "in": "header",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
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
  "summary": "Get HLS segment or init file",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## playStudioHdrVideo

`GET /api/assets/{id}/video/studio-hdr`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset-media.controller.ts#L277).

Play the Studio HDR intermediate

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Get(':id/video/studio-hdr')
@FileResponse()
@Authenticated({ permission: Permission.AssetView })
@Endpoint({
    summary: 'Play the Studio HDR intermediate',
    description:
      'FL-97: streams the 10-bit AV1 intermediate that keeps an HDR video’s BT.2020 PQ or HLG signal, for the Studio editor. Not found until it has been made (placing the video in a Studio project queues it). Supports byte range requests.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "FL-97: streams the 10-bit AV1 intermediate that keeps an HDR video’s BT.2020 PQ or HLG signal, for the Studio editor. Not found until it has been made (placing the video in a Studio project queues it). Supports byte range requests.",
  "operationId": "playStudioHdrVideo",
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
  "summary": "Play the Studio HDR intermediate",
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
  "x-immich-permission": "asset.view",
  "x-immich-state": "Alpha"
}
```

## readCastMedia

`GET /api/cast/{token}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cast.controller.ts#L51).

Read Cast media

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Get('cast/:token')
@FileResponse()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Read Cast media',
    description:
      'Streams the rendition a signed Cast URL names, without a session token or cookies (byte ranges supported for video). Answers 401 for an invalid, tampered or expired URL and 403 when casting is no longer allowed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Streams the rendition a signed Cast URL names, without a session token or cookies (byte ranges supported for video). Answers 401 for an invalid, tampered or expired URL and 403 when casting is no longer allowed.",
  "operationId": "readCastMedia",
  "parameters": [
    {
      "name": "token",
      "required": true,
      "in": "path",
      "description": "The signed Cast token",
      "schema": {
        "minLength": 1,
        "maxLength": 1024,
        "pattern": "^[\\w-]+\\.[\\w-]+$",
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
  "summary": "Read Cast media",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ]
}
```

## getDevelopPresets

`GET /api/develop-presets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photo-tools.controller.ts#L83).

List develop presets

Permission: `See authentication declaration`. Admin only: `false`.

Models: [DevelopPresetResponseDto](models-10.md#developpresetresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Get('develop-presets')
@Authenticated()
@Endpoint({
    summary: 'List develop presets',
    description: 'Your saved develop presets, by name.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Your saved develop presets, by name.",
  "operationId": "getDevelopPresets",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/DevelopPresetResponseDto"
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
  "summary": "List develop presets",
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
  "x-immich-state": "Alpha"
}
```

## createDevelopPreset

`POST /api/develop-presets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photo-tools.controller.ts#L94).

Save a develop preset

Permission: `See authentication declaration`. Admin only: `false`.

Models: [DevelopPresetCreateDto](models-10.md#developpresetcreatedto), [DevelopPresetResponseDto](models-10.md#developpresetresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Post('develop-presets')
@Authenticated()
@Endpoint({
    summary: 'Save a develop preset',
    description: 'Saves develop settings (sliders, look, strength and masks, never geometry) under a new name.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Saves develop settings (sliders, look, strength and masks, never geometry) under a new name.",
  "operationId": "createDevelopPreset",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/DevelopPresetCreateDto"
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
            "$ref": "#/components/schemas/DevelopPresetResponseDto"
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
  "summary": "Save a develop preset",
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
  "x-immich-state": "Alpha"
}
```

## deleteDevelopPreset

`DELETE /api/develop-presets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photo-tools.controller.ts#L121).

Delete a develop preset

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Delete('develop-presets/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Delete a develop preset',
    description: 'Deletes the preset. Versions already saved with its settings are unchanged.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes the preset. Versions already saved with its settings are unchanged.",
  "operationId": "deleteDevelopPreset",
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
  "summary": "Delete a develop preset",
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
  "x-immich-state": "Alpha"
}
```

## updateDevelopPreset

`PUT /api/develop-presets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photo-tools.controller.ts#L105).

Update a develop preset

Permission: `See authentication declaration`. Admin only: `false`.

Models: [DevelopPresetResponseDto](models-10.md#developpresetresponsedto), [DevelopPresetUpdateDto](models-10.md#developpresetupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller()
@Put('develop-presets/:id')
@Authenticated()
@Endpoint({
    summary: 'Update a develop preset',
    description:
      'Renames a preset, changes its settings, or both. Settings the request leaves out keep their stored values.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Renames a preset, changes its settings, or both. Settings the request leaves out keep their stored values.",
  "operationId": "updateDevelopPreset",
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
          "$ref": "#/components/schemas/DevelopPresetUpdateDto"
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
            "$ref": "#/components/schemas/DevelopPresetResponseDto"
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
  "summary": "Update a develop preset",
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
  "x-immich-state": "Alpha"
}
```

## listTakeoutImports

`GET /api/takeout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L58).

List Google Photos imports

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResponseDto](models-37.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Get()
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'List Google Photos imports', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "listTakeoutImports",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/TakeoutResponseDto"
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
  "summary": "List Google Photos imports",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## createTakeoutImport

`POST /api/takeout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L65).

Start a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutCreateDto](models-36.md#takeoutcreatedto), [TakeoutResponseDto](models-37.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post()
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Start a Google Photos import',
    description:
      'Creates an import to stage Takeout archives into. Administrators may instead name a folder inside one of the permitted import locations.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Creates an import to stage Takeout archives into. Administrators may instead name a folder inside one of the permitted import locations.",
  "operationId": "createTakeoutImport",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TakeoutCreateDto"
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
            "$ref": "#/components/schemas/TakeoutResponseDto"
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
  "summary": "Start a Google Photos import",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## getTakeoutRoots

`GET /api/takeout/roots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L78).

List the permitted import locations

Permission: `See authentication declaration`. Admin only: `true`.

Models: [TakeoutRootsResponseDto](models-37.md#takeoutrootsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Get('roots')
@Authenticated({ admin: true })
@Endpoint({ summary: 'List the permitted import locations', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getTakeoutRoots",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TakeoutRootsResponseDto"
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
  "summary": "List the permitted import locations",
  "tags": [
    "Assets"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## deleteTakeoutImport

`DELETE /api/takeout/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L92).

Delete a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Delete a Google Photos import',
    description: 'Removes the import and its staged copies. Everything it brought into the library stays there.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the import and its staged copies. Everything it brought into the library stays there.",
  "operationId": "deleteTakeoutImport",
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
  "summary": "Delete a Google Photos import",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## getTakeoutImport

`GET /api/takeout/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L85).

Get a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResponseDto](models-37.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Get(':id')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Get a Google Photos import', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getTakeoutImport",
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
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TakeoutResponseDto"
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
  "summary": "Get a Google Photos import",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## createTakeoutArchive

`POST /api/takeout/{id}/archives`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L104).

Stage a Takeout archive

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutArchiveCreateDto](models-36.md#takeoutarchivecreatedto), [TakeoutSourceResponseDto](models-37.md#takeoutsourceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post(':id/archives')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Stage a Takeout archive', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "createTakeoutArchive",
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
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TakeoutArchiveCreateDto"
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
            "$ref": "#/components/schemas/TakeoutSourceResponseDto"
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
  "summary": "Stage a Takeout archive",
  "tags": [
    "Assets"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```
