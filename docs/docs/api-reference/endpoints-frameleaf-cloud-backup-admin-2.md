# Server API — Frameleaf Cloud backup (admin) 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## storeCloudBackupEscrow

`PUT /api/admin/cloud/backup/escrow`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L252).

Keep a key copy with Frameleaf Cloud

Permission: `adminCloudBackup.update`. Admin only: `false`.

Models: [CloudBackupEscrowDto](models-08.md#cloudbackupescrowdto), [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Put('escrow')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'storeCloudBackupEscrow',
    summary: 'Keep a key copy with Frameleaf Cloud',
    description:
      'Server key mode only: wraps the bucket key under the passphrase (scrypt, then AES-256-GCM) and stores the result with Frameleaf Cloud, which cannot unwrap it. The passphrase is never stored or sent.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Server key mode only: wraps the bucket key under the passphrase (scrypt, then AES-256-GCM) and stores the result with Frameleaf Cloud, which cannot unwrap it. The passphrase is never stored or sent.",
  "operationId": "storeCloudBackupEscrow",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupEscrowDto"
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
  "summary": "Keep a key copy with Frameleaf Cloud",
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

## generateCloudBackupKey

`POST /api/admin/cloud/backup/key`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L64).

Generate a bucket key

Permission: `adminCloudBackup.update`. Admin only: `false`.

Models: [CloudBackupGeneratedKeyDto](models-08.md#cloudbackupgeneratedkeydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('key')
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'generateCloudBackupKey',
    summary: 'Generate a bucket key',
    description:
      'A new 256-bit key made by this server for "Generate a key for me", returned this once for the recovery kit. Nothing is stored until setup claims a bucket with it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "A new 256-bit key made by this server for \"Generate a key for me\", returned this once for the recovery kit. Nothing is stored until setup claims a bucket with it.",
  "operationId": "generateCloudBackupKey",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupGeneratedKeyDto"
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
  "summary": "Generate a bucket key",
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

## unlockCloudBackupKey

`POST /api/admin/cloud/backup/key/unlock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L91).

Load the backup key into memory

Permission: `adminCloudBackup.update`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto), [CloudBackupUnlockDto](models-08.md#cloudbackupunlockdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('key/unlock')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'unlockCloudBackupKey',
    summary: 'Load the backup key into memory',
    description:
      'Own-memory key mode: loads the key after a restart. It is held in memory by this server’s workers only, never saved; backups wait until it is loaded.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Own-memory key mode: loads the key after a restart. It is held in memory by this server’s workers only, never saved; backups wait until it is loaded.",
  "operationId": "unlockCloudBackupKey",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupUnlockDto"
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
  "summary": "Load the backup key into memory",
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

## getCloudBackupManifests

`GET /api/admin/cloud/backup/manifests`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L198).

List the kept backups

Permission: `adminCloudBackup.read`. Admin only: `false`.

Models: [CloudBackupManifestsResponseDto](models-08.md#cloudbackupmanifestsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Get('manifests')
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
@Endpoint({
    operationId: 'getCloudBackupManifests',
    summary: 'List the kept backups',
    description: 'The backups retention keeps, newest first, with their size and the database dump each pairs with.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The backups retention keeps, newest first, with their size and the database dump each pairs with.",
  "operationId": "getCloudBackupManifests",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudBackupManifestsResponseDto"
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
  "summary": "List the kept backups",
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

## listCloudBackupManifestAlbums

`POST /api/admin/cloud/backup/manifests/albums`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L224).

List the albums a backup can bring back

Permission: `adminCloudBackup.read`. Admin only: `false`.

Models: [CloudBackupManifestAlbumsDto](models-08.md#cloudbackupmanifestalbumsdto), [CloudBackupManifestAlbumsResponseDto](models-08.md#cloudbackupmanifestalbumsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('manifests/albums')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
@Endpoint({
    operationId: 'listCloudBackupManifestAlbums',
    summary: 'List the albums a backup can bring back',
    description:
      'The albums one kept backup records that are deleted or no longer hold every item they held then. Reads the backup’s manifest from the bucket.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The albums one kept backup records that are deleted or no longer hold every item they held then. Reads the backup’s manifest from the bucket.",
  "operationId": "listCloudBackupManifestAlbums",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupManifestAlbumsDto"
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
            "$ref": "#/components/schemas/CloudBackupManifestAlbumsResponseDto"
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
  "summary": "List the albums a backup can bring back",
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

## searchCloudBackupManifestItems

`POST /api/admin/cloud/backup/manifests/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L210).

