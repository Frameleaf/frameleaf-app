# Server API — Database Backups (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteDatabaseBackup

`DELETE /api/admin/database-backups`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L101).

Delete database backup

Permission: `backup.delete`. Admin only: `true`.

Models: [DatabaseBackupDeleteDto](models-10.md#databasebackupdeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Delete()
@Endpoint({
    summary: 'Delete database backup',
    description: 'Delete a backup by its filename',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ permission: Permission.BackupDelete, admin: true })
```

Complete operation contract:

```json
{
  "description": "Delete a backup by its filename",
  "operationId": "deleteDatabaseBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/DatabaseBackupDeleteDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
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
  "summary": "Delete database backup",
  "tags": [
    "Database Backups (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.5.0",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "backup.delete",
  "x-immich-state": "Alpha"
}
```

## listDatabaseBackups

`GET /api/admin/database-backups`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L46).

List database backups

Permission: `maintenance`. Admin only: `true`.

Models: [DatabaseBackupListResponseDto](models-10.md#databasebackuplistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Get()
@Endpoint({
    summary: 'List database backups',
    description: 'Get the list of the successful and failed backups',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Get the list of the successful and failed backups",
  "operationId": "listDatabaseBackups",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/DatabaseBackupListResponseDto"
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
  "summary": "List database backups",
  "tags": [
    "Database Backups (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.5.0",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## getBackupRestoreVerification

`GET /api/admin/database-backups/restore-verification`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L58).

Get backup restore verification

Permission: `maintenance`. Admin only: `true`.

Models: [BackupRestoreVerificationResponseDto](models-06.md#backuprestoreverificationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Get('restore-verification')
@Endpoint({
    summary: 'Get backup restore verification',
    description: 'When restoring the database and the original files was last proved, and whether a test is due',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "When restoring the database and the original files was last proved, and whether a test is due",
  "operationId": "getBackupRestoreVerification",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/BackupRestoreVerificationResponseDto"
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
  "summary": "Get backup restore verification",
  "tags": [
    "Database Backups (admin)"
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
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## recordBackupRestoreVerification

`POST /api/admin/database-backups/restore-verification`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L69).

Record a backup restore test

Permission: `maintenance`. Admin only: `true`.

Models: [BackupRestoreVerificationRecordDto](models-06.md#backuprestoreverificationrecorddto), [BackupRestoreVerificationResponseDto](models-06.md#backuprestoreverificationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Post('restore-verification')
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Record a backup restore test',
    description: 'Records that restoring the database, the original files or both was proved just now',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Records that restoring the database, the original files or both was proved just now",
  "operationId": "recordBackupRestoreVerification",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/BackupRestoreVerificationRecordDto"
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
            "$ref": "#/components/schemas/BackupRestoreVerificationResponseDto"
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
  "summary": "Record a backup restore test",
  "tags": [
    "Database Backups (admin)"
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
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## startDatabaseRestoreFlow

`POST /api/admin/database-backups/start-restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L112).

Start database backup restore flow

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Post('start-restore')
@Endpoint({
    summary: 'Start database backup restore flow',
    description: 'Put Frameleaf into maintenance mode to restore a backup (Frameleaf must not be configured)',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ public: true, setup: true })
```

Complete operation contract:

```json
{
  "description": "Put Frameleaf into maintenance mode to restore a backup (Frameleaf must not be configured)",
  "operationId": "startDatabaseRestoreFlow",
  "parameters": [],
  "responses": {
    "201": {
      "description": ""
    }
  },
  "summary": "Start database backup restore flow",
  "tags": [
    "Database Backups (admin)"
  ],
  "x-immich-history": [
    {
      "version": "v2.5.0",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## uploadDatabaseBackup

`POST /api/admin/database-backups/upload`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L130).

Upload database backup

Permission: `backup.upload`. Admin only: `true`.

Models: [DatabaseBackupUploadDto](models-10.md#databasebackupuploaddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Post('upload')
@Authenticated({ permission: Permission.BackupUpload, admin: true })
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'Backup Upload', type: DatabaseBackupUploadDto })
@Endpoint({
    summary: 'Upload database backup',
    description: 'Uploads .sql/.sql.gz file to restore backup from',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@UseInterceptors(FileInterceptor('file'))
```

Complete operation contract:

```json
{
  "description": "Uploads .sql/.sql.gz file to restore backup from",
  "operationId": "uploadDatabaseBackup",
  "parameters": [],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/DatabaseBackupUploadDto"
        }
      }
    },
    "description": "Backup Upload",
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
  "summary": "Upload database backup",
  "tags": [
    "Database Backups (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.5.0",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "backup.upload",
  "x-immich-state": "Alpha"
}
```

## downloadDatabaseBackup

`GET /api/admin/database-backups/{filename}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/database-backup.controller.ts#L84).

Download database backup

Permission: `backup.download`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.DatabaseBackups)
@Controller('admin/database-backups')
@Get(':filename')
@FileResponse()
@Endpoint({
    summary: 'Download database backup',
    description: 'Downloads the database backup file',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ permission: Permission.BackupDownload, admin: true })
@OriginalTransfer()
```

Complete operation contract:

```json
{
  "description": "Downloads the database backup file",
  "operationId": "downloadDatabaseBackup",
  "parameters": [
    {
      "name": "filename",
      "required": true,
      "in": "path",
      "schema": {
        "pattern": "^[a-zA-Z0-9_\\-.]+$",
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
  "summary": "Download database backup",
  "tags": [
    "Database Backups (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.5.0",
      "state": "Added"
    },
    {
      "version": "v2.5.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "backup.download",
  "x-immich-state": "Alpha"
}
```
