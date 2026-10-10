# Server API — Notifications (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## createNotification

`POST /api/admin/notifications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification-admin.controller.ts#L23).

Create a notification

Permission: `See authentication declaration`. Admin only: `true`.

Models: [NotificationCreateDto](models-18.md#notificationcreatedto), [NotificationDto](models-18.md#notificationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications')
@Post()
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Create a notification',
    description: 'Create a new notification for a specific user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new notification for a specific user.",
  "operationId": "createNotification",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/NotificationCreateDto"
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
  "summary": "Create a notification",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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

## getNotificationTemplateAdmin

`POST /api/admin/notifications/templates/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification-admin.controller.ts#L46).

Render email template

Permission: `See authentication declaration`. Admin only: `true`.

Models: [TemplateDto](models-37.md#templatedto), [TemplateResponseDto](models-37.md#templateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications')
@Post('templates/:name')
@Authenticated({ admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Render email template',
    description: 'Retrieve a preview of the provided email template.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a preview of the provided email template.",
  "operationId": "getNotificationTemplateAdmin",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/TemplateDto"
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
            "$ref": "#/components/schemas/TemplateResponseDto"
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
  "summary": "Render email template",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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

## sendTestEmailAdmin

`POST /api/admin/notifications/test-email`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/notification-admin.controller.ts#L34).

Send test email

Permission: `See authentication declaration`. Admin only: `true`.

Models: [AdminConfigSmtpDto](models-02.md#adminconfigsmtpdto), [TestEmailResponseDto](models-37.md#testemailresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications')
@Post('test-email')
@Authenticated({ admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Send test email',
    description: 'Send a test email using the provided SMTP configuration.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Send a test email using the provided SMTP configuration.",
  "operationId": "sendTestEmailAdmin",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AdminConfigSmtpDto"
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
            "$ref": "#/components/schemas/TestEmailResponseDto"
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
  "summary": "Send test email",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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