Search the items in a backup

Permission: `adminCloudBackup.read`. Admin only: `false`.

Models: [CloudBackupManifestItemsDto](models-08.md#cloudbackupmanifestitemsdto), [CloudBackupManifestItemsResponseDto](models-08.md#cloudbackupmanifestitemsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('manifests/items')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRead, admin: true })
@Endpoint({
    operationId: 'searchCloudBackupManifestItems',
    summary: 'Search the items in a backup',
    description:
      'The items one kept backup holds, found by file name, and whether each is still in the library. Reads the backup’s manifest from the bucket.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The items one kept backup holds, found by file name, and whether each is still in the library. Reads the backup’s manifest from the bucket.",
  "operationId": "searchCloudBackupManifestItems",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupManifestItemsDto"
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
            "$ref": "#/components/schemas/CloudBackupManifestItemsResponseDto"
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
  "summary": "Search the items in a backup",
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

## pruneCloudBackup

`POST /api/admin/cloud/backup/prune`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L184).

Clean up backups past retention

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupPruneDto](models-08.md#cloudbackupprunedto), [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('prune')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'pruneCloudBackup',
    summary: 'Clean up backups past retention',
    description:
      'Queues a clean-up of runs past the retention settings. Only files no kept backup names are removed. A dry run counts what would go; the clean-up itself needs a dry run from the last day first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a clean-up of runs past the retention settings. Only files no kept backup names are removed. A dry run counts what would go; the clean-up itself needs a dry run from the last day first.",
  "operationId": "pruneCloudBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupPruneDto"
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
  "summary": "Clean up backups past retention",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## restoreCloudBackup

`POST /api/admin/cloud/backup/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L238).

Restore from a backup

Permission: `adminCloudBackup.update`. Admin only: `false`.

Models: [CloudBackupRestoreDto](models-08.md#cloudbackuprestoredto), [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('restore')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'restoreCloudBackup',
    summary: 'Restore from a backup',
    description:
      'Queues a restore from a kept backup: files into a restore folder for Library Care, one item back in place, the database dump for the maintenance restore, or the whole library. Every file is checked against its SHA-256 before it is written; a file in the way is moved aside, never deleted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a restore from a kept backup: files into a restore folder for Library Care, one item back in place, the database dump for the maintenance restore, or the whole library. Every file is checked against its SHA-256 before it is written; a file in the way is moved aside, never deleted.",
  "operationId": "restoreCloudBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupRestoreDto"
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
  "summary": "Restore from a backup",
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

## startCloudBackupRun

`POST /api/admin/cloud/backup/runs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L117).

Back up now

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('runs')
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'startCloudBackupRun',
    summary: 'Back up now',
    description:
      'Queues a backup run, or answers with the one already queued or running. Only new or changed files upload.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a backup run, or answers with the one already queued or running. Only new or changed files upload.",
  "operationId": "startCloudBackupRun",
  "parameters": [],
  "responses": {
    "201": {
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
  "summary": "Back up now",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## cancelCloudBackupRun

`POST /api/admin/cloud/backup/runs/{id}/cancel`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L156).

Cancel a backup run

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('runs/:id/cancel')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'cancelCloudBackupRun',
    summary: 'Cancel a backup run',
    description:
      'The run stops without a manifest. Files it already uploaded stay in the bucket and are not uploaded again.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The run stops without a manifest. Files it already uploaded stay in the bucket and are not uploaded again.",
  "operationId": "cancelCloudBackupRun",
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
  "summary": "Cancel a backup run",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## pauseCloudBackupRun

`POST /api/admin/cloud/backup/runs/{id}/pause`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L130).

Pause a backup run

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('runs/:id/pause')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'pauseCloudBackupRun',
    summary: 'Pause a backup run',
    description: 'The run stops after the files in hand and carries on from there when resumed.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The run stops after the files in hand and carries on from there when resumed.",
  "operationId": "pauseCloudBackupRun",
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
  "summary": "Pause a backup run",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## resumeCloudBackupRun

`POST /api/admin/cloud/backup/runs/{id}/resume`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L143).

