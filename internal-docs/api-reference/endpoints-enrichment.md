# Server API — Enrichment

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getVideoMomentFrame

`GET /api/enrichment/frames/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L130).

Get a video moment frame

Permission: `asset.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Get('frames/:id')
@FileResponse()
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get a video moment frame',
    description: 'The image of one reusable video frame, under the same access as its video.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The image of one reusable video frame, under the same access as its video.",
  "operationId": "getVideoMomentFrame",
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
  "summary": "Get a video moment frame",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## searchSimilarVideoMoments

`GET /api/enrichment/frames/{id}/similar`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L147).

Find moments like a video frame

Permission: `asset.read`. Admin only: `false`.

Models: [VideoMomentSearchResponseDto](models-37.md#videomomentsearchresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Get('frames/:id/similar')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Find moments like a video frame',
    description:
      "Finds the moments nearest one frame's stored search embedding across your videos, including other times in the same video, never the frame itself. Nothing is sent to a model and nothing is written.",
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Finds the moments nearest one frame's stored search embedding across your videos, including other times in the same video, never the frame itself. Nothing is sent to a model and nothing is written.",
  "operationId": "searchSimilarVideoMoments",
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
      "name": "limit",
      "required": false,
      "in": "query",
      "description": "Most moments to return",
      "schema": {
        "minimum": 1,
        "maximum": 100,
        "default": 24,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/VideoMomentSearchResponseDto"
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
  "summary": "Find moments like a video frame",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## searchVideoMoments

`POST /api/enrichment/moments/search`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L117).

Search video moments

Permission: `asset.read`. Admin only: `false`.

Models: [VideoMomentSearchDto](models-37.md#videomomentsearchdto), [VideoMomentSearchResponseDto](models-37.md#videomomentsearchresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Post('moments/search')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Search video moments',
    description:
      'Finds timestamped moments inside your videos by meaning, against the frame index, and by words in captions and typed transcripts.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Finds timestamped moments inside your videos by meaning, against the frame index, and by words in captions and typed transcripts.",
  "operationId": "searchVideoMoments",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/VideoMomentSearchDto"
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
            "$ref": "#/components/schemas/VideoMomentSearchResponseDto"
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
  "summary": "Search video moments",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## getEnrichmentOptions

`GET /api/enrichment/options`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L61).

Get enrichment options

Permission: `See authentication declaration`. Admin only: `true`.

Models: [EnrichmentOptionsResponseDto](models-11.md#enrichmentoptionsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Get('options')
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Get enrichment options',
    description:
      'The processing destinations an enrichment preview or plan may use, with whether each would take the work now, the routed destinations and the saved models.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The processing destinations an enrichment preview or plan may use, with whether each would take the work now, the routed destinations and the saved models.",
  "operationId": "getEnrichmentOptions",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/EnrichmentOptionsResponseDto"
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
  "summary": "Get enrichment options",
  "tags": [
    "Enrichment"
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

## createEnrichmentPlan

`POST /api/enrichment/plans`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L89).

Queue an enrichment plan

Permission: `asset.update`. Admin only: `false`.

Models: [EnrichmentPlanCreateDto](models-11.md#enrichmentplancreatedto), [EnrichmentPlanResponseDto](models-11.md#enrichmentplanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Post('plans')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Queue an enrichment plan',
    description:
      'Runs the chosen stages, and the ones they need, on a frozen list of assets in the background, pinned to the destinations and configuration admitted now. Moment captions are never added unless chosen. Submitting the same requestKey again returns the existing plan.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Runs the chosen stages, and the ones they need, on a frozen list of assets in the background, pinned to the destinations and configuration admitted now. Moment captions are never added unless chosen. Submitting the same requestKey again returns the existing plan.",
  "operationId": "createEnrichmentPlan",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/EnrichmentPlanCreateDto"
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
            "$ref": "#/components/schemas/EnrichmentPlanResponseDto"
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
  "summary": "Queue an enrichment plan",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## getEnrichmentPlan

`GET /api/enrichment/plans/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L105).

Get an enrichment plan

Permission: `See authentication declaration`. Admin only: `false`.

Models: [EnrichmentPlanResponseDto](models-11.md#enrichmentplanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Get('plans/:id')
@Authenticated()
@Endpoint({
    summary: 'Get an enrichment plan',
    description:
      'The plan with every asset and stage: queued, running, skipped, failed, completed or cancelled. Read from the durable record, so it is the same after a reload. Cancel, pause, resume and retry are the media operation routes.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The plan with every asset and stage: queued, running, skipped, failed, completed or cancelled. Read from the durable record, so it is the same after a reload. Cancel, pause, resume and retry are the media operation routes.",
  "operationId": "getEnrichmentPlan",
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
            "$ref": "#/components/schemas/EnrichmentPlanResponseDto"
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
  "summary": "Get an enrichment plan",
  "tags": [
    "Enrichment"
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

## previewEnrichment

`POST /api/enrichment/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L73).

Preview an enrichment change

Permission: `See authentication declaration`. Admin only: `true`.

Models: [EnrichmentPreviewRequestDto](models-11.md#enrichmentpreviewrequestdto), [EnrichmentPreviewResponseDto](models-11.md#enrichmentpreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Post('preview')
@HttpCode(HttpStatus.OK)
@Authenticated({ admin: true })
@Endpoint({
    summary: 'Preview an enrichment change',
    description:
      'Describes a few samples with a draft model or prompt, one at a time, on a named destination. Nothing is written: stored descriptions, tags, Locked state, embeddings and frames are unchanged.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Describes a few samples with a draft model or prompt, one at a time, on a named destination. Nothing is written: stored descriptions, tags, Locked state, embeddings and frames are unchanged.",
  "operationId": "previewEnrichment",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/EnrichmentPreviewRequestDto"
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
            "$ref": "#/components/schemas/EnrichmentPreviewResponseDto"
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
  "summary": "Preview an enrichment change",
  "tags": [
    "Enrichment"
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

## setVideoMomentCover

`PUT /api/enrichment/videos/{id}/cover`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L175).

Choose a video cover frame

Permission: `asset.update`. Admin only: `false`.

Models: [VideoMomentCoverDto](models-37.md#videomomentcoverdto), [VideoMomentsResponseDto](models-37.md#videomomentsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Put('videos/:id/cover')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Choose a video cover frame',
    description:
      'Keeps the chosen frame as a time in the video, so it survives the frames being cut again. Null returns to the best-ranked frame.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Keeps the chosen frame as a time in the video, so it survives the frames being cut again. Null returns to the best-ranked frame.",
  "operationId": "setVideoMomentCover",
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
          "$ref": "#/components/schemas/VideoMomentCoverDto"
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
            "$ref": "#/components/schemas/VideoMomentsResponseDto"
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
  "summary": "Choose a video cover frame",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## getVideoMoments

`GET /api/enrichment/videos/{id}/moments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L163).

Get video moments

Permission: `asset.read`. Admin only: `false`.

Models: [VideoMomentsResponseDto](models-37.md#videomomentsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Get('videos/:id/moments')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get video moments',
    description:
      'The reusable frames of a video ranked best first, its cover, its generated and manual moments, and what they were made from, with any that are out of date marked.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The reusable frames of a video ranked best first, its cover, its generated and manual moments, and what they were made from, with any that are out of date marked.",
  "operationId": "getVideoMoments",
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
            "$ref": "#/components/schemas/VideoMomentsResponseDto"
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
  "summary": "Get video moments",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## createVideoMoment

`POST /api/enrichment/videos/{id}/moments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L191).

Add a video moment

Permission: `asset.update`. Admin only: `false`.

Models: [VideoMomentCreateDto](models-37.md#videomomentcreatedto), [VideoMomentDto](models-37.md#videomomentdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Post('videos/:id/moments')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Add a video moment',
    description: 'Adds your own moment, with an optional title and typed transcript. Refreshing never removes it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Adds your own moment, with an optional title and typed transcript. Refreshing never removes it.",
  "operationId": "createVideoMoment",
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
          "$ref": "#/components/schemas/VideoMomentCreateDto"
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
            "$ref": "#/components/schemas/VideoMomentDto"
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
  "summary": "Add a video moment",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## deleteVideoMoment

`DELETE /api/enrichment/videos/{id}/moments/{momentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L222).

Delete a video moment

Permission: `asset.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Delete('videos/:id/moments/:momentId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Delete a video moment',
    description: 'Removes one of your own moments. Generated moments are refreshed, not deleted.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes one of your own moments. Generated moments are refreshed, not deleted.",
  "operationId": "deleteVideoMoment",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "momentId",
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
  "summary": "Delete a video moment",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## updateVideoMoment

`PUT /api/enrichment/videos/{id}/moments/{momentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/enrichment.controller.ts#L207).

Update a video moment

Permission: `asset.update`. Admin only: `false`.

Models: [VideoMomentDto](models-37.md#videomomentdto), [VideoMomentUpdateDto](models-37.md#videomomentupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Enrichment)
@Controller('enrichment')
@Put('videos/:id/moments/:momentId')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Update a video moment',
    description: 'Edits one of your own moments. Generated moments are refreshed, not edited.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Edits one of your own moments. Generated moments are refreshed, not edited.",
  "operationId": "updateVideoMoment",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Asset ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "momentId",
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
          "$ref": "#/components/schemas/VideoMomentUpdateDto"
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
            "$ref": "#/components/schemas/VideoMomentDto"
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
  "summary": "Update a video moment",
  "tags": [
    "Enrichment"
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
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```
