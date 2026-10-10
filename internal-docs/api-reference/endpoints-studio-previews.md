# Server API — Studio previews

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## openStudioPreviewStream

`POST /api/studio/preview-streams`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview-stream.controller.ts#L29).

Open a Studio preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewStreamDto](models-34.md#studiopreviewstreamdto), [StudioPreviewStreamOpenDto](models-34.md#studiopreviewstreamopendto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
@Post()
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Open a Studio preview stream',
    description:
      "Opens a bounded WebRTC playback session of the project's current stored revision from an exact rational time. Refused for a superseded revision, an unavailable source, or when the account already holds the most sessions it may; an open session of the same project is superseded.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Opens a bounded WebRTC playback session of the project's current stored revision from an exact rational time. Refused for a superseded revision, an unavailable source, or when the account already holds the most sessions it may; an open session of the same project is superseded.",
  "operationId": "openStudioPreviewStream",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioPreviewStreamOpenDto"
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
            "$ref": "#/components/schemas/StudioPreviewStreamDto"
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
  "summary": "Open a Studio preview stream",
  "tags": [
    "Studio previews"
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

## closeStudioPreviewStream

`DELETE /api/studio/preview-streams/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview-stream.controller.ts#L89).

Close a Studio preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewStreamDto](models-34.md#studiopreviewstreamdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
@Delete(':id')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Close a Studio preview stream',
    description: 'Ends the session; the worker stops sending on its next signalling poll.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Ends the session; the worker stops sending on its next signalling poll.",
  "operationId": "closeStudioPreviewStream",
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
            "$ref": "#/components/schemas/StudioPreviewStreamDto"
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
  "summary": "Close a Studio preview stream",
  "tags": [
    "Studio previews"
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

## getStudioPreviewStream

`GET /api/studio/preview-streams/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview-stream.controller.ts#L45).

Get a Studio preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewStreamDto](models-34.md#studiopreviewstreamdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
@Get(':id')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio preview stream',
    description:
      "The session's state and, while it waits for an answer, the worker's offer. Polling it is the keepalive; each poll re-checks project access and the stored head, and closes the session when either has changed.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The session's state and, while it waits for an answer, the worker's offer. Polling it is the keepalive; each poll re-checks project access and the stored head, and closes the session when either has changed.",
  "operationId": "getStudioPreviewStream",
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
            "$ref": "#/components/schemas/StudioPreviewStreamDto"
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
  "summary": "Get a Studio preview stream",
  "tags": [
    "Studio previews"
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

## answerStudioPreviewStream

`PUT /api/studio/preview-streams/{id}/answer`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview-stream.controller.ts#L57).

Answer a Studio preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewStreamAnswerDto](models-34.md#studiopreviewstreamanswerdto), [StudioPreviewStreamDto](models-34.md#studiopreviewstreamdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
@Put(':id/answer')
@Authenticated()
@Endpoint({
    summary: 'Answer a Studio preview stream',
    description:
      "The browser's complete answer (non-trickle ICE) to the current negotiation's offer: receive one video, send nothing. The server writes the session's bitrate bound into it before the worker reads it.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The browser's complete answer (non-trickle ICE) to the current negotiation's offer: receive one video, send nothing. The server writes the session's bitrate bound into it before the worker reads it.",
  "operationId": "answerStudioPreviewStream",
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
          "$ref": "#/components/schemas/StudioPreviewStreamAnswerDto"
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
            "$ref": "#/components/schemas/StudioPreviewStreamDto"
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
  "summary": "Answer a Studio preview stream",
  "tags": [
    "Studio previews"
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

## reconnectStudioPreviewStream

`POST /api/studio/preview-streams/{id}/reconnect`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview-stream.controller.ts#L73).

Reconnect a Studio preview stream

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewStreamDto](models-34.md#studiopreviewstreamdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/preview-streams')
@Post(':id/reconnect')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Reconnect a Studio preview stream',
    description:
      "Starts the next negotiation after the peer connection dropped, only once project access, the stored head, every source's availability and the worker's lease have been validated again. Any failure closes the session with its reason.",
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Starts the next negotiation after the peer connection dropped, only once project access, the stored head, every source's availability and the worker's lease have been validated again. Any failure closes the session with its reason.",
  "operationId": "reconnectStudioPreviewStream",
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
            "$ref": "#/components/schemas/StudioPreviewStreamDto"
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
  "summary": "Reconnect a Studio preview stream",
  "tags": [
    "Studio previews"
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

## requestStudioPreview

`POST /api/studio/previews`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview.controller.ts#L42).

Request a Studio preview frame

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewRequestDto](models-34.md#studiopreviewrequestdto), [StudioPreviewResponseDto](models-34.md#studiopreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/previews')
@Post()
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Request a Studio preview frame',
    description:
      "Asks for one frame of a project's current stored revision at an exact rational time, quality and viewport. The server reads the graph from project storage and resolves its sources for the caller; a request naming a superseded revision is refused with the current one. An identical request shares the render rather than starting a second one, and previews of superseded revisions are cancelled.",
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Asks for one frame of a project's current stored revision at an exact rational time, quality and viewport. The server reads the graph from project storage and resolves its sources for the caller; a request naming a superseded revision is refused with the current one. An identical request shares the render rather than starting a second one, and previews of superseded revisions are cancelled.",
  "operationId": "requestStudioPreview",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioPreviewRequestDto"
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
            "$ref": "#/components/schemas/StudioPreviewResponseDto"
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
  "summary": "Request a Studio preview frame",
  "tags": [
    "Studio previews"
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

## cancelStudioPreview

`DELETE /api/studio/previews/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview.controller.ts#L104).

Cancel a Studio preview

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewDto](models-34.md#studiopreviewdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/previews')
@Delete(':id')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Cancel a Studio preview',
    description:
      'Retires delivery of a preview. Scoped admissions require their captured consumer and operation identities; cancellation receipt facts distinguish durable request from renderer release. An active renderer directory is retained until genuine release.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retires delivery of a preview. Scoped admissions require their captured consumer and operation identities; cancellation receipt facts distinguish durable request from renderer release. An active renderer directory is retained until genuine release.",
  "operationId": "cancelStudioPreview",
  "parameters": [
    {
      "name": "consumerRequestId",
      "required": false,
      "in": "query",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "expectedOperationId",
      "required": false,
      "in": "query",
      "description": "Captured operation ID; literal string null explicitly names a never-enqueued admission. Omission and empty strings are not null.",
      "schema": {
        "anyOf": [
          {
            "type": "string",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$"
          },
          {
            "type": "string",
            "enum": [
              "null"
            ]
          }
        ]
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
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioPreviewDto"
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
  "summary": "Cancel a Studio preview",
  "tags": [
    "Studio previews"
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

## getStudioPreview

`GET /api/studio/previews/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview.controller.ts#L55).

Get a Studio preview

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioPreviewDto](models-34.md#studiopreviewdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/previews')
@Get(':id')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio preview',
    description: 'The state of one requested frame, including its revision-bound entity tag.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The state of one requested frame, including its revision-bound entity tag.",
  "operationId": "getStudioPreview",
  "parameters": [
    {
      "name": "consumerRequestId",
      "required": false,
      "in": "query",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
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
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioPreviewDto"
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
  "summary": "Get a Studio preview",
  "tags": [
    "Studio previews"
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

## viewStudioPreviewFrame

`GET /api/studio/previews/{id}/frame`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-preview.controller.ts#L70).

View a Studio preview frame

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioPreviews)
@Controller('studio/previews')
@Get(':id/frame')
@FileResponse()
@Authenticated()
@Endpoint({
    summary: 'View a Studio preview frame',
    description:
      'Returns the rendered frame. The entity tag contains the project revision, so a frame whose revision has been superseded is refused with 409 rather than served or revalidated.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns the rendered frame. The entity tag contains the project revision, so a frame whose revision has been superseded is refused with 409 rather than served or revalidated.",
  "operationId": "viewStudioPreviewFrame",
  "parameters": [
    {
      "name": "consumerRequestId",
      "required": false,
      "in": "query",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
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
  "summary": "View a Studio preview frame",
  "tags": [
    "Studio previews"
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
