# Server API — Server

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAboutInfo

`GET /api/server/about`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L37).

Get server information

Permission: `server.about`. Admin only: `false`.

Models: [ServerAboutResponseDto](models-29.md#serveraboutresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('about')
@Authenticated({ permission: Permission.ServerAbout })
@Endpoint({
    summary: 'Get server information',
    description: 'Retrieve a list of information about the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of information about the server.",
  "operationId": "getAboutInfo",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerAboutResponseDto"
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
  "summary": "Get server information",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.about",
  "x-immich-state": "Stable"
}
```

## getApkLinks

`GET /api/server/apk-links`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L48).

Get APK links

Permission: `server.apkLinks`. Admin only: `false`.

Models: [ServerApkLinksDto](models-29.md#serverapklinksdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('apk-links')
@Authenticated({ permission: Permission.ServerApkLinks })
@ApiNotFoundResponse({ description: 'No signed Android release is configured for this server' })
@Endpoint({
    summary: 'Get APK links',
    description:
      'Retrieve links to the signed APKs for the current server version, from the release destination configured for this server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve links to the signed APKs for the current server version, from the release destination configured for this server.",
  "operationId": "getApkLinks",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerApkLinksDto"
          }
        }
      },
      "description": ""
    },
    "404": {
      "description": "No signed Android release is configured for this server"
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
  "summary": "Get APK links",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.apkLinks",
  "x-immich-state": "Stable"
}
```

## getAppReleases

`GET /api/server/app-releases`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L61).

Get app releases

Permission: `server.about`. Admin only: `false`.

Models: [ServerAppReleasesResponseDto](models-30.md#serverappreleasesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('app-releases')
@Authenticated({ permission: Permission.ServerAbout })
@Endpoint({
    summary: 'Get app releases',
    description:
      'Retrieve the signed release destinations of the mobile apps for this server, or that none is configured.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the signed release destinations of the mobile apps for this server, or that none is configured.",
  "operationId": "getAppReleases",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerAppReleasesResponseDto"
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
  "summary": "Get app releases",
  "tags": [
    "Server"
  ],
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
  "x-immich-permission": "server.about",
  "x-immich-state": "Alpha"
}
```

## getServerConfig

`GET /api/server/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L144).

Get config

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerConfigDto](models-30.md#serverconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('config')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get config',
    description: 'Retrieve the current server configuration.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getPublicConfig' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Retrieve the current server configuration.",
  "operationId": "getServerConfig",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerConfigDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get config",
  "tags": [
    "Server",
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
      "version": "v3.2.0",
      "state": "Deprecated",
      "replacementId": "getPublicConfig"
    }
  ],
  "x-immich-state": "Deprecated"
}
```

## getServerConnections

`GET /api/server/connections`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L84).

Get connections

Permission: `server.about`. Admin only: `false`.

Models: [RemoteConnectionsResponseDto](models-27.md#remoteconnectionsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('connections')
@Authenticated({ permission: Permission.ServerAbout })
@Endpoint({
    summary: 'Get connections',
    description:
      'The ways to reach this server through Frameleaf Cloud remote access, in the order apps should try them (local, wan, ipv6, custom hostname, relay), and the address it publishes. Empty unless remote access is on.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The ways to reach this server through Frameleaf Cloud remote access, in the order apps should try them (local, wan, ipv6, custom hostname, relay), and the address it publishes. Empty unless remote access is on.",
  "operationId": "getServerConnections",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteConnectionsResponseDto"
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
  "summary": "Get connections",
  "tags": [
    "Server"
  ],
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
  "x-immich-permission": "server.about",
  "x-immich-state": "Alpha"
}
```

## getServerFeatures

`GET /api/server/features`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L129).

Get features

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerFeaturesDto](models-30.md#serverfeaturesdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('features')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get features',
    description: 'Retrieve available features supported by this server.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getPublicConfig' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Retrieve available features supported by this server.",
  "operationId": "getServerFeatures",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerFeaturesDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get features",
  "tags": [
    "Server",
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
      "version": "v3.2.0",
      "state": "Deprecated",
      "replacementId": "getPublicConfig"
    }
  ],
  "x-immich-state": "Deprecated"
}
```

## getLibrarySetupStatus

`GET /api/server/library-setup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L66).

