# Server API — Item shares

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## unshareItems

`DELETE /api/item-shares`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/item-share.controller.ts#L47).

Stop sharing items with people

Permission: `asset.share`. Admin only: `false`.

Models: [ItemShareChangeDto](models-14.md#itemsharechangedto), [ItemShareChangeResponseDto](models-14.md#itemsharechangeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ItemShares)
@Controller('item-shares')
@Delete()
@Authenticated({ permission: Permission.AssetShare })
@Endpoint({
    summary: 'Stop sharing items with people',
    description: 'Stop sharing your own items with these people. They lose access at once.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Stop sharing your own items with these people. They lose access at once.",
  "operationId": "unshareItems",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ItemShareChangeDto"
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
            "$ref": "#/components/schemas/ItemShareChangeResponseDto"
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
  "summary": "Stop sharing items with people",
  "tags": [
    "Item shares"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.share"
}
```

## shareItems

`POST /api/item-shares`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/item-share.controller.ts#L31).

Share items with people

Permission: `asset.share`. Admin only: `false`.

Models: [ItemShareChangeDto](models-14.md#itemsharechangedto), [ItemShareChangeResponseDto](models-14.md#itemsharechangeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ItemShares)
@Controller('item-shares')
@Post()
@Authenticated({ permission: Permission.AssetShare })
@Endpoint({
    summary: 'Share items with people',
    description:
      'Share your own items with people who have an account on this server. They see the items under Sharing, in their own library, and are notified. Locked items are refused.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Share your own items with people who have an account on this server. They see the items under Sharing, in their own library, and are notified. Locked items are refused.",
  "operationId": "shareItems",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ItemShareChangeDto"
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
            "$ref": "#/components/schemas/ItemShareChangeResponseDto"
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
  "summary": "Share items with people",
  "tags": [
    "Item shares"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.share"
}
```

## getItemShares

`PUT /api/item-shares/query`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/item-share.controller.ts#L62).

List who items are shared with

Permission: `asset.share`. Admin only: `false`.

Models: [ItemShareQueryDto](models-14.md#itemsharequerydto), [ItemShareResponseDto](models-14.md#itemshareresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ItemShares)
@Controller('item-shares')
@Put('query')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetShare })
@Endpoint({
    summary: 'List who items are shared with',
    description: 'The people each of your own items is shared with.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The people each of your own items is shared with.",
  "operationId": "getItemShares",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ItemShareQueryDto"
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
              "$ref": "#/components/schemas/ItemShareResponseDto"
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
  "summary": "List who items are shared with",
  "tags": [
    "Item shares"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.share"
}
```

## getReceivedItemShares

`GET /api/item-shares/received`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/item-share.controller.ts#L74).

Items shared with you

Permission: `asset.read`. Admin only: `false`.

Models: [ItemShareReceivedResponseDto](models-14.md#itemsharereceivedresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ItemShares)
@Controller('item-shares')
@Get('received')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Items shared with you',
    description:
      'Items other people shared with you one by one, newest first. Items that are locked, trashed or no longer shared are left out.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Items other people shared with you one by one, newest first. Items that are locked, trashed or no longer shared are left out.",
  "operationId": "getReceivedItemShares",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ItemShareReceivedResponseDto"
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
  "summary": "Items shared with you",
  "tags": [
    "Item shares"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.read"
}
```
