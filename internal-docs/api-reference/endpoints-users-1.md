# Server API — Users 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchUsers

`GET /api/users`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L85).

Get all users

Permission: `user.read`. Admin only: `false`.

Models: [UserResponseDto](models-37.md#userresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get()
@Authenticated({ permission: Permission.UserRead })
@Endpoint({
    summary: 'Get all users',
    description: 'Retrieve a list of all users on the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all users on the server.",
  "operationId": "searchUsers",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/UserResponseDto"
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
  "summary": "Get all users",
  "tags": [
    "Users"
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
  "x-immich-permission": "user.read",
  "x-immich-state": "Stable"
}
```

## getMyUser

`GET /api/users/me`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L96).

Get current user

Permission: `user.read`. Admin only: `false`.

Models: [UserMeResponseDto](models-37.md#usermeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me')
@Authenticated({ permission: Permission.UserRead })
@Endpoint({
    summary: 'Get current user',
    description:
      'Retrieve information about the user making the API request, with their role on this server (`serverRole`) and whether they may upload here (`canUpload`), so an app can label the server and show backup only where it is allowed. `owner` (the administrator whose Frameleaf account owns this server) and `admin` administer it; `user` has their own library, as does everyone Frameleaf Cloud invited to this server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about the user making the API request, with their role on this server (`serverRole`) and whether they may upload here (`canUpload`), so an app can label the server and show backup only where it is allowed. `owner` (the administrator whose Frameleaf account owns this server) and `admin` administer it; `user` has their own library, as does everyone Frameleaf Cloud invited to this server.",
  "operationId": "getMyUser",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserMeResponseDto"
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
  "summary": "Get current user",
  "tags": [
    "Users"
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
  "x-immich-permission": "user.read",
  "x-immich-state": "Stable"
}
```

## updateMyUser

`PUT /api/users/me`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L119).

Update current user

Permission: `user.update`. Admin only: `false`.

Models: [UserAdminResponseDto](models-36.md#useradminresponsedto), [UserUpdateMeDto](models-37.md#userupdatemedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Put('me')
@Authenticated({ permission: Permission.UserUpdate })
@Endpoint({
    summary: 'Update current user',
    description: 'Update the current user making the API request.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMyUser' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update the current user making the API request.",
  "operationId": "updateMyUser",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UserUpdateMeDto"
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
            "$ref": "#/components/schemas/UserAdminResponseDto"
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
  "summary": "Update current user",
  "tags": [
    "Users",
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
      "replacementId": "updateMyUser"
    }
  ],
  "x-immich-permission": "user.update",
  "x-immich-state": "Deprecated"
}
```

## listBackupDevices

`GET /api/users/me/backup-devices`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L41).

List own backup devices

Permission: `user.read`. Admin only: `false`.

Models: [BackupDeviceListDto](models-06.md#backupdevicelistdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Get()
@Authenticated({ permission: Permission.UserRead })
@Endpoint({ summary: 'List own backup devices', history: new HistoryBuilder().added('v3') })
```

Complete operation contract:

```json
{
  "operationId": "listBackupDevices",
  "parameters": [
    {
      "name": "limit",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "offset",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 1000000,
        "default": 0,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BackupDeviceListDto"
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
  "summary": "List own backup devices",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "user.read"
}
```

## registerBackupDevice

`POST /api/users/me/backup-devices`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L28).

Register or report an own backup device

Permission: `user.update`. Admin only: `false`.

Models: [BackupDeviceDto](models-06.md#backupdevicedto), [BackupDeviceWriteDto](models-06.md#backupdevicewritedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Post()
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.UserUpdate })
@Endpoint({
    summary: 'Register or report an own backup device',
    description:
      'Stable deviceKey scoped to the owner. Success time and pending count are device-reported, never checksum verification. Removing a device preserves assets and reconciliation history.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Stable deviceKey scoped to the owner. Success time and pending count are device-reported, never checksum verification. Removing a device preserves assets and reconciliation history.",
  "operationId": "registerBackupDevice",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BackupDeviceWriteDto"
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
            "$ref": "#/components/schemas/BackupDeviceDto"
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
  "summary": "Register or report an own backup device",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "user.update"
}
```

## removeBackupDevice

`DELETE /api/users/me/backup-devices/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L48).

Remove an own backup device without deleting assets

Permission: `user.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.UserUpdate })
@Endpoint({
    summary: 'Remove an own backup device without deleting assets',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "operationId": "removeBackupDevice",
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
  "summary": "Remove an own backup device without deleting assets",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "user.update"
}
```

## listBackupReconciliations

`GET /api/users/me/backup-devices/{id}/reconciliations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L93).

List own device reconciliation history

Permission: `asset.read`. Admin only: `false`.

Models: [ReconciliationHistoryDto](models-27.md#reconciliationhistorydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Get(':id/reconciliations')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'List own device reconciliation history',
    description:
      'Requires elevated unfiltered session; checkedAt identifies actual inventory snapshot. Includes incomplete runs explicitly; admin metadata access never grants foreign hash access.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Requires elevated unfiltered session; checkedAt identifies actual inventory snapshot. Includes incomplete runs explicitly; admin metadata access never grants foreign hash access.",
  "operationId": "listBackupReconciliations",
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
    },
    {
      "name": "limit",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "offset",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 1000000,
        "default": 0,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReconciliationHistoryDto"
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
  "summary": "List own device reconciliation history",
  "tags": [
    "Users"
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

## startBackupReconciliation

`POST /api/users/me/backup-devices/{id}/reconciliations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L59).

