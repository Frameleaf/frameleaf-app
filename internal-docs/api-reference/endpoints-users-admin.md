# Server API — Users (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## listAllBackupDevices

`GET /api/admin/backup-devices`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/backup-device.controller.ts#L114).

List backup device metadata across users

Permission: `adminUser.read`. Admin only: `true`.

Models: [BackupDeviceListDto](models-06.md#backupdevicelistdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/backup-devices')
@Get()
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'List backup device metadata across users',
    description:
      'Administrative metadata only. No reconciliation digests or foreign asset access. quietForDays is elapsed whole days since reported successful backup, null when never reported.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Administrative metadata only. No reconciliation digests or foreign asset access. quietForDays is elapsed whole days since reported successful backup, null when never reported.",
  "operationId": "listAllBackupDevices",
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
  "summary": "List backup device metadata across users",
  "tags": [
    "Users (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "adminUser.read"
}
```

## searchUsersAdmin

`GET /api/admin/users`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L30).

Search users

Permission: `adminUser.read`. Admin only: `true`.

Models: [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get()
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Search users',
    description: 'Search for users.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Search for users.",
  "operationId": "searchUsersAdmin",
  "parameters": [
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "User ID filter",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "withDeleted",
      "required": false,
      "in": "query",
      "description": "Include deleted users",
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
              "$ref": "#/components/schemas/UserAdminResponseDto"
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
  "summary": "Search users",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```

## createUserAdmin

`POST /api/admin/users`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L41).

Create a user

Permission: `adminUser.create`. Admin only: `true`.

