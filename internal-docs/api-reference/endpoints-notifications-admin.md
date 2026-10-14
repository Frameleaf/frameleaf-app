# Server API — Notifications (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## createNotification

`POST /api/admin/notifications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/notification-admin.controller.ts#L23).

Create a notification

Permission: `See authentication declaration`. Admin only: `true`.

Models: [NotificationCreateDto](models-19.md#notificationcreatedto), [NotificationDto](models-19.md#notificationdto).

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

## disconnectMailAccount

`DELETE /api/admin/notifications/mail-connection`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/mail-connection.controller.ts#L60).

Disconnect the mail account

Permission: `See authentication declaration`. Admin only: `true`.

Models: [MailDisconnectResponseDto](models-16.md#maildisconnectresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications/mail-connection')
@Delete()
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Disconnect the mail account',
    description:
      'Stop sending from the connected account: access is revoked at the provider where the provider allows it, the stored token is deleted and email is switched off until another way of sending is set up.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Stop sending from the connected account: access is revoked at the provider where the provider allows it, the stored token is deleted and email is switched off until another way of sending is set up.",
  "operationId": "disconnectMailAccount",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MailDisconnectResponseDto"
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
  "summary": "Disconnect the mail account",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-state": "Alpha"
}
```

## getMailConnection

`GET /api/admin/notifications/mail-connection`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/mail-connection.controller.ts#L22).

Get the mail account connection

Permission: `See authentication declaration`. Admin only: `true`.

Models: [MailConnectionStateDto](models-16.md#mailconnectionstatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications/mail-connection')
@Get()
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get the mail account connection',
    description:
      'The Gmail or Microsoft account this server sends email from, whether it needs a new sign-in, and which providers can be connected by signing in.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "The Gmail or Microsoft account this server sends email from, whether it needs a new sign-in, and which providers can be connected by signing in.",
  "operationId": "getMailConnection",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MailConnectionStateDto"
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
  "summary": "Get the mail account connection",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-state": "Alpha"
}
```

## completeMailSignIn

`POST /api/admin/notifications/mail-connection/complete`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/mail-connection.controller.ts#L47).

Complete a mail account sign-in

Permission: `See authentication declaration`. Admin only: `true`.

Models: [MailSignInCompleteResponseDto](models-16.md#mailsignincompleteresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications/mail-connection')
@Post('complete')
@Authenticated({ admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Complete a mail account sign-in',
    description:
      'Ask whether the sign-in in progress has finished at the provider, and connect the account when it has. Call it every few seconds while `state` is `pending`.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Ask whether the sign-in in progress has finished at the provider, and connect the account when it has. Call it every few seconds while `state` is `pending`.",
  "operationId": "completeMailSignIn",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MailSignInCompleteResponseDto"
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
  "summary": "Complete a mail account sign-in",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-state": "Alpha"
}
```

## startMailSignIn

`POST /api/admin/notifications/mail-connection/start`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/mail-connection.controller.ts#L34).

Start a mail account sign-in

Permission: `See authentication declaration`. Admin only: `true`.

Models: [MailSignInStartDto](models-16.md#mailsigninstartdto), [MailSignInStartResponseDto](models-16.md#mailsigninstartresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.NotificationsAdmin)
@Controller('admin/notifications/mail-connection')
@Post('start')
@Authenticated({ admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Start a mail account sign-in',
    description:
      "Start connecting a Gmail or Microsoft account. The answer is the provider's sign-in page to open in the browser; the server must be linked to a Frameleaf Cloud account.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Start connecting a Gmail or Microsoft account. The answer is the provider's sign-in page to open in the browser; the server must be linked to a Frameleaf Cloud account.",
  "operationId": "startMailSignIn",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MailSignInStartDto"
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
            "$ref": "#/components/schemas/MailSignInStartResponseDto"
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
  "summary": "Start a mail account sign-in",
  "tags": [
    "Notifications (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-state": "Alpha"
}
```

## getNotificationTemplateAdmin

`POST /api/admin/notifications/templates/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/notification-admin.controller.ts#L46).

Render email template

Permission: `See authentication declaration`. Admin only: `true`.

Models: [TemplateDto](models-38.md#templatedto), [TemplateResponseDto](models-38.md#templateresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/notification-admin.controller.ts#L34).

Send test email

Permission: `See authentication declaration`. Admin only: `true`.

Models: [AdminConfigSmtpDto](models-02.md#adminconfigsmtpdto), [TestEmailResponseDto](models-38.md#testemailresponsedto).

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