Library preparation for this authenticated device

Permission: `sync.stream`. Admin only: `false`.

Models: [LibrarySetupStatusDto](models-14.md#librarysetupstatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Get()
@Authenticated({ permission: Permission.SyncStream })
@Endpoint({
    operationId: 'getLibrarySetupStatus',
    summary: 'Library preparation for this authenticated device',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "getLibrarySetupStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LibrarySetupStatusDto"
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
  "summary": "Library preparation for this authenticated device",
  "tags": [
    "Server"
  ],
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
  "x-immich-permission": "sync.stream",
  "x-immich-state": "Alpha"
}
```

## beginLibrarySetup

`POST /api/server/library-setup/begin`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L77).

Start the managed library rescan

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LibrarySetupStatusDto](models-14.md#librarysetupstatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Post('begin')
@Authenticated({ admin: true })
@Endpoint({ operationId: 'beginLibrarySetup', summary: 'Start the managed library rescan', history })
```

Complete operation contract:

```json
{
  "operationId": "beginLibrarySetup",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LibrarySetupStatusDto"
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
  "summary": "Start the managed library rescan",
  "tags": [
    "Server"
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
  "x-immich-state": "Alpha"
}
```

## finishLibrarySetup

`POST /api/server/library-setup/finish`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L157).

Finish after catalog and browsing previews are cached

Permission: `sync.stream`. Admin only: `false`.

Models: [FinishLibrarySetupDto](models-11.md#finishlibrarysetupdto), [LibrarySetupStatusDto](models-14.md#librarysetupstatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Post('finish')
@Authenticated({ permission: Permission.SyncStream })
@Endpoint({
    operationId: 'finishLibrarySetup',
    summary: 'Finish after catalog and browsing previews are cached',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "finishLibrarySetup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FinishLibrarySetupDto"
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
            "$ref": "#/components/schemas/LibrarySetupStatusDto"
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
  "summary": "Finish after catalog and browsing previews are cached",
  "tags": [
    "Server"
  ],
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
  "x-immich-permission": "sync.stream",
  "x-immich-state": "Alpha"
}
```

## getManagerLibrarySetup

`GET /api/server/library-setup/manager`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L85).

Manager machine-authenticated setup status

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LibrarySetupStatusDto](models-14.md#librarysetupstatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Get('manager')
@Authenticated({ public: true })
@Endpoint({ operationId: 'getManagerLibrarySetup', summary: 'Manager machine-authenticated setup status', history })
```

Complete operation contract:

```json
{
  "operationId": "getManagerLibrarySetup",
  "parameters": [
    {
      "name": "x-frameleaf-manager",
      "required": true,
      "in": "header",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LibrarySetupStatusDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Manager machine-authenticated setup status",
  "tags": [
    "Server"
  ],
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
  "x-immich-state": "Alpha"
}
```

## beginManagerLibrarySetup

`POST /api/server/library-setup/manager`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L93).

Manager machine-authenticated rescan

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LibrarySetupStatusDto](models-14.md#librarysetupstatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Post('manager')
@Authenticated({ public: true })
@Endpoint({ operationId: 'beginManagerLibrarySetup', summary: 'Manager machine-authenticated rescan', history })
```

Complete operation contract:

```json
{
  "operationId": "beginManagerLibrarySetup",
  "parameters": [
    {
      "name": "x-frameleaf-manager",
      "required": true,
      "in": "header",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LibrarySetupStatusDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Manager machine-authenticated rescan",
  "tags": [
    "Server"
  ],
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
  "x-immich-state": "Alpha"
}
```

## syncLibrarySetup

`POST /api/server/library-setup/sync`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-library-setup.controller.ts#L102).

Warm the authenticated device catalog during setup

Permission: `sync.stream`. Admin only: `false`.

Models: [WarmLibrarySetupDto](models-37.md#warmlibrarysetupdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/library-setup')
@Post('sync')
@Authenticated({ permission: Permission.SyncStream })
@Endpoint({ operationId: 'syncLibrarySetup', summary: 'Warm the authenticated device catalog during setup', history })
```

Complete operation contract:

```json
{
  "operationId": "syncLibrarySetup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/WarmLibrarySetupDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
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
  "summary": "Warm the authenticated device catalog during setup",
  "tags": [
    "Server"
  ],
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
  "x-immich-permission": "sync.stream",
  "x-immich-state": "Alpha"
}
```

## getSupportedMediaTypes

`GET /api/server/media-types`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L170).

Get supported media types

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerMediaTypesResponseDto](models-30.md#servermediatypesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('media-types')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get supported media types',
    description: 'Retrieve all media types supported by the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all media types supported by the server.",
  "operationId": "getSupportedMediaTypes",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerMediaTypesResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get supported media types",
  "tags": [
    "Server"
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
  "x-immich-state": "Stable"
}
```

## pingServer

`GET /api/server/ping`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L96).

Ping

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerPingResponse](models-30.md#serverpingresponse).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('ping')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Ping',
    description: 'Pong',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Pong",
  "operationId": "pingServer",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerPingResponse"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Ping",
  "tags": [
    "Server"
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
  "x-immich-state": "Stable"
}
```

## createNewServerAdmin

`POST /api/server/setup/admin`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-server-setup.controller.ts#L75).

Set up a new server with a password administrator

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafSetupAdminDto](models-12.md#frameleafsetupadmindto), [FrameleafSetupErrorDto](models-12.md#frameleafsetuperrordto), [UserAdminResponseDto](models-36.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/setup')
@Post('admin')
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSetup)
@Endpoint({
    operationId: 'createNewServerAdmin',
    summary: 'Set up a new server with a password administrator',
    description: `For the Frameleaf apps, from the home network, with a setup ticket: creates the server's first administrator with an email and password (the same account as the web first-run sign-up), for sign-in without Frameleaf Cloud. ${REFUSALS}`,
    history: history(),
  })
@ApiResponse({ status: 400, type: FrameleafSetupErrorDto, description: 'A refused setup' })
```

Complete operation contract:

```json
{
  "description": "For the Frameleaf apps, from the home network, with a setup ticket: creates the server's first administrator with an email and password (the same account as the web first-run sign-up), for sign-in without Frameleaf Cloud. Every refusal carries a FrameleafSetupErrorCode in `code`: setup_lan_only (only from the home network, never over remote access), setup_complete (the server already has an administrator), setup_code_required, setup_code_invalid (with `attemptsLeft`), setup_code_replaced (too many wrong tries: a new code is on the console), setup_code_locked (a code pinned with FRAMELEAF_SETUP_CODE after too many wrong tries: restart the server), setup_ticket_invalid, setup_cloud_unavailable, setup_already_linked, setup_link_token_invalid, setup_link_token_used, setup_link_failed. Too many requests from one address answer 429 rate_limited.",
  "operationId": "createNewServerAdmin",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafSetupAdminDto"
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
    },
    "400": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupErrorDto"
          }
        }
      },
      "description": "A refused setup"
    }
  },
  "summary": "Set up a new server with a password administrator",
  "tags": [
    "Server"
  ],
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
  "x-immich-state": "Alpha"
}
```

## verifyServerSetupCode

`POST /api/server/setup/code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-server-setup.controller.ts#L39).

