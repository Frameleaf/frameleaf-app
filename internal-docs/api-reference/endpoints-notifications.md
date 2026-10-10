# Server API — Notifications

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteNotifications

`DELETE /api/notifications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L45).

Delete notifications

Permission: `notification.delete`. Admin only: `false`.

Models: [NotificationDeleteAllDto](models-18.md#notificationdeletealldto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Delete()
@Authenticated({ permission: Permission.NotificationDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete notifications',
    description: 'Delete a list of notifications at once.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a list of notifications at once.",
  "operationId": "deleteNotifications",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/NotificationDeleteAllDto"
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
  "summary": "Delete notifications",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.delete",
  "x-immich-state": "Stable"
}
```

## getNotifications

`GET /api/notifications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L22).

Retrieve notifications

Permission: `notification.read`. Admin only: `false`.

Models: [NotificationDto](models-19.md#notificationdto), [NotificationLevel](models-19.md#notificationlevel), [NotificationType](models-19.md#notificationtype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Get()
@Authenticated({ permission: Permission.NotificationRead })
@Endpoint({
    summary: 'Retrieve notifications',
    description: 'Retrieve a list of notifications.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of notifications.",
  "operationId": "getNotifications",
  "parameters": [
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Filter by notification ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "level",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/NotificationLevel"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/NotificationType"
      }
    },
    {
      "name": "unread",
      "required": false,
      "in": "query",
      "description": "Filter by unread status",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/NotificationDto"
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
  "summary": "Retrieve notifications",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.read",
  "x-immich-state": "Stable"
}
```

## updateNotifications

`PUT /api/notifications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L33).

Update notifications

Permission: `notification.update`. Admin only: `false`.

Models: [NotificationUpdateAllDto](models-19.md#notificationupdatealldto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Put()
@Authenticated({ permission: Permission.NotificationUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Update notifications',
    description: 'Update a list of notifications. Allows to bulk-set the read status of notifications.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update a list of notifications. Allows to bulk-set the read status of notifications.",
  "operationId": "updateNotifications",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/NotificationUpdateAllDto"
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
  "summary": "Update notifications",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.update",
  "x-immich-state": "Stable"
}
```

## deleteNotification

`DELETE /api/notifications/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L83).

Delete a notification

Permission: `notification.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Delete(':id')
@Authenticated({ permission: Permission.NotificationDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a notification',
    description: 'Delete a specific notification.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific notification.",
  "operationId": "deleteNotification",
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
  "summary": "Delete a notification",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.delete",
  "x-immich-state": "Stable"
}
```

## getNotification

`GET /api/notifications/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L57).

Get a notification

Permission: `notification.read`. Admin only: `false`.

Models: [NotificationDto](models-19.md#notificationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Get(':id')
@Authenticated({ permission: Permission.NotificationRead })
@Endpoint({
    summary: 'Get a notification',
    description: 'Retrieve a specific notification identified by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific notification identified by id.",
  "operationId": "getNotification",
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
            "$ref": "#/components/schemas/NotificationDto"
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
  "summary": "Get a notification",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.read",
  "x-immich-state": "Stable"
}
```

## updateNotification

`PUT /api/notifications/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification.controller.ts#L68).

Update a notification

Permission: `notification.update`. Admin only: `false`.

Models: [NotificationDto](models-19.md#notificationdto), [NotificationUpdateDto](models-19.md#notificationupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Notifications)
@Controller('notifications')
@Put(':id')
@Authenticated({ permission: Permission.NotificationUpdate })
@Endpoint({
    summary: 'Update a notification',
    description: 'Update a specific notification to set its read status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update a specific notification to set its read status.",
  "operationId": "updateNotification",
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
          "$ref": "#/components/schemas/NotificationUpdateDto"
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
            "$ref": "#/components/schemas/NotificationDto"
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
  "summary": "Update a notification",
  "tags": [
    "Notifications"
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
  "x-immich-permission": "notification.update",
  "x-immich-state": "Stable"
}
```
