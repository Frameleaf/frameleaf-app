# Server API — Frameleaf Cloud (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## checkInCloud

`POST /api/admin/cloud/heartbeat`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L282).

Check in with Frameleaf Cloud now

Permission: `adminCloud.update`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Post('heartbeat')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
@Endpoint({
    operationId: 'checkInCloud',
    summary: 'Check in with Frameleaf Cloud now',
    description: 'Sends one check-in with exactly the fields the "What this server sends" panel lists.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Sends one check-in with exactly the fields the \"What this server sends\" panel lists.",
  "operationId": "checkInCloud",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Check in with Frameleaf Cloud now",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.update",
  "x-immich-state": "Alpha"
}
```

## unlinkCloud

`DELETE /api/admin/cloud/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L131).

Unlink this server from Frameleaf Cloud

Permission: `adminCloud.link`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Delete('link')
@Authenticated({ permission: Permission.AdminCloudLink, admin: true })
@Endpoint({
    operationId: 'unlinkCloud',
    summary: 'Unlink this server from Frameleaf Cloud',
    description:
      'Clears the link and switches remote access, cloud processing and cloud backup off. Sign in with Frameleaf sessions end; local photos, accounts and password sign-in are unchanged.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Clears the link and switches remote access, cloud processing and cloud backup off. Sign in with Frameleaf sessions end; local photos, accounts and password sign-in are unchanged.",
  "operationId": "unlinkCloud",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Unlink this server from Frameleaf Cloud",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.link",
  "x-immich-state": "Alpha"
}
```

## getCloudLink

`GET /api/admin/cloud/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L93).

Check the Frameleaf Cloud link

Permission: `adminCloud.read`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Get('link')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'getCloudLink',
    summary: 'Check the Frameleaf Cloud link',
    description:
      'The link state. While a code waits for approval, this server asks Frameleaf Cloud whether it was approved, denied or expired, no more often than the interval the cloud set.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The link state. While a code waits for approval, this server asks Frameleaf Cloud whether it was approved, denied or expired, no more often than the interval the cloud set.",
  "operationId": "getCloudLink",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Check the Frameleaf Cloud link",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```

## startCloudLink

`POST /api/admin/cloud/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L79).

Start linking this server to a Frameleaf account

Permission: `adminCloud.link`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Post('link')
@Authenticated({ permission: Permission.AdminCloudLink, admin: true })
@RateLimited(RATE_LIMITS.linkStart)
@Endpoint({
    operationId: 'startCloudLink',
    summary: 'Start linking this server to a Frameleaf account',
    description:
      'Starts an RFC 8628 device authorization and returns the code to approve on the Frameleaf Cloud approval page, with a QR payload and its expiry.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Starts an RFC 8628 device authorization and returns the code to approve on the Frameleaf Cloud approval page, with a QR payload and its expiry.",
  "operationId": "startCloudLink",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Start linking this server to a Frameleaf account",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.link",
  "x-immich-state": "Alpha"
}
```

## continueCloudLink

`POST /api/admin/cloud/link/continue`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L106).

Link in the Frameleaf account’s data region

Permission: `adminCloud.link`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Post('link/continue')
@Authenticated({ permission: Permission.AdminCloudLink, admin: true })
@Endpoint({
    operationId: 'continueCloudLink',
    summary: 'Link in the Frameleaf account’s data region',
    description:
      'After Frameleaf Cloud refused an approved link because the account keeps its data in another region (409 region-mismatch), links again with the same, unspent approval in the account’s region. No new code is needed.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "After Frameleaf Cloud refused an approved link because the account keeps its data in another region (409 region-mismatch), links again with the same, unspent approval in the account’s region. No new code is needed.",
  "operationId": "continueCloudLink",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Link in the Frameleaf account’s data region",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.link",
  "x-immich-state": "Alpha"
}
```

## cancelCloudLink

`DELETE /api/admin/cloud/link/pending`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L119).

Cancel a pending link

Permission: `adminCloud.link`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Delete('link/pending')
@Authenticated({ permission: Permission.AdminCloudLink, admin: true })
@Endpoint({
    operationId: 'cancelCloudLink',
    summary: 'Cancel a pending link',
    description: 'Stops waiting for the current code. Nothing changes on this server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Stops waiting for the current code. Nothing changes on this server.",
  "operationId": "cancelCloudLink",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Cancel a pending link",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.link",
  "x-immich-state": "Alpha"
}
```

## updateCloudPermissions

`PUT /api/admin/cloud/permissions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L144).

Choose what Frameleaf Cloud may ask this server to do

Permission: `adminCloud.update`. Admin only: `true`.

Models: [CloudPermissionsUpdateDto](models-09.md#cloudpermissionsupdatedto), [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('permissions')
@Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
@Endpoint({
    operationId: 'updateCloudPermissions',
    summary: 'Choose what Frameleaf Cloud may ask this server to do',
    description:
      'The instance-side toggles every cloud command is checked against. This server always decides and records each request.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The instance-side toggles every cloud command is checked against. This server always decides and records each request.",
  "operationId": "updateCloudPermissions",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudPermissionsUpdateDto"
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
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Choose what Frameleaf Cloud may ask this server to do",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.update",
  "x-immich-state": "Alpha"
}
```

## getRemoteAccess

`GET /api/admin/cloud/remote`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L183).

