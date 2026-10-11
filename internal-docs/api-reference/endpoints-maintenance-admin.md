# Server API — Maintenance (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getIntegrityReport

`GET /api/admin/integrity/report`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L50).

Get integrity report by type

Permission: `maintenance`. Admin only: `true`.

Models: [IntegrityReport](models-14.md#integrityreport), [IntegrityReportResponseDto](models-14.md#integrityreportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Get('report')
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Get integrity report by type',
    description: 'Get all flagged items by integrity report type',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Get all flagged items by integrity report type",
  "operationId": "getIntegrityReport",
  "parameters": [
    {
      "name": "cursor",
      "required": false,
      "in": "query",
      "description": "Cursor for pagination",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "limit",
      "required": false,
      "in": "query",
      "description": "Number of items per page",
      "schema": {
        "maximum": 9007199254740991,
        "exclusiveMinimum": true,
        "default": 500,
        "type": "integer",
        "minimum": 0
      }
    },
    {
      "name": "type",
      "required": true,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/IntegrityReport"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/IntegrityReportResponseDto"
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
  "summary": "Get integrity report by type",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## deleteIntegrityReport

`DELETE /api/admin/integrity/report/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L80).

Delete integrity report item

Permission: `maintenance`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Delete('report/:id')
@Endpoint({
    summary: 'Delete integrity report item',
    description: 'Delete a given report item and perform corresponding deletion (e.g. trash asset, delete file)',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Delete a given report item and perform corresponding deletion (e.g. trash asset, delete file)",
  "operationId": "deleteIntegrityReport",
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
  "summary": "Delete integrity report item",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## getIntegrityReportFile

`GET /api/admin/integrity/report/{id}/file`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L62).

Download flagged file

Permission: `maintenance`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Get('report/:id/file')
@Endpoint({
    summary: 'Download flagged file',
    description: 'Download the untracked/broken file if one exists',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
@FileResponse()
@Authenticated({ permission: Permission.Maintenance, admin: true })
@OriginalTransfer()
```

Complete operation contract:

```json
{
  "description": "Download the untracked/broken file if one exists",
  "operationId": "getIntegrityReportFile",
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
  "summary": "Download flagged file",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## getIntegrityReportCsv

`GET /api/admin/integrity/report/{type}/csv`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L91).

Export integrity report by type as CSV

Permission: `maintenance`. Admin only: `true`.

Models: [IntegrityReport](models-14.md#integrityreport).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Get('report/:type/csv')
@Endpoint({
    summary: 'Export integrity report by type as CSV',
    description: 'Get all integrity report entries for a given type as a CSV',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
@FileResponse()
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Get all integrity report entries for a given type as a CSV",
  "operationId": "getIntegrityReportCsv",
  "parameters": [
    {
      "name": "type",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/IntegrityReport"
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
  "summary": "Export integrity report by type as CSV",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## getIntegrityCheckRuns

`GET /api/admin/integrity/runs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L39).

Get integrity check runs

Permission: `maintenance`. Admin only: `true`.

Models: [IntegrityCheckRunsResponseDto](models-14.md#integritycheckrunsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Get('runs')
@Endpoint({
    summary: 'Get integrity check runs',
    description: 'Get when each integrity check last completed a full run',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Get when each integrity check last completed a full run",
  "operationId": "getIntegrityCheckRuns",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/IntegrityCheckRunsResponseDto"
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
  "summary": "Get integrity check runs",
  "tags": [
    "Maintenance (admin)"
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

## getIntegrityReportSummary

`GET /api/admin/integrity/summary`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/integrity-admin.controller.ts#L28).

Get integrity report summary

Permission: `maintenance`. Admin only: `true`.

Models: [IntegrityReportSummaryResponseDto](models-14.md#integrityreportsummaryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/integrity')
@Get('summary')
@Endpoint({
    summary: 'Get integrity report summary',
    description: 'Get a count of the items flagged in each integrity report',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Get a count of the items flagged in each integrity report",
  "operationId": "getIntegrityReportSummary",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/IntegrityReportSummaryResponseDto"
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
  "summary": "Get integrity report summary",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## setMaintenanceMode

`POST /api/admin/maintenance`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/maintenance.controller.ts#L57).

Set maintenance mode

Permission: `maintenance`. Admin only: `true`.

Models: [SetMaintenanceModeDto](models-32.md#setmaintenancemodedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/maintenance')
@Post()
@Endpoint({
    summary: 'Set maintenance mode',
    description: 'Put Frameleaf into or take it out of maintenance mode',
    history: new HistoryBuilder().added('v2.3.0').alpha('v2.3.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Put Frameleaf into or take it out of maintenance mode",
  "operationId": "setMaintenanceMode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SetMaintenanceModeDto"
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
  "summary": "Set maintenance mode",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.3.0",
      "state": "Added"
    },
    {
      "version": "v2.3.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## detectPriorInstall

`GET /api/admin/maintenance/detect-install`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/maintenance.controller.ts#L35).

Detect existing install

Permission: `maintenance`. Admin only: `true`.

Models: [MaintenanceDetectInstallResponseDto](models-16.md#maintenancedetectinstallresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/maintenance')
@Get('detect-install')
@Endpoint({
    summary: 'Detect existing install',
    description: 'Collect integrity checks and other heuristics about local data.',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ permission: Permission.Maintenance, admin: true })
```

Complete operation contract:

```json
{
  "description": "Collect integrity checks and other heuristics about local data.",
  "operationId": "detectPriorInstall",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MaintenanceDetectInstallResponseDto"
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
  "summary": "Detect existing install",
  "tags": [
    "Maintenance (admin)"
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

## maintenanceLogin

`POST /api/admin/maintenance/login`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/maintenance.controller.ts#L46).

Log into maintenance mode

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MaintenanceAuthDto](models-16.md#maintenanceauthdto), [MaintenanceLoginDto](models-16.md#maintenancelogindto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/maintenance')
@Post('login')
@Endpoint({
    summary: 'Log into maintenance mode',
    description: 'Login with maintenance token or cookie to receive current information and perform further actions.',
    history: new HistoryBuilder().added('v2.3.0').alpha('v2.3.0'),
  })
@Authenticated({ public: true })
```

Complete operation contract:

```json
{
  "description": "Login with maintenance token or cookie to receive current information and perform further actions.",
  "operationId": "maintenanceLogin",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MaintenanceLoginDto"
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
            "$ref": "#/components/schemas/MaintenanceAuthDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Log into maintenance mode",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-history": [
    {
      "version": "v2.3.0",
      "state": "Added"
    },
    {
      "version": "v2.3.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getMaintenanceStatus

`GET /api/admin/maintenance/status`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/maintenance.controller.ts#L24).

Get maintenance mode status

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MaintenanceStatusResponseDto](models-16.md#maintenancestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/maintenance')
@Get('status')
@Endpoint({
    summary: 'Get maintenance mode status',
    description: 'Fetch information about the currently running maintenance action.',
    history: new HistoryBuilder().added('v2.5.0').alpha('v2.5.0'),
  })
@Authenticated({ public: true })
```

Complete operation contract:

```json
{
  "description": "Fetch information about the currently running maintenance action.",
  "operationId": "getMaintenanceStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MaintenanceStatusResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get maintenance mode status",
  "tags": [
    "Maintenance (admin)"
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

## restorePhysicalDeduplicationCopy

`POST /api/admin/physical-deduplication/applies/{id}/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L102).

Restore a copy of an applied physical deduplication plan

Permission: `job.create`. Admin only: `true`.

Models: [PhysicalDeduplicationRestoreRequestDto](models-27.md#physicaldeduplicationrestorerequestdto), [PhysicalDeduplicationVerificationDto](models-27.md#physicaldeduplicationverificationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Post('applies/:id/restore')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.JobCreate, admin: true })
@Endpoint({
    summary: 'Restore a copy of an applied physical deduplication plan',
    description:
      'Point one copy back at its own former file, only while that file is still on disk with the reviewed checksum and size, and answer with the plan verified again. A copy whose own file was removed cannot be restored.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Point one copy back at its own former file, only while that file is still on disk with the reviewed checksum and size, and answer with the plan verified again. A copy whose own file was removed cannot be restored.",
  "operationId": "restorePhysicalDeduplicationCopy",
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
          "$ref": "#/components/schemas/PhysicalDeduplicationRestoreRequestDto"
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
            "$ref": "#/components/schemas/PhysicalDeduplicationVerificationDto"
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
  "summary": "Restore a copy of an applied physical deduplication plan",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.create",
  "x-immich-state": "Alpha"
}
```

## verifyPhysicalDeduplicationApply

`POST /api/admin/physical-deduplication/applies/{id}/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L86).

Verify an applied physical deduplication plan

Permission: `job.read`. Admin only: `true`.

Models: [PhysicalDeduplicationVerificationDto](models-27.md#physicaldeduplicationverificationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Post('applies/:id/verify')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.JobRead, admin: true })
@Endpoint({
    summary: 'Verify an applied physical deduplication plan',
    description:
      'Hash every retained original the applied plan shares again and check that every copy it changed still resolves to one. Reports, per copy, whether its own former file is gone (which cannot be undone) or still on disk (which can be restored). Nothing is written.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Hash every retained original the applied plan shares again and check that every copy it changed still resolves to one. Reports, per copy, whether its own former file is gone (which cannot be undone) or still on disk (which can be restored). Nothing is written.",
  "operationId": "verifyPhysicalDeduplicationApply",
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
            "$ref": "#/components/schemas/PhysicalDeduplicationVerificationDto"
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
  "summary": "Verify an applied physical deduplication plan",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.read",
  "x-immich-state": "Alpha"
}
```

## applyPhysicalDeduplicationPlan

`POST /api/admin/physical-deduplication/plan/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L70).

Apply a reviewed physical deduplication plan

Permission: `job.create`. Admin only: `true`.

Models: [MediaOperationDto](models-17.md#mediaoperationdto), [PhysicalDeduplicationApplyRequestDto](models-27.md#physicaldeduplicationapplyrequestdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Post('plan/apply')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.JobCreate, admin: true })
@Endpoint({
    summary: 'Apply a reviewed physical deduplication plan',
    description:
      'Queue exactly the reviewed copies as a durable, pausable job. Requires the review token and the typed confirmation. Answers 409 when another plan is being applied or anything changed since the review.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue exactly the reviewed copies as a durable, pausable job. Requires the review token and the typed confirmation. Answers 409 when another plan is being applied or anything changed since the review.",
  "operationId": "applyPhysicalDeduplicationPlan",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhysicalDeduplicationApplyRequestDto"
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
            "$ref": "#/components/schemas/MediaOperationDto"
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
  "summary": "Apply a reviewed physical deduplication plan",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.create",
  "x-immich-state": "Alpha"
}
```

## reviewPhysicalDeduplicationPlan

`POST /api/admin/physical-deduplication/plan/review`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L54).

Review a physical deduplication plan

Permission: `job.create`. Admin only: `true`.

Models: [PhysicalDeduplicationReviewRequestDto](models-27.md#physicaldeduplicationreviewrequestdto), [PhysicalDeduplicationReviewResponseDto](models-27.md#physicaldeduplicationreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Post('plan/review')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.JobCreate, admin: true })
@Endpoint({
    summary: 'Review a physical deduplication plan',
    description:
      'Check the plan on screen against the library again and bind the per-group decisions to it. Answers 409 when a newer preview replaced the plan, it was applied, or any checksum, ownership, path or reference evidence changed. Nothing is written.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Check the plan on screen against the library again and bind the per-group decisions to it. Answers 409 when a newer preview replaced the plan, it was applied, or any checksum, ownership, path or reference evidence changed. Nothing is written.",
  "operationId": "reviewPhysicalDeduplicationPlan",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhysicalDeduplicationReviewRequestDto"
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
            "$ref": "#/components/schemas/PhysicalDeduplicationReviewResponseDto"
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
  "summary": "Review a physical deduplication plan",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.create",
  "x-immich-state": "Alpha"
}
```

## getPhysicalDeduplicationPreview

`GET /api/admin/physical-deduplication/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L29).

Get physical deduplication preview

Permission: `job.read`. Admin only: `true`.

Models: [PhysicalDeduplicationPreviewResponseDto](models-27.md#physicaldeduplicationpreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Get('preview')
@Authenticated({ permission: Permission.JobRead, admin: true })
@Endpoint({
    summary: 'Get physical deduplication preview',
    description:
      'Return the latest physical deduplication plan with per-copy evidence, and the plans being applied or applied recently. Thumbnail visibility is the asset access of the requesting administrator, evaluated on every read.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Return the latest physical deduplication plan with per-copy evidence, and the plans being applied or applied recently. Thumbnail visibility is the asset access of the requesting administrator, evaluated on every read.",
  "operationId": "getPhysicalDeduplicationPreview",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhysicalDeduplicationPreviewResponseDto"
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
  "summary": "Get physical deduplication preview",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.read",
  "x-immich-state": "Alpha"
}
```

## requestPhysicalDeduplicationPreview

`POST /api/admin/physical-deduplication/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-deduplication.controller.ts#L41).

Request physical deduplication preview

Permission: `job.create`. Admin only: `true`.

Models: [PhysicalDeduplicationPreviewRequestDto](models-27.md#physicaldeduplicationpreviewrequestdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Maintenance)
@Controller('admin/physical-deduplication')
@Post('preview')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.JobCreate, admin: true })
@Endpoint({
    summary: 'Request physical deduplication preview',
    description:
      'Queue a dry run that may retain originals in an account chosen for the preview and may review the copies of one account. Applying needs a reviewed plan and the saved master account.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue a dry run that may retain originals in an account chosen for the preview and may review the copies of one account. Applying needs a reviewed plan and the saved master account.",
  "operationId": "requestPhysicalDeduplicationPreview",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhysicalDeduplicationPreviewRequestDto"
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
  "summary": "Request physical deduplication preview",
  "tags": [
    "Maintenance (admin)"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "job.create",
  "x-immich-state": "Alpha"
}
```
