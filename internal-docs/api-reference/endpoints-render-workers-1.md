# Server API — Render workers 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## listRenderWorkers

`GET /api/admin/render-workers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L88).

List render workers

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerDto](models-30.md#renderworkerdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Get()
@Authenticated({ admin: true })
@Endpoint({
    summary: 'List render workers',
    description: 'Every enrolled worker identity with its destination, scopes, ceilings and current load.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Every enrolled worker identity with its destination, scopes, ceilings and current load.",
  "operationId": "listRenderWorkers",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/RenderWorkerDto"
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
  "summary": "List render workers",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## createRenderWorker

`POST /api/admin/render-workers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L99).

Enrol a render worker

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerCreateDto](models-30.md#renderworkercreatedto), [RenderWorkerCreateResponseDto](models-30.md#renderworkercreateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Post()
@HttpCode(HttpStatus.CREATED)
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Enrol a render worker',
    description:
      'Creates a worker identity and returns its enrolment secret once. The server stores only a hash; the secret cannot be recovered later.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Creates a worker identity and returns its enrolment secret once. The server stores only a hash; the secret cannot be recovered later.",
  "operationId": "createRenderWorker",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerCreateDto"
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
            "$ref": "#/components/schemas/RenderWorkerCreateResponseDto"
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
  "summary": "Enrol a render worker",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## searchRenderWorkerAudit

`GET /api/admin/render-workers/audit`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L153).

Search the render worker audit trail

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerAuditDto](models-30.md#renderworkerauditdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Get('audit')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Search the render worker audit trail',
    description:
      'Enrolments, admissions, refusals, limit breaches and revocations, newest first. Never a secret or a path.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Enrolments, admissions, refusals, limit breaches and revocations, newest first. Never a secret or a path.",
  "operationId": "searchRenderWorkerAudit",
  "parameters": [
    {
      "name": "take",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 500,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "workerId",
      "required": false,
      "in": "query",
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
            "items": {
              "$ref": "#/components/schemas/RenderWorkerAuditDto"
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
  "summary": "Search the render worker audit trail",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## getRenderWorkerCompatibility

`GET /api/admin/render-workers/compatibility`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L165).

Get render worker compatibility

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerCompatibilityResponseDto](models-30.md#renderworkercompatibilityresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Get('compatibility')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get render worker compatibility',
    description:
      'Which render kinds a qualified GPU worker (live session, fresh conformance, pinned engine) can take right now.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Which render kinds a qualified GPU worker (live session, fresh conformance, pinned engine) can take right now.",
  "operationId": "getRenderWorkerCompatibility",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RenderWorkerCompatibilityResponseDto"
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
  "summary": "Get render worker compatibility",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## getRenderWorkerLimits

`GET /api/admin/render-workers/limits`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L115).

Get render limits

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerLimitsResponseDto](models-30.md#renderworkerlimitsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Get('limits')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get render limits',
    description:
      'The instance default and every per-account ceiling on concurrent operations, wall-clock and output size.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The instance default and every per-account ceiling on concurrent operations, wall-clock and output size.",
  "operationId": "getRenderWorkerLimits",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/RenderWorkerLimitsResponseDto"
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
  "summary": "Get render limits",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## updateRenderWorkerLimits

`PUT /api/admin/render-workers/limits`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L127).

Set render limits

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerLimitDto](models-30.md#renderworkerlimitdto), [RenderWorkerLimitUpdateDto](models-30.md#renderworkerlimitupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Put('limits')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Set render limits',
    description: 'Sets the instance default when `userId` is omitted, otherwise the ceiling for one account.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Sets the instance default when `userId` is omitted, otherwise the ceiling for one account.",
  "operationId": "updateRenderWorkerLimits",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerLimitUpdateDto"
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
            "$ref": "#/components/schemas/RenderWorkerLimitDto"
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
  "summary": "Set render limits",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## deleteRenderWorkerUserLimit

`DELETE /api/admin/render-workers/limits/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L141).

Remove an account’s render limits

Permission: `See authentication declaration`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Delete('limits/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Remove an account’s render limits',
    description: 'The account falls back to the instance default.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The account falls back to the instance default.",
  "operationId": "deleteRenderWorkerUserLimit",
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
  "summary": "Remove an account’s render limits",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## revokeRenderWorker

`DELETE /api/admin/render-workers/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L203).

Revoke a render worker

Permission: `See authentication declaration`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Revoke a render worker',
    description:
      'Revokes the identity and every session it holds. Claims it held expire into the recovery pass; the record is kept for the audit trail.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Revokes the identity and every session it holds. Claims it held expire into the recovery pass; the record is kept for the audit trail.",
  "operationId": "revokeRenderWorker",
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
  "summary": "Revoke a render worker",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## getRenderWorker

`GET /api/admin/render-workers/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L177).

Get a render worker

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerDto](models-30.md#renderworkerdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Get(':id')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get a render worker',
    description: 'One worker identity with its current load.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "One worker identity with its current load.",
  "operationId": "getRenderWorker",
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
            "$ref": "#/components/schemas/RenderWorkerDto"
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
  "summary": "Get a render worker",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## updateRenderWorker

`PUT /api/admin/render-workers/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L188).

