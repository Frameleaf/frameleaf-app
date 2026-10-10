# Server API — Tags

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAllTags

`GET /api/tags`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L36).

Retrieve tags

Permission: `tag.read`. Admin only: `false`.

Models: [TagResponseDto](models-38.md#tagresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Get()
@Authenticated({ permission: Permission.TagRead })
@Endpoint({
    summary: 'Retrieve tags',
    description: 'Retrieve a list of all tags.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all tags.",
  "operationId": "getAllTags",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/TagResponseDto"
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
  "summary": "Retrieve tags",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.read",
  "x-immich-state": "Stable"
}
```

## createTag

`POST /api/tags`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L25).

Create a tag

Permission: `tag.create`. Admin only: `false`.

Models: [TagCreateDto](models-38.md#tagcreatedto), [TagResponseDto](models-38.md#tagresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Post()
@Authenticated({ permission: Permission.TagCreate })
@Endpoint({
    summary: 'Create a tag',
    description: 'Create a new tag by providing a name and optional color.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new tag by providing a name and optional color.",
  "operationId": "createTag",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TagCreateDto"
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
            "$ref": "#/components/schemas/TagResponseDto"
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
  "summary": "Create a tag",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.create",
  "x-immich-state": "Stable"
}
```

## upsertTags

`PUT /api/tags`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L59).

Upsert tags

Permission: `tag.create`. Admin only: `false`.

Models: [TagResponseDto](models-38.md#tagresponsedto), [TagUpsertDto](models-38.md#tagupsertdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Put()
@Authenticated({ permission: Permission.TagCreate })
@Endpoint({
    summary: 'Upsert tags',
    description: 'Create or update multiple tags in a single request.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create or update multiple tags in a single request.",
  "operationId": "upsertTags",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TagUpsertDto"
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
              "$ref": "#/components/schemas/TagResponseDto"
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
  "summary": "Upsert tags",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.create",
  "x-immich-state": "Stable"
}
```

## bulkTagAssets

`PUT /api/tags/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L70).

Tag assets

Permission: `tag.asset`. Admin only: `false`.

Models: [TagBulkAssetsDto](models-38.md#tagbulkassetsdto), [TagBulkAssetsResponseDto](models-38.md#tagbulkassetsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Put('assets')
@Authenticated({ permission: Permission.TagAsset })
@Endpoint({
    summary: 'Tag assets',
    description: 'Add multiple tags to multiple assets in a single request.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Add multiple tags to multiple assets in a single request.",
  "operationId": "bulkTagAssets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TagBulkAssetsDto"
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
            "$ref": "#/components/schemas/TagBulkAssetsResponseDto"
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
  "summary": "Tag assets",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.asset",
  "x-immich-state": "Stable"
}
```

## getTagStatistics

`GET /api/tags/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L47).

Retrieve tag statistics

Permission: `tag.read`. Admin only: `false`.

Models: [TagStatisticsResponseDto](models-38.md#tagstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Get('statistics')
@Authenticated({ permission: Permission.TagRead })
@Endpoint({
    summary: 'Retrieve tag statistics',
    description:
      'Count the Timeline items that carry each tag: exactly that tag, and that tag or any tag nested under it. Archived, Locked and hidden items are never counted, and tags the session may not see are left out.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Count the Timeline items that carry each tag: exactly that tag, and that tag or any tag nested under it. Archived, Locked and hidden items are never counted, and tags the session may not see are left out.",
  "operationId": "getTagStatistics",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/TagStatisticsResponseDto"
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
  "summary": "Retrieve tag statistics",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.read",
  "x-immich-state": "Alpha"
}
```

## deleteTag

`DELETE /api/tags/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L114).

Delete a tag

Permission: `tag.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Delete(':id')
@Authenticated({ permission: Permission.TagDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a tag',
    description: 'Delete a specific tag by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific tag by its ID.",
  "operationId": "deleteTag",
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
  "summary": "Delete a tag",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.delete",
  "x-immich-state": "Stable"
}
```

## getTagById

`GET /api/tags/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L81).

Retrieve a tag

Permission: `tag.read`. Admin only: `false`.

Models: [TagResponseDto](models-38.md#tagresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Get(':id')
@Authenticated({ permission: Permission.TagRead })
@Endpoint({
    summary: 'Retrieve a tag',
    description: 'Retrieve a specific tag by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific tag by its ID.",
  "operationId": "getTagById",
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
            "$ref": "#/components/schemas/TagResponseDto"
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
  "summary": "Retrieve a tag",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.read",
  "x-immich-state": "Stable"
}
```

## updateTag

`PUT /api/tags/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L92).

Update a tag

Permission: `tag.update`. Admin only: `false`.

Models: [TagResponseDto](models-38.md#tagresponsedto), [TagUpdateDto](models-38.md#tagupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Put(':id')
@Authenticated({ permission: Permission.TagUpdate })
@Endpoint({
    summary: 'Update a tag',
    description: 'Update an existing tag identified by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2').deprecated('v3', { replacementId: 'updateTag' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an existing tag identified by its ID.",
  "operationId": "updateTag",
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
          "$ref": "#/components/schemas/TagUpdateDto"
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
            "$ref": "#/components/schemas/TagResponseDto"
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
  "summary": "Update a tag",
  "tags": [
    "Tags",
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
      "replacementId": "updateTag"
    }
  ],
  "x-immich-permission": "tag.update",
  "x-immich-state": "Deprecated"
}
```

## untagAssets

`DELETE /api/tags/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L141).

Untag assets

Permission: `tag.asset`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Delete(':id/assets')
@Authenticated({ permission: Permission.TagAsset })
@Endpoint({
    summary: 'Untag assets',
    description: 'Remove a tag from all the specified assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove a tag from all the specified assets.",
  "operationId": "untagAssets",
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
  "summary": "Untag assets",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.asset",
  "x-immich-state": "Stable"
}
```

## tagAssets

`PUT /api/tags/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L126).

Tag assets

Permission: `tag.asset`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Put(':id/assets')
@Authenticated({ permission: Permission.TagAsset })
@Endpoint({
    summary: 'Tag assets',
    description: 'Add a tag to all the specified assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Add a tag to all the specified assets.",
  "operationId": "tagAssets",
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
  "summary": "Tag assets",
  "tags": [
    "Tags"
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
  "x-immich-permission": "tag.asset",
  "x-immich-state": "Stable"
}
```