Resume a backup run

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('runs/:id/resume')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'resumeCloudBackupRun',
    summary: 'Resume a backup run',
    description: 'A paused run goes back to the queue and finishes the same manifest.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "A paused run goes back to the queue and finishes the same manifest.",
  "operationId": "resumeCloudBackupRun",
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
  "summary": "Resume a backup run",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## setupCloudBackup

`POST /api/admin/cloud/backup/setup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L77).

Set up cloud backup

Permission: `adminCloudBackup.update`. Admin only: `false`.

Models: [CloudBackupSetupDto](models-08.md#cloudbackupsetupdto), [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('setup')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupUpdate, admin: true })
@Endpoint({
    operationId: 'setupCloudBackup',
    summary: 'Set up cloud backup',
    description:
      'Claims the bucket for this server with the chosen key (an SSE-C write of frameleaf-backup.json holding the instance id) and turns cloud backup on. Refuses a bucket claimed by another server or holding other files, and a provider without SSE-C.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Claims the bucket for this server with the chosen key (an SSE-C write of frameleaf-backup.json holding the instance id) and turns cloud backup on. Refuses a bucket claimed by another server or holding other files, and a provider without SSE-C.",
  "operationId": "setupCloudBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupSetupDto"
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
  "summary": "Set up cloud backup",
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

## verifyCloudBackup

`POST /api/admin/cloud/backup/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-admin.controller.ts#L170).

Check the backed-up files

Permission: `adminCloudBackup.run`. Admin only: `false`.