Update a render worker

Permission: `See authentication declaration`. Admin only: `true`.

Models: [RenderWorkerDto](models-30.md#renderworkerdto), [RenderWorkerUpdateDto](models-30.md#renderworkerupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('admin/render-workers')
@Put(':id')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Update a render worker',
    description: 'Changes the name, scopes, required engine digest and ceilings. A revoked worker cannot be changed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Changes the name, scopes, required engine digest and ceilings. A revoked worker cannot be changed.",
  "operationId": "updateRenderWorker",
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
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerUpdateDto"
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
            "$ref": "#/components/schemas/RenderWorkerDto"
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
  "summary": "Update a render worker",
  "tags": [
    "Render workers"
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
  "x-immich-state": "Alpha"
}
```

## admitRenderWorker

`POST /api/render-workers/admission`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L246).

Admit a render worker

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerAdmissionDto](models-29.md#renderworkeradmissiondto), [RenderWorkerSessionDto](models-30.md#renderworkersessiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('admission')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ public: true })
@Endpoint({
    summary: 'Admit a render worker',
    description:
      'Exchanges the enrolment secret and fresh conformance evidence for a scoped, expiring session credential. Refusals are audited and answered generically.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Exchanges the enrolment secret and fresh conformance evidence for a scoped, expiring session credential. Refusals are audited and answered generically.",
  "operationId": "admitRenderWorker",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerAdmissionDto"
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
            "$ref": "#/components/schemas/RenderWorkerSessionDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Admit a render worker",
  "tags": [
    "Render workers"
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

## claimRenderOperation

`POST /api/render-workers/claims`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L259).

Claim the next admitted operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerClaimDto](models-30.md#renderworkerclaimdto), [RenderWorkerClaimRequestDto](models-30.md#renderworkerclaimrequestdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('claims')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Claim the next admitted operation',
    description:
      'Returns the oldest queued operation this worker is admitted to run, with its claim token, checkpoints and short-lived input grants. Answers 204 when nothing is admissible.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Returns the oldest queued operation this worker is admitted to run, with its claim token, checkpoints and short-lived input grants. Answers 204 when nothing is admissible.",
  "operationId": "claimRenderOperation",
  "parameters": [
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerClaimRequestDto"
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
            "$ref": "#/components/schemas/RenderWorkerClaimDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Claim the next admitted operation",
  "tags": [
    "Render workers"
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

## readRenderArtifact

`GET /api/render-workers/operations/{id}/artifacts/{sequence}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L504).

