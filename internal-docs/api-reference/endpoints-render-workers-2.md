# Server API — Render workers 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getRenderStreamSignal

`POST /api/render-workers/operations/{id}/stream`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/render-worker.controller.ts#L420).

Read the signalling of a claimed preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerStreamSignalDto](models-29.md#renderworkerstreamsignaldto), [RenderWorkerStreamSignalRequestDto](models-29.md#renderworkerstreamsignalrequestdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/stream')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Read the signalling of a claimed preview stream',
    description:
      "FL-96. What the worker holding a Studio preview stream must do now: stop (`close`), offer for the current negotiation (`offerNeeded`), or connect with the browser's answer, which carries the server's bitrate bound. Poll at least every two seconds while streaming.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "FL-96. What the worker holding a Studio preview stream must do now: stop (`close`), offer for the current negotiation (`offerNeeded`), or connect with the browser's answer, which carries the server's bitrate bound. Poll at least every two seconds while streaming.",
  "operationId": "getRenderStreamSignal",
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
          "$ref": "#/components/schemas/RenderWorkerStreamSignalRequestDto"
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
            "$ref": "#/components/schemas/RenderWorkerStreamSignalDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Read the signalling of a claimed preview stream",
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

## offerRenderStream

`POST /api/render-workers/operations/{id}/stream/offer`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/render-worker.controller.ts#L438).

Offer a claimed preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerStreamOfferDto](models-29.md#renderworkerstreamofferdto), [RenderWorkerWriteResultDto](models-29.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/stream/offer')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Offer a claimed preview stream',
    description:
      'FL-96. The complete session description (non-trickle ICE) for the current negotiation: one send-only video and one control data channel. One offer per negotiation per claim.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "FL-96. The complete session description (non-trickle ICE) for the current negotiation: one send-only video and one control data channel. One offer per negotiation per claim.",
  "operationId": "offerRenderStream",
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
          "$ref": "#/components/schemas/RenderWorkerStreamOfferDto"
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
  "summary": "Offer a claimed preview stream",
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

## validateRenderOperation

`POST /api/render-workers/operations/{id}/validate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/render-worker.controller.ts#L351).

Begin validating a claimed operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerCompleteDto](models-29.md#renderworkercompletedto), [RenderWorkerWriteResultDto](models-29.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('operations/:id/validate')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Begin validating a claimed operation',
    description: 'Moves the operation to `validating`. Nothing is published until `complete`.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Moves the operation to `validating`. Nothing is published until `complete`.",
  "operationId": "validateRenderOperation",
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
  "summary": "Begin validating a claimed operation",
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

## getRenderRemoteReferences

`GET /api/render-workers/remote-references`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/render-worker.controller.ts#L456).

List what this worker must stop or delete

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerRemoteReferenceDto](models-29.md#renderworkerremotereferencedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Get('remote-references')
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'List what this worker must stop or delete',
    description:
      'Studio export renders that were cancelled or abandoned and copies of outputs this worker kept. Each stays listed until the worker acknowledges it.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Studio export renders that were cancelled or abandoned and copies of outputs this worker kept. Each stays listed until the worker acknowledges it.",
  "operationId": "getRenderRemoteReferences",
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
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/RenderWorkerRemoteReferenceDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "List what this worker must stop or delete",
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

## acknowledgeRenderRemoteReference

`POST /api/render-workers/remote-references/{id}/acknowledge`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/render-worker.controller.ts#L471).

Acknowledge a remote reference

Permission: `See authentication declaration`. Admin only: `false`.

Models: [RenderWorkerWriteResultDto](models-29.md#renderworkerwriteresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.RenderWorkers)
@Controller('render-workers')
@HomeNetworkOnly()
@Post('remote-references/:id/acknowledge')
@HttpCode(HttpStatus.OK)
@WorkerSessionHeader()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Acknowledge a remote reference',
    description: 'The worker confirms the render is stopped, or the copy deleted, and nothing of it remains.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The worker confirms the render is stopped, or the copy deleted, and nothing of it remains.",
  "operationId": "acknowledgeRenderRemoteReference",
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
  "summary": "Acknowledge a remote reference",
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
