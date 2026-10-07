# Server API — Config (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAdminConfig

`GET /api/admin/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L25).

Get the admin configuration

Permission: `adminConfig.read`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Get()
@Authenticated({ permission: Permission.AdminConfigRead, admin: true })
@Endpoint({
    summary: 'Get the admin configuration',
    description: 'Retrieve admin configuration.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve admin configuration.",
  "operationId": "getAdminConfig",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Get the admin configuration",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.read",
  "x-immich-state": "Alpha"
}
```

## updateAdminConfig

`PUT /api/admin/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L47).

Update the system configuration

Permission: `adminConfig.update`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Put()
@Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
@Endpoint({
    summary: 'Update the system configuration',
    description: 'Update the system configuration with a new system configuration.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Update the system configuration with a new system configuration.",
  "operationId": "updateAdminConfig",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AdminConfigDto"
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
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Update the system configuration",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.update",
  "x-immich-state": "Alpha"
}
```

## getConfigCredentials

`GET /api/admin/config/credentials`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L58).

List the server credentials

Permission: `adminConfig.read`. Admin only: `false`.

Models: [ConfigCredentialResponseDto](models-09.md#configcredentialresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Get('credentials')
@Authenticated({ permission: Permission.AdminConfigRead, admin: true })
@Endpoint({
    summary: 'List the server credentials',
    description: 'Whether each write-only server credential is stored. Credential values are never returned.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether each write-only server credential is stored. Credential values are never returned.",
  "operationId": "getConfigCredentials",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ConfigCredentialResponseDto"
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
  "summary": "List the server credentials",
  "tags": [
    "Config (admin)"
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
  "x-immich-permission": "adminConfig.read",
  "x-immich-state": "Alpha"
}
```

## deleteConfigCredential

`DELETE /api/admin/config/credentials/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L85).

Clear a server credential

Permission: `adminConfig.update`. Admin only: `false`.

Models: [ConfigCredential](models-09.md#configcredential), [ConfigCredentialResponseDto](models-09.md#configcredentialresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Delete('credentials/:name')
@Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
@Endpoint({
    summary: 'Clear a server credential',
    description: 'Remove the stored value of one write-only server credential.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the stored value of one write-only server credential.",
  "operationId": "deleteConfigCredential",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/ConfigCredential"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ConfigCredentialResponseDto"
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
  "summary": "Clear a server credential",
  "tags": [
    "Config (admin)"
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
  "x-immich-permission": "adminConfig.update",
  "x-immich-state": "Alpha"
}
```

## updateConfigCredential

`PUT /api/admin/config/credentials/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L69).

Replace a server credential

Permission: `adminConfig.update`. Admin only: `false`.

Models: [ConfigCredential](models-09.md#configcredential), [ConfigCredentialResponseDto](models-09.md#configcredentialresponsedto), [ConfigCredentialUpdateDto](models-09.md#configcredentialupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Put('credentials/:name')
@Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
@Endpoint({
    summary: 'Replace a server credential',
    description:
      'Store a new value for one write-only server credential. The value is validated like a configuration save and is never returned.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Store a new value for one write-only server credential. The value is validated like a configuration save and is never returned.",
  "operationId": "updateConfigCredential",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/ConfigCredential"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ConfigCredentialUpdateDto"
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
            "$ref": "#/components/schemas/ConfigCredentialResponseDto"
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
  "summary": "Replace a server credential",
  "tags": [
    "Config (admin)"
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
  "x-immich-permission": "adminConfig.update",
  "x-immich-state": "Alpha"
}
```

## getAdminConfigDefaults

`GET /api/admin/config/defaults`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L36).

Get the system configuration defaults

Permission: `adminConfig.read`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Get('defaults')
@Authenticated({ permission: Permission.AdminConfigRead, admin: true })
@Endpoint({
    summary: 'Get the system configuration defaults',
    description: 'Retrieve the default value of every system configuration property.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the default value of every system configuration property.",
  "operationId": "getAdminConfigDefaults",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Get the system configuration defaults",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.read",
  "x-immich-state": "Alpha"
}
```

## getAdminConfigHistory

`GET /api/admin/config/history`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L99).

Get the settings change history

Permission: `adminConfig.read`. Admin only: `false`.

Models: [SystemConfigHistoryResponseDto](models-35.md#systemconfighistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Get('history')
@Authenticated({ permission: Permission.AdminConfigRead, admin: true })
@Endpoint({
    summary: 'Get the settings change history',
    description:
      'The newest saved settings changes, each with its time, the administrator who saved it and the changed settings before and after. Credentials are listed only as replaced or cleared.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The newest saved settings changes, each with its time, the administrator who saved it and the changed settings before and after. Credentials are listed only as replaced or cleared.",
  "operationId": "getAdminConfigHistory",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SystemConfigHistoryResponseDto"
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
  "summary": "Get the settings change history",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.read",
  "x-immich-state": "Alpha"
}
```

## getAdminConfigWithRevision

`GET /api/admin/config/revision`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L111).

Get the admin configuration with its revision

Permission: `adminConfig.read`. Admin only: `false`.

Models: [AdminConfigRevisionResponseDto](models-02.md#adminconfigrevisionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Get('revision')
@Authenticated({ permission: Permission.AdminConfigRead, admin: true })
@Endpoint({
    summary: 'Get the admin configuration with its revision',
    description:
      'Retrieve the admin configuration together with a revision that changes whenever a saved setting changes. Send the revision back when saving so a save made against older settings is refused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the admin configuration together with a revision that changes whenever a saved setting changes. Send the revision back when saving so a save made against older settings is refused.",
  "operationId": "getAdminConfigWithRevision",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminConfigRevisionResponseDto"
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
  "summary": "Get the admin configuration with its revision",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.read",
  "x-immich-state": "Alpha"
}
```

## updateAdminConfigWithRevision

`PUT /api/admin/config/revision`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-admin.controller.ts#L123).

Update the system configuration if it is unchanged

Permission: `adminConfig.update`. Admin only: `false`.

Models: [AdminConfigRevisionResponseDto](models-02.md#adminconfigrevisionresponsedto), [AdminConfigRevisionUpdateDto](models-02.md#adminconfigrevisionupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigAdmin)
@Controller('admin/config')
@Put('revision')
@Authenticated({ permission: Permission.AdminConfigUpdate, admin: true })
@Endpoint({
    summary: 'Update the system configuration if it is unchanged',
    description:
      'Save a complete system configuration only when the saved settings still match the revision it was made against. Returns the saved configuration and its new revision.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
@ApiResponse({ status: 409, description: 'The saved settings changed since the given revision; nothing was saved.' })
```

Complete operation contract:

```json
{
  "description": "Save a complete system configuration only when the saved settings still match the revision it was made against. Returns the saved configuration and its new revision.",
  "operationId": "updateAdminConfigWithRevision",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AdminConfigRevisionUpdateDto"
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
            "$ref": "#/components/schemas/AdminConfigRevisionResponseDto"
          }
        }
      },
      "description": ""
    },
    "409": {
      "description": "The saved settings changed since the given revision; nothing was saved."
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
  "summary": "Update the system configuration if it is unchanged",
  "tags": [
    "Config (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminConfig.update",
  "x-immich-state": "Alpha"
}
```