Start own device inventory reconciliation

Permission: `asset.read`. Admin only: `false`.

Models: [ReconciliationResultDto](models-27.md#reconciliationresultdto), [ReconciliationStartDto](models-27.md#reconciliationstartdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Post(':id/reconciliations')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Start own device inventory reconciliation',
    description:
      'Requires a current elevated session and no active hidden-content filter.256 indexed bucket digests of sorted unique raw SHA256 bytes, maximum2000 hashes per bucket. Differing buckets require complete hash lists. Snapshot database inventory excludes offline/last-checked-missing originals; not a fresh filesystem check.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Requires a current elevated session and no active hidden-content filter.256 indexed bucket digests of sorted unique raw SHA256 bytes, maximum2000 hashes per bucket. Differing buckets require complete hash lists. Snapshot database inventory excludes offline/last-checked-missing originals; not a fresh filesystem check.",
  "operationId": "startBackupReconciliation",
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
          "$ref": "#/components/schemas/ReconciliationStartDto"
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
            "$ref": "#/components/schemas/ReconciliationResultDto"
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
  "summary": "Start own device inventory reconciliation",
  "tags": [
    "Users"
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

## reconcileBackupBucket

`POST /api/users/me/backup-devices/{id}/reconciliations/{runId}/buckets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/backup-device.controller.ts#L76).

Reconcile one complete differing bucket

Permission: `asset.read`. Admin only: `false`.

Models: [ReconciliationBucketDto](models-27.md#reconciliationbucketdto), [ReconciliationResultDto](models-27.md#reconciliationresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller('users/me/backup-devices')
@Post(':id/reconciliations/:runId/buckets')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Reconcile one complete differing bucket',
    description:
      'Up to2000 distinct SHA256 hashes matching original count/digest and first-byte bucket. Server extras never count as device missing. Changed server inventory refuses continuation; start a new run. Repeated validated bucket requests do not double-count; a concurrent snapshot conflict returns409 and may be retried. No completed audit until every differing bucket is validated.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to2000 distinct SHA256 hashes matching original count/digest and first-byte bucket. Server extras never count as device missing. Changed server inventory refuses continuation; start a new run. Repeated validated bucket requests do not double-count; a concurrent snapshot conflict returns409 and may be retried. No completed audit until every differing bucket is validated.",
  "operationId": "reconcileBackupBucket",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "runId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ReconciliationBucketDto"
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
            "$ref": "#/components/schemas/ReconciliationResultDto"
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
  "summary": "Reconcile one complete differing bucket",
  "tags": [
    "Users"
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

## getMyCalendarHeatmap

`GET /api/users/me/calendar-heatmap`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L108).

Retrieve calendar heatmap activity

Permission: `user.read`. Admin only: `false`.

Models: [CalendarHeatmapResponseDto](models-07.md#calendarheatmapresponsedto), [CalendarHeatmapType](models-07.md#calendarheatmaptype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/calendar-heatmap')
@Authenticated({ permission: Permission.UserRead })
@Endpoint({
    summary: 'Retrieve calendar heatmap activity',
    description: 'Retrieve activity counts for a specified period, in a calendar heatmap format.',
    history: new HistoryBuilder().added('v3').stable('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve activity counts for a specified period, in a calendar heatmap format.",
  "operationId": "getMyCalendarHeatmap",
  "parameters": [
    {
      "name": "from",
      "required": false,
      "in": "query",
      "description": "Start date in UTC",
      "schema": {
        "format": "date",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
        "example": "2024-01-01",
        "type": "string"
      }
    },
    {
      "name": "to",
      "required": false,
      "in": "query",
      "description": "End date in UTC",
      "schema": {
        "format": "date",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
        "example": "2024-01-01",
        "type": "string"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "default": "Upload",
        "$ref": "#/components/schemas/CalendarHeatmapType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CalendarHeatmapResponseDto"
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
  "summary": "Retrieve calendar heatmap activity",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "user.read",
  "x-immich-state": "Stable"
}
```

## deleteUserLicense

`DELETE /api/users/me/license`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L217).

Remove your supporter key

Permission: `userLicense.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Delete('me/license')
@Authenticated({ permission: Permission.UserLicenseDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove your supporter key',
    description: 'Remove your supporter key from this server. The key stays yours to activate again.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove your supporter key from this server. The key stays yours to activate again.",
  "operationId": "deleteUserLicense",
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
  "summary": "Remove your supporter key",
  "tags": [
    "Users"
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
  "x-immich-permission": "userLicense.delete",
  "x-immich-state": "Stable"
}
```

## getUserLicense

`GET /api/users/me/license`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L192).

