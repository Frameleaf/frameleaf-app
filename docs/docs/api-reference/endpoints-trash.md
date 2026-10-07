# Server API — Trash

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getUtilityActivity

`GET /api/trash/activity`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L50).

Get utility activity

Permission: `asset.read`. Admin only: `false`.

Models: [UtilityActivityResponseDto](models-37.md#utilityactivityresponsedto), [UtilityActivityTool](models-37.md#utilityactivitytool).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Get('activity')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get utility activity',
    description:
      'Your own history of moves to the trash and their undos made from a utility such as Large files, newest first, kept for a year. An item is named only while this session may still see it.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Your own history of moves to the trash and their undos made from a utility such as Large files, newest first, kept for a year. An item is named only while this session may still see it.",
  "operationId": "getUtilityActivity",
  "parameters": [
    {
      "name": "tool",
      "required": true,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/UtilityActivityTool"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UtilityActivityResponseDto"
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
  "summary": "Get utility activity",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## applyTrashReview

`POST /api/trash/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L78).

Apply a reviewed trash change

Permission: `asset.delete`. Admin only: `false`.

Models: [TrashApplyDto](models-36.md#trashapplydto), [TrashResponseDto](models-36.md#trashresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Post('apply')
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Apply a reviewed trash change',
    description:
      'Applies an action to exactly the reviewed set. The set is resolved again with the same ownership, Locked and privacy rules; if it differs from the review in any way the request fails with 409 and nothing changes.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Applies an action to exactly the reviewed set. The set is resolved again with the same ownership, Locked and privacy rules; if it differs from the review in any way the request fails with 409 and nothing changes.",
  "operationId": "applyTrashReview",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TrashApplyDto"
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
            "$ref": "#/components/schemas/TrashResponseDto"
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
  "summary": "Apply a reviewed trash change",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Alpha"
}
```

## emptyTrash

`POST /api/trash/empty`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L91).

Empty trash

Permission: `asset.delete`. Admin only: `false`.

Models: [TrashResponseDto](models-36.md#trashresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Post('empty')
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Empty trash',
    description: 'Permanently delete all items in the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Permanently delete all items in the trash.",
  "operationId": "emptyTrash",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TrashResponseDto"
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
  "summary": "Empty trash",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Stable"
}
```

## getTrashItems

`GET /api/trash/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L38).

List trash items

Permission: `asset.read`. Admin only: `false`.

Models: [AssetTypeEnum](models-06.md#assettypeenum), [TrashItemSort](models-36.md#trashitemsort), [TrashItemsResponseDto](models-36.md#trashitemsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Get('items')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'List trash items',
    description:
      'One page of your own trash, filtered by file name and media type and ordered by deletion time, size or name. Locked media is listed only in an unlocked session.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "One page of your own trash, filtered by file name and media type and ordered by deletion time, size or name. Locked media is listed only in an unlocked session.",
  "operationId": "getTrashItems",
  "parameters": [
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number, from 1",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "query",
      "required": false,
      "in": "query",
      "description": "Words that must all appear in the file name",
      "schema": {
        "maxLength": 255,
        "type": "string"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Items per page",
      "schema": {
        "minimum": 1,
        "maximum": 1000,
        "default": 200,
        "type": "integer"
      }
    },
    {
      "name": "sort",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/TrashItemSort"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TrashItemsResponseDto"
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
  "summary": "List trash items",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## restoreTrash

`POST /api/trash/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L103).

Restore trash

Permission: `asset.delete`. Admin only: `false`.

Models: [TrashResponseDto](models-36.md#trashresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Post('restore')
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Restore trash',
    description: 'Restore all items in the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Restore all items in the trash.",
  "operationId": "restoreTrash",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TrashResponseDto"
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
  "summary": "Restore trash",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Stable"
}
```

## restoreAssets

`POST /api/trash/restore/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L115).

Restore assets

Permission: `asset.delete`. Admin only: `false`.

Models: [BulkIdsDto](models-07.md#bulkidsdto), [TrashResponseDto](models-36.md#trashresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Post('restore/assets')
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Restore assets',
    description: 'Restore specific assets from the trash.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Restore specific assets from the trash.",
  "operationId": "restoreAssets",
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
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TrashResponseDto"
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
  "summary": "Restore assets",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Stable"
}
```

## reviewTrash

`POST /api/trash/review`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L65).

Review a trash change

Permission: `asset.delete`. Admin only: `false`.

Models: [TrashReviewDto](models-36.md#trashreviewdto), [TrashReviewResponseDto](models-36.md#trashreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Post('review')
@Authenticated({ permission: Permission.AssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Review a trash change',
    description:
      'Resolves exactly which items an action would change (move to trash, restore, restore all, delete or empty) and returns their count, size, shared originals and a token that fingerprints the set. Nothing is changed.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Resolves exactly which items an action would change (move to trash, restore, restore all, delete or empty) and returns their count, size, shared originals and a token that fingerprints the set. Nothing is changed.",
  "operationId": "reviewTrash",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TrashReviewDto"
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
            "$ref": "#/components/schemas/TrashReviewResponseDto"
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
  "summary": "Review a trash change",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.delete",
  "x-immich-state": "Alpha"
}
```

## getTrashSummary

`GET /api/trash/summary`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/trash.controller.ts#L26).

Get trash summary

Permission: `asset.read`. Admin only: `false`.

Models: [TrashSummaryResponseDto](models-36.md#trashsummaryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Trash)
@Controller('trash')
@Get('summary')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get trash summary',
    description:
      'Counts for your own trash as this session may see it: items, the combined size of their originals, and items still being removed from storage. Locked media counts only in an unlocked session.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Counts for your own trash as this session may see it: items, the combined size of their originals, and items still being removed from storage. Locked media counts only in an unlocked session.",
  "operationId": "getTrashSummary",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/TrashSummaryResponseDto"
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
  "summary": "Get trash summary",
  "tags": [
    "Trash"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```
