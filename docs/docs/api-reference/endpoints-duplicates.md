# Server API — Duplicates

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteDuplicates

`DELETE /api/duplicates`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate.controller.ts#L28).

Delete duplicates

Permission: `duplicate.delete`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Delete()
@Authenticated({ permission: Permission.DuplicateDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete duplicates',
    description: 'Delete multiple duplicate assets specified by their IDs.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete multiple duplicate assets specified by their IDs.",
  "operationId": "deleteDuplicates",
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
  "summary": "Delete duplicates",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.delete",
  "x-immich-state": "Stable"
}
```

## getAssetDuplicates

`GET /api/duplicates`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate.controller.ts#L17).

Retrieve duplicates

Permission: `duplicate.read`. Admin only: `false`.

Models: [DuplicateResponseDto](models-11.md#duplicateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Get()
@Authenticated({ permission: Permission.DuplicateRead })
@Endpoint({
    summary: 'Retrieve duplicates',
    description: 'Retrieve a list of duplicate assets available to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of duplicate assets available to the authenticated user.",
  "operationId": "getAssetDuplicates",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/DuplicateResponseDto"
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
  "summary": "Retrieve duplicates",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.read",
  "x-immich-state": "Stable"
}
```

## getDuplicateDecisions

`GET /api/duplicates/decisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate-review.controller.ts#L35).

Retrieve recent duplicate decisions

Permission: `duplicate.read`. Admin only: `false`.

Models: [DuplicateDecisionHistoryDto](models-11.md#duplicatedecisionhistorydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Get('decisions')
@Authenticated({ permission: Permission.DuplicateRead })
@Endpoint({
    summary: 'Retrieve recent duplicate decisions',
    description:
      'Your most recent duplicate decision jobs, which can be undone while nothing has changed since, and the decision jobs still running.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Your most recent duplicate decision jobs, which can be undone while nothing has changed since, and the decision jobs still running.",
  "operationId": "getDuplicateDecisions",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/DuplicateDecisionHistoryDto"
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
  "summary": "Retrieve recent duplicate decisions",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.read",
  "x-immich-state": "Alpha"
}
```

## resolveDuplicates

`POST /api/duplicates/resolve`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate.controller.ts#L52).

Resolve duplicate groups

Permission: `duplicate.delete`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [DuplicateResolveDto](models-11.md#duplicateresolvedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Post('resolve')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.DuplicateDelete })
@Endpoint({
    summary: 'Resolve duplicate groups',
    description: 'Resolve duplicate groups by synchronizing metadata across assets and deleting/trashing duplicates.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Resolve duplicate groups by synchronizing metadata across assets and deleting/trashing duplicates.",
  "operationId": "resolveDuplicates",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/DuplicateResolveDto"
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
  "summary": "Resolve duplicate groups",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.delete",
  "x-immich-state": "Alpha"
}
```

## getDuplicateReview

`GET /api/duplicates/review`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate-review.controller.ts#L23).

Retrieve the duplicate review

Permission: `duplicate.read`. Admin only: `false`.

Models: [DuplicateReviewGroupDto](models-11.md#duplicatereviewgroupdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Get('review')
@Authenticated({ permission: Permission.DuplicateRead })
@Endpoint({
    summary: 'Retrieve the duplicate review',
    description:
      'Your duplicate groups, each read as a whole: whether it holds copies of one photo or frames of a burst, the evidence behind the suggested keeper, and whether this session may decide it. A group with photos this session does not see, or with another account’s photo, is listed but cannot be decided.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Your duplicate groups, each read as a whole: whether it holds copies of one photo or frames of a burst, the evidence behind the suggested keeper, and whether this session may decide it. A group with photos this session does not see, or with another account’s photo, is listed but cannot be decided.",
  "operationId": "getDuplicateReview",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/DuplicateReviewGroupDto"
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
  "summary": "Retrieve the duplicate review",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.read",
  "x-immich-state": "Alpha"
}
```

## deleteDuplicate

`DELETE /api/duplicates/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/duplicate.controller.ts#L40).

Dismiss a duplicate group

Permission: `duplicate.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Duplicates)
@Controller('duplicates')
@Delete(':id')
@Authenticated({ permission: Permission.DuplicateDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Dismiss a duplicate group',
    description: 'Dismiss a duplicate group by its ID, unlinking all assets in the group without deleting them.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Dismiss a duplicate group by its ID, unlinking all assets in the group without deleting them.",
  "operationId": "deleteDuplicate",
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
  "summary": "Dismiss a duplicate group",
  "tags": [
    "Duplicates"
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
  "x-immich-permission": "duplicate.delete",
  "x-immich-state": "Stable"
}
```