Get your supporter key

Permission: `userLicense.read`. Admin only: `false`.

Models: [LicenseResponseDto](models-14.md#licenseresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/license')
@Authenticated({ permission: Permission.UserLicenseRead })
@Endpoint({
    summary: 'Get your supporter key',
    description:
      'Your own Frameleaf supporter key (FL-I…), as its last four symbols and activation date. The key itself is never returned.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Your own Frameleaf supporter key (FL-I…), as its last four symbols and activation date. The key itself is never returned.",
  "operationId": "getUserLicense",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseResponseDto"
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
  "summary": "Get your supporter key",
  "tags": [
    "Users"
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
  "x-immich-permission": "userLicense.read",
  "x-immich-state": "Stable"
}
```

## setUserLicense

`PUT /api/users/me/license`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L204).

Activate your supporter key

Permission: `userLicense.update`. Admin only: `false`.

Models: [LicenseActivateDto](models-14.md#licenseactivatedto), [LicenseResponseDto](models-14.md#licenseresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Put('me/license')
@Authenticated({ permission: Permission.UserLicenseUpdate })
@RateLimited(RATE_LIMITS.licenseActivation)
@Endpoint({
    summary: 'Activate your supporter key',
    description:
      'Activate a personal Frameleaf supporter key (FL-IXXX-XXXX-XXXX) for your account with Frameleaf Cloud. The key travels only in this request body.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Activate a personal Frameleaf supporter key (FL-IXXX-XXXX-XXXX) for your account with Frameleaf Cloud. The key travels only in this request body.",
  "operationId": "setUserLicense",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LicenseActivateDto"
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
            "$ref": "#/components/schemas/LicenseResponseDto"
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
  "summary": "Activate your supporter key",
  "tags": [
    "Users"
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
  "x-immich-permission": "userLicense.update",
  "x-immich-state": "Stable"
}
```

## deleteUserOnboarding

`DELETE /api/users/me/onboarding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L251).

Delete user onboarding

Permission: `userOnboarding.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Delete('me/onboarding')
@Authenticated({ permission: Permission.UserOnboardingDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete user onboarding',
    description: 'Delete the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete the onboarding status of the current user.",
  "operationId": "deleteUserOnboarding",
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
  "summary": "Delete user onboarding",
  "tags": [
    "Users"
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
  "x-immich-permission": "userOnboarding.delete",
  "x-immich-state": "Stable"
}
```

## getUserOnboarding

`GET /api/users/me/onboarding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L229).

Retrieve user onboarding

Permission: `userOnboarding.read`. Admin only: `false`.

Models: [OnboardingResponseDto](models-17.md#onboardingresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/onboarding')
@Authenticated({ permission: Permission.UserOnboardingRead })
@Endpoint({
    summary: 'Retrieve user onboarding',
    description: 'Retrieve the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the onboarding status of the current user.",
  "operationId": "getUserOnboarding",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/OnboardingResponseDto"
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
  "summary": "Retrieve user onboarding",
  "tags": [
    "Users"
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
  "x-immich-permission": "userOnboarding.read",
  "x-immich-state": "Stable"
}
```

## setUserOnboarding

`PUT /api/users/me/onboarding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L240).

Update user onboarding

Permission: `userOnboarding.update`. Admin only: `false`.

Models: [OnboardingDto](models-17.md#onboardingdto), [OnboardingResponseDto](models-17.md#onboardingresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Put('me/onboarding')
@Authenticated({ permission: Permission.UserOnboardingUpdate })
@Endpoint({
    summary: 'Update user onboarding',
    description: 'Update the onboarding status of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update the onboarding status of the current user.",
  "operationId": "setUserOnboarding",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OnboardingDto"
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
            "$ref": "#/components/schemas/OnboardingResponseDto"
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
  "summary": "Update user onboarding",
  "tags": [
    "Users"
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
  "x-immich-permission": "userOnboarding.update",
  "x-immich-state": "Stable"
}
```

## getMyPinnedCollections

`GET /api/users/me/pins`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L52).

Get my pinned collections

Permission: `userPreference.read`. Admin only: `false`.

Models: [PinnedCollectionsResponseDto](models-25.md#pinnedcollectionsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/pins')
@Authenticated({ permission: Permission.UserPreferenceRead })
@Endpoint({
    summary: 'Get my pinned collections',
    description:
      'Complete ordered snapshot of current access-filtered titles, counts and covers. Unavailable pins disclose only their opaque pin ID and kind. Requires a user session.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Complete ordered snapshot of current access-filtered titles, counts and covers. Unavailable pins disclose only their opaque pin ID and kind. Requires a user session.",
  "operationId": "getMyPinnedCollections",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PinnedCollectionsResponseDto"
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
  "summary": "Get my pinned collections",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "userPreference.read"
}
```

## setMyPinnedCollections

`PUT /api/users/me/pins`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L64).

Replace my pinned collections

Permission: `userPreference.update`. Admin only: `false`.

Models: [PinnedCollectionsResponseDto](models-25.md#pinnedcollectionsresponsedto), [PinnedCollectionsUpdateDto](models-25.md#pinnedcollectionsupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Put('me/pins')
@Authenticated({ permission: Permission.UserPreferenceUpdate })
@Endpoint({
    summary: 'Replace my pinned collections',
    description:
      'Add, remove or reorder by replacing the complete ordered list against expectedRevision. Stale writes return 409. Retain unavailable pins using their opaque ID, kind and null targetId. Requires a user session.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Add, remove or reorder by replacing the complete ordered list against expectedRevision. Stale writes return 409. Retain unavailable pins using their opaque ID, kind and null targetId. Requires a user session.",
  "operationId": "setMyPinnedCollections",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PinnedCollectionsUpdateDto"
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
            "$ref": "#/components/schemas/PinnedCollectionsResponseDto"
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
  "summary": "Replace my pinned collections",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "userPreference.update"
}
```

## getMyPreferences

`GET /api/users/me/preferences`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L141).

Get my preferences

Permission: `userPreference.read`. Admin only: `false`.

Models: [UserPreferencesResponseDto](models-37.md#userpreferencesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/preferences')
@Authenticated({ permission: Permission.UserPreferenceRead })
@Endpoint({
    summary: 'Get my preferences',
    description: 'Retrieve the preferences for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the preferences for the current user.",
  "operationId": "getMyPreferences",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserPreferencesResponseDto"
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
  "summary": "Get my preferences",
  "tags": [
    "Users"
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
  "x-immich-permission": "userPreference.read",
  "x-immich-state": "Stable"
}
```

## updateMyPreferences

`PUT /api/users/me/preferences`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L164).

Update my preferences

Permission: `userPreference.update`. Admin only: `false`.

Models: [UserPreferencesResponseDto](models-37.md#userpreferencesresponsedto), [UserPreferencesUpdateDto](models-37.md#userpreferencesupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Put('me/preferences')
@Authenticated({ permission: Permission.UserPreferenceUpdate })
@Endpoint({
    summary: 'Update my preferences',
    description: 'Update the preferences of the current user.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMyPreferences' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update the preferences of the current user.",
  "operationId": "updateMyPreferences",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UserPreferencesUpdateDto"
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
            "$ref": "#/components/schemas/UserPreferencesResponseDto"
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
  "summary": "Update my preferences",
  "tags": [
    "Users",
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
      "replacementId": "updateMyPreferences"
    }
  ],
  "x-immich-permission": "userPreference.update",
  "x-immich-state": "Deprecated"
}
```

## getMyPreferenceHistory

`GET /api/users/me/preferences/history`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L152).

Get my preference history

Permission: `userPreference.read`. Admin only: `false`.

Models: [UserPreferenceHistoryResponseDto](models-37.md#userpreferencehistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get('me/preferences/history')
@Authenticated({ permission: Permission.UserPreferenceRead })
@Endpoint({
    summary: 'Get my preference history',
    description:
      'The newest changes to the current user’s own preferences, with the device that saved each. Locked-content rules appear only as changed.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The newest changes to the current user’s own preferences, with the device that saved each. Locked-content rules appear only as changed.",
  "operationId": "getMyPreferenceHistory",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserPreferenceHistoryResponseDto"
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
  "summary": "Get my preference history",
  "tags": [
    "Users"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "userPreference.read",
  "x-immich-state": "Alpha"
}
```

## deleteProfileImage

`DELETE /api/users/profile-image`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L292).

Delete user profile image

Permission: `userProfileImage.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Delete('profile-image')
@Authenticated({ permission: Permission.UserProfileImageDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete user profile image',
    description: 'Delete the profile image of the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete the profile image of the current user.",
  "operationId": "deleteProfileImage",
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
  "summary": "Delete user profile image",
  "tags": [
    "Users"
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
  "x-immich-permission": "userProfileImage.delete",
  "x-immich-state": "Stable"
}
```

## createProfileImage

`POST /api/users/profile-image`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L274).

Create user profile image

Permission: `userProfileImage.update`. Admin only: `false`.

Models: [CreateProfileImageDto](models-09.md#createprofileimagedto), [CreateProfileImageResponseDto](models-10.md#createprofileimageresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Post('profile-image')
@Authenticated({ permission: Permission.UserProfileImageUpdate })
@UseInterceptors(FileUploadInterceptor)
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A new avatar for the user', type: CreateProfileImageDto })
@Endpoint({
    summary: 'Create user profile image',
    description: 'Upload and set a new profile image for the current user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Upload and set a new profile image for the current user.",
  "operationId": "createProfileImage",
  "parameters": [],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/CreateProfileImageDto"
        }
      }
    },
    "description": "A new avatar for the user",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CreateProfileImageResponseDto"
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
  "summary": "Create user profile image",
  "tags": [
    "Users"
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
  "x-immich-permission": "userProfileImage.update",
  "x-immich-state": "Stable"
}
```

## getUser

`GET /api/users/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L263).

Retrieve a user

Permission: `user.read`. Admin only: `false`.

Models: [UserResponseDto](models-37.md#userresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get(':id')
@Authenticated({ permission: Permission.UserRead })
@Endpoint({
    summary: 'Retrieve a user',
    description: 'Retrieve a specific user by their ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific user by their ID.",
  "operationId": "getUser",
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
            "$ref": "#/components/schemas/UserResponseDto"
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
  "summary": "Retrieve a user",
  "tags": [
    "Users"
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
  "x-immich-permission": "user.read",
  "x-immich-state": "Stable"
}
```