Read a verified whole-export artifact under the current claim

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Get('operations/:id/artifacts/:sequence')
@FileResponse()
@WorkerSessionHeader()
@ApiHeader({ name: 'x-render-claim-token', required: true })
@Authenticated({ public: true })
@Endpoint({ summary: 'Read a verified whole-export artifact under the current claim', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "readRenderArtifact",
  "parameters": [
    {
      "name": "chunkKey",
      "required": true,
      "in": "query",
      "schema": {
        "minLength": 1,
        "maxLength": 256,
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "role",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string",
        "enum": [
          "media",
          "subtitle"
        ]
      }
    },
    {
      "name": "sequence",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "x-render-claim-token",
      "in": "header",
      "required": true,
      "schema": {
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
  "summary": "Read a verified whole-export artifact under the current claim",
  "tags": [
    "Render workers"
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

## uploadRenderArtifact

`PUT /api/render-workers/operations/{id}/artifacts/{sequence}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L487).

Upload a whole-export artifact

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Put('operations/:id/artifacts/:sequence')
@WorkerSessionHeader()
@ApiHeader({ name: 'x-render-claim-token', required: true })
@ApiConsumes('application/octet-stream')
@ApiBody({ schema: { type: 'string', format: 'binary' } })
@Authenticated({ public: true })
@Endpoint({ summary: 'Upload a whole-export artifact', history: history() })
```

Complete operation contract:

```json
{
  "operationId": "uploadRenderArtifact",
  "parameters": [
    {
      "name": "checksum",
      "required": true,
      "in": "query",
      "schema": {
        "pattern": "^[\\da-f]{64}$",
        "type": "string"
      }
    },
    {
      "name": "chunkKey",
      "required": true,
      "in": "query",
      "schema": {
        "minLength": 1,
        "maxLength": 256,
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "role",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string",
        "enum": [
          "media",
          "subtitle"
        ]
      }
    },
    {
      "name": "sequence",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "sizeInBytes",
      "required": true,
      "in": "query",
      "schema": {
        "pattern": "^\\d+$",
        "type": "string"
      }
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "x-render-claim-token",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/octet-stream": {
        "schema": {
          "format": "binary",
          "type": "string"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Upload a whole-export artifact",
  "tags": [
    "Render workers"
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

## acknowledgeRenderCancel

`POST /api/render-workers/operations/{id}/cancel-ack`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L403).

Acknowledge a cancellation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerCancelAckDto](models-30.md#renderworkercancelackdto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/cancel-ack')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Acknowledge a cancellation',
    description: 'The worker confirms it stopped. Only then does the operation become `cancelled`.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The worker confirms it stopped. Only then does the operation become `cancelled`.",
  "operationId": "acknowledgeRenderCancel",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerCancelAckDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Acknowledge a cancellation",
  "tags": [
    "Render workers"
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

## planRenderCheckpoint

`POST /api/render-workers/operations/{id}/checkpoints`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L316).

Plan a render checkpoint

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerCheckpointPlanDto](models-30.md#renderworkercheckpointplandto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/checkpoints')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Plan a render checkpoint',
    description: 'Records a chunk and every digest that identifies it. Re-planning a sequence replaces its identity.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Records a chunk and every digest that identifies it. Re-planning a sequence replaces its identity.",
  "operationId": "planRenderCheckpoint",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerCheckpointPlanDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Plan a render checkpoint",
  "tags": [
    "Render workers"
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

## completeRenderCheckpoint

`POST /api/render-workers/operations/{id}/checkpoints/{sequence}/complete`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L333).

Complete a render checkpoint

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerCheckpointCompleteDto](models-30.md#renderworkercheckpointcompletedto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/checkpoints/:sequence/complete')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Complete a render checkpoint',
    description:
      'Marks a planned chunk rendered. The chunk key must still match; a re-planned chunk cannot be completed.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Marks a planned chunk rendered. The chunk key must still match; a re-planned chunk cannot be completed.",
  "operationId": "completeRenderCheckpoint",
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
    },
    {
      "name": "sequence",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerCheckpointCompleteDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Complete a render checkpoint",
  "tags": [
    "Render workers"
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

## completeRenderOperation

`POST /api/render-workers/operations/{id}/complete`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L368).

Complete a claimed operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerCompleteDto](models-30.md#renderworkercompletedto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/complete')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Complete a claimed operation',
    description:
      'Publishes a validated result under the same claim. A previous valid result is kept until this succeeds.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Publishes a validated result under the same claim. A previous valid result is kept until this succeeds.",
  "operationId": "completeRenderOperation",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerCompleteDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Complete a claimed operation",
  "tags": [
    "Render workers"
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

## failRenderOperation

`POST /api/render-workers/operations/{id}/fail`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L386).

Fail a claimed operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerFailDto](models-30.md#renderworkerfaildto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/fail')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Fail a claimed operation',
    description: 'Records a stable error code and operator detail. A finished operation is not reopened.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Records a stable error code and operator detail. A finished operation is not reopened.",
  "operationId": "failRenderOperation",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerFailDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Fail a claimed operation",
  "tags": [
    "Render workers"
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

## heartbeatRenderOperation

`POST /api/render-workers/operations/{id}/heartbeat`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L281).

Heartbeat a claimed operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerHeartbeatDto](models-30.md#renderworkerheartbeatdto), [RenderWorkerHeartbeatResponseDto](models-30.md#renderworkerheartbeatresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/heartbeat')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Heartbeat a claimed operation',
    description:
      'Extends the lease, enforces the wall-clock and output ceilings and reports whether the owner asked to cancel.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Extends the lease, enforces the wall-clock and output ceilings and reports whether the owner asked to cancel.",
  "operationId": "heartbeatRenderOperation",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerHeartbeatDto"
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
            "$ref": "#/components/schemas/RenderWorkerHeartbeatResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Heartbeat a claimed operation",
  "tags": [
    "Render workers"
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

## readRenderOperationInput

`GET /api/render-workers/operations/{id}/inputs/{grant}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L523).

Read an operation input

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Get('operations/:id/inputs/:grant')
@FileResponse()
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Read an operation input',
    description:
      'Streams one input under a grant issued with the claim. The grant is bound to this operation, this claim and this session, and owner access is re-checked on every read.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Streams one input under a grant issued with the claim. The grant is bound to this operation, this claim and this session, and owner access is re-checked on every read.",
  "operationId": "readRenderOperationInput",
  "parameters": [
    {
      "name": "grant",
      "required": true,
      "in": "path",
      "schema": {
        "minLength": 1,
        "maxLength": 8192,
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
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
  "summary": "Read an operation input",
  "tags": [
    "Render workers"
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

## reportRenderOperationProgress

`POST /api/render-workers/operations/{id}/progress`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/render-worker.controller.ts#L299).

Report progress on a claimed operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerProgressDto](models-30.md#renderworkerprogressdto), [RenderWorkerWriteResultDto](models-30.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/progress')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Report progress on a claimed operation',
    description: 'Counted units only; the percentage is derived on the server.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Counted units only; the percentage is derived on the server.",
  "operationId": "reportRenderOperationProgress",
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
    },
    {
      "name": "x-frameleaf-worker-session",
      "in": "header",
      "description": "The session credential issued by admission",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RenderWorkerProgressDto"
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
            "$ref": "#/components/schemas/RenderWorkerWriteResultDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Report progress on a claimed operation",
  "tags": [
    "Render workers"
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
