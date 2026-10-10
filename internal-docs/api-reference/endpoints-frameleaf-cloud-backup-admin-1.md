# Server API — Frameleaf Cloud backup (admin) 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getBuddyBackupStatus

`GET /api/admin/buddy-backup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L60).

Get Buddy Backup and hosting status

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Get()
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'getBuddyBackupStatus', summary: 'Get Buddy Backup and hosting status', history })
```

Complete operation contract:

```json
{
  "operationId": "getBuddyBackupStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Get Buddy Backup and hosting status",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## controlBuddyBackup

`POST /api/admin/buddy-backup/control`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L214).

Start, pause, resume, restart or verify Buddy Backup

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyControlDto](models-07.md#buddycontroldto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('control')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'controlBuddyBackup',
    summary: 'Start, pause, resume, restart or verify Buddy Backup',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "controlBuddyBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyControlDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Start, pause, resume, restart or verify Buddy Backup",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## inviteBackupBuddy

`POST /api/admin/buddy-backup/invitations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L101).

Invite a Cloud account to pair its Frameleaf server

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyInviteDto](models-07.md#buddyinvitedto), [BuddyInviteResponseDto](models-07.md#buddyinviteresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('invitations')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'inviteBackupBuddy',
    summary: 'Invite a Cloud account to pair its Frameleaf server',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "inviteBackupBuddy",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyInviteDto"
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
            "$ref": "#/components/schemas/BuddyInviteResponseDto"
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
  "summary": "Invite a Cloud account to pair its Frameleaf server",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## acceptBackupBuddy

`POST /api/admin/buddy-backup/invitations/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L114).

Accept a Buddy invitation with this hosting capacity

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyAcceptDto](models-07.md#buddyacceptdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('invitations/accept')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'acceptBackupBuddy',
    summary: 'Accept a Buddy invitation with this hosting capacity',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "acceptBackupBuddy",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyAcceptDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Accept a Buddy invitation with this hosting capacity",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## generateBuddyRecoveryKit

`POST /api/admin/buddy-backup/key`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L138).

Generate and return a new recovery kit once

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyKitDto](models-07.md#buddykitdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'generateBuddyRecoveryKit',
    summary: 'Generate and return a new recovery kit once',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "generateBuddyRecoveryKit",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyKitDto"
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
  "summary": "Generate and return a new recovery kit once",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## wrapBuddyRecoveryKit

`POST /api/admin/buddy-backup/key/escrow`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L151).

Encrypt a recovery kit locally with a passphrase

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyEscrowDto](models-07.md#buddyescrowdto), [BuddyEscrowWrapDto](models-07.md#buddyescrowwrapdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key/escrow')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'wrapBuddyRecoveryKit',
    summary: 'Encrypt a recovery kit locally with a passphrase',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "wrapBuddyRecoveryKit",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyEscrowWrapDto"
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
            "$ref": "#/components/schemas/BuddyEscrowDto"
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
  "summary": "Encrypt a recovery kit locally with a passphrase",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## unlockBuddyRecoveryKit

`POST /api/admin/buddy-backup/key/escrow/import`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L164).

Unlock and import an encrypted recovery package locally

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyEscrowImportDto](models-07.md#buddyescrowimportdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key/escrow/import')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'unlockBuddyRecoveryKit',
    summary: 'Unlock and import an encrypted recovery package locally',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "unlockBuddyRecoveryKit",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyEscrowImportDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Unlock and import an encrypted recovery package locally",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## importBuddyRecoveryKit

`POST /api/admin/buddy-backup/key/import`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L185).

Import a recovery kit on the rebound server

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyKitDto](models-07.md#buddykitdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key/import')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'importBuddyRecoveryKit', summary: 'Import a recovery kit on the rebound server', history })
```

Complete operation contract:

```json
{
  "operationId": "importBuddyRecoveryKit",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyKitDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Import a recovery kit on the rebound server",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## rotateBuddyRecoveryKit

`POST /api/admin/buddy-backup/key/rotate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L193).

