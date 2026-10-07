# Server API — System metadata

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAdminOnboarding

`GET /api/system-metadata/admin-onboarding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L24).

Retrieve admin onboarding

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [AdminOnboardingUpdateDto](models-02.md#adminonboardingupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('admin-onboarding')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Retrieve admin onboarding',
    description: 'Retrieve the current admin onboarding status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current admin onboarding status.",
  "operationId": "getAdminOnboarding",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminOnboardingUpdateDto"
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
  "summary": "Retrieve admin onboarding",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Stable"
}
```

## updateAdminOnboarding

`POST /api/system-metadata/admin-onboarding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L35).

Update admin onboarding

Permission: `systemMetadata.update`. Admin only: `true`.

Models: [AdminOnboardingUpdateDto](models-02.md#adminonboardingupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Post('admin-onboarding')
@Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Update admin onboarding',
    description: 'Update the admin onboarding status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Update the admin onboarding status.",
  "operationId": "updateAdminOnboarding",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AdminOnboardingUpdateDto"
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
  "summary": "Update admin onboarding",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.update",
  "x-immich-state": "Stable"
}
```

## getFrameleafSetup

`GET /api/system-metadata/frameleaf-setup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L47).

Retrieve Frameleaf setup

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [FrameleafSetupResponseDto](models-12.md#frameleafsetupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('frameleaf-setup')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Retrieve Frameleaf setup',
    description: 'Retrieve whether Frameleaf first-run setup is complete, its flow and the saved progress.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve whether Frameleaf first-run setup is complete, its flow and the saved progress.",
  "operationId": "getFrameleafSetup",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupResponseDto"
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
  "summary": "Retrieve Frameleaf setup",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Alpha"
}
```

## updateFrameleafSetup

`PUT /api/system-metadata/frameleaf-setup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L58).

Save Frameleaf setup progress

Permission: `systemMetadata.update`. Admin only: `true`.

Models: [FrameleafSetupResponseDto](models-12.md#frameleafsetupresponsedto), [FrameleafSetupUpdateDto](models-12.md#frameleafsetupupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Put('frameleaf-setup')
@Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
@Endpoint({
    summary: 'Save Frameleaf setup progress',
    description: 'Save the per-step first-run setup progress. Passwords are never accepted.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Save the per-step first-run setup progress. Passwords are never accepted.",
  "operationId": "updateFrameleafSetup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafSetupUpdateDto"
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
            "$ref": "#/components/schemas/FrameleafSetupResponseDto"
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
  "summary": "Save Frameleaf setup progress",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.update",
  "x-immich-state": "Alpha"
}
```

## finishFrameleafSetup

`POST /api/system-metadata/frameleaf-setup/finish`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L69).

Finish Frameleaf setup

Permission: `systemMetadata.update`. Admin only: `true`.

Models: [FrameleafSetupResponseDto](models-12.md#frameleafsetupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Post('frameleaf-setup/finish')
@Authenticated({ permission: Permission.SystemMetadataUpdate, admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Finish Frameleaf setup',
    description: 'Finish first-run setup after checking that an admin exists and the library location is writable.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Finish first-run setup after checking that an admin exists and the library location is writable.",
  "operationId": "finishFrameleafSetup",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupResponseDto"
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
  "summary": "Finish Frameleaf setup",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.update",
  "x-immich-state": "Alpha"
}
```

## getFrameleafSetupLibrary

`GET /api/system-metadata/frameleaf-setup/library`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L81).

Retrieve library totals for setup

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [FrameleafSetupLibraryResponseDto](models-12.md#frameleafsetuplibraryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('frameleaf-setup/library')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Retrieve library totals for setup',
    description: 'Retrieve the items, people, albums and size of the library for first-run setup.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the items, people, albums and size of the library for first-run setup.",
  "operationId": "getFrameleafSetupLibrary",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupLibraryResponseDto"
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
  "summary": "Retrieve library totals for setup",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Alpha"
}
```

## getFrameleafSetupStorage

`GET /api/system-metadata/frameleaf-setup/storage`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L92).

Check library storage for setup

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [FrameleafSetupStorageResponseDto](models-12.md#frameleafsetupstorageresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('frameleaf-setup/storage')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Check library storage for setup',
    description: 'Check that the library location is writable and report its free space.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Check that the library location is writable and report its free space.",
  "operationId": "getFrameleafSetupStorage",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupStorageResponseDto"
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
  "summary": "Check library storage for setup",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Alpha"
}
```

## getReverseGeocodingState

`GET /api/system-metadata/reverse-geocoding-state`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L103).

Retrieve reverse geocoding state

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [ReverseGeocodingStateResponseDto](models-29.md#reversegeocodingstateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('reverse-geocoding-state')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Retrieve reverse geocoding state',
    description: 'Retrieve the current state of the reverse geocoding import.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current state of the reverse geocoding import.",
  "operationId": "getReverseGeocodingState",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReverseGeocodingStateResponseDto"
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
  "summary": "Retrieve reverse geocoding state",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Stable"
}
```

## getVersionCheckState

`GET /api/system-metadata/version-check-state`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/system-metadata.controller.ts#L114).

Retrieve version check state

Permission: `systemMetadata.read`. Admin only: `true`.

Models: [VersionCheckStateResponseDto](models-38.md#versioncheckstateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemMetadata)
@Controller('system-metadata')
@Get('version-check-state')
@Authenticated({ permission: Permission.SystemMetadataRead, admin: true })
@Endpoint({
    summary: 'Retrieve version check state',
    description: 'Retrieve the current state of the version check process.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current state of the version check process.",
  "operationId": "getVersionCheckState",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/VersionCheckStateResponseDto"
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
  "summary": "Retrieve version check state",
  "tags": [
    "System metadata"
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
  "x-immich-permission": "systemMetadata.read",
  "x-immich-state": "Stable"
}
```
