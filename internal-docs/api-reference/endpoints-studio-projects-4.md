# Server API — Studio projects 4

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## restoreStudioProjectRevision

`POST /api/studio/projects/{id}/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L322).

Restore a Studio project revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectRestoreDto](models-35.md#studioprojectrestoredto), [StudioProjectSaveResponseDto](models-35.md#studioprojectsaveresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/restore')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Restore a Studio project revision',
    description:
      'Appends a new revision with the content of an earlier one. History is never rewritten; the restore is itself a revision.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Appends a new revision with the content of an earlier one. History is never rewritten; the restore is itself a revision.",
  "operationId": "restoreStudioProjectRevision",
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
          "$ref": "#/components/schemas/StudioProjectRestoreDto"
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
            "$ref": "#/components/schemas/StudioProjectSaveResponseDto"
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
  "summary": "Restore a Studio project revision",
  "tags": [
    "Studio projects"
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

## enqueueStudioReverseConform

`POST /api/studio/projects/{id}/reverse-conform`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L206).

Queue a Studio clip source reversal

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioReverseConformEnqueueDto](models-35.md#studioreverseconformenqueuedto), [StudioReverseConformQueuedDto](models-35.md#studioreverseconformqueueddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/reverse-conform')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Queue a Studio clip source reversal',
    description: 'Owner-only local source reversal bound to a stored revision and the requesting editor lease.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner-only local source reversal bound to a stored revision and the requesting editor lease.",
  "operationId": "enqueueStudioReverseConform",
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
          "$ref": "#/components/schemas/StudioReverseConformEnqueueDto"
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
            "$ref": "#/components/schemas/StudioReverseConformQueuedDto"
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
  "summary": "Queue a Studio clip source reversal",
  "tags": [
    "Studio projects"
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

## applyStudioReverseConform

`POST /api/studio/projects/{id}/reverse-conform/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L223).