Check a new server’s setup code

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafSetupCodeDto](models-12.md#frameleafsetupcodedto), [FrameleafSetupErrorDto](models-12.md#frameleafsetuperrordto), [FrameleafSetupTicketResponseDto](models-12.md#frameleafsetupticketresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/setup')
@Post('code')
@HttpCode(HttpStatus.OK)
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSetup)
@Endpoint({
    operationId: 'verifyServerSetupCode',
    summary: 'Check a new server’s setup code',
    description: `For the Frameleaf apps, from the home network, while the server has no administrator: checks the setup code shown on the server's console and in its log (or its QR code), and returns a setup ticket, usable once from this device for ten minutes, to link the server or create its administrator. Five wrong codes replace the code. The code is never in any response. ${REFUSALS}`,
    history: history(),
  })
@ApiResponse({ status: 401, type: FrameleafSetupErrorDto, description: 'A wrong, replaced or locked setup code' })
```

Complete operation contract:

```json
{
  "description": "For the Frameleaf apps, from the home network, while the server has no administrator: checks the setup code shown on the server's console and in its log (or its QR code), and returns a setup ticket, usable once from this device for ten minutes, to link the server or create its administrator. Five wrong codes replace the code. The code is never in any response. Every refusal carries a FrameleafSetupErrorCode in `code`: setup_lan_only (only from the home network, never over remote access), setup_complete (the server already has an administrator), setup_code_required, setup_code_invalid (with `attemptsLeft`), setup_code_replaced (too many wrong tries: a new code is on the console), setup_code_locked (a code pinned with FRAMELEAF_SETUP_CODE after too many wrong tries: restart the server), setup_ticket_invalid, setup_cloud_unavailable, setup_already_linked, setup_link_token_invalid, setup_link_token_used, setup_link_failed. Too many requests from one address answer 429 rate_limited.",
  "operationId": "verifyServerSetupCode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafSetupCodeDto"
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
            "$ref": "#/components/schemas/FrameleafSetupTicketResponseDto"
          }
        }
      },
      "description": ""
    },
    "401": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupErrorDto"
          }
        }
      },
      "description": "A wrong, replaced or locked setup code"
    }
  },
  "summary": "Check a new server’s setup code",
  "tags": [
    "Server"
  ],
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
  "x-immich-state": "Alpha"
}
```

## linkNewServer

`POST /api/server/setup/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/frameleaf-server-setup.controller.ts#L57).

