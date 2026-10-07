# Server API — Frameleaf Cloud jobs

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## createCloudMlJob

`POST /api/cloud/ml/jobs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml.controller.ts#L45).

Confirm a Frameleaf Cloud job

Permission: `cloudMlJob.create`. Admin only: `false`.

Models: [CloudMlJobCreateDto](models-09.md#cloudmljobcreatedto), [CloudMlJobResponseDto](models-09.md#cloudmljobresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudJobs)
@Controller('cloud/ml/jobs')
@Post()
@Authenticated({ permission: Permission.CloudMlJobCreate })
@Endpoint({
    operationId: 'createCloudMlJob',
    summary: 'Confirm a Frameleaf Cloud job',
    description:
      'Confirms a kept estimate with the consent version it was shown with and the acknowledgement that the file leaves this server. The job then runs in Activity. A repeated confirmation answers with the same job; an expired estimate is refused with 409 estimate-expired and is never reused.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Confirms a kept estimate with the consent version it was shown with and the acknowledgement that the file leaves this server. The job then runs in Activity. A repeated confirmation answers with the same job; an expired estimate is refused with 409 estimate-expired and is never reused.",
  "operationId": "createCloudMlJob",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlJobCreateDto"
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
            "$ref": "#/components/schemas/CloudMlJobResponseDto"
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
  "summary": "Confirm a Frameleaf Cloud job",
  "tags": [
    "Frameleaf Cloud jobs"
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
  "x-immich-permission": "cloudMlJob.create",
  "x-immich-state": "Alpha"
}
```

## estimateCloudMlJob

`POST /api/cloud/ml/jobs/estimate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml.controller.ts#L28).

Estimate a Frameleaf Cloud job

Permission: `cloudMlJob.create`. Admin only: `false`.

Models: [CloudMlJobEstimateRequestDto](models-09.md#cloudmljobestimaterequestdto), [CloudMlJobEstimateResponseDto](models-09.md#cloudmljobestimateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudJobs)
@Controller('cloud/ml/jobs')
@Post('estimate')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.CloudMlJobCreate })
@Endpoint({
    operationId: 'estimateCloudMlJob',
    summary: 'Estimate a Frameleaf Cloud job',
    description:
      'Prepares the preview or the whole file without metadata and asks Frameleaf Cloud for a sealed estimate: metered GPU time × rate + a start fee per worker, as a p50–p90 range with a per-photo or per-minute figure, the AI Wallet and the consent version. Nothing is sent to be processed. 409 model-mismatch sends the person back to the model slider.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Prepares the preview or the whole file without metadata and asks Frameleaf Cloud for a sealed estimate: metered GPU time × rate + a start fee per worker, as a p50–p90 range with a per-photo or per-minute figure, the AI Wallet and the consent version. Nothing is sent to be processed. 409 model-mismatch sends the person back to the model slider.",
  "operationId": "estimateCloudMlJob",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlJobEstimateRequestDto"
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
            "$ref": "#/components/schemas/CloudMlJobEstimateResponseDto"
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
  "summary": "Estimate a Frameleaf Cloud job",
  "tags": [
    "Frameleaf Cloud jobs"
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
  "x-immich-permission": "cloudMlJob.create",
  "x-immich-state": "Alpha"
}
```

## getCloudMlJob

`GET /api/cloud/ml/jobs/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml.controller.ts#L58).

Get a Frameleaf Cloud job

Permission: `cloudMlJob.read`. Admin only: `false`.

Models: [CloudMlJobActivityDto](models-09.md#cloudmljobactivitydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudJobs)
@Controller('cloud/ml/jobs')
@Get(':id')
@Authenticated({ permission: Permission.CloudMlJobRead })
@Endpoint({
    operationId: 'getCloudMlJob',
    summary: 'Get a Frameleaf Cloud job',
    description:
      'Where one of your Frameleaf Cloud jobs is: its stage (queued, starting, running, paused, done, failed or cancelled), the model, and the estimated, metered and settled cost.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Where one of your Frameleaf Cloud jobs is: its stage (queued, starting, running, paused, done, failed or cancelled), the model, and the estimated, metered and settled cost.",
  "operationId": "getCloudMlJob",
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
            "$ref": "#/components/schemas/CloudMlJobActivityDto"
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
  "summary": "Get a Frameleaf Cloud job",
  "tags": [
    "Frameleaf Cloud jobs"
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
  "x-immich-permission": "cloudMlJob.read",
  "x-immich-state": "Alpha"
}
```