Models: [UserAdminCreateDto](models-37.md#useradmincreatedto), [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Post()
@Authenticated({ permission: Permission.AdminUserCreate, admin: true })
@Endpoint({
    summary: 'Create a user',
    description: 'Create a new user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new user.",
  "operationId": "createUserAdmin",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/UserAdminCreateDto"
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
  "summary": "Create a user",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.create",
  "x-immich-state": "Stable"
}
```

## deleteUserAdmin

`DELETE /api/admin/users/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L93).

Delete a user

Permission: `adminUser.delete`. Admin only: `true`.

Models: [UserAdminDeleteDto](models-37.md#useradmindeletedto), [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Delete(':id')
@Authenticated({ permission: Permission.AdminUserDelete, admin: true })
@Endpoint({
    summary: 'Delete a user',
    description: 'Delete a user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a user.",
  "operationId": "deleteUserAdmin",
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
          "$ref": "#/components/schemas/UserAdminDeleteDto"
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
  "summary": "Delete a user",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.delete",
  "x-immich-state": "Stable"
}
```

## getUserAdmin

`GET /api/admin/users/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L52).

Retrieve a user

Permission: `adminUser.read`. Admin only: `true`.

Models: [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Retrieve a user',
    description: 'Retrieve  a specific user by their ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve  a specific user by their ID.",
  "operationId": "getUserAdmin",
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
  "summary": "Retrieve a user",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```

## updateUserAdmin

`PUT /api/admin/users/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L63).

Update a user

Permission: `adminUser.update`. Admin only: `true`.

Models: [UserAdminResponseDto](models-37.md#useradminresponsedto), [UserAdminUpdateDto](models-37.md#useradminupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Put(':id')
@Authenticated({ permission: Permission.AdminUserUpdate, admin: true })
@Endpoint({
    summary: 'Update a user',
    description: 'Update an existing user.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateUserAdmin' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an existing user.",
  "operationId": "updateUserAdmin",
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
          "$ref": "#/components/schemas/UserAdminUpdateDto"
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
  "summary": "Update a user",
  "tags": [
    "Users (admin)",
    "Deprecated"
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
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateUserAdmin"
    }
  ],
  "x-immich-permission": "adminUser.update",
  "x-immich-state": "Deprecated"
}
```

## getUserCalendarHeatmapAdmin

`GET /api/admin/users/{id}/calendar-heatmap`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L108).

Retrieve calendar heatmap activity

Permission: `adminUser.read`. Admin only: `true`.

Models: [CalendarHeatmapResponseDto](models-07.md#calendarheatmapresponsedto), [CalendarHeatmapType](models-07.md#calendarheatmaptype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/calendar-heatmap')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
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
  "operationId": "getUserCalendarHeatmapAdmin",
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
    "Users (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```

## getUserHistoryAdmin

`GET /api/admin/users/{id}/history`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L127).

FL-76: the account detail's Activity tab. What administrators did to this account and its
libraries, newest first, recorded by the services that made each change.

Permission: `adminUser.read`. Admin only: `true`.

Models: [UserAdminHistoryResponseDto](models-37.md#useradminhistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/history')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Retrieve user history',
    description:
      'What administrators did to a specific user and their libraries, newest first: account creation, profile, role, quota and storage label changes, password and PIN resets, signed-out devices, preference changes, deletion and restore, and library changes and scans. Page with `before` and `take`.',
    history: new HistoryBuilder().added('v3').stable('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "What administrators did to a specific user and their libraries, newest first: account creation, profile, role, quota and storage label changes, password and PIN resets, signed-out devices, preference changes, deletion and restore, and library changes and scans. Page with `before` and `take`.",
  "operationId": "getUserHistoryAdmin",
  "parameters": [
    {
      "name": "before",
      "required": false,
      "in": "query",
      "description": "Only events older than this event, for paging",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "description": "Page size, 50 by default",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserAdminHistoryResponseDto"
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
  "summary": "FL-76: the account detail's Activity tab. What administrators did to this account and its\nlibraries, newest first, recorded by the services that made each change.",
  "tags": [
    "Users (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```

## getUserPinCodeStateAdmin

`GET /api/admin/users/{id}/pin-code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L171).

Retrieve whether a user has a PIN

Permission: `adminUser.read`. Admin only: `true`.

Models: [UserAdminPinCodeStateResponseDto](models-37.md#useradminpincodestateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/pin-code')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Retrieve whether a user has a PIN',
    description: 'Retrieve whether a specific user has a PIN code set, never the PIN itself.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve whether a specific user has a PIN code set, never the PIN itself.",
  "operationId": "getUserPinCodeStateAdmin",
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
            "$ref": "#/components/schemas/UserAdminPinCodeStateResponseDto"
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
  "summary": "Retrieve whether a user has a PIN",
  "tags": [
    "Users (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Alpha"
}
```

## getUserPreferencesAdmin

`GET /api/admin/users/{id}/preferences`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L200).

Retrieve user preferences

Permission: `adminUser.read`. Admin only: `true`.

Models: [UserPreferencesResponseDto](models-38.md#userpreferencesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/preferences')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Retrieve user preferences',
    description: 'Retrieve the preferences of a specific user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the preferences of a specific user.",
  "operationId": "getUserPreferencesAdmin",
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
  "summary": "Retrieve user preferences",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```

## updateUserPreferencesAdmin

`PUT /api/admin/users/{id}/preferences`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L211).

Update user preferences

Permission: `adminUser.update`. Admin only: `true`.

Models: [UserPreferencesResponseDto](models-38.md#userpreferencesresponsedto), [UserPreferencesUpdateDto](models-38.md#userpreferencesupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Put(':id/preferences')
@Authenticated({ permission: Permission.AdminUserUpdate, admin: true })
@Endpoint({
    summary: 'Update user preferences',
    description: 'Update the preferences of a specific user.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateUserPreferencesAdmin' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update the preferences of a specific user.",
  "operationId": "updateUserPreferencesAdmin",
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
  "summary": "Update user preferences",
  "tags": [
    "Users (admin)",
    "Deprecated"
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
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateUserPreferencesAdmin"
    }
  ],
  "x-immich-permission": "adminUser.update",
  "x-immich-state": "Deprecated"
}
```

## restoreUserAdmin

`POST /api/admin/users/{id}/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L241).

Restore a deleted user

Permission: `adminUser.delete`. Admin only: `true`.

Models: [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Post(':id/restore')
@Authenticated({ permission: Permission.AdminUserDelete, admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Restore a deleted user',
    description: 'Restore a previously deleted user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Restore a previously deleted user.",
  "operationId": "restoreUserAdmin",
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
  "summary": "Restore a deleted user",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.delete",
  "x-immich-state": "Stable"
}
```

## getUserSessionsAdmin

`GET /api/admin/users/{id}/sessions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L143).

Retrieve user sessions

Permission: `adminSession.read`. Admin only: `true`.

Models: [SessionResponseDto](models-31.md#sessionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/sessions')
@Authenticated({ permission: Permission.AdminSessionRead, admin: true })
@Endpoint({
    summary: 'Retrieve user sessions',
    description: 'Retrieve all sessions for a specific user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all sessions for a specific user.",
  "operationId": "getUserSessionsAdmin",
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
            "items": {
              "$ref": "#/components/schemas/SessionResponseDto"
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
  "summary": "Retrieve user sessions",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminSession.read",
  "x-immich-state": "Stable"
}
```

## deleteUserSessionAdmin

`DELETE /api/admin/users/{id}/sessions/{sessionId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L159).

FL-76: `SessionService.delete` only checks `Permission.AuthDeviceDelete` over the caller's
own sessions, so an administrator could never revoke a foreign session through it. This is
the explicit, audited admin path the account detail's Security tab needs instead.

Permission: `adminSession.delete`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Delete(':id/sessions/:sessionId')
@Authenticated({ permission: Permission.AdminSessionDelete, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a user session',
    description: 'Delete a specific session for a specific user, signing that device out.',
    history: new HistoryBuilder().added('v3').stable('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific session for a specific user, signing that device out.",
  "operationId": "deleteUserSessionAdmin",
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
      "name": "sessionId",
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
  "summary": "FL-76: `SessionService.delete` only checks `Permission.AuthDeviceDelete` over the caller's\nown sessions, so an administrator could never revoke a foreign session through it. This is\nthe explicit, audited admin path the account detail's Security tab needs instead.",
  "tags": [
    "Users (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminSession.delete",
  "x-immich-state": "Stable"
}
```

## getUserStatisticsAdmin

`GET /api/admin/users/{id}/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/user-admin.controller.ts#L185).

Retrieve user statistics

Permission: `adminUser.read`. Admin only: `true`.

Models: [AssetStatsResponseDto](models-06.md#assetstatsresponsedto), [AssetVisibility](models-06.md#assetvisibility).

Controller access declarations:

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Get(':id/statistics')
@Authenticated({ permission: Permission.AdminUserRead, admin: true })
@Endpoint({
    summary: 'Retrieve user statistics',
    description: 'Retrieve asset statistics for a specific user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve asset statistics for a specific user.",
  "operationId": "getUserStatisticsAdmin",
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
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AssetStatsResponseDto"
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
  "summary": "Retrieve user statistics",
  "tags": [
    "Users (admin)"
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
  "x-immich-permission": "adminUser.read",
  "x-immich-state": "Stable"
}
```