Set up a new server with a Frameleaf account

Permission: `See authentication declaration`. Admin only: `false`.

Models: [FrameleafSetupErrorDto](models-12.md#frameleafsetuperrordto), [FrameleafSetupLinkDto](models-12.md#frameleafsetuplinkdto), [FrameleafSetupLinkResponseDto](models-12.md#frameleafsetuplinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server/setup')
@Post('link')
@HttpCode(HttpStatus.OK)
@Authenticated({ public: true })
@RateLimited(RATE_LIMITS.frameleafSetup)
@Endpoint({
    operationId: 'linkNewServer',
    summary: 'Set up a new server with a Frameleaf account',
    description: `For the Frameleaf apps, from the home network, with a setup ticket: links this new server with a single-use Frameleaf link token (fll_…, the same kind FRAMELEAF_LINK_TOKEN takes) under the name the person chose. The Frameleaf account that minted the token owns the server, and its first Sign in with Frameleaf (in a browser or by token exchange) creates the administrator, without a server password. ${REFUSALS}`,
    history: history(),
  })
@ApiResponse({ status: 400, type: FrameleafSetupErrorDto, description: 'A refused setup or link' })
```

Complete operation contract:

```json
{
  "description": "For the Frameleaf apps, from the home network, with a setup ticket: links this new server with a single-use Frameleaf link token (fll_…, the same kind FRAMELEAF_LINK_TOKEN takes) under the name the person chose. The Frameleaf account that minted the token owns the server, and its first Sign in with Frameleaf (in a browser or by token exchange) creates the administrator, without a server password. Every refusal carries a FrameleafSetupErrorCode in `code`: setup_lan_only (only from the home network, never over remote access), setup_complete (the server already has an administrator), setup_code_required, setup_code_invalid (with `attemptsLeft`), setup_code_replaced (too many wrong tries: a new code is on the console), setup_code_locked (a code pinned with FRAMELEAF_SETUP_CODE after too many wrong tries: restart the server), setup_ticket_invalid, setup_cloud_unavailable, setup_already_linked, setup_link_token_invalid, setup_link_token_used, setup_link_failed. Too many requests from one address answer 429 rate_limited.",
  "operationId": "linkNewServer",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/FrameleafSetupLinkDto"
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
            "$ref": "#/components/schemas/FrameleafSetupLinkResponseDto"
          }
        }
      },
      "description": ""
    },
    "400": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FrameleafSetupErrorDto"
          }
        }
      },
      "description": "A refused setup or link"
    }
  },
  "summary": "Set up a new server with a Frameleaf account",
  "tags": [
    "Server"
  ],
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
  "x-immich-state": "Alpha"
}
```

## getServerStatistics

`GET /api/server/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L159).

