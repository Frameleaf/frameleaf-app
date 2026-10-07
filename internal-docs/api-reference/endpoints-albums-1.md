# Server API — Albums 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAllAlbums

`GET /api/albums`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L35).

List all albums

Permission: `album.read`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Get()
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List all albums',
    description: 'Retrieve a list of albums available to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of albums available to the authenticated user.",
  "operationId": "getAllAlbums",
  "parameters": [
    {
      "name": "assetId",
      "required": false,
      "in": "query",
      "description": "Filter albums containing this asset ID (ignores other parameters)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Album ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "isOwned",
      "required": false,
      "in": "query",
      "description": "Filter by ownership: true = only owned, false = only shared-with-me, undefined = no filter",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isShared",
      "required": false,
      "in": "query",
      "description": "Filter by shared status: true = only shared, false = not shared, undefined = no filter",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "name",
      "required": false,
      "in": "query",
      "description": "Album name (exact match)",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "suppressedOnly",
      "required": false,
      "in": "query",
      "description": "Return album metadata for suppressed content only",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "List all albums",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Stable"
}
```

## createAlbum

`POST /api/albums`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L46).

Create an album

Permission: `album.create`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto), [CreateAlbumDto](models-09.md#createalbumdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Post()
@Authenticated({ permission: Permission.AlbumCreate })
@Endpoint({
    summary: 'Create an album',
    description: 'Create a new album. The album can also be created with initial users and assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new album. The album can also be created with initial users and assets.",
  "operationId": "createAlbum",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CreateAlbumDto"
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
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Create an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.create",
  "x-immich-state": "Stable"
}
```

## addAssetsToAlbums

`PUT /api/albums/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L210).

Add assets to albums

Permission: `albumAsset.create`. Admin only: `false`.

Models: [AlbumsAddAssetsDto](models-02.md#albumsaddassetsdto), [AlbumsAddAssetsResponseDto](models-02.md#albumsaddassetsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put('assets')
@Authenticated({ permission: Permission.AlbumAssetCreate })
@Endpoint({
    summary: 'Add assets to albums',
    description: 'Send a list of asset IDs and album IDs to add each asset to each album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Send a list of asset IDs and album IDs to add each asset to each album.",
  "operationId": "addAssetsToAlbums",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AlbumsAddAssetsDto"
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
            "$ref": "#/components/schemas/AlbumsAddAssetsResponseDto"
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
  "summary": "Add assets to albums",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumAsset.create",
  "x-immich-state": "Stable"
}
```

## getAlbumIconCatalogue

`GET /api/albums/icons`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L80).

Retrieve the album icon catalogue

Permission: `album.read`. Admin only: `false`.

