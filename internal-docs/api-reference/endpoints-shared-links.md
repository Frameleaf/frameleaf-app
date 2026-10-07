# Server API — Shared links

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAllSharedLinks

`GET /api/shared-links`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L59).

Retrieve all shared links

Permission: `sharedLink.read`. Admin only: `false`.

Models: [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Get()
@Authenticated({ permission: Permission.SharedLinkRead })
@Endpoint({
    summary: 'Retrieve all shared links',
    description: 'Retrieve a list of all shared links.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all shared links.",
  "operationId": "getAllSharedLinks",
  "parameters": [
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Filter by album ID",
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
      "description": "Filter by shared link ID",
      "x-immich-history": [
        {
          "version": "v2.5.0",
          "state": "Added"
        }
      ],
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
              "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Retrieve all shared links",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.read",
  "x-immich-state": "Stable"
}
```

## createSharedLink

`POST /api/shared-links`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L115).

Create a shared link

Permission: `sharedLink.create`. Admin only: `false`.

Models: [SharedLinkCreateDto](models-30.md#sharedlinkcreatedto), [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Post()
@Authenticated({ permission: Permission.SharedLinkCreate })
@Endpoint({
    summary: 'Create a shared link',
    description: 'Create a new shared link.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new shared link.",
  "operationId": "createSharedLink",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SharedLinkCreateDto"
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
            "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Create a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.create",
  "x-immich-state": "Stable"
}
```

## sharedLinkLogin

`POST /api/shared-links/login`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L70).

Shared link login

Permission: `See authentication declaration`. Admin only: `false`.

Models: [SharedLinkLoginDto](models-30.md#sharedlinklogindto), [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Post('login')
@Authenticated({ sharedLink: true })
@RateLimited(RATE_LIMITS.sharedLinkLogin)
@Endpoint({
    summary: 'Shared link login',
    description: 'Login to a password protected shared link',
    history: new HistoryBuilder().added('v2.6.0').beta('v2.6.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Login to a password protected shared link",
  "operationId": "sharedLinkLogin",
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
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SharedLinkLoginDto"
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
            "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Shared link login",
  "tags": [
    "Shared links"
  ],
  "x-immich-history": [
    {
      "version": "v2.6.0",
      "state": "Added"
    },
    {
      "version": "v2.6.0",
      "state": "Beta"
    }
  ],
  "x-immich-state": "Beta"
}
```

## getMySharedLink

`GET /api/shared-links/me`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L93).

Retrieve current shared link

Permission: `See authentication declaration`. Admin only: `false`.

Models: [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Get('me')
@Authenticated({ sharedLink: true })
@Endpoint({
    summary: 'Retrieve current shared link',
    description: 'Retrieve the current shared link associated with authentication method.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current shared link associated with authentication method.",
  "operationId": "getMySharedLink",
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
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Retrieve current shared link",
  "tags": [
    "Shared links"
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
  "x-immich-state": "Stable"
}
```

## removeSharedLink

`DELETE /api/shared-links/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L141).

Delete a shared link

Permission: `sharedLink.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Delete(':id')
@Authenticated({ permission: Permission.SharedLinkDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a shared link',
    description: 'Delete a specific shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific shared link by its ID.",
  "operationId": "removeSharedLink",
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
  "summary": "Delete a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.delete",
  "x-immich-state": "Stable"
}
```

## getSharedLinkById

`GET /api/shared-links/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L104).

Retrieve a shared link

Permission: `sharedLink.read`. Admin only: `false`.

Models: [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Get(':id')
@Authenticated({ permission: Permission.SharedLinkRead })
@Endpoint({
    summary: 'Retrieve a shared link',
    description: 'Retrieve a specific shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific shared link by its ID.",
  "operationId": "getSharedLinkById",
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
            "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Retrieve a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.read",
  "x-immich-state": "Stable"
}
```

## updateSharedLink

`PATCH /api/shared-links/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L126).

Update a shared link

Permission: `sharedLink.update`. Admin only: `false`.

Models: [SharedLinkEditDto](models-30.md#sharedlinkeditdto), [SharedLinkResponseDto](models-30.md#sharedlinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Patch(':id')
@Authenticated({ permission: Permission.SharedLinkUpdate })
@Endpoint({
    summary: 'Update a shared link',
    description: 'Update an existing shared link by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update an existing shared link by its ID.",
  "operationId": "updateSharedLink",
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
          "$ref": "#/components/schemas/SharedLinkEditDto"
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
            "$ref": "#/components/schemas/SharedLinkResponseDto"
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
  "summary": "Update a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.update",
  "x-immich-state": "Stable"
}
```

## removeSharedLinkAssets

`DELETE /api/shared-links/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L169).

Remove assets from a shared link

Permission: `sharedLink.update`. Admin only: `false`.

Models: [AssetIdsDto](models-05.md#assetidsdto), [AssetIdsResponseDto](models-05.md#assetidsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Delete(':id/assets')
@Authenticated({ permission: Permission.SharedLinkUpdate })
@Endpoint({
    summary: 'Remove assets from a shared link',
    description:
      'Remove assets from a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove assets from a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.",
  "operationId": "removeSharedLinkAssets",
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
          "$ref": "#/components/schemas/AssetIdsDto"
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
              "$ref": "#/components/schemas/AssetIdsResponseDto"
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
  "summary": "Remove assets from a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.update",
  "x-immich-state": "Stable"
}
```

## addSharedLinkAssets

`PUT /api/shared-links/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-link.controller.ts#L153).

Add assets to a shared link

Permission: `sharedLink.update`. Admin only: `false`.

Models: [AssetIdsDto](models-05.md#assetidsdto), [AssetIdsResponseDto](models-05.md#assetidsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedLinks)
@Controller('shared-links')
@Put(':id/assets')
@Authenticated({ permission: Permission.SharedLinkUpdate })
@Endpoint({
    summary: 'Add assets to a shared link',
    description:
      'Add assets to a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Add assets to a specific shared link by its ID. This endpoint is only relevant for shared link of type individual.",
  "operationId": "addSharedLinkAssets",
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
          "$ref": "#/components/schemas/AssetIdsDto"
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
              "$ref": "#/components/schemas/AssetIdsResponseDto"
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
  "summary": "Add assets to a shared link",
  "tags": [
    "Shared links"
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
  "x-immich-permission": "sharedLink.update",
  "x-immich-state": "Stable"
}
```