Rotate encryption while retaining historical keys

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyKitDto](models-07.md#buddykitdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key/rotate')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'rotateBuddyRecoveryKit',
    summary: 'Rotate encryption while retaining historical keys',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "rotateBuddyRecoveryKit",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyKitDto"
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
  "summary": "Rotate encryption while retaining historical keys",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## verifyBuddyRecoveryKit

`POST /api/admin/buddy-backup/key/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L177).

Verify the recovery kit the owner saved

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyKitDto](models-07.md#buddykitdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('key/verify')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'verifyBuddyRecoveryKit', summary: 'Verify the recovery kit the owner saved', history })
```

Complete operation contract:

```json
{
  "operationId": "verifyBuddyRecoveryKit",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyKitDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Verify the recovery kit the owner saved",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## checkBuddyBackupCoverage

`POST /api/admin/buddy-backup/preflight`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L68).

Check backup size, storage and configuration coverage

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyPreflightDto](models-07.md#buddypreflightdto), [BuddyPreflightRequestDto](models-07.md#buddypreflightrequestdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('preflight')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'checkBuddyBackupCoverage',
    summary: 'Check backup size, storage and configuration coverage',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "checkBuddyBackupCoverage",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyPreflightRequestDto"
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
            "$ref": "#/components/schemas/BuddyPreflightDto"
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
  "summary": "Check backup size, storage and configuration coverage",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## testBuddyBackup

`POST /api/admin/buddy-backup/probe`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L206).

Verify an encrypted round trip

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyProbeResponseDto](models-07.md#buddyproberesponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('probe')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'testBuddyBackup', summary: 'Verify an encrypted round trip', history })
```

Complete operation contract:

```json
{
  "operationId": "testBuddyBackup",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyProbeResponseDto"
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
  "summary": "Verify an encrypted round trip",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## refreshBuddyBackup

`POST /api/admin/buddy-backup/refresh`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L81).

Refresh the Cloud pairing

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('refresh')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'refreshBuddyBackup', summary: 'Refresh the Cloud pairing', history })
```

Complete operation contract:

```json
{
  "operationId": "refreshBuddyBackup",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Refresh the Cloud pairing",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## changeBuddyRelationship

`POST /api/admin/buddy-backup/relationship`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L126).

Confirm, end, or immediately block a pairing

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyRelationshipDto](models-07.md#buddyrelationshipdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('relationship')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'changeBuddyRelationship',
    summary: 'Confirm, end, or immediately block a pairing',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "changeBuddyRelationship",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyRelationshipDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Confirm, end, or immediately block a pairing",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## restoreBuddyBackup

`POST /api/admin/buddy-backup/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L243).

