# Server API — Jobs

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getQueuesLegacy

`GET /api/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L39).

Retrieve queue counts and status

Permission: `job.read`. Admin only: `true`.

Models: [QueuesResponseLegacyDto](models-28.md#queuesresponselegacydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Get()
@Authenticated({ permission: Permission.JobRead, admin: true })
@Endpoint({
    summary: 'Retrieve queue counts and status',
    description: 'Retrieve the counts of the current queue, as well as the current status.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2').deprecated('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Retrieve the counts of the current queue, as well as the current status.",
  "operationId": "getQueuesLegacy",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/QueuesResponseLegacyDto"
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
  "summary": "Retrieve queue counts and status",
  "tags": [
    "Jobs",
    "Deprecated"
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
    },
    {
      "version": "v2.4.0",
      "state": "Deprecated"
    }
  ],
  "x-immich-permission": "job.read",
  "x-immich-state": "Deprecated"
}
```

## createJob

`POST /api/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L64).

Create a manual job

Permission: `job.create`. Admin only: `true`.

Models: [JobCreateDto](models-13.md#jobcreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Post()
@Authenticated({ permission: Permission.JobCreate, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Create a manual job',
    description:
      'Run a specific job. Most jobs are queued automatically, but this endpoint allows for manual creation of a handful of jobs, including various cleanup tasks, as well as creating a new database backup.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Run a specific job. Most jobs are queued automatically, but this endpoint allows for manual creation of a handful of jobs, including various cleanup tasks, as well as creating a new database backup.",
  "operationId": "createJob",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/JobCreateDto"
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
  "summary": "Create a manual job",
  "tags": [
    "Jobs"
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
  "x-immich-permission": "job.create",
  "x-immich-state": "Stable"
}
```

## getRunningJobs

`GET /api/jobs/running`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L52).

Get running jobs

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RunningJobsResponseDto](models-29.md#runningjobsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Get('running')
@Authenticated()
@Endpoint({
    summary: 'Get running jobs',
    description:
      'Everything running in the background that the signed-in account may see, in one answer: its own unfinished media operations (paused ones included) and highlight exports, and for administrators every server job queue that has work, with the progress of its current run. Non-administrators always receive an empty queue list.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Everything running in the background that the signed-in account may see, in one answer: its own unfinished media operations (paused ones included) and highlight exports, and for administrators every server job queue that has work, with the progress of its current run. Non-administrators always receive an empty queue list.",
  "operationId": "getRunningJobs",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RunningJobsResponseDto"
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
  "summary": "Get running jobs",
  "tags": [
    "Jobs"
  ],
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
  "x-immich-state": "Alpha"
}
```

## getJobRuns

`GET /api/jobs/runs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L25).

List durable job runs

Permission: `job.read`. Admin only: `true`.

Models: [JobRunPageDto](models-13.md#jobrunpagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Get('runs')
@Authenticated({ permission: Permission.JobRead, admin: true })
@Endpoint({ summary: 'List durable job runs', history: new HistoryBuilder().added('v3').alpha('v3') })
```

Complete operation contract:

```json
{
  "operationId": "getJobRuns",
  "parameters": [
    {
      "name": "skip",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "default": 0,
        "type": "integer"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 100,
        "default": 25,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/JobRunPageDto"
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
  "summary": "List durable job runs",
  "tags": [
    "Jobs"
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
  "x-immich-permission": "job.read",
  "x-immich-state": "Alpha"
}
```

## getJobRunItems

`GET /api/jobs/runs/{id}/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L32).

Inspect selected job run items

Permission: `job.read`. Admin only: `true`.

Models: [JobRunItemPageDto](models-13.md#jobrunitempagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Get('runs/:id/items')
@Authenticated({ permission: Permission.JobRead, admin: true })
@Endpoint({ summary: 'Inspect selected job run items', history: new HistoryBuilder().added('v3').alpha('v3') })
```

Complete operation contract:

```json
{
  "operationId": "getJobRunItems",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "skip",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "default": 0,
        "type": "integer"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 100,
        "default": 25,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/JobRunItemPageDto"
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
  "summary": "Inspect selected job run items",
  "tags": [
    "Jobs"
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
  "x-immich-permission": "job.read",
  "x-immich-state": "Alpha"
}
```

## runQueueCommandLegacy

`PUT /api/jobs/{name}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/job.controller.ts#L77).

Run jobs

Permission: `job.create`. Admin only: `true`.

Models: [QueueCommandDto](models-27.md#queuecommanddto), [QueueName](models-27.md#queuename), [QueueResponseLegacyDto](models-27.md#queueresponselegacydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Jobs)
@Controller('jobs')
@Put(':name')
@Authenticated({ permission: Permission.JobCreate, admin: true })
@Endpoint({
    summary: 'Run jobs',
    description:
      'Queue all assets for a specific job type. Defaults to only queueing assets that have not yet been processed, but the force command can be used to re-process all assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2').deprecated('v2.4.0'),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Queue all assets for a specific job type. Defaults to only queueing assets that have not yet been processed, but the force command can be used to re-process all assets.",
  "operationId": "runQueueCommandLegacy",
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
          "$ref": "#/components/schemas/QueueCommandDto"
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
            "$ref": "#/components/schemas/QueueResponseLegacyDto"
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
  "summary": "Run jobs",
  "tags": [
    "Jobs",
    "Deprecated"
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
    },
    {
      "version": "v2.4.0",
      "state": "Deprecated"
    }
  ],
  "x-immich-permission": "job.create",
  "x-immich-state": "Deprecated"
}
```
