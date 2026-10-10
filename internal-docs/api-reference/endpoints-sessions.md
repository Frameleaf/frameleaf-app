# Server API — Sessions

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## deleteAllSessions

`DELETE /api/sessions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L43).

Delete all sessions

Permission: `session.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Delete()
@Authenticated({ permission: Permission.SessionDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete all sessions',
    description: 'Delete all sessions for the user. This will not delete the current session.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete all sessions for the user. This will not delete the current session.",
  "operationId": "deleteAllSessions",
  "parameters": [],
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
  "summary": "Delete all sessions",
  "tags": [
    "Sessions"
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
  "x-immich-permission": "session.delete",
  "x-immich-state": "Stable"
}
```

## getSessions

`GET /api/sessions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L32).

Retrieve sessions

Permission: `session.read`. Admin only: `false`.

Models: [SessionResponseDto](models-31.md#sessionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Get()
@Authenticated({ permission: Permission.SessionRead })
@Endpoint({
    summary: 'Retrieve sessions',
    description: 'Retrieve a list of sessions for the user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of sessions for the user.",
  "operationId": "getSessions",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SessionResponseDto"
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
  "summary": "Retrieve sessions",
  "tags": [
    "Sessions"
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
  "x-immich-permission": "session.read",
  "x-immich-state": "Stable"
}
```

## createSession

`POST /api/sessions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L21).

Create a session

Permission: `session.create`. Admin only: `false`.

Models: [SessionCreateDto](models-31.md#sessioncreatedto), [SessionCreateResponseDto](models-31.md#sessioncreateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Post()
@Authenticated({ permission: Permission.SessionCreate })
@Endpoint({
    summary: 'Create a session',
    description: 'Create a session as a child to the current session. This endpoint is used for casting.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a session as a child to the current session. This endpoint is used for casting.",
  "operationId": "createSession",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SessionCreateDto"
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
            "$ref": "#/components/schemas/SessionCreateResponseDto"
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
  "summary": "Create a session",
  "tags": [
    "Sessions"
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
  "x-immich-permission": "session.create",
  "x-immich-state": "Stable"
}
```

## deleteSession

`DELETE /api/sessions/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L85).

Delete a session

Permission: `session.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Delete(':id')
@Authenticated({ permission: Permission.SessionDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a session',
    description: 'Delete a specific session by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific session by id.",
  "operationId": "deleteSession",
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
  "summary": "Delete a session",
  "tags": [
    "Sessions"
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
  "x-immich-permission": "session.delete",
  "x-immich-state": "Stable"
}
```

## updateSession

`PUT /api/sessions/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L55).

Update a session

Permission: `session.update`. Admin only: `false`.

Models: [SessionResponseDto](models-31.md#sessionresponsedto), [SessionUpdateDto](models-31.md#sessionupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Put(':id')
@Authenticated({ permission: Permission.SessionUpdate })
@Endpoint({
    summary: 'Update a session',
    description: 'Update a specific session identified by id.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateSession' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update a specific session identified by id.",
  "operationId": "updateSession",
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
          "$ref": "#/components/schemas/SessionUpdateDto"
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
            "$ref": "#/components/schemas/SessionResponseDto"
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
  "summary": "Update a session",
  "tags": [
    "Sessions",
    "Deprecated"
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
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateSession"
    }
  ],
  "x-immich-permission": "session.update",
  "x-immich-state": "Deprecated"
}
```

## lockSession

`POST /api/sessions/{id}/lock`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L97).

Lock a session

Permission: `session.lock`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Post(':id/lock')
@Authenticated({ permission: Permission.SessionLock })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Lock a session',
    description: 'Lock a specific session by id.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Lock a specific session by id.",
  "operationId": "lockSession",
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
  "summary": "Lock a session",
  "tags": [
    "Sessions"
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
  "x-immich-permission": "session.lock",
  "x-immich-state": "Stable"
}
```