Preview or start a verified restore

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyRestoreDto](models-07.md#buddyrestoredto), [BuddyRestoreResponseDto](models-07.md#buddyrestoreresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('restore')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'restoreBuddyBackup', summary: 'Preview or start a verified restore', history })
```

Complete operation contract:

```json
{
  "operationId": "restoreBuddyBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyRestoreDto"
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
            "$ref": "#/components/schemas/BuddyRestoreResponseDto"
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
  "summary": "Preview or start a verified restore",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## applyBuddyRecovery

`POST /api/admin/buddy-backup/restore/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L258).

Apply staged settings or server recovery in maintenance mode

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddyApplyDto](models-07.md#buddyapplydto), [BuddyApplyResponseDto](models-07.md#buddyapplyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Post('restore/apply')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'applyBuddyRecovery',
    summary: 'Apply staged settings or server recovery in maintenance mode',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "applyBuddyRecovery",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddyApplyDto"
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
            "$ref": "#/components/schemas/BuddyApplyResponseDto"
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
  "summary": "Apply staged settings or server recovery in maintenance mode",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## getBuddyRestoreCheckpoint

`GET /api/admin/buddy-backup/restores`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L47).

Resume the current owner restore or staged recovery

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyRestoreCheckpointDto](models-07.md#buddyrestorecheckpointdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Get('restores')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'getBuddyRestoreCheckpoint',
    summary: 'Resume the current owner restore or staged recovery',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "getBuddyRestoreCheckpoint",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyRestoreCheckpointDto"
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
  "summary": "Resume the current owner restore or staged recovery",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## getBuddyRestoreStatus

`GET /api/admin/buddy-backup/restores/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L250).

Get restore or staging progress

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyRestoreStatusDto](models-07.md#buddyrestorestatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Get('restores/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'getBuddyRestoreStatus', summary: 'Get restore or staging progress', history })
```

Complete operation contract:

```json
{
  "operationId": "getBuddyRestoreStatus",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BuddyRestoreStatusDto"
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
  "summary": "Get restore or staging progress",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## configureBuddyBackup

`PUT /api/admin/buddy-backup/settings`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L89).

Configure hosting, schedules and transfer limits

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [BuddySettingsDto](models-07.md#buddysettingsdto), [BuddyStatusDto](models-07.md#buddystatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Put('settings')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true, refreshElevation: false })
@Endpoint({
    operationId: 'configureBuddyBackup',
    summary: 'Configure hosting, schedules and transfer limits',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "configureBuddyBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BuddySettingsDto"
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
            "$ref": "#/components/schemas/BuddyStatusDto"
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
  "summary": "Configure hosting, schedules and transfer limits",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## listBuddyBackupSnapshots

`GET /api/admin/buddy-backup/snapshots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L226).

List complete Buddy restore points

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddySnapshotListDto](models-07.md#buddysnapshotlistdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Get('snapshots')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'listBuddyBackupSnapshots', summary: 'List complete Buddy restore points', history })
```

Complete operation contract:

```json
{
  "operationId": "listBuddyBackupSnapshots",
  "parameters": [
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
            "$ref": "#/components/schemas/BuddySnapshotListDto"
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
  "summary": "List complete Buddy restore points",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## browseBuddyBackup

`GET /api/admin/buddy-backup/snapshots/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup.controller.ts#L235).

Browse a decrypted restore point

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [BuddyBrowseDto](models-07.md#buddybrowsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/buddy-backup')
@Get('snapshots/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({ operationId: 'browseBuddyBackup', summary: 'Browse a decrypted restore point', history })
```

Complete operation contract:

```json
{
  "operationId": "browseBuddyBackup",
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
            "$ref": "#/components/schemas/BuddyBrowseDto"
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
  "summary": "Browse a decrypted restore point",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## turnOffCloudBackup

`DELETE /api/admin/cloud/backup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-admin.controller.ts#L105).

Turn cloud backup off

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Delete()
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'turnOffCloudBackup',
    summary: 'Turn cloud backup off',
    description: 'Stops backing up. The bucket, its backups and the key are kept.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Stops backing up. The bucket, its backups and the key are kept.",
  "operationId": "turnOffCloudBackup",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupStatusResponseDto"
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
  "summary": "Turn cloud backup off",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## getCloudBackupStatus

`GET /api/admin/cloud/backup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-admin.controller.ts#L37).

Get the cloud backup status

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Get()
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
@Endpoint({
    operationId: 'getCloudBackupStatus',
    summary: 'Get the cloud backup status',
    description:
      'The claimed bucket, the key mode and fingerprint (never the key), whether the key is loaded, the last run, the last success, usage and the run in progress.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The claimed bucket, the key mode and fingerprint (never the key), whether the key is loaded, the last run, the last success, usage and the run in progress.",
  "operationId": "getCloudBackupStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupStatusResponseDto"
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
  "summary": "Get the cloud backup status",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.read",
  "x-immich-state": "Alpha"
}
```

## checkCloudBackupBucket

`POST /api/admin/cloud/backup/check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-admin.controller.ts#L50).

Check a bucket for cloud backup

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [CloudBackupCheckDto](models-08.md#cloudbackupcheckdto), [CloudBackupCheckResponseDto](models-08.md#cloudbackupcheckresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('check')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'checkCloudBackupBucket',
    summary: 'Check a bucket for cloud backup',
    description:
      'Lists the bucket and writes, reads back and deletes a test file encrypted with a throwaway customer key (SSE-C). Nothing is claimed or saved.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Lists the bucket and writes, reads back and deletes a test file encrypted with a throwaway customer key (SSE-C). Nothing is claimed or saved.",
  "operationId": "checkCloudBackupBucket",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupCheckDto"
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
            "$ref": "#/components/schemas/CloudBackupCheckResponseDto"
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
  "summary": "Check a bucket for cloud backup",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```

## removeCloudBackupEscrow

`DELETE /api/admin/cloud/backup/escrow`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-admin.controller.ts#L265).

Remove the key copy from Frameleaf Cloud

Permission: `adminCloudBackup.update`. Admin only: `true`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Delete('escrow')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'removeCloudBackupEscrow',
    summary: 'Remove the key copy from Frameleaf Cloud',
    description: 'Deletes the wrapped key Frameleaf Cloud keeps for this server.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes the wrapped key Frameleaf Cloud keeps for this server.",
  "operationId": "removeCloudBackupEscrow",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupStatusResponseDto"
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
  "summary": "Remove the key copy from Frameleaf Cloud",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "adminCloudBackup.update",
  "x-immich-state": "Alpha"
}
```