Get statistics

Permission: `server.statistics`. Admin only: `false`.

Models: [ServerStatsResponseDto](models-30.md#serverstatsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('statistics')
@Authenticated({ permission: Permission.ServerStatistics, admin: true })
@Endpoint({
    summary: 'Get statistics',
    description: 'Retrieve statistics about the entire Frameleaf instance such as asset counts.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve statistics about the entire Frameleaf instance such as asset counts.",
  "operationId": "getServerStatistics",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerStatsResponseDto"
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
  "summary": "Get statistics",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.statistics",
  "x-immich-state": "Stable"
}
```

## getStorage

`GET /api/server/storage`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L73).

Get storage

Permission: `server.storage`. Admin only: `false`.

Models: [ServerStorageResponseDto](models-30.md#serverstorageresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('storage')
@Authenticated({ permission: Permission.ServerStorage })
@Endpoint({
    summary: 'Get storage',
    description: 'Retrieve the current storage utilization information of the server.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current storage utilization information of the server.",
  "operationId": "getStorage",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerStorageResponseDto"
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
  "summary": "Get storage",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.storage",
  "x-immich-state": "Stable"
}
```

## getServerVersion

`GET /api/server/version`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L107).

Get server version

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerVersionResponseDto](models-30.md#serverversionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('version')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get server version',
    description: 'Retrieve the current server version in semantic versioning (semver) format.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current server version in semantic versioning (semver) format.",
  "operationId": "getServerVersion",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ServerVersionResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get server version",
  "tags": [
    "Server"
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
  "x-immich-state": "Stable"
}
```

## getVersionCheck

`GET /api/server/version-check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L181).

Get version check status

Permission: `server.versionCheck`. Admin only: `false`.

Models: [VersionCheckStateResponseDto](models-37.md#versioncheckstateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('version-check')
@Authenticated({ permission: Permission.ServerVersionCheck })
@Endpoint({
    summary: 'Get version check status',
    description: 'Retrieve information about the last time the version check ran.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about the last time the version check ran.",
  "operationId": "getVersionCheck",
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
  "summary": "Get version check status",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.versionCheck",
  "x-immich-state": "Stable"
}
```

## checkVersionNow

`POST /api/server/version-check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L192).

Check for updates now

Permission: `server.versionCheck`. Admin only: `false`.

Models: [ReleaseEventV1](models-27.md#releaseeventv1).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Post('version-check')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.ServerVersionCheck, admin: true })
@Endpoint({
    summary: 'Check for updates now',
    description:
      "Ask Frameleaf's release feed for the newest version now, whether or not automatic checks are on (About → Check for updates). No other service is contacted.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Ask Frameleaf's release feed for the newest version now, whether or not automatic checks are on (About → Check for updates). No other service is contacted.",
  "operationId": "checkVersionNow",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ReleaseEventV1"
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
  "summary": "Check for updates now",
  "tags": [
    "Server"
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
  "x-immich-permission": "server.versionCheck",
  "x-immich-state": "Alpha"
}
```

## getVersionHistory

`GET /api/server/version-history`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/server.controller.ts#L118).

Get version history

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ServerVersionHistoryResponseDto](models-30.md#serverversionhistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Server)
@Controller('server')
@Get('version-history')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get version history',
    description: 'Retrieve a list of past versions the server has been on.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of past versions the server has been on.",
  "operationId": "getVersionHistory",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ServerVersionHistoryResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get version history",
  "tags": [
    "Server"
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
  "x-immich-state": "Stable"
}
```
