# Server API — Media operations

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchMediaOperations

`GET /api/media-operations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L48).

List your media operations

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationKind](models-15.md#mediaoperationkind), [MediaOperationListResponseDto](models-15.md#mediaoperationlistresponsedto), [MediaOperationStatus](models-15.md#mediaoperationstatus).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Get()
@Authenticated()
@Endpoint({
    summary: 'List your media operations',
    description:
      'Durable renders, restorations and edits belonging to the signed-in account, newest first. These survive closing the browser and restarting the server.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Durable renders, restorations and edits belonging to the signed-in account, newest first. These survive closing the browser and restarting the server.",
  "operationId": "searchMediaOperations",
  "parameters": [
    {
      "name": "includeDismissed",
      "required": false,
      "in": "query",
      "description": "Include jobs the owner cleared",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "kind",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MediaOperationKind"
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
      "name": "status",
      "required": false,
      "in": "query",
      "description": "Restrict to one status",
      "schema": {
        "$ref": "#/components/schemas/MediaOperationStatus"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaOperationListResponseDto"
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
  "summary": "List your media operations",
  "tags": [
    "Media operations"
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

## createBulkMediaOperation

`POST /api/media-operations/bulk`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L75).

Queue a bulk operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationBulkCreateDto](models-15.md#mediaoperationbulkcreatedto), [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Post('bulk')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Queue a bulk operation',
    description:
      'Applies one action to a frozen list of assets in the background. The list is never re-resolved; access is checked for every item as it is changed, and items the account cannot change are reported as skipped. Submitting the same requestId again returns the existing operation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Applies one action to a frozen list of assets in the background. The list is never re-resolved; access is checked for every item as it is changed, and items the account cannot change are reported as skipped. Submitting the same requestId again returns the existing operation.",
  "operationId": "createBulkMediaOperation",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaOperationBulkCreateDto"
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
  "summary": "Queue a bulk operation",
  "tags": [
    "Media operations"
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

## getMediaOperationStatistics

`GET /api/media-operations/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L63).

Get media operation statistics

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationStatisticsDto](models-15.md#mediaoperationstatisticsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Get('statistics')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get media operation statistics',
    description:
      'Operational counts by kind, status and destination. Aggregates only: no owner, label or media is included.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Operational counts by kind, status and destination. Aggregates only: no owner, label or media is included.",
  "operationId": "getMediaOperationStatistics",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaOperationStatisticsDto"
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
  "summary": "Get media operation statistics",
  "tags": [
    "Media operations"
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

## dismissMediaOperation

`DELETE /api/media-operations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L187).

Clear a finished media operation

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Clear a finished media operation',
    description: 'Removes a finished job from your Activity list. The record is kept for lineage and remote cleanup.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes a finished job from your Activity list. The record is kept for lineage and remote cleanup.",
  "operationId": "dismissMediaOperation",
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
  "summary": "Clear a finished media operation",
  "tags": [
    "Media operations"
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

## getMediaOperation

`GET /api/media-operations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L91).

Get a media operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDetailDto](models-15.md#mediaoperationdetaildto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Get(':id')
@Authenticated()
@Endpoint({
    summary: 'Get a media operation',
    description: 'The job with its render checkpoints and the immutable snapshot it was bound to.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The job with its render checkpoints and the immutable snapshot it was bound to.",
  "operationId": "getMediaOperation",
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
            "$ref": "#/components/schemas/MediaOperationDetailDto"
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
  "summary": "Get a media operation",
  "tags": [
    "Media operations"
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

## cancelMediaOperation

`POST /api/media-operations/{id}/cancel`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L135).

Cancel a media operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Post(':id/cancel')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Cancel a media operation',
    description:
      'Records the cancellation durably. A queued job stops at once; a claimed job reports `cancelling` until the worker acknowledges it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Records the cancellation durably. A queued job stops at once; a claimed job reports `cancelling` until the worker acknowledges it.",
  "operationId": "cancelMediaOperation",
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
  "summary": "Cancel a media operation",
  "tags": [
    "Media operations"
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

## pauseMediaOperation

`POST /api/media-operations/{id}/pause`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L148).

Pause a media operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Post(':id/pause')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Pause a media operation',
    description:
      'Holds a bulk operation, Studio export or restoration. A queued job is paused at once; a running job stops at its next checkpoint and reports `pauseRequestedAt` until then. Other kinds cannot be paused.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Holds a bulk operation, Studio export or restoration. A queued job is paused at once; a running job stops at its next checkpoint and reports `pauseRequestedAt` until then. Other kinds cannot be paused.",
  "operationId": "pauseMediaOperation",
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
  "summary": "Pause a media operation",
  "tags": [
    "Media operations"
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

## resumeMediaOperation

`POST /api/media-operations/{id}/resume`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L161).

Resume a media operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Post(':id/resume')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Resume a media operation',
    description:
      'Returns a paused job to the queue, where it carries on from what it recorded, or withdraws a pause its worker has not reached yet.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns a paused job to the queue, where it carries on from what it recorded, or withdraws a pause its worker has not reached yet.",
  "operationId": "resumeMediaOperation",
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
  "summary": "Resume a media operation",
  "tags": [
    "Media operations"
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

## retryMediaOperation

`POST /api/media-operations/{id}/retry`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L174).

Retry a media operation

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Post(':id/retry')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Retry a media operation',
    description:
      'Queues a new job from the failed or cancelled one, reusing its immutable snapshot and destination and recording the lineage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a new job from the failed or cancelled one, reusing its immutable snapshot and destination and recording the lineage.",
  "operationId": "retryMediaOperation",
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
  "summary": "Retry a media operation",
  "tags": [
    "Media operations"
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

## viewMediaOperationReversePreview

`GET /api/media-operations/{id}/reverse-preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L118).

View a source reversal preview

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Get(':id/reverse-preview')
@Authenticated()
@FileResponse()
@Header('Cache-Control', 'private, no-store')
@Endpoint({
    summary: 'View a source reversal preview',
    description:
      'The checked H264/AAC derivative of your completed source reversal. Every read verifies current project and source access and the checksum of the returned bytes.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The checked H264/AAC derivative of your completed source reversal. Every read verifies current project and source access and the checksum of the returned bytes.",
  "operationId": "viewMediaOperationReversePreview",
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
  "summary": "View a source reversal preview",
  "tags": [
    "Media operations"
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
  "x-immich-state": "Alpha"
}
```

## getMediaOperationReverseResult

`GET /api/media-operations/{id}/reverse-result`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/media-operation.controller.ts#L102).

Get a completed source reversal result

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioReverseConformResultDto](models-33.md#studioreverseconformresultdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaOperations)
@Controller('media-operations')
@Get(':id/reverse-result')
@Authenticated()
@Header('Cache-Control', 'private, no-store')
@Endpoint({
    summary: 'Get a completed source reversal result',
    description:
      'Owner-only metadata after current project, source and generated-lineage authorization. Contains no storage paths or worker grants.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner-only metadata after current project, source and generated-lineage authorization. Contains no storage paths or worker grants.",
  "operationId": "getMediaOperationReverseResult",
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
            "$ref": "#/components/schemas/StudioReverseConformResultDto"
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
  "summary": "Get a completed source reversal result",
  "tags": [
    "Media operations"
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
  "x-immich-state": "Alpha"
}
```
