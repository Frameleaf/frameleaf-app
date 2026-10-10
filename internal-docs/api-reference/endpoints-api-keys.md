# Server API — API keys

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getApiKeys

`GET /api/api-keys`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L27).

List all API keys

Permission: `apiKey.read`. Admin only: `false`.

Models: [ApiKeyResponseDto](models-03.md#apikeyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Get()
@Authenticated({ permission: Permission.ApiKeyRead })
@Endpoint({
    summary: 'List all API keys',
    description: 'Retrieve all API keys of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all API keys of the current user.",
  "operationId": "getApiKeys",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ApiKeyResponseDto"
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
  "summary": "List all API keys",
  "tags": [
    "API keys"
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
  "x-immich-permission": "apiKey.read",
  "x-immich-state": "Stable"
}
```

## createApiKey

`POST /api/api-keys`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L16).

Create an API key

Permission: `apiKey.create`. Admin only: `false`.

Models: [ApiKeyCreateDto](models-03.md#apikeycreatedto), [ApiKeyCreateResponseDto](models-03.md#apikeycreateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Post()
@Authenticated({ permission: Permission.ApiKeyCreate })
@Endpoint({
    summary: 'Create an API key',
    description: 'Creates a new API key. It will be limited to the permissions specified.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Creates a new API key. It will be limited to the permissions specified.",
  "operationId": "createApiKey",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ApiKeyCreateDto"
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
            "$ref": "#/components/schemas/ApiKeyCreateResponseDto"
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
  "summary": "Create an API key",
  "tags": [
    "API keys"
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
  "x-immich-permission": "apiKey.create",
  "x-immich-state": "Stable"
}
```

## getMyApiKey

`GET /api/api-keys/me`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L38).

Retrieve the current API key

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ApiKeyResponseDto](models-03.md#apikeyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Get('me')
@Authenticated({ permission: false })
@Endpoint({
    summary: 'Retrieve the current API key',
    description: 'Retrieve the API key that is used to access this endpoint.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the API key that is used to access this endpoint.",
  "operationId": "getMyApiKey",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ApiKeyResponseDto"
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
  "summary": "Retrieve the current API key",
  "tags": [
    "API keys"
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

## deleteApiKey

`DELETE /api/api-keys/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L102).

Delete an API key

Permission: `apiKey.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Delete(':id')
@Authenticated({ permission: Permission.ApiKeyDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete an API key',
    description: 'Deletes an API key identified by its ID. The current user must own this API key.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes an API key identified by its ID. The current user must own this API key.",
  "operationId": "deleteApiKey",
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
  "summary": "Delete an API key",
  "tags": [
    "API keys"
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
  "x-immich-permission": "apiKey.delete",
  "x-immich-state": "Stable"
}
```

## getApiKey

`GET /api/api-keys/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L49).

Retrieve an API key

Permission: `apiKey.read`. Admin only: `false`.

Models: [ApiKeyResponseDto](models-03.md#apikeyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Get(':id')
@Authenticated({ permission: Permission.ApiKeyRead })
@Endpoint({
    summary: 'Retrieve an API key',
    description: 'Retrieve an API key by its ID. The current user must own this API key.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve an API key by its ID. The current user must own this API key.",
  "operationId": "getApiKey",
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
            "$ref": "#/components/schemas/ApiKeyResponseDto"
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
  "summary": "Retrieve an API key",
  "tags": [
    "API keys"
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
  "x-immich-permission": "apiKey.read",
  "x-immich-state": "Stable"
}
```

## updateApiKey

`PUT /api/api-keys/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L60).

Update an API key

Permission: `apiKey.update`. Admin only: `false`.

Models: [ApiKeyResponseDto](models-03.md#apikeyresponsedto), [ApiKeyUpdateDto](models-03.md#apikeyupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Put(':id')
@Authenticated({ permission: Permission.ApiKeyUpdate })
@Endpoint({
    summary: 'Update an API key',
    description: 'Updates the name and permissions of an API key by its ID. The current user must own this API key.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateApiKey' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Updates the name and permissions of an API key by its ID. The current user must own this API key.",
  "operationId": "updateApiKey",
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
          "$ref": "#/components/schemas/ApiKeyUpdateDto"
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
            "$ref": "#/components/schemas/ApiKeyResponseDto"
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
  "summary": "Update an API key",
  "tags": [
    "API keys",
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
      "replacementId": "updateApiKey"
    }
  ],
  "x-immich-permission": "apiKey.update",
  "x-immich-state": "Deprecated"
}
```

## rotateApiKey

`POST /api/api-keys/{id}/rotate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L90).

Rotate an API key

Permission: `apiKey.rotate`. Admin only: `false`.

Models: [ApiKeyCreateResponseDto](models-03.md#apikeycreateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Post(':id/rotate')
@Authenticated({ permission: Permission.ApiKeyRotate })
@Endpoint({
    summary: 'Rotate an API key',
    description:
      'Generates a new secret for an API key, immediately invalidating the previous one. The current user must own this API key.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Generates a new secret for an API key, immediately invalidating the previous one. The current user must own this API key.",
  "operationId": "rotateApiKey",
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
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ApiKeyCreateResponseDto"
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
  "summary": "Rotate an API key",
  "tags": [
    "API keys"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "apiKey.rotate"
}
```
