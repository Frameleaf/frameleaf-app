# Server API — Activities

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getActivities

`GET /api/activities`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/activity.controller.ts#L23).

List all activities

Permission: `activity.read`. Admin only: `false`.

Models: [ActivityResponseDto](models-01.md#activityresponsedto), [ReactionLevel](models-27.md#reactionlevel), [ReactionType](models-27.md#reactiontype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Activities)
@Controller('activities')
@Get()
@Authenticated({ permission: Permission.ActivityRead })
@Endpoint({
    summary: 'List all activities',
    description:
      'Returns a list of activities for the selected asset or album. The activities are returned in sorted order, with the oldest activities appearing first.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns a list of activities for the selected asset or album. The activities are returned in sorted order, with the oldest activities appearing first.",
  "operationId": "getActivities",
  "parameters": [
    {
      "name": "albumId",
      "required": true,
      "in": "query",
      "description": "Album ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetId",
      "required": false,
      "in": "query",
      "description": "Asset ID (if activity is for an asset)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "level",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/ReactionLevel"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/ReactionType"
      }
    },
    {
      "name": "userId",
      "required": false,
      "in": "query",
      "description": "Filter by user ID",
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
            "items": {
              "$ref": "#/components/schemas/ActivityResponseDto"
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
  "summary": "List all activities",
  "tags": [
    "Activities"
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
  "x-immich-permission": "activity.read",
  "x-immich-state": "Stable"
}
```

## createActivity

`POST /api/activities`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/activity.controller.ts#L35).

Create an activity

Permission: `activity.create`. Admin only: `false`.

Models: [ActivityCreateDto](models-01.md#activitycreatedto), [ActivityResponseDto](models-01.md#activityresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Activities)
@Controller('activities')
@Post()
@Authenticated({ permission: Permission.ActivityCreate })
@Endpoint({
    summary: 'Create an activity',
    description: 'Create a like or a comment for an album, or an asset in an album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a like or a comment for an album, or an asset in an album.",
  "operationId": "createActivity",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ActivityCreateDto"
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
            "$ref": "#/components/schemas/ActivityResponseDto"
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
  "summary": "Create an activity",
  "tags": [
    "Activities"
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
  "x-immich-permission": "activity.create",
  "x-immich-state": "Stable"
}
```

## getActivityStatistics

`GET /api/activities/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/activity.controller.ts#L54).

Retrieve activity statistics

Permission: `activity.statistics`. Admin only: `false`.

Models: [ActivityStatisticsResponseDto](models-01.md#activitystatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Activities)
@Controller('activities')
@Get('statistics')
@Authenticated({ permission: Permission.ActivityStatistics })
@Endpoint({
    summary: 'Retrieve activity statistics',
    description: 'Returns the number of likes and comments for a given album or asset in an album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns the number of likes and comments for a given album or asset in an album.",
  "operationId": "getActivityStatistics",
  "parameters": [
    {
      "name": "albumId",
      "required": true,
      "in": "query",
      "description": "Album ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetId",
      "required": false,
      "in": "query",
      "description": "Asset ID (if activity is for an asset)",
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
            "$ref": "#/components/schemas/ActivityStatisticsResponseDto"
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
  "summary": "Retrieve activity statistics",
  "tags": [
    "Activities"
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
  "x-immich-permission": "activity.statistics",
  "x-immich-state": "Stable"
}
```

## deleteActivity

`DELETE /api/activities/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/activity.controller.ts#L65).

Delete an activity

Permission: `activity.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Activities)
@Controller('activities')
@Delete(':id')
@Authenticated({ permission: Permission.ActivityDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete an activity',
    description: 'Removes a like or comment from a given album or asset in an album.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes a like or comment from a given album or asset in an album.",
  "operationId": "deleteActivity",
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
  "summary": "Delete an activity",
  "tags": [
    "Activities"
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
  "x-immich-permission": "activity.delete",
  "x-immich-state": "Stable"
}
```
