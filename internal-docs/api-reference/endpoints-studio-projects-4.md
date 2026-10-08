# Server API — Studio projects 4

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## saveStudioProjectRevision

`POST /api/studio/projects/{id}/revisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L265).

Save a Studio project revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectSaveDto](models-34.md#studioprojectsavedto), [StudioProjectSaveResponseDto](models-34.md#studioprojectsaveresponsedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L314).

Get a Studio project revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectRevisionDetailDto](models-34.md#studioprojectrevisiondetaildto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L328).

Compare two Studio project revisions

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDiffDto](models-33.md#studioprojectdiffdto).

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

## restoreStudioProjectFromTrash

`POST /api/studio/projects/{id}/trash/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-project.controller.ts#L152).

Restore a Studio project from the trash

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDto](models-33.md#studioprojectdto).

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

## getStudioRestoredVersion

`GET /api/studio/restored-versions/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-source.controller.ts#L20).

Get a restored version for Studio

Permission: `asset.edit.get`. Admin only: `false`.

Models: [StudioRestoredVersionDto](models-34.md#studiorestoredversiondto).

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

Models: [StudioWorkspaceDto](models-34.md#studioworkspacedto).

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

Models: [StudioWorkspaceDto](models-34.md#studioworkspacedto), [StudioWorkspaceSaveDto](models-34.md#studioworkspacesavedto).

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
