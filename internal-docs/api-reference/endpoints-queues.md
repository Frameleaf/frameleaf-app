# Server API — Queues

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getStorageMigrationStatus

`GET /api/admin/storage-migration`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/storage-migration-admin.controller.ts#L18).

Get storage migration status

Permission: `queue.read`. Admin only: `true`.

Models: [StorageMigrationStatusResponseDto](models-33.md#storagemigrationstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('admin/storage-migration')
@Get()
@Authenticated({ permission: Permission.QueueRead, admin: true })
@Endpoint({
    summary: 'Get storage migration status',
    description:
      'Whether the storage template is on, which template originals are moved to, and where the storage template migration queue stands: running, paused, unfinished work and job counts.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether the storage template is on, which template originals are moved to, and where the storage template migration queue stands: running, paused, unfinished work and job counts.",
  "operationId": "getStorageMigrationStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StorageMigrationStatusResponseDto"
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
  "summary": "Get storage migration status",
  "tags": [
    "Queues"
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
  "x-immich-permission": "queue.read",
  "x-immich-state": "Alpha"
}
```

## runStorageMigrationInBackground

`POST /api/admin/storage-migration`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/storage-migration-admin.controller.ts#L30).

Run storage migration in the background

Permission: `queue.update`. Admin only: `true`.

Models: [StorageMigrationStatusResponseDto](models-33.md#storagemigrationstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('admin/storage-migration')
@Post()
@Authenticated({ permission: Permission.QueueUpdate, admin: true })
@HttpCode(HttpStatus.ACCEPTED)
@Endpoint({
    summary: 'Run storage migration in the background',
    description:
      'Start moving originals to the paths the storage template names, in the background, and return the status. Refused with 400 while the storage template is off and with 409 while a migration is already running.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Start moving originals to the paths the storage template names, in the background, and return the status. Refused with 400 while the storage template is off and with 409 while a migration is already running.",
  "operationId": "runStorageMigrationInBackground",
  "parameters": [],
  "responses": {
    "202": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StorageMigrationStatusResponseDto"
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
  "summary": "Run storage migration in the background",
  "tags": [
    "Queues"
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
  "x-immich-permission": "queue.update",
  "x-immich-state": "Alpha"
}
```

## getQueues

`GET /api/queues`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L25).

List all queues

Permission: `queue.read`. Admin only: `true`.

Models: [QueueResponseDto](models-28.md#queueresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Get()
@Authenticated({ permission: Permission.QueueRead, admin: true })
@Endpoint({
    summary: 'List all queues',
    description: 'Retrieves a list of queues.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieves a list of queues.",
  "operationId": "getQueues",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/QueueResponseDto"
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
  "summary": "List all queues",
  "tags": [
    "Queues"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.4.0",
      "state": "Added"
    },
    {
      "version": "v2.4.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "queue.read",
  "x-immich-state": "Alpha"
}
```

## getQueue

`GET /api/queues/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L36).

Retrieve a queue

Permission: `queue.read`. Admin only: `true`.

Models: [QueueName](models-28.md#queuename), [QueueResponseDto](models-28.md#queueresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Get(':name')
@Authenticated({ permission: Permission.QueueRead, admin: true })
@Endpoint({
    summary: 'Retrieve a queue',
    description: 'Retrieves a specific queue by its name.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieves a specific queue by its name.",
  "operationId": "getQueue",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/QueueResponseDto"
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
  "summary": "Retrieve a queue",
  "tags": [
    "Queues"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.4.0",
      "state": "Added"
    },
    {
      "version": "v2.4.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "queue.read",
  "x-immich-state": "Alpha"
}
```

## updateQueue

`PUT /api/queues/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L47).

Update a queue

Permission: `queue.update`. Admin only: `true`.

Models: [QueueName](models-28.md#queuename), [QueueResponseDto](models-28.md#queueresponsedto), [QueueUpdateDto](models-28.md#queueupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Put(':name')
@Authenticated({ permission: Permission.QueueUpdate, admin: true })
@Endpoint({
    summary: 'Update a queue',
    description: 'Change the paused status of a specific queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Change the paused status of a specific queue.",
  "operationId": "updateQueue",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/QueueUpdateDto"
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
            "$ref": "#/components/schemas/QueueResponseDto"
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
  "summary": "Update a queue",
  "tags": [
    "Queues"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.4.0",
      "state": "Added"
    },
    {
      "version": "v2.4.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "queue.update",
  "x-immich-state": "Alpha"
}
```

## emptyQueue

`DELETE /api/queues/{name}/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L110).

Empty a queue

Permission: `queueJob.delete`. Admin only: `true`.

Models: [QueueDeleteDto](models-28.md#queuedeletedto), [QueueName](models-28.md#queuename).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Delete(':name/jobs')
@Authenticated({ permission: Permission.QueueJobDelete, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Empty a queue',
    description: 'Removes all jobs from the specified queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes all jobs from the specified queue.",
  "operationId": "emptyQueue",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/QueueDeleteDto"
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
  "summary": "Empty a queue",
  "tags": [
    "Queues"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.4.0",
      "state": "Added"
    },
    {
      "version": "v2.4.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "queueJob.delete",
  "x-immich-state": "Alpha"
}
```

## getQueueJobs

`GET /api/queues/{name}/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L62).

Retrieve queue jobs

Permission: `queueJob.read`. Admin only: `true`.

Models: [QueueJobResponseDto](models-28.md#queuejobresponsedto), [QueueJobStatus](models-28.md#queuejobstatus), [QueueName](models-28.md#queuename).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Get(':name/jobs')
@Authenticated({ permission: Permission.QueueJobRead, admin: true })
@Endpoint({
    summary: 'Retrieve queue jobs',
    description: 'Retrieves a list of queue jobs from the specified queue.',
    history: new HistoryBuilder().added('v2.4.0').alpha('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieves a list of queue jobs from the specified queue.",
  "operationId": "getQueueJobs",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    },
    {
      "name": "ownerId",
      "required": false,
      "in": "query",
      "description": "Only jobs whose item belongs to this account (FL-71 account filter)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "status",
      "required": false,
      "in": "query",
      "description": "Filter jobs by status",
      "schema": {
        "type": "array",
        "items": {
          "$ref": "#/components/schemas/QueueJobStatus"
        }
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/QueueJobResponseDto"
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
  "summary": "Retrieve queue jobs",
  "tags": [
    "Queues"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v2.4.0",
      "state": "Added"
    },
    {
      "version": "v2.4.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "queueJob.read",
  "x-immich-state": "Alpha"
}
```

## retryFailedQueueJobs

`POST /api/queues/{name}/jobs/retry-failed`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L95).

Retry failed queue jobs

Permission: `queueJob.create`. Admin only: `true`.

Models: [QueueName](models-28.md#queuename), [QueueRetryFailedResponseDto](models-28.md#queueretryfailedresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Post(':name/jobs/retry-failed')
@Authenticated({ permission: Permission.QueueJobCreate, admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Retry failed queue jobs',
    description: 'Puts every failed job of the specified queue back in the queue with its saved data.',
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Puts every failed job of the specified queue back in the queue with its saved data.",
  "operationId": "retryFailedQueueJobs",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/QueueRetryFailedResponseDto"
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
  "summary": "Retry failed queue jobs",
  "tags": [
    "Queues"
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
  "x-immich-permission": "queueJob.create",
  "x-immich-state": "Alpha"
}
```

## getQueueOwnerStatistics

`GET /api/queues/{name}/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/queue.controller.ts#L78).

Retrieve queue statistics for an account

Permission: `queueJob.read`. Admin only: `true`.

Models: [QueueName](models-28.md#queuename), [QueueOwnerStatisticsResponseDto](models-28.md#queueownerstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Queues)
@Controller('queues')
@Get(':name/statistics')
@Authenticated({ permission: Permission.QueueJobRead, admin: true })
@Endpoint({
    summary: 'Retrieve queue statistics for an account',
    description:
      "Counts, per state, the jobs of the specified queue that work on one account's items. At most 1,000 jobs of each state are read; `truncated` marks lower bounds.",
    history: new HistoryBuilder().added('v3').alpha('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Counts, per state, the jobs of the specified queue that work on one account's items. At most 1,000 jobs of each state are read; `truncated` marks lower bounds.",
  "operationId": "getQueueOwnerStatistics",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/QueueName"
      }
    },
    {
      "name": "ownerId",
      "required": true,
      "in": "query",
      "description": "The account whose jobs are counted",
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
            "$ref": "#/components/schemas/QueueOwnerStatisticsResponseDto"
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
  "summary": "Retrieve queue statistics for an account",
  "tags": [
    "Queues"
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
  "x-immich-permission": "queueJob.read",
  "x-immich-state": "Alpha"
}
```