Models: [CloudBackupStatusResponseDto](models-08.md#cloudbackupstatusresponsedto), [CloudBackupVerifyDto](models-08.md#cloudbackupverifydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('admin/cloud/backup')
@Post('verify')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudBackupRun, admin: true })
@Endpoint({
    operationId: 'verifyCloudBackup',
    summary: 'Check the backed-up files',
    description:
      'Queues a check of the bucket: sample fetches this week’s 1/52 of the files and checks each against its SHA-256; full checks every file a kept backup names is there. Missing or damaged files are uploaded again by the next run.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a check of the bucket: sample fetches this week’s 1/52 of the files and checks each against its SHA-256; full checks every file a kept backup names is there. Missing or damaged files are uploaded again by the next run.",
  "operationId": "verifyCloudBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudBackupVerifyDto"
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
  "summary": "Check the backed-up files",
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
  "x-immich-permission": "adminCloudBackup.run",
  "x-immich-state": "Alpha"
}
```

## restoreOwnBuddyBackup

`POST /api/users/me/buddy-backup/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/buddy-backup.controller.ts#L300).

Preview or restore own items or an album

Permission: `asset.update`. Admin only: `false`.

Models: [BuddyRestoreDto](models-07.md#buddyrestoredto), [BuddyRestoreResponseDto](models-07.md#buddyrestoreresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
@Post('restore')
@Authenticated({ permission: Permission.AssetUpdate, refreshElevation: false })
@Endpoint({ operationId: 'restoreOwnBuddyBackup', summary: 'Preview or restore own items or an album', history })
```

Complete operation contract:

```json
{
  "operationId": "restoreOwnBuddyBackup",
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
  "summary": "Preview or restore own items or an album",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## getOwnBuddyRestoreCheckpoint

`GET /api/users/me/buddy-backup/restores`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/buddy-backup.controller.ts#L275).

Resume an own Buddy restore

Permission: `asset.read`. Admin only: `false`.

Models: [BuddyRestoreCheckpointDto](models-07.md#buddyrestorecheckpointdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
@Get('restores')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({ operationId: 'getOwnBuddyRestoreCheckpoint', summary: 'Resume an own Buddy restore', history })
```

Complete operation contract:

```json
{
  "operationId": "getOwnBuddyRestoreCheckpoint",
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
  "summary": "Resume an own Buddy restore",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## getOwnBuddyRestoreStatus

`GET /api/users/me/buddy-backup/restores/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/buddy-backup.controller.ts#L306).

Get own Buddy restore progress

Permission: `asset.read`. Admin only: `false`.

Models: [BuddyRestoreStatusDto](models-07.md#buddyrestorestatusdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
@Get('restores/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({ operationId: 'getOwnBuddyRestoreStatus', summary: 'Get own Buddy restore progress', history })
```

Complete operation contract:

```json
{
  "operationId": "getOwnBuddyRestoreStatus",
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
  "summary": "Get own Buddy restore progress",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## listOwnBuddySnapshots

`GET /api/users/me/buddy-backup/snapshots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/buddy-backup.controller.ts#L282).

List own accessible Buddy restore points

Permission: `asset.read`. Admin only: `false`.

Models: [BuddySnapshotListDto](models-07.md#buddysnapshotlistdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
@Get('snapshots')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({ operationId: 'listOwnBuddySnapshots', summary: 'List own accessible Buddy restore points', history })
```

Complete operation contract:

```json
{
  "operationId": "listOwnBuddySnapshots",
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
  "summary": "List own accessible Buddy restore points",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## browseOwnBuddyBackup

`GET /api/users/me/buddy-backup/snapshots/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/buddy-backup.controller.ts#L289).

Browse own accessible backed-up items and albums

Permission: `asset.read`. Admin only: `false`.

Models: [BuddyBrowseDto](models-07.md#buddybrowsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/buddy-backup')
@Get('snapshots/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({
    operationId: 'browseOwnBuddyBackup',
    summary: 'Browse own accessible backed-up items and albums',
    history,
  })
```

Complete operation contract:

```json
{
  "operationId": "browseOwnBuddyBackup",
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
  "summary": "Browse own accessible backed-up items and albums",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## listOwnKeptBackups

`GET /api/users/me/cloud-backup/backups`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-owner.controller.ts#L73).

List own kept backups with accessible deleted history

Permission: `asset.read`. Admin only: `false`.

Models: [OwnerBackupsResponseDto](models-17.md#ownerbackupsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
@Get('backups')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({
    summary: 'List own kept backups with accessible deleted history',
    description:
      'Owner-only discovery. Foreign/private/unknown history is excluded before paging; no global counts. Search across all backups is not provided by this endpoint.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner-only discovery. Foreign/private/unknown history is excluded before paging; no global counts. Search across all backups is not provided by this endpoint.",
  "operationId": "listOwnKeptBackups",
  "parameters": [
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
            "$ref": "#/components/schemas/OwnerBackupsResponseDto"
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
  "summary": "List own kept backups with accessible deleted history",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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

## getOwnBackupHistory

`GET /api/users/me/cloud-backup/history`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/cloud-backup-owner.controller.ts#L89).

Search own deleted history in one kept backup

Permission: `asset.read`. Admin only: `false`.

Models: [OwnerBackupHistoryResponseDto](models-17.md#ownerbackuphistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudBackup)
@Controller('users/me/cloud-backup')
@Get('history')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({
    summary: 'Search own deleted history in one kept backup',
    description:
      'Caller-owned trashed/deleted entries from a chosen kept manifest. Unknown physical deletion dates are explicit; file modification and backup dates are never deletion dates. Historical missing owner/privacy evidence is excluded. Does not restore items.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Caller-owned trashed/deleted entries from a chosen kept manifest. Unknown physical deletion dates are explicit; file modification and backup dates are never deletion dates. Historical missing owner/privacy evidence is excluded. Does not restore items.",
  "operationId": "getOwnBackupHistory",
  "parameters": [
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
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/OwnerBackupHistoryResponseDto"
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
  "summary": "Search own deleted history in one kept backup",
  "tags": [
    "Frameleaf Cloud backup (admin)"
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