Get remote access

Permission: `adminCloud.read`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Get('remote')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'getRemoteAccess',
    summary: 'Get remote access',
    description:
      'Whether remote access is on, how it connects, the address it publishes, its certificate, the custom hostname and the connection candidates. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether remote access is on, how it connects, the address it publishes, its certificate, the custom hostname and the connection candidates. Reads local state only; nothing is contacted.",
  "operationId": "getRemoteAccess",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Get remote access",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```

## updateRemoteAccess

`PUT /api/admin/cloud/remote`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L209).

Change remote access

Permission: `adminRemoteAccess.update`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto), [RemoteAccessUpdateDto](models-28.md#remoteaccessupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('remote')
@Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
@Endpoint({
    operationId: 'updateRemoteAccess',
    summary: 'Change remote access',
    description:
      'Turns remote access on or off and chooses its connection, direct port and published address. Turning it on needs a linked server with a remote access plan; publishing your own domain needs a verified custom hostname.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Turns remote access on or off and chooses its connection, direct port and published address. Turning it on needs a linked server with a remote access plan; publishing your own domain needs a verified custom hostname.",
  "operationId": "updateRemoteAccess",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RemoteAccessUpdateDto"
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
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Change remote access",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminRemoteAccess.update",
  "x-immich-state": "Alpha"
}
```

## updateCloudRemoteAccess

`PUT /api/admin/cloud/remote-access`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L170).

Choose what remote access may carry

Permission: `adminCloud.update`. Admin only: `true`.

Models: [CloudRemoteAccessUpdateDto](models-09.md#cloudremoteaccessupdatedto), [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('remote-access')
@Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
@Endpoint({
    operationId: 'updateCloudRemoteAccess',
    summary: 'Choose what remote access may carry',
    description:
      'Remote visitors always sign in with Frameleaf. This allows original downloads, archives and database backups through the relay, and password sign-in away from home. Turning either on needs a linked server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Remote visitors always sign in with Frameleaf. This allows original downloads, archives and database backups through the relay, and password sign-in away from home. Turning either on needs a linked server.",
  "operationId": "updateCloudRemoteAccess",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudRemoteAccessUpdateDto"
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
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Choose what remote access may carry",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.update",
  "x-immich-state": "Alpha"
}
```

## removeRemoteHostname

`DELETE /api/admin/cloud/remote/hostname`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L269).

Stop using the custom hostname

Permission: `adminRemoteAccess.update`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Delete('remote/hostname')
@Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
@Endpoint({
    operationId: 'removeRemoteHostname',
    summary: 'Stop using the custom hostname',
    description:
      'Removes the custom hostname and publishes the Frameleaf address again. Its DNS records can then be deleted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the custom hostname and publishes the Frameleaf address again. Its DNS records can then be deleted.",
  "operationId": "removeRemoteHostname",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Stop using the custom hostname",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminRemoteAccess.update",
  "x-immich-state": "Alpha"
}
```

## setRemoteHostname

`PUT /api/admin/cloud/remote/hostname`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L239).

Use your own domain for remote access

Permission: `adminRemoteAccess.update`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto), [RemoteHostnameUpdateDto](models-28.md#remotehostnameupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('remote/hostname')
@Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
@Endpoint({
    operationId: 'setRemoteHostname',
    summary: 'Use your own domain for remote access',
    description:
      'Adds a hostname on a domain you own, such as photos.example.com, and returns the two DNS records to add at your DNS provider. It waits for them until they are checked.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Adds a hostname on a domain you own, such as photos.example.com, and returns the two DNS records to add at your DNS provider. It waits for them until they are checked.",
  "operationId": "setRemoteHostname",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RemoteHostnameUpdateDto"
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
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Use your own domain for remote access",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminRemoteAccess.update",
  "x-immich-state": "Alpha"
}
```

## checkRemoteHostname

`POST /api/admin/cloud/remote/hostname/check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L255).

Check the custom hostname’s DNS records

Permission: `adminRemoteAccess.update`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Post('remote/hostname/check')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
@Endpoint({
    operationId: 'checkRemoteHostname',
    summary: 'Check the custom hostname’s DNS records',
    description:
      'Asks Frameleaf Cloud whether both DNS records point to this server. Once they do, the hostname is verified and this server obtains its certificate.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Asks Frameleaf Cloud whether both DNS records point to this server. Once they do, the hostname is verified and this server obtains its certificate.",
  "operationId": "checkRemoteHostname",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Check the custom hostname’s DNS records",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminRemoteAccess.update",
  "x-immich-state": "Alpha"
}
```

## testRemoteAccess

`POST /api/admin/cloud/remote/test`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L225).

Test remote access

Permission: `adminRemoteAccess.update`. Admin only: `true`.

Models: [RemoteAccessStatusResponseDto](models-28.md#remoteaccessstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Post('remote/test')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminRemoteAccessUpdate, admin: true })
@Endpoint({
    operationId: 'testRemoteAccess',
    summary: 'Test remote access',
    description:
      'Checks the certificate, the HTTPS listener and a request through it to this server, and reports the relay and the router as last seen. The result is kept with the remote access status.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Checks the certificate, the HTTPS listener and a request through it to this server, and reports the relay and the router as last seen. The result is kept with the remote access status.",
  "operationId": "testRemoteAccess",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteAccessStatusResponseDto"
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
  "summary": "Test remote access",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminRemoteAccess.update",
  "x-immich-state": "Alpha"
}
```

## getRemoteAccessUsage

`GET /api/admin/cloud/remote/usage`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L196).

Get relay use this month

Permission: `adminCloud.read`. Admin only: `true`.

Models: [RemoteAccessUsageResponseDto](models-28.md#remoteaccessusageresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Get('remote/usage')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'getRemoteAccessUsage',
    summary: 'Get relay use this month',
    description:
      'How much has gone through the Frameleaf relay this month and the allowance the plan includes, as Frameleaf Cloud meters them. Only on a linked server with remote access in its plan.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "How much has gone through the Frameleaf relay this month and the allowance the plan includes, as Frameleaf Cloud meters them. Only on a linked server with remote access in its plan.",
  "operationId": "getRemoteAccessUsage",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RemoteAccessUsageResponseDto"
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
  "summary": "Get relay use this month",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```

## updateCloudSignIn

`PUT /api/admin/cloud/sign-in`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L157).

Choose where Sign in with Frameleaf is offered

Permission: `adminCloud.update`. Admin only: `true`.

Models: [CloudSignInUpdateDto](models-09.md#cloudsigninupdatedto), [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('sign-in')
@Authenticated({ permission: Permission.AdminCloudUpdate, admin: true })
@Endpoint({
    operationId: 'updateCloudSignIn',
    summary: 'Choose where Sign in with Frameleaf is offered',
    description:
      'Remote access always requires Sign in with Frameleaf. This also offers it on the login page at home, once the server is linked, and sets its button text.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Remote access always requires Sign in with Frameleaf. This also offers it on the login page at home, once the server is linked, and sets its button text.",
  "operationId": "updateCloudSignIn",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudSignInUpdateDto"
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
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Choose where Sign in with Frameleaf is offered",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.update",
  "x-immich-state": "Alpha"
}
```

## getCloudStatus

`GET /api/admin/cloud/status`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L66).

Get the Frameleaf Cloud link status

Permission: `adminCloud.read`. Admin only: `true`.

Models: [CloudStatusResponseDto](models-09.md#cloudstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Get('status')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'getCloudStatus',
    summary: 'Get the Frameleaf Cloud link status',
    description:
      'Whether Frameleaf Cloud is configured, and whether this server is unlinked, waiting for approval, linked or revoked. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether Frameleaf Cloud is configured, and whether this server is unlinked, waiting for approval, linked or revoked. Reads local state only; nothing is contacted.",
  "operationId": "getCloudStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudStatusResponseDto"
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
  "summary": "Get the Frameleaf Cloud link status",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```

## getCloudTour

`GET /api/admin/cloud/tour`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L40).

Get your linked-server tour

Permission: `adminCloud.read`. Admin only: `true`.

Models: [CloudTourResponseDto](models-09.md#cloudtourresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Get('tour')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'getCloudTour',
    summary: 'Get your linked-server tour',
    description:
      'Whether you have seen the tour of what linking to Frameleaf Cloud unlocks, whether to open it now, and the status it shows for this server. Reads local state only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether you have seen the tour of what linking to Frameleaf Cloud unlocks, whether to open it now, and the status it shows for this server. Reads local state only; nothing is contacted.",
  "operationId": "getCloudTour",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudTourResponseDto"
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
  "summary": "Get your linked-server tour",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```

## markCloudTourSeen

`PUT /api/admin/cloud/tour`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/cloud-admin.controller.ts#L53).

Mark your linked-server tour as seen

Permission: `adminCloud.read`. Admin only: `true`.

Models: [CloudTourResponseDto](models-09.md#cloudtourresponsedto), [CloudTourSeenDto](models-09.md#cloudtourseendto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloud)
@Controller('admin/cloud')
@Put('tour')
@Authenticated({ permission: Permission.AdminCloudRead, admin: true })
@Endpoint({
    operationId: 'markCloudTourSeen',
    summary: 'Mark your linked-server tour as seen',
    description:
      'Records how you ended the tour (finished, skipped, opened a settings page, or linked during first-run setup), so it is not offered to you again. The first ending is kept. Changes no settings and contacts nothing.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Records how you ended the tour (finished, skipped, opened a settings page, or linked during first-run setup), so it is not offered to you again. The first ending is kept. Changes no settings and contacts nothing.",
  "operationId": "markCloudTourSeen",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudTourSeenDto"
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
            "$ref": "#/components/schemas/CloudTourResponseDto"
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
  "summary": "Mark your linked-server tour as seen",
  "tags": [
    "Frameleaf Cloud (admin)"
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
  "x-immich-permission": "adminCloud.read",
  "x-immich-state": "Alpha"
}
```
