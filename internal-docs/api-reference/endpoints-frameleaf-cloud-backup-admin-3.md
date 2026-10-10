# Server API — Frameleaf Cloud backup (admin) 3

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getOwnBackupThumbnail

`GET /api/users/me/cloud-backup/history/{id}/thumbnail`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-owner.controller.ts#L105).

Read an authorized kept backup thumbnail

Permission: `asset.view`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
@Get('history/:id/thumbnail')
@Header('Cache-Control', 'private, no-store')
@Header('X-Content-Type-Options', 'nosniff')
@Authenticated({ permission: Permission.AssetView, refreshElevation: false })
@FileResponse()
@Endpoint({
    summary: 'Read an authorized kept backup thumbnail',
    description:
      'Only recorded thumbnail objects, actual SHA256 and size verified, maximum8MiB. Normal credentials/privacy and kept membership are rechecked after remote reads.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Only recorded thumbnail objects, actual SHA256 and size verified, maximum8MiB. Normal credentials/privacy and kept membership are rechecked after remote reads.",
  "operationId": "getOwnBackupThumbnail",
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
        "maximum": 100,
        "default": 50,
        "type": "integer"
      }
    },
    {
      "name": "manifestKey",
      "required": true,
      "in": "query",
      "schema": {
        "maxLength": 300,
        "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
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
    },
    {
      "name": "query",
      "required": false,
      "in": "query",
      "schema": {
        "maxLength": 200,
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
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
  "summary": "Read an authorized kept backup thumbnail",
  "tags": [
    "Frameleaf Cloud backup (admin)"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.view"
}
```

## restoreOwnBackupItems

`POST /api/users/me/cloud-backup/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-owner.controller.ts#L57).

Restore own items from a chosen kept backup

Permission: `asset.update`. Admin only: `false`.

Models: [OwnerBackupRestoreDto](models-18.md#ownerbackuprestoredto), [OwnerBackupRestoreResponseDto](models-18.md#ownerbackuprestoreresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
@Post('restore')
@Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
@Endpoint({
    summary: 'Restore own items from a chosen kept backup',
    description:
      '1–100 unique own items; a current PIN-elevated session is required throughout execution. SHA256 verified staging, guarded owner destinations and details; unknown historical evidence refuses. Returns only the operation identity, never admin-global backup status.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "1–100 unique own items; a current PIN-elevated session is required throughout execution. SHA256 verified staging, guarded owner destinations and details; unknown historical evidence refuses. Returns only the operation identity, never admin-global backup status.",
  "operationId": "restoreOwnBackupItems",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OwnerBackupRestoreDto"
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
            "$ref": "#/components/schemas/OwnerBackupRestoreResponseDto"
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
  "summary": "Restore own items from a chosen kept backup",
  "tags": [
    "Frameleaf Cloud backup (admin)"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.update"
}
```

## getOwnSetupProgress

`GET /api/users/me/cloud-backup/setup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cloud-backup-owner.controller.ts#L44).

Get the cloud backup setup progress

Permission: `adminCloudBackup.read`. Admin only: `true`.

Models: [CloudBackupOwnerSetupResponseDto](models-08.md#cloudbackupownersetupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
@Get('setup')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true, refreshElevation: false })
@Endpoint({
    summary: 'Get the cloud backup setup progress',
    description:
      'Read-only activation chain for the server owner (an administrator) to poll: plan entitlement seen, bucket claimed, key loaded, first run, next scheduled run. Never the bucket, endpoint, key, usage or file names. Other users are refused.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Read-only activation chain for the server owner (an administrator) to poll: plan entitlement seen, bucket claimed, key loaded, first run, next scheduled run. Never the bucket, endpoint, key, usage or file names. Other users are refused.",
  "operationId": "getOwnSetupProgress",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupOwnerSetupResponseDto"
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
  "summary": "Get the cloud backup setup progress",
  "tags": [
    "Frameleaf Cloud backup (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "adminCloudBackup.read"
}
```
