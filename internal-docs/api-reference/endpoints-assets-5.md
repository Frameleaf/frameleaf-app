# Server API — Assets 5

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## listTakeoutImports

`GET /api/takeout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L58).

List Google Photos imports

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResponseDto](models-38.md#takeoutresponsedto).

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

Models: [TakeoutCreateDto](models-38.md#takeoutcreatedto), [TakeoutResponseDto](models-38.md#takeoutresponsedto).

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

Models: [TakeoutRootsResponseDto](models-38.md#takeoutrootsresponsedto).

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

Models: [TakeoutResponseDto](models-38.md#takeoutresponsedto).

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

Models: [TakeoutArchiveCreateDto](models-38.md#takeoutarchivecreatedto), [TakeoutSourceResponseDto](models-38.md#takeoutsourceresponsedto).

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

## deleteTakeoutArchive

`DELETE /api/takeout/{id}/archives/{archiveId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L116).

Remove a staged Takeout archive

Permission: `asset.upload`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Delete(':id/archives/:archiveId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Remove a staged Takeout archive', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "deleteTakeoutArchive",
  "parameters": [
    {
      "name": "archiveId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
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
  "summary": "Remove a staged Takeout archive",
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

## uploadTakeoutArchiveChunk

`PUT /api/takeout/{id}/archives/{archiveId}/chunks`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L124).

Upload part of a Takeout archive

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutSourceResponseDto](models-38.md#takeoutsourceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Put(':id/archives/:archiveId/chunks')
@Authenticated({ permission: Permission.AssetUpload })
@ApiConsumes('application/octet-stream')
@ApiBody({ schema: { type: 'string', format: 'binary' } })
@Endpoint({
    summary: 'Upload part of a Takeout archive',
    description: 'Appends up to 8 MiB at the given byte offset. Repeating a part already staged is harmless.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Appends up to 8 MiB at the given byte offset. Repeating a part already staged is harmless.",
  "operationId": "uploadTakeoutArchiveChunk",
  "parameters": [
    {
      "name": "archiveId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
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
      "name": "offset",
      "required": true,
      "in": "query",
      "description": "Byte offset of this chunk",
      "schema": {
        "minimum": 0,
        "maximum": 1099511627776,
        "type": "integer"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/octet-stream": {
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
  "summary": "Upload part of a Takeout archive",
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

## verifyTakeoutArchiveChunk

`POST /api/takeout/{id}/archives/{archiveId}/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L158).

Check a staged part of a Takeout archive

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutVerifyChunkDto](models-38.md#takeoutverifychunkdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post(':id/archives/:archiveId/verify')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Check a staged part of a Takeout archive',
    description: 'Compares a range already uploaded with the file the browser is about to resume from.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Compares a range already uploaded with the file the browser is about to resume from.",
  "operationId": "verifyTakeoutArchiveChunk",
  "parameters": [
    {
      "name": "archiveId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
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
          "$ref": "#/components/schemas/TakeoutVerifyChunkDto"
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
  "summary": "Check a staged part of a Takeout archive",
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

## controlTakeoutImport

`POST /api/takeout/{id}/control`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L203).

Pause, resume or cancel a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutControlDto](models-38.md#takeoutcontroldto), [TakeoutResponseDto](models-38.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post(':id/control')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Pause, resume or cancel a Google Photos import', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "controlTakeoutImport",
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
          "$ref": "#/components/schemas/TakeoutControlDto"
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
  "summary": "Pause, resume or cancel a Google Photos import",
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

## startTakeoutImport

`POST /api/takeout/{id}/import`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L186).

Import the reviewed items

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutOptionsDto](models-38.md#takeoutoptionsdto), [TakeoutResponseDto](models-38.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post(':id/import')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Import the reviewed items',
    description:
      'Queues the import as a background job with these choices. Items already in the library are matched, not copied again, and keep their album memberships.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues the import as a background job with these choices. Items already in the library are matched, not copied again, and keep their album memberships.",
  "operationId": "startTakeoutImport",
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
          "$ref": "#/components/schemas/TakeoutOptionsDto"
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
  "summary": "Import the reviewed items",
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

## getTakeoutItems

`GET /api/takeout/{id}/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L215).

List the items of a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutItemState](models-38.md#takeoutitemstate), [TakeoutItemsResponseDto](models-38.md#takeoutitemsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Get(':id/items')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'List the items of a Google Photos import', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getTakeoutItems",
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
      "name": "limit",
      "required": false,
      "in": "query",
      "description": "Items to return",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "offset",
      "required": false,
      "in": "query",
      "description": "Items to skip",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "default": 0,
        "type": "integer"
      }
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/TakeoutItemState"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TakeoutItemsResponseDto"
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
  "summary": "List the items of a Google Photos import",
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

## resolveTakeoutItem

`PUT /api/takeout/{id}/items/{itemId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L226).

Choose metadata for an item, or leave it out

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResolveDto](models-38.md#takeoutresolvedto), [TakeoutResponseDto](models-38.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Put(':id/items/:itemId')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Choose metadata for an item, or leave it out', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "resolveTakeoutItem",
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
      "name": "itemId",
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
          "$ref": "#/components/schemas/TakeoutResolveDto"
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
  "summary": "Choose metadata for an item, or leave it out",
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

## getTakeoutPairs

`GET /api/takeout/{id}/live-photos`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L237).

List possible Live Photos in a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutPairState](models-38.md#takeoutpairstate), [TakeoutPairsResponseDto](models-38.md#takeoutpairsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Get(':id/live-photos')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'List possible Live Photos in a Google Photos import', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "getTakeoutPairs",
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
      "name": "limit",
      "required": false,
      "in": "query",
      "description": "Pairs to return",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "offset",
      "required": false,
      "in": "query",
      "description": "Pairs to skip",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "default": 0,
        "type": "integer"
      }
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/TakeoutPairState"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TakeoutPairsResponseDto"
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
  "summary": "List possible Live Photos in a Google Photos import",
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

## decideTakeoutPair

`PUT /api/takeout/{id}/live-photos`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L248).

Link or separate a possible Live Photo

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutPairDecisionDto](models-38.md#takeoutpairdecisiondto), [TakeoutPairsResponseDto](models-38.md#takeoutpairsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Put(':id/live-photos')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Link or separate a possible Live Photo', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "decideTakeoutPair",
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
          "$ref": "#/components/schemas/TakeoutPairDecisionDto"
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
            "$ref": "#/components/schemas/TakeoutPairsResponseDto"
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
  "summary": "Link or separate a possible Live Photo",
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

## scanTakeoutImport

`POST /api/takeout/{id}/scan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/takeout.controller.ts#L174).

Scan a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResponseDto](models-38.md#takeoutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Assets)
@Controller('takeout')
@Post(':id/scan')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Scan a Google Photos import',
    description: 'Queues the scan of the staged sources as a background job that continues after the browser closes.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues the scan of the staged sources as a background job that continues after the browser closes.",
  "operationId": "scanTakeoutImport",
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
  "summary": "Scan a Google Photos import",
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
