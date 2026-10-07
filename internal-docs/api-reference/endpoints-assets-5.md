# Server API — Assets 5

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## controlTakeoutImport

`POST /api/takeout/{id}/control`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L203).

Pause, resume or cancel a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutControlDto](models-36.md#takeoutcontroldto), [TakeoutResponseDto](models-37.md#takeoutresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L186).

Import the reviewed items

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutOptionsDto](models-36.md#takeoutoptionsdto), [TakeoutResponseDto](models-37.md#takeoutresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L215).

List the items of a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutItemState](models-36.md#takeoutitemstate), [TakeoutItemsResponseDto](models-36.md#takeoutitemsresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L226).

Choose metadata for an item, or leave it out

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResolveDto](models-36.md#takeoutresolvedto), [TakeoutResponseDto](models-37.md#takeoutresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L237).

List possible Live Photos in a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutPairState](models-36.md#takeoutpairstate), [TakeoutPairsResponseDto](models-36.md#takeoutpairsresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L248).

Link or separate a possible Live Photo

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutPairDecisionDto](models-36.md#takeoutpairdecisiondto), [TakeoutPairsResponseDto](models-36.md#takeoutpairsresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/takeout.controller.ts#L174).

Scan a Google Photos import

Permission: `asset.upload`. Admin only: `false`.

Models: [TakeoutResponseDto](models-37.md#takeoutresponsedto).

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
