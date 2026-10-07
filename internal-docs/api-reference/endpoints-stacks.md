# Server API — Stacks

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteStacks

`DELETE /api/stacks`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L40).

Delete stacks

Permission: `stack.delete`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Delete()
@Authenticated({ permission: Permission.StackDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete stacks',
    description: 'Delete multiple stacks by providing a list of stack IDs.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete multiple stacks by providing a list of stack IDs.",
  "operationId": "deleteStacks",
  "parameters": [],
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
  "summary": "Delete stacks",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.delete",
  "x-immich-state": "Stable"
}
```

## searchStacks

`GET /api/stacks`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L17).

Retrieve stacks

Permission: `stack.read`. Admin only: `false`.

Models: [StackResponseDto](models-32.md#stackresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Get()
@Authenticated({ permission: Permission.StackRead })
@Endpoint({
    summary: 'Retrieve stacks',
    description: 'Retrieve a list of stacks.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of stacks.",
  "operationId": "searchStacks",
  "parameters": [
    {
      "name": "primaryAssetId",
      "required": false,
      "in": "query",
      "description": "Filter by primary asset ID",
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
              "$ref": "#/components/schemas/StackResponseDto"
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
  "summary": "Retrieve stacks",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.read",
  "x-immich-state": "Stable"
}
```

## createStack

`POST /api/stacks`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L28).

Create a stack

Permission: `stack.create`. Admin only: `false`.

Models: [StackCreateDto](models-32.md#stackcreatedto), [StackResponseDto](models-32.md#stackresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Post()
@Authenticated({ permission: Permission.StackCreate })
@Endpoint({
    summary: 'Create a stack',
    description:
      'Create a new stack by providing a name and a list of asset IDs to include in the stack. If any of the provided asset IDs are primary assets of an existing stack, the existing stack will be merged into the newly created stack.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new stack by providing a name and a list of asset IDs to include in the stack. If any of the provided asset IDs are primary assets of an existing stack, the existing stack will be merged into the newly created stack.",
  "operationId": "createStack",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StackCreateDto"
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
            "$ref": "#/components/schemas/StackResponseDto"
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
  "summary": "Create a stack",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.create",
  "x-immich-state": "Stable"
}
```

## deleteStack

`DELETE /api/stacks/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L93).

Delete a stack

Permission: `stack.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Delete(':id')
@Authenticated({ permission: Permission.StackDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a stack',
    description: 'Delete a specific stack by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific stack by its ID.",
  "operationId": "deleteStack",
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
  "summary": "Delete a stack",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.delete",
  "x-immich-state": "Stable"
}
```

## getStack

`GET /api/stacks/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L52).

Retrieve a stack

Permission: `stack.read`. Admin only: `false`.

Models: [StackResponseDto](models-32.md#stackresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Get(':id')
@Authenticated({ permission: Permission.StackRead })
@Endpoint({
    summary: 'Retrieve a stack',
    description: 'Retrieve a specific stack by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific stack by its ID.",
  "operationId": "getStack",
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
            "$ref": "#/components/schemas/StackResponseDto"
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
  "summary": "Retrieve a stack",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.read",
  "x-immich-state": "Stable"
}
```

## updateStack

`PUT /api/stacks/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L63).

Update a stack

Permission: `stack.update`. Admin only: `false`.

Models: [StackResponseDto](models-32.md#stackresponsedto), [StackUpdateDto](models-32.md#stackupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Put(':id')
@Authenticated({ permission: Permission.StackUpdate })
@Endpoint({
    summary: 'Update a stack',
    description: 'Update an existing stack by its ID.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateStack' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an existing stack by its ID.",
  "operationId": "updateStack",
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
          "$ref": "#/components/schemas/StackUpdateDto"
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
            "$ref": "#/components/schemas/StackResponseDto"
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
  "summary": "Update a stack",
  "tags": [
    "Stacks",
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
      "replacementId": "updateStack"
    }
  ],
  "x-immich-permission": "stack.update",
  "x-immich-state": "Deprecated"
}
```

## removeAssetFromStack

`DELETE /api/stacks/{id}/assets/{assetId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/stack.controller.ts#L105).

Remove an asset from a stack

Permission: `stack.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Delete(':id/assets/:assetId')
@Authenticated({ permission: Permission.StackUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove an asset from a stack',
    description: 'Remove a specific asset from a stack by providing the stack ID and asset ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove a specific asset from a stack by providing the stack ID and asset ID.",
  "operationId": "removeAssetFromStack",
  "parameters": [
    {
      "name": "assetId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
  "summary": "Remove an asset from a stack",
  "tags": [
    "Stacks"
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
  "x-immich-permission": "stack.update",
  "x-immich-state": "Stable"
}
```
