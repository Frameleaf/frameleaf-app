# Server API — Push

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## listPushDevices

`GET /api/push/devices`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L40).

List own push devices

Permission: `session.read`. Admin only: `false`.

Models: [PushDeviceListResponseDto](models-26.md#pushdevicelistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Get('devices')
@Authenticated({ permission: Permission.SessionRead })
@Endpoint({
    summary: 'List own push devices',
    description: 'The devices registered for push on this account. Push tokens are never returned.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The devices registered for push on this account. Push tokens are never returned.",
  "operationId": "listPushDevices",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PushDeviceListResponseDto"
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
  "summary": "List own push devices",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.read"
}
```

## unregisterPushDevice

`DELETE /api/push/devices/current`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L75).

Unregister this device from push

Permission: `session.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Delete('devices/current')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.SessionDelete })
@Endpoint({
    summary: 'Unregister this device from push',
    description: 'Removes the calling session’s push registration and its Live Activity tokens.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the calling session’s push registration and its Live Activity tokens.",
  "operationId": "unregisterPushDevice",
  "parameters": [],
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
  "summary": "Unregister this device from push",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.delete"
}
```

## updatePushDevice

`PATCH /api/push/devices/current`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L63).

Update this device’s push registration

Permission: `session.update`. Admin only: `false`.

Models: [PushDeviceResponseDto](models-26.md#pushdeviceresponsedto), [PushDeviceUpdateDto](models-26.md#pushdeviceupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Patch('devices/current')
@Authenticated({ permission: Permission.SessionUpdate })
@Endpoint({
    summary: 'Update this device’s push registration',
    description:
      'Changes a rotated token, the key, the linked backup device or preferences; omitted fields stay. Payloads follow frameleaf-push-v1 (docs/developer/push-envelope-v1).',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Changes a rotated token, the key, the linked backup device or preferences; omitted fields stay. Payloads follow frameleaf-push-v1 (docs/developer/push-envelope-v1).",
  "operationId": "updatePushDevice",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PushDeviceUpdateDto"
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
            "$ref": "#/components/schemas/PushDeviceResponseDto"
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
  "summary": "Update this device’s push registration",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.update"
}
```

## registerPushDevice

`PUT /api/push/devices/current`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L51).

Register this device for push

Permission: `session.update`. Admin only: `false`.

Models: [PushDeviceRegisterDto](models-26.md#pushdeviceregisterdto), [PushDeviceResponseDto](models-26.md#pushdeviceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Put('devices/current')
@Authenticated({ permission: Permission.SessionUpdate })
@Endpoint({
    summary: 'Register this device for push',
    description:
      "Registers or replaces the push registration of the calling session: platform, APNs or FCM token, the ActivityKit push-to-start token (iOS), the device's X25519 public key and notification preferences. Registering again rotates the tokens and key. Every payload is encrypted to the key (frameleaf-push-v1, specified in docs/developer/push-envelope-v1: envelope layout, key agreement, plaintext and test vectors); the Frameleaf push gateway receives only the target and the encrypted blob. Needs a signed-in device session (not an API key).",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Registers or replaces the push registration of the calling session: platform, APNs or FCM token, the ActivityKit push-to-start token (iOS), the device's X25519 public key and notification preferences. Registering again rotates the tokens and key. Every payload is encrypted to the key (frameleaf-push-v1, specified in docs/developer/push-envelope-v1: envelope layout, key agreement, plaintext and test vectors); the Frameleaf push gateway receives only the target and the encrypted blob. Needs a signed-in device session (not an API key).",
  "operationId": "registerPushDevice",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PushDeviceRegisterDto"
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
            "$ref": "#/components/schemas/PushDeviceResponseDto"
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
  "summary": "Register this device for push",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.update"
}
```

## removePushActivityToken

`DELETE /api/push/devices/current/activities/{activityId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L114).

Remove a Live Activity push token

Permission: `session.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Delete('devices/current/activities/:activityId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.SessionUpdate })
@Endpoint({
    summary: 'Remove a Live Activity push token',
    description: 'The activity ended on the device.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The activity ended on the device.",
  "operationId": "removePushActivityToken",
  "parameters": [
    {
      "name": "activityId",
      "required": true,
      "in": "path",
      "description": "The Live Activity id on the device (ActivityKit `Activity.id`)",
      "schema": {
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[\\w.-]+$",
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
  "summary": "Remove a Live Activity push token",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.update"
}
```

## setPushActivityToken

`PUT /api/push/devices/current/activities/{activityId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L98).

Set a Live Activity push token

Permission: `session.update`. Admin only: `false`.

Models: [PushActivityTokenDto](models-26.md#pushactivitytokendto), [PushDeviceResponseDto](models-26.md#pushdeviceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Put('devices/current/activities/:activityId')
@Authenticated({ permission: Permission.SessionUpdate })
@Endpoint({
    summary: 'Set a Live Activity push token',
    description:
      'iOS only: the ActivityKit update token of one Live Activity (the Cloud Backup activation), replaced when ActivityKit rotates it.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "iOS only: the ActivityKit update token of one Live Activity (the Cloud Backup activation), replaced when ActivityKit rotates it.",
  "operationId": "setPushActivityToken",
  "parameters": [
    {
      "name": "activityId",
      "required": true,
      "in": "path",
      "description": "The Live Activity id on the device (ActivityKit `Activity.id`)",
      "schema": {
        "minLength": 1,
        "maxLength": 128,
        "pattern": "^[\\w.-]+$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PushActivityTokenDto"
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
            "$ref": "#/components/schemas/PushDeviceResponseDto"
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
  "summary": "Set a Live Activity push token",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.update"
}
```

## removePushDevice

`DELETE /api/push/devices/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L87).

Remove an own push device

Permission: `session.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Delete('devices/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.SessionDelete })
@Endpoint({
    summary: 'Remove an own push device',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "operationId": "removePushDevice",
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
  "summary": "Remove an own push device",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.delete"
}
```

## getPushStatus

`GET /api/push/status`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/push.controller.ts#L28).

Push availability

Permission: `session.read`. Admin only: `false`.

Models: [PushStatusResponseDto](models-26.md#pushstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Push)
@Controller('push')
@Get('status')
@Authenticated({ permission: Permission.SessionRead })
@Endpoint({
    summary: 'Push availability',
    description:
      'Whether this server delivers push notifications. Push needs a server linked to Frameleaf Cloud; an unlinked server answers available: false with the reason, so the app can say so. Also names the payload encryption and the events, and whether the calling session registered its device.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether this server delivers push notifications. Push needs a server linked to Frameleaf Cloud; an unlinked server answers available: false with the reason, so the app can say so. Also names the payload encryption and the events, and whether the calling session registered its device.",
  "operationId": "getPushStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PushStatusResponseDto"
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
  "summary": "Push availability",
  "tags": [
    "Push"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "session.read"
}
```
