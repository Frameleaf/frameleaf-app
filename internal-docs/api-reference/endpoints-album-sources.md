# Server API — Album sources

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAlbumSourceLinks

`GET /api/album-sources`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L26).

List album source links

Permission: `album.read`. Admin only: `false`.

Models: [AlbumSourceLinkResponseDto](models-02.md#albumsourcelinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Get()
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List album source links',
    description: 'List your phone albums and folders linked to server albums.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "List your phone albums and folders linked to server albums.",
  "operationId": "getAlbumSourceLinks",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AlbumSourceLinkResponseDto"
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
  "summary": "List album source links",
  "tags": [
    "Album sources"
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
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## resolveAlbumSources

`POST /api/album-sources/resolve`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L37).

Resolve album sources

Permission: `album.create`. Admin only: `false`.

Models: [AlbumSourceResolveDto](models-02.md#albumsourceresolvedto), [AlbumSourceResolveResponseDto](models-02.md#albumsourceresolveresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Post('resolve')
@Authenticated({ permission: Permission.AlbumCreate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Resolve album sources',
    description:
      'For each phone album or folder, return its linked server album; otherwise link it to your oldest album with the same trimmed, case-insensitive name, or create an album. Never creates two albums for one source, also with several devices resolving at once.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "For each phone album or folder, return its linked server album; otherwise link it to your oldest album with the same trimmed, case-insensitive name, or create an album. Never creates two albums for one source, also with several devices resolving at once.",
  "operationId": "resolveAlbumSources",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AlbumSourceResolveDto"
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
            "$ref": "#/components/schemas/AlbumSourceResolveResponseDto"
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
  "summary": "Resolve album sources",
  "tags": [
    "Album sources"
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
  "x-immich-permission": "album.create",
  "x-immich-state": "Alpha"
}
```

## deleteAlbumSourceLink

`DELETE /api/album-sources/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L102).

Delete an album source link

Permission: `album.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Delete(':id')
@Authenticated({ permission: Permission.AlbumUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete an album source link',
    description: 'Unlink the phone album or folder. The server album and its photos are kept.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Unlink the phone album or folder. The server album and its photos are kept.",
  "operationId": "deleteAlbumSourceLink",
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
  "summary": "Delete an album source link",
  "tags": [
    "Album sources"
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

## updateAlbumSourceLink

`PATCH /api/album-sources/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L86).

Update an album source link

Permission: `album.update`. Admin only: `false`.

Models: [AlbumSourceUpdateDto](models-02.md#albumsourceupdatedto), [AlbumSourceUpdateResponseDto](models-02.md#albumsourceupdateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Patch(':id')
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Update an album source link',
    description:
      'Record the source’s new name on the phone, renaming the server album only while its name still equals the name it last followed. An optional sourceId re-keys the link (409 when another link holds it).',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Record the source’s new name on the phone, renaming the server album only while its name still equals the name it last followed. An optional sourceId re-keys the link (409 when another link holds it).",
  "operationId": "updateAlbumSourceLink",
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
          "$ref": "#/components/schemas/AlbumSourceUpdateDto"
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
            "$ref": "#/components/schemas/AlbumSourceUpdateResponseDto"
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
  "summary": "Update an album source link",
  "tags": [
    "Album sources"
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

## removeAlbumSourceAssets

`DELETE /api/album-sources/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L70).

Remove assets through an album source link

Permission: `albumAsset.delete`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Delete(':id/assets')
@Authenticated({ permission: Permission.AlbumAssetDelete })
@Endpoint({
    summary: 'Remove assets through an album source link',
    description:
      "Take out only the album memberships this link's sync added. Assets are never deleted, trashed or hidden, and memberships added by hand or still recorded by another link stay.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Take out only the album memberships this link's sync added. Assets are never deleted, trashed or hidden, and memberships added by hand or still recorded by another link stay.",
  "operationId": "removeAlbumSourceAssets",
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
  "summary": "Remove assets through an album source link",
  "tags": [
    "Album sources"
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
  "x-immich-permission": "albumAsset.delete",
  "x-immich-state": "Alpha"
}
```

## addAlbumSourceAssets

`POST /api/album-sources/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/album-source.controller.ts#L53).

Add assets through an album source link

Permission: `albumAsset.create`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.AlbumSources)
@Controller('album-sources')
@Post(':id/assets')
@Authenticated({ permission: Permission.AlbumAssetCreate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Add assets through an album source link',
    description:
      'Add assets to the linked album and record that the sync added them. Idempotent; an asset already in the album by hand is reported as a duplicate and never recorded.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Add assets to the linked album and record that the sync added them. Idempotent; an asset already in the album by hand is reported as a duplicate and never recorded.",
  "operationId": "addAlbumSourceAssets",
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
  "summary": "Add assets through an album source link",
  "tags": [
    "Album sources"
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
  "x-immich-permission": "albumAsset.create",
  "x-immich-state": "Alpha"
}
```