Apply a completed Studio clip source reversal

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectSaveResponseDto](models-35.md#studioprojectsaveresponsedto), [StudioReverseConformApplyDto](models-35.md#studioreverseconformapplydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/reverse-conform/apply')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Apply a completed Studio clip source reversal',
    description:
      'Rechecks ownership, current source access, lease and the original revision before relinking the clip. Newer edits are never overwritten.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Rechecks ownership, current source access, lease and the original revision before relinking the clip. Newer edits are never overwritten.",
  "operationId": "applyStudioReverseConform",
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
          "$ref": "#/components/schemas/StudioReverseConformApplyDto"
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
            "$ref": "#/components/schemas/StudioProjectSaveResponseDto"
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
  "summary": "Apply a completed Studio clip source reversal",
  "tags": [
    "Studio projects"
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

## getStudioProjectHistory

`GET /api/studio/projects/{id}/revisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L339).

List Studio project history

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectHistoryResponseDto](models-35.md#studioprojecthistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/revisions')
@Authenticated()
@Endpoint({
    summary: 'List Studio project history',
    description: 'Revisions newest first, without their documents.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Revisions newest first, without their documents.",
  "operationId": "getStudioProjectHistory",
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
        "maximum": 200,
        "default": 50,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioProjectHistoryResponseDto"
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
  "summary": "List Studio project history",
  "tags": [
    "Studio projects"
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

## saveStudioProjectRevision

`POST /api/studio/projects/{id}/revisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L305).

Save a Studio project revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectSaveDto](models-35.md#studioprojectsavedto), [StudioProjectSaveResponseDto](models-35.md#studioprojectsaveresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/revisions')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Save a Studio project revision',
    description:
      'Autosave. Stores the complete document as the next revision when `expectedRevision` is the head and the caller holds the lease. The same `requestKey` with the same document replays the earlier result; an unchanged document writes nothing.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Autosave. Stores the complete document as the next revision when `expectedRevision` is the head and the caller holds the lease. The same `requestKey` with the same document replays the earlier result; an unchanged document writes nothing.",
  "operationId": "saveStudioProjectRevision",
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
          "$ref": "#/components/schemas/StudioProjectSaveDto"
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
            "$ref": "#/components/schemas/StudioProjectSaveResponseDto"
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
  "summary": "Save a Studio project revision",
  "tags": [
    "Studio projects"
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

## getStudioProjectRevision

`GET /api/studio/projects/{id}/revisions/{revision}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L354).

Get a Studio project revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectRevisionDetailDto](models-35.md#studioprojectrevisiondetaildto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/revisions/:revision')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio project revision',
    description: 'One historical revision with its document, under the same review rule as the head.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "One historical revision with its document, under the same review rule as the head.",
  "operationId": "getStudioProjectRevision",
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
      "name": "revision",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioProjectRevisionDetailDto"
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
  "summary": "Get a Studio project revision",
  "tags": [
    "Studio projects"
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

## diffStudioProjectRevision

`GET /api/studio/projects/{id}/revisions/{revision}/diff`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L368).

Compare two Studio project revisions

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDiffDto](models-35.md#studioprojectdiffdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/revisions/:revision/diff')
@Authenticated()
@Endpoint({
    summary: 'Compare two Studio project revisions',
    description:
      'What changed between `against` and this revision, as graph paths and counts. No graph values are returned.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What changed between `against` and this revision, as graph paths and counts. No graph values are returned.",
  "operationId": "diffStudioProjectRevision",
  "parameters": [
    {
      "name": "against",
      "required": true,
      "in": "query",
      "description": "The earlier revision to compare with",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
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
      "name": "revision",
      "required": true,
      "in": "path",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioProjectDiffDto"
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
  "summary": "Compare two Studio project revisions",
  "tags": [
    "Studio projects"
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

## createStudioTranscription

`POST /api/studio/projects/{id}/transcriptions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L240).

Transcribe a Studio clip

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioTranscriptionCreateDto](models-35.md#studiotranscriptioncreatedto), [StudioTranscriptionQueuedDto](models-35.md#studiotranscriptionqueueddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/transcriptions')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Transcribe a Studio clip',
    description:
      'Owner only. Queues Whisper speech to text for one video or audio clip on the main timeline of the head revision, on the named machine-learning destination (this server or a home-network worker that serves Studio AI). `language` is a BCP 47 tag or `auto`. Follow the job in Activity (`/media-operations/{id}`, cancel with `/media-operations/{id}/cancel`); read the cues with `GET /studio/projects/{id}/transcriptions/{transcriptionId}` and apply them with `captions.set`. The graph is never edited.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner only. Queues Whisper speech to text for one video or audio clip on the main timeline of the head revision, on the named machine-learning destination (this server or a home-network worker that serves Studio AI). `language` is a BCP 47 tag or `auto`. Follow the job in Activity (`/media-operations/{id}`, cancel with `/media-operations/{id}/cancel`); read the cues with `GET /studio/projects/{id}/transcriptions/{transcriptionId}` and apply them with `captions.set`. The graph is never edited.",
  "operationId": "createStudioTranscription",
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
          "$ref": "#/components/schemas/StudioTranscriptionCreateDto"
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
            "$ref": "#/components/schemas/StudioTranscriptionQueuedDto"
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
  "summary": "Transcribe a Studio clip",
  "tags": [
    "Studio projects"
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

## getStudioTranscription

`GET /api/studio/projects/{id}/transcriptions/{transcriptionId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L257).

Get a Studio clip transcription

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioTranscriptionDto](models-35.md#studiotranscriptiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/transcriptions/:transcriptionId')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio clip transcription',
    description:
      'Owner only. The job status and progress, and once it has completed the cues (exact rational seconds on the sequence, ready for `captions.set`) and word timings.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner only. The job status and progress, and once it has completed the cues (exact rational seconds on the sequence, ready for `captions.set`) and word timings.",
  "operationId": "getStudioTranscription",
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
      "name": "transcriptionId",
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
            "$ref": "#/components/schemas/StudioTranscriptionDto"
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
  "summary": "Get a Studio clip transcription",
  "tags": [
    "Studio projects"
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

## restoreStudioProjectFromTrash

`POST /api/studio/projects/{id}/trash/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L160).

Restore a Studio project from the trash

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDto](models-35.md#studioprojectdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/trash/restore')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Restore a Studio project from the trash',
    description: 'Brings a trashed project back to the shelf it was on. Owner only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Brings a trashed project back to the shelf it was on. Owner only.",
  "operationId": "restoreStudioProjectFromTrash",
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
            "$ref": "#/components/schemas/StudioProjectDto"
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
  "summary": "Restore a Studio project from the trash",
  "tags": [
    "Studio projects"
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

## getStudioResources

`GET /api/studio/resources`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-catalog.controller.ts#L33).

List the Studio resources this server may use

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioResourceInventoryDto](models-35.md#studioresourceinventorydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('resources')
@Authenticated()
@Endpoint({
    summary: 'List the Studio resources this server may use',
    description:
      'Every font, LUT, audio track, model, voice and tool the Studio engine can reach that has a reviewed rights decision: its licence, whether it may be redistributed, run on this server or run on Frameleaf Cloud, why a use was withheld, and the worker capability that runs it. A resource not listed is refused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every font, LUT, audio track, model, voice and tool the Studio engine can reach that has a reviewed rights decision: its licence, whether it may be redistributed, run on this server or run on Frameleaf Cloud, why a use was withheld, and the worker capability that runs it. A resource not listed is refused.",
  "operationId": "getStudioResources",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioResourceInventoryDto"
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
  "summary": "List the Studio resources this server may use",
  "tags": [
    "Studio projects"
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

## getStudioRestoredVersion

`GET /api/studio/restored-versions/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-source.controller.ts#L20).

Get a restored version for Studio

Permission: `asset.edit.get`. Admin only: `false`.

Models: [StudioRestoredVersionDto](models-35.md#studiorestoredversiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/restored-versions')
@Get(':id')
@Authenticated({ permission: Permission.AssetEditGet })
@Endpoint({
    summary: 'Get a restored version for Studio',
    description:
      'An accepted restoration of one of your photos or videos as a Studio media bin entry: the media id a clip of it carries, its size and length, and whether it can be placed now. A discarded, expired or Locked one says so; someone else’s is not found.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "An accepted restoration of one of your photos or videos as a Studio media bin entry: the media id a clip of it carries, its size and length, and whether it can be placed now. A discarded, expired or Locked one says so; someone else’s is not found.",
  "operationId": "getStudioRestoredVersion",
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
            "$ref": "#/components/schemas/StudioRestoredVersionDto"
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
  "summary": "Get a restored version for Studio",
  "tags": [
    "Studio projects"
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
  "x-immich-permission": "asset.edit.get",
  "x-immich-state": "Alpha"
}
```

## getStudioWorkspace

`GET /api/studio/workspace`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-workspace.controller.ts#L19).

Get your Studio workspace layout

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioWorkspaceDto](models-36.md#studioworkspacedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/workspace')
@Get()
@Authenticated()
@Endpoint({
    summary: 'Get your Studio workspace layout',
    description: 'The editor layout you last saved, or nulls when you have none. Only ever your own.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The editor layout you last saved, or nulls when you have none. Only ever your own.",
  "operationId": "getStudioWorkspace",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioWorkspaceDto"
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
  "summary": "Get your Studio workspace layout",
  "tags": [
    "Studio projects"
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

## saveStudioWorkspace

`PUT /api/studio/workspace`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-workspace.controller.ts#L30).

Save your Studio workspace layout

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioWorkspaceDto](models-36.md#studioworkspacedto), [StudioWorkspaceSaveDto](models-36.md#studioworkspacesavedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/workspace')
@Put()
@Authenticated()
@Endpoint({
    summary: 'Save your Studio workspace layout',
    description:
      'Replaces your stored editor layout. The layout is stored as JSON and returned as the same value (key order and spacing are not kept), up to 256 KiB.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Replaces your stored editor layout. The layout is stored as JSON and returned as the same value (key order and spacing are not kept), up to 256 KiB.",
  "operationId": "saveStudioWorkspace",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioWorkspaceSaveDto"
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
            "$ref": "#/components/schemas/StudioWorkspaceDto"
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
  "summary": "Save your Studio workspace layout",
  "tags": [
    "Studio projects"
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
