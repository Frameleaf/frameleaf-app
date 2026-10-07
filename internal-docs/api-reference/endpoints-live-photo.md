# Server API — Live Photo

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getLivePhotoCandidates

`GET /api/live-photo/candidates`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/live-photo.controller.ts#L19).

List live photo relink candidates

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LivePhotoCandidatesResponseDto](models-14.md#livephotocandidatesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.LivePhoto)
@Controller('live-photo')
@Get('candidates')
@Authenticated()
@Endpoint({
    summary: 'List live photo relink candidates',
    description:
      'Find separated live photos (a still image and its motion video that are not linked) that can be reassembled.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Find separated live photos (a still image and its motion video that are not linked) that can be reassembled.",
  "operationId": "getLivePhotoCandidates",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LivePhotoCandidatesResponseDto"
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
  "summary": "List live photo relink candidates",
  "tags": [
    "Live Photo"
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

## relinkLivePhotos

`POST /api/live-photo/relink`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/live-photo.controller.ts#L31).

Relink live photos

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LivePhotoRelinkDto](models-14.md#livephotorelinkdto), [LivePhotoRelinkResponseDto](models-14.md#livephotorelinkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.LivePhoto)
@Controller('live-photo')
@Post('relink')
@Authenticated()
@Endpoint({
    summary: 'Relink live photos',
    description: 'Reassemble the selected still + video pairs into live photos, hiding the standalone videos.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Reassemble the selected still + video pairs into live photos, hiding the standalone videos.",
  "operationId": "relinkLivePhotos",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LivePhotoRelinkDto"
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
            "$ref": "#/components/schemas/LivePhotoRelinkResponseDto"
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
  "summary": "Relink live photos",
  "tags": [
    "Live Photo"
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
