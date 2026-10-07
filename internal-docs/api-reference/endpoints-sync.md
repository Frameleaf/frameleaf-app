# Server API — Sync

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteSyncAck

`DELETE /api/sync/ack`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/sync.controller.ts#L79).

Delete acknowledgements

Permission: `syncCheckpoint.delete`. Admin only: `false`.

Models: [SyncAckDeleteDto](models-33.md#syncackdeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sync)
@Controller('sync')
@Delete('ack')
@Authenticated({ permission: Permission.SyncCheckpointDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete acknowledgements',
    description: 'Delete specific synchronization acknowledgments.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete specific synchronization acknowledgments.",
  "operationId": "deleteSyncAck",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SyncAckDeleteDto"
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
  "summary": "Delete acknowledgements",
  "tags": [
    "Sync"
  ],
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
  "x-immich-permission": "syncCheckpoint.delete",
  "x-immich-state": "Stable"
}
```

## getSyncAck

`GET /api/sync/ack`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/sync.controller.ts#L38).

Retrieve acknowledgements

Permission: `syncCheckpoint.read`. Admin only: `false`.

Models: [SyncAckDto](models-33.md#syncackdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sync)
@Controller('sync')
@Get('ack')
@Authenticated({ permission: Permission.SyncCheckpointRead })
@Endpoint({
    summary: 'Retrieve acknowledgements',
    description:
      'Retrieve the legacy synchronization acknowledgments for the current session. Use GET /sync/ack/v2 for all sync families, including album source links.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the legacy synchronization acknowledgments for the current session. Use GET /sync/ack/v2 for all sync families, including album source links.",
  "operationId": "getSyncAck",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SyncAckDto"
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
  "summary": "Retrieve acknowledgements",
  "tags": [
    "Sync"
  ],
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
  "x-immich-permission": "syncCheckpoint.read",
  "x-immich-state": "Stable"
}
```

## sendSyncAck

`POST /api/sync/ack`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/sync.controller.ts#L66).

Acknowledge changes

Permission: `syncCheckpoint.update`. Admin only: `false`.

Models: [SyncAckSetDto](models-33.md#syncacksetdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sync)
@Controller('sync')
@Post('ack')
@Authenticated({ permission: Permission.SyncCheckpointUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Acknowledge changes',
    description:
      'Send a list of synchronization acknowledgements to confirm that the latest changes have been received.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Send a list of synchronization acknowledgements to confirm that the latest changes have been received.",
  "operationId": "sendSyncAck",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SyncAckSetDto"
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
  "summary": "Acknowledge changes",
  "tags": [
    "Sync"
  ],
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
  "x-immich-permission": "syncCheckpoint.update",
  "x-immich-state": "Stable"
}
```

## getSyncAckV2

`GET /api/sync/ack/v2`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/sync.controller.ts#L54).

Retrieve all acknowledgements

Permission: `syncCheckpoint.read`. Admin only: `false`.

Models: [SyncAckV2Dto](models-33.md#syncackv2dto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sync)
@Controller('sync')
@Get('ack/v2')
@Authenticated({ permission: Permission.SyncCheckpointRead })
@Endpoint({
    summary: 'Retrieve all acknowledgements',
    description:
      'Retrieve synchronization acknowledgments for every sync family in the current session, including album source links. Acknowledgment IDs are opaque and can be sent unchanged to POST /sync/ack.',
    history: new HistoryBuilder().added('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve synchronization acknowledgments for every sync family in the current session, including album source links. Acknowledgment IDs are opaque and can be sent unchanged to POST /sync/ack.",
  "operationId": "getSyncAckV2",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SyncAckV2Dto"
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
  "summary": "Retrieve all acknowledgements",
  "tags": [
    "Sync"
  ],
  "x-immich-history": [
    {
      "version": "v2",
      "state": "Added"
    }
  ],
  "x-immich-permission": "syncCheckpoint.read"
}
```

## getSyncStream

`POST /api/sync/stream`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/sync.controller.ts#L20).

Stream sync changes

Permission: `sync.stream`. Admin only: `false`.

Models: [SyncStreamDto](models-35.md#syncstreamdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sync)
@Controller('sync')
@Post('stream')
@Authenticated({ permission: Permission.SyncStream })
@Header('Content-Type', 'application/jsonlines+json')
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Stream sync changes',
    description:
      'Retrieve a JSON lines streamed response of changes for synchronization. This endpoint is used by the mobile app to efficiently stay up to date with changes.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a JSON lines streamed response of changes for synchronization. This endpoint is used by the mobile app to efficiently stay up to date with changes.",
  "operationId": "getSyncStream",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SyncStreamDto"
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
  "summary": "Stream sync changes",
  "tags": [
    "Sync"
  ],
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
  "x-immich-permission": "sync.stream",
  "x-immich-state": "Stable"
}
```