Models: [AlbumIconCatalogueResponseDto](models-02.md#albumiconcatalogueresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Get('icons')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Retrieve the album icon catalogue',
    description:
      'Every Material Design Icons name an album or collection may use, plus the categorised suggested set shown first in icon choosers. Served as data so clients never bundle the catalogue.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Every Material Design Icons name an album or collection may use, plus the categorised suggested set shown first in icon choosers. Served as data so clients never bundle the catalogue.",
  "operationId": "getAlbumIconCatalogue",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AlbumIconCatalogueResponseDto"
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
  "summary": "Retrieve the album icon catalogue",
  "tags": [
    "Albums"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## setAlbumOrder

`PUT /api/albums/order`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L92).

Arrange a group of the album directory

Permission: `album.update`. Admin only: `false`.

Models: [AlbumOrderDto](models-02.md#albumorderdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put('order')
@Authenticated({ permission: Permission.AlbumUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Arrange a group of the album directory',
    description:
      "Save the authenticated user's own custom order for one group of their album directory: the albums inside a collection, or at the top level the collections, the albums on their own, or the shared spaces. The order is personal and changes organization only; access and membership are untouched. The ids must be exactly the group as it is now, otherwise 409.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Save the authenticated user's own custom order for one group of their album directory: the albums inside a collection, or at the top level the collections, the albums on their own, or the shared spaces. The order is personal and changes organization only; access and membership are untouched. The ids must be exactly the group as it is now, otherwise 409.",
  "operationId": "setAlbumOrder",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AlbumOrderDto"
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
  "summary": "Arrange a group of the album directory",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Alpha"
}
```

## getAlbumStatistics

`GET /api/albums/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L57).

Retrieve album statistics

Permission: `album.statistics`. Admin only: `false`.

Models: [AlbumStatisticsResponseDto](models-02.md#albumstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Get('statistics')
@Authenticated({ permission: Permission.AlbumStatistics })
@Endpoint({
    summary: 'Retrieve album statistics',
    description: 'Returns statistics about the albums available to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns statistics about the albums available to the authenticated user.",
  "operationId": "getAlbumStatistics",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AlbumStatisticsResponseDto"
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
  "summary": "Retrieve album statistics",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.statistics",
  "x-immich-state": "Stable"
}
```

## getAlbumTree

`GET /api/albums/tree`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L68).

Retrieve the album directory

Permission: `album.read`. Admin only: `false`.

Models: [AlbumTreeResponseDto](models-02.md#albumtreeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Get('tree')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Retrieve the album directory',
    description:
      'Collections with their albums, albums that stand on their own, and shared spaces, for everything the authenticated user owns or is shared with. Albums nest one level deep inside collections only; collections and shared spaces are always top level.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Collections with their albums, albums that stand on their own, and shared spaces, for everything the authenticated user owns or is shared with. Albums nest one level deep inside collections only; collections and shared spaces are always top level.",
  "operationId": "getAlbumTree",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AlbumTreeResponseDto"
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
  "summary": "Retrieve the album directory",
  "tags": [
    "Albums"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## deleteAlbum

`DELETE /api/albums/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L136).

Delete an album

Permission: `album.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Delete(':id')
@Authenticated({ permission: Permission.AlbumDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete an album',
    description:
      'Delete a specific album by its ID. Note the album is initially trashed and then immediately scheduled for deletion, but relies on a background job to complete the process.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific album by its ID. Note the album is initially trashed and then immediately scheduled for deletion, but relies on a background job to complete the process.",
  "operationId": "deleteAlbum",
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
  "summary": "Delete an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.delete",
  "x-immich-state": "Stable"
}
```

## getAlbumInfo

`GET /api/albums/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L105).

Retrieve an album

Permission: `album.read`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
@Get(':id')
@Endpoint({
    summary: 'Retrieve an album',
    description: 'Retrieve information about a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about a specific album by its ID.",
  "operationId": "getAlbumInfo",
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
    },
    {
      "name": "suppressedOnly",
      "required": false,
      "in": "query",
      "description": "Return album metadata for suppressed content only",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Retrieve an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Stable"
}
```

## updateAlbumInfo

`PATCH /api/albums/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L120).

Update an album

Permission: `album.update`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto), [UpdateAlbumDto](models-36.md#updatealbumdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Patch(':id')
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Update an album',
    description:
      'Update the information of a specific album by its ID. This endpoint can be used to update the album name, description, sort order, etc. However, it is not used to add or remove assets or users from the album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update the information of a specific album by its ID. This endpoint can be used to update the album name, description, sort order, etc. However, it is not used to add or remove assets or users from the album.",
  "operationId": "updateAlbumInfo",
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
          "$ref": "#/components/schemas/UpdateAlbumDto"
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
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Update an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.update",
  "x-immich-state": "Stable"
}
```

## removeAssetFromAlbum

`DELETE /api/albums/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L221).

Remove assets from an album

Permission: `albumAsset.delete`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Delete(':id/assets')
@Authenticated({ permission: Permission.AlbumAssetDelete })
@Endpoint({
    summary: 'Remove assets from an album',
    description: 'Remove multiple assets from a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove multiple assets from a specific album by its ID.",
  "operationId": "removeAssetFromAlbum",
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
          "$ref": "#/components/schemas/BulkIdsDto"
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
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Remove assets from an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumAsset.delete",
  "x-immich-state": "Stable"
}
```

## addAssetsToAlbum

`PUT /api/albums/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L195).

Add assets to an album

Permission: `albumAsset.create`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put(':id/assets')
@Authenticated({ permission: Permission.AlbumAssetCreate })
@Endpoint({
    summary: 'Add assets to an album',
    description: 'Add multiple assets to a specific album by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Add multiple assets to a specific album by its ID.",
  "operationId": "addAssetsToAlbum",
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
          "$ref": "#/components/schemas/BulkIdsDto"
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
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Add assets to an album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumAsset.create",
  "x-immich-state": "Stable"
}
```

## moveAlbumToCollection

`PUT /api/albums/{id}/collection`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L179).

Move an album into or out of a collection

Permission: `album.update`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto), [MoveAlbumDto](models-17.md#movealbumdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put(':id/collection')
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Move an album into or out of a collection',
    description:
      'Move an album into a collection, or send null to take it out so it stands on its own. Only the album owner can move it (an editor gets 403); the destination must be a collection the user can edit. Collections and shared spaces cannot be moved.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Move an album into a collection, or send null to take it out so it stands on its own. Only the album owner can move it (an editor gets 403); the destination must be a collection the user can edit. Collections and shared spaces cannot be moved.",
  "operationId": "moveAlbumToCollection",
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
          "$ref": "#/components/schemas/MoveAlbumDto"
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
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Move an album into or out of a collection",
  "tags": [
    "Albums"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.update"
}
```

## getAlbumDescendantCount

`GET /api/albums/{id}/descendant-count`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L164).

Count descendant albums

Permission: `album.read`. Admin only: `false`.

Models: [AlbumDescendantCountResponseDto](models-02.md#albumdescendantcountresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Authenticated({ permission: Permission.AlbumRead })
@Get(':id/descendant-count')
@Endpoint({
    summary: 'Count descendant albums',
    description:
      'Return the number of descendant albums (children, grandchildren, etc.) for a specific album. Used by the UI to show "Delete X and N nested albums?" confirmations.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Return the number of descendant albums (children, grandchildren, etc.) for a specific album. Used by the UI to show \"Delete X and N nested albums?\" confirmations.",
  "operationId": "getAlbumDescendantCount",
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
            "$ref": "#/components/schemas/AlbumDescendantCountResponseDto"
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
  "summary": "Count descendant albums",
  "tags": [
    "Albums"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## getAlbumMapMarkers

`GET /api/albums/{id}/map-markers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L149).

Retrieve album map markers

Permission: `album.read`. Admin only: `false`.

Models: [MapMarkerResponseDto](models-14.md#mapmarkerresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Authenticated({ permission: Permission.AlbumRead, sharedLink: true })
@Get(':id/map-markers')
@Endpoint({
    summary: 'Retrieve album map markers',
    description: 'Retrieve map marker information for a specific album by its ID.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve map marker information for a specific album by its ID.",
  "operationId": "getAlbumMapMarkers",
  "parameters": [
    {
      "name": "fileCreatedAfter",
      "required": false,
      "in": "query",
      "description": "Filter assets created after this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "fileCreatedBefore",
      "required": false,
      "in": "query",
      "description": "Filter assets created before this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
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
      "name": "isArchived",
      "required": false,
      "in": "query",
      "description": "Include archived items (the album default); false leaves them out",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by the viewer's own favorites; other members' favorites are never matched",
      "schema": {
        "type": "boolean"
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
      "name": "withPartners",
      "required": false,
      "in": "query",
      "description": "Include the album's items owned by anyone else (the album default); false keeps only your own",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withSharedAlbums",
      "required": false,
      "in": "query",
      "description": "Accepted for the shared map settings; has no effect on an album map",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/MapMarkerResponseDto"
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
  "summary": "Retrieve album map markers",
  "tags": [
    "Albums"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## removeUserFromAlbum

`DELETE /api/albums/{id}/user/{userId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L267).

Remove user from album

Permission: `albumUser.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Delete(':id/user/:userId')
@Authenticated({ permission: Permission.AlbumUserDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove user from album',
    description: 'Remove a user from an album. Use an ID of "me" to leave a shared album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove a user from an album. Use an ID of \"me\" to leave a shared album.",
  "operationId": "removeUserFromAlbum",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Album ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": true,
      "in": "path",
      "description": "Album user ID, or \"me\" to reference the current user.",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Updated",
          "description": "\"me\" as a value is deprecated"
        }
      ],
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
  "summary": "Remove user from album",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumUser.delete",
  "x-immich-state": "Stable"
}
```

## updateAlbumUser

`PUT /api/albums/{id}/user/{userId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L251).

Update user role

Permission: `albumUser.update`. Admin only: `false`.

Models: [UpdateAlbumUserDto](models-36.md#updatealbumuserdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put(':id/user/:userId')
@Authenticated({ permission: Permission.AlbumUserUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Update user role',
    description: 'Change the role for a specific user in a specific album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Change the role for a specific user in a specific album.",
  "operationId": "updateAlbumUser",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Album ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": true,
      "in": "path",
      "description": "Album user ID, or \"me\" to reference the current user.",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Updated",
          "description": "\"me\" as a value is deprecated"
        }
      ],
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UpdateAlbumUserDto"
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
  "summary": "Update user role",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumUser.update",
  "x-immich-state": "Stable"
}
```

## addUsersToAlbum

`PUT /api/albums/{id}/users`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/album.controller.ts#L236).

Share album with users

Permission: `albumUser.create`. Admin only: `false`.

Models: [AddUsersDto](models-01.md#addusersdto), [AlbumResponseDto](models-02.md#albumresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('albums')
@Put(':id/users')
@Authenticated({ permission: Permission.AlbumUserCreate })
@Endpoint({
    summary: 'Share album with users',
    description: 'Share an album with multiple users. Each user can be given a specific role in the album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Share an album with multiple users. Each user can be given a specific role in the album.",
  "operationId": "addUsersToAlbum",
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
          "$ref": "#/components/schemas/AddUsersDto"
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
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Share album with users",
  "tags": [
    "Albums"
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
  "x-immich-permission": "albumUser.create",
  "x-immich-state": "Stable"
}
```

## getAssetClassifications

`GET /api/classification/assets/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/classification.controller.ts#L201).

Retrieve classification contributions for an asset

Permission: `asset.read`. Admin only: `false`.

Models: [ClassificationContributionDto](models-07.md#classificationcontributiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Get('assets/:id')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve classification contributions for an asset',
    description: 'Which of your rules put this item in a smart album, added a tag to it or archived it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Which of your rules put this item in a smart album, added a tag to it or archived it.",
  "operationId": "getAssetClassifications",
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
              "$ref": "#/components/schemas/ClassificationContributionDto"
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
  "summary": "Retrieve classification contributions for an asset",
  "tags": [
    "Albums"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## previewClassificationRule

`POST /api/classification/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/classification.controller.ts#L78).

Preview a classification rule

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationPreviewDto](models-07.md#classificationpreviewdto), [ClassificationPreviewResponseDto](models-07.md#classificationpreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Post('preview')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Preview a classification rule',
    description:
      'What a draft rule matches, without writing anything. Rules with visual categories are previewed over a bounded sample of your newest items.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What a draft rule matches, without writing anything. Rules with visual categories are previewed over a bounded sample of your newest items.",
  "operationId": "previewClassificationRule",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ClassificationPreviewDto"
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
            "$ref": "#/components/schemas/ClassificationPreviewResponseDto"
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
  "summary": "Preview a classification rule",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## getClassificationRules

`GET /api/classification/rules`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/classification.controller.ts#L49).

List classification rules

Permission: `album.read`. Admin only: `false`.

Models: [ClassificationRuleResponseDto](models-08.md#classificationruleresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Albums)
@Controller('classification')
@Get('rules')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List classification rules',
    description: 'Your smart album rules, optionally only the one behind an album.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Your smart album rules, optionally only the one behind an album.",
  "operationId": "getClassificationRules",
  "parameters": [
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Only the rule behind this album",
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
              "$ref": "#/components/schemas/ClassificationRuleResponseDto"
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
  "summary": "List classification rules",
  "tags": [
    "Albums"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```
