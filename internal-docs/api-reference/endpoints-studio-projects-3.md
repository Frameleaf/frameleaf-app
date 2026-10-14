# Server API — Studio projects 3

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getStudioFonts

`GET /api/studio/fonts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-catalog.controller.ts#L45).

List the title fonts bundled with this server

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioFontCatalogDto](models-34.md#studiofontcatalogdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('fonts')
@Authenticated()
@Endpoint({
    summary: 'List the title fonts bundled with this server',
    description:
      'The title font families a native Studio client draws (graph protocol 14.3.5): each family as a graph names it, its package, version, licence and copyright line, and every bundled file with its weight, style, Unicode subset, format, size and SHA-256. Each font is listed twice: as WOFF2, and decoded to TTF for a client that cannot load WOFF2. The files are served by GET /studio/fonts/{sha256}.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The title font families a native Studio client draws (graph protocol 14.3.5): each family as a graph names it, its package, version, licence and copyright line, and every bundled file with its weight, style, Unicode subset, format, size and SHA-256. Each font is listed twice: as WOFF2, and decoded to TTF for a client that cannot load WOFF2. The files are served by GET /studio/fonts/{sha256}.",
  "operationId": "getStudioFonts",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioFontCatalogDto"
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
  "summary": "List the title fonts bundled with this server",
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

## getStudioFontFile

`GET /api/studio/fonts/{sha256}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-catalog.controller.ts#L57).

Download a bundled title font file

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('fonts/:sha256')
@FileResponse()
@Authenticated()
@Endpoint({
    summary: 'Download a bundled title font file',
    description:
      'The bytes of one file of GET /studio/fonts, named by its SHA-256. Only a hash the catalogue lists is served; the answer for a hash never changes and may be cached for good. Check the hash after download.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The bytes of one file of GET /studio/fonts, named by its SHA-256. Only a hash the catalogue lists is served; the answer for a hash never changes and may be cached for good. Check the hash after download.",
  "operationId": "getStudioFontFile",
  "parameters": [
    {
      "name": "sha256",
      "required": true,
      "in": "path",
      "description": "SHA-256 of a catalogue file, lower-case hex",
      "schema": {
        "pattern": "^[a-f0-9]{64}$",
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
  "summary": "Download a bundled title font file",
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

## searchStudioProjects

`GET /api/studio/projects`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L74).

List Studio projects

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectListResponseDto](models-35.md#studioprojectlistresponsedto), [StudioProjectShelf](models-35.md#studioprojectshelf), [StudioProjectSort](models-35.md#studioprojectsort).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get()
@Authenticated()
@Endpoint({
    summary: 'List Studio projects',
    description:
      'One shelf of the project library. The active shelf holds projects you own and projects shared with a space you belong to; the archive and the trash hold your own only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "One shelf of the project library. The active shelf holds projects you own and projects shared with a space you belong to; the archive and the trash hold your own only.",
  "operationId": "searchStudioProjects",
  "parameters": [
    {
      "name": "query",
      "required": false,
      "in": "query",
      "description": "Case-insensitive part of the name",
      "schema": {
        "maxLength": 200,
        "type": "string"
      }
    },
    {
      "name": "shelf",
      "required": false,
      "in": "query",
      "description": "Which shelf to list; `active` when omitted",
      "schema": {
        "$ref": "#/components/schemas/StudioProjectShelf"
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
      "name": "sort",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/StudioProjectSort"
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
            "$ref": "#/components/schemas/StudioProjectListResponseDto"
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
  "summary": "List Studio projects",
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

## createStudioProject

`POST /api/studio/projects`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L102).

Create a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectCreateDto](models-35.md#studioprojectcreatedto), [StudioProjectDetailDto](models-35.md#studioprojectdetaildto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post()
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Create a Studio project',
    description:
      'Creates an empty project owned by you and hands the write lease to the given editor instance. An initial document, when given, is saved as revision 1.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Creates an empty project owned by you and hands the write lease to the given editor instance. An initial document, when given, is saved as revision 1.",
  "operationId": "createStudioProject",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioProjectCreateDto"
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
            "$ref": "#/components/schemas/StudioProjectDetailDto"
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
  "summary": "Create a Studio project",
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

## emptyStudioProjectTrash

`POST /api/studio/projects/trash/empty`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L89).

Empty the Studio trash

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectTrashEmptyResponseDto](models-35.md#studioprojecttrashemptyresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post('trash/empty')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    summary: 'Empty the Studio trash',
    description:
      'Deletes every project in your Studio trash for good, with its history and comments. Media in your library is never touched.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes every project in your Studio trash for good, with its history and comments. Media in your library is never touched.",
  "operationId": "emptyStudioProjectTrash",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioProjectTrashEmptyResponseDto"
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
  "summary": "Empty the Studio trash",
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

## deleteStudioProject

`DELETE /api/studio/projects/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L143).

Delete a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Delete a Studio project',
    description:
      'Moves the project to the trash, where it can be restored until its retention runs out; with `permanent`, deletes it, its history and its comments now. Owner only. Media in your library is never touched, and finished jobs keep their lineage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Moves the project to the trash, where it can be restored until its retention runs out; with `permanent`, deletes it, its history and its comments now. Owner only. Media in your library is never touched, and finished jobs keep their lineage.",
  "operationId": "deleteStudioProject",
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
      "name": "permanent",
      "required": false,
      "in": "query",
      "description": "Delete for good instead of moving to the trash. Library media is never touched either way.",
      "schema": {
        "type": "boolean"
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
  "summary": "Delete a Studio project",
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

## getStudioProject

`GET /api/studio/projects/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L115).

Get a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDetailDto](models-35.md#studioprojectdetaildto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio project',
    description:
      'The project with its head document. A reviewer receives the document only when every source it references is available to them; otherwise it is withheld.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The project with its head document. A reviewer receives the document only when every source it references is available to them; otherwise it is withheld.",
  "operationId": "getStudioProject",
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
            "$ref": "#/components/schemas/StudioProjectDetailDto"
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
  "summary": "Get a Studio project",
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

## updateStudioProject

`PUT /api/studio/projects/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L127).

Update a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDto](models-35.md#studioprojectdto), [StudioProjectUpdateDto](models-35.md#studioprojectupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Put(':id')
@Authenticated()
@Endpoint({
    summary: 'Update a Studio project',
    description:
      'Rename the project, set the shared space whose members may review it, archive it or bring it back, or choose a library item as its poster. Owner only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Rename the project, set the shared space whose members may review it, archive it or bring it back, or choose a library item as its poster. Owner only.",
  "operationId": "updateStudioProject",
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
          "$ref": "#/components/schemas/StudioProjectUpdateDto"
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
  "summary": "Update a Studio project",
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

## exportStudioProjectBundle

`POST /api/studio/projects/{id}/bundle`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L189).

Export a Studio project as a bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-17.md#mediaoperationdto), [StudioBundleExportCreateDto](models-34.md#studiobundleexportcreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/bundle')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Export a Studio project as a bundle',
    description:
      'Queues a portable bundle of the current version: the project document, a manifest with digests, and references to its media or, when asked, copies of the media you own. Follow it in Activity. Owner only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a portable bundle of the current version: the project document, a manifest with digests, and references to its media or, when asked, copies of the media you own. Follow it in Activity. Owner only.",
  "operationId": "exportStudioProjectBundle",
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
          "$ref": "#/components/schemas/StudioBundleExportCreateDto"
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
  "summary": "Export a Studio project as a bundle",
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

## getStudioProjectComments

`GET /api/studio/projects/{id}/comments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L384).

List Studio review comments

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioCommentListResponseDto](models-34.md#studiocommentlistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/comments')
@Authenticated()
@Endpoint({
    summary: 'List Studio review comments',
    description: 'Comments pinned to the timeline, oldest first.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Comments pinned to the timeline, oldest first.",
  "operationId": "getStudioProjectComments",
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
            "$ref": "#/components/schemas/StudioCommentListResponseDto"
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
  "summary": "List Studio review comments",
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

## addStudioProjectComment

`POST /api/studio/projects/{id}/comments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L399).

Add a Studio review comment

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioCommentCreateDto](models-34.md#studiocommentcreatedto), [StudioCommentDto](models-34.md#studiocommentdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/comments')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Add a Studio review comment',
    description: 'Owner and reviewers may comment. The time is an exact fraction of seconds. No lease is needed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner and reviewers may comment. The time is an exact fraction of seconds. No lease is needed.",
  "operationId": "addStudioProjectComment",
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
          "$ref": "#/components/schemas/StudioCommentCreateDto"
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
            "$ref": "#/components/schemas/StudioCommentDto"
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
  "summary": "Add a Studio review comment",
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

## removeStudioProjectComment

`DELETE /api/studio/projects/{id}/comments/{commentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L430).

Remove a Studio review comment

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Delete(':id/comments/:commentId')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Remove a Studio review comment',
    description: 'The author or the project owner may remove a comment.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The author or the project owner may remove a comment.",
  "operationId": "removeStudioProjectComment",
  "parameters": [
    {
      "name": "commentId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
  "summary": "Remove a Studio review comment",
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

## updateStudioProjectComment

`PUT /api/studio/projects/{id}/comments/{commentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L415).

Update a Studio review comment

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioCommentDto](models-34.md#studiocommentdto), [StudioCommentUpdateDto](models-34.md#studiocommentupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Put(':id/comments/:commentId')
@Authenticated()
@Endpoint({
    summary: 'Update a Studio review comment',
    description: 'The author edits the text; the author or the owner resolves or reopens it.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The author edits the text; the author or the owner resolves or reopens it.",
  "operationId": "updateStudioProjectComment",
  "parameters": [
    {
      "name": "commentId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioCommentUpdateDto"
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
            "$ref": "#/components/schemas/StudioCommentDto"
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
  "summary": "Update a Studio review comment",
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

## duplicateStudioProject

`POST /api/studio/projects/{id}/duplicate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project.controller.ts#L172).

Duplicate a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectDto](models-35.md#studioprojectdto), [StudioProjectDuplicateDto](models-35.md#studioprojectduplicatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/duplicate')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Duplicate a Studio project',
    description:
      'Creates a new project of yours whose first version is this project as it is now. The copy is not shared for review. Owner only.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Creates a new project of yours whose first version is this project as it is now. The copy is not shared for review. Owner only.",
  "operationId": "duplicateStudioProject",
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
          "$ref": "#/components/schemas/StudioProjectDuplicateDto"
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
  "summary": "Duplicate a Studio project",
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

## getStudioExports

`GET /api/studio/projects/{id}/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-export.controller.ts#L66).

List a Studio project’s exports

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioExportListResponseDto](models-34.md#studioexportlistresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('projects/:id/exports')
@Authenticated()
@Endpoint({
    summary: 'List a Studio project’s exports',
    description: 'Every export of the project, newest first: published versions and exports still on their way.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Every export of the project, newest first: published versions and exports still on their way.",
  "operationId": "getStudioExports",
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
            "$ref": "#/components/schemas/StudioExportListResponseDto"
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
  "summary": "List a Studio project’s exports",
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

## createStudioExport

`POST /api/studio/projects/{id}/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-export.controller.ts#L49).

Export a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioExportCreateDto](models-34.md#studioexportcreatedto), [StudioExportCreateResponseDto](models-34.md#studioexportcreateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Post('projects/:id/exports')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Export a Studio project',
    description:
      'Queues a render of the current version to a finished file. Every source is checked for you now, again when the render starts and again before the result is published; the result inherits every source’s Locked and sensitive status. A result that uses media shared with you stays with the project. Follow it in Activity. Owner only.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a render of the current version to a finished file. Every source is checked for you now, again when the render starts and again before the result is published; the result inherits every source’s Locked and sensitive status. A result that uses media shared with you stays with the project. Follow it in Activity. Owner only.",
  "operationId": "createStudioExport",
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
          "$ref": "#/components/schemas/StudioExportCreateDto"
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
            "$ref": "#/components/schemas/StudioExportCreateResponseDto"
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
  "summary": "Export a Studio project",
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

## getStudioProjectImports

`GET /api/studio/projects/{id}/imports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project-import.controller.ts#L157).

List the files imported into a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectImportDto](models-35.md#studioprojectimportdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/imports')
@Authenticated()
@Endpoint({
    summary: 'List the files imported into a Studio project',
    description: 'Every file kept with one of your projects, with its type, size and checksum.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every file kept with one of your projects, with its type, size and checksum.",
  "operationId": "getStudioProjectImports",
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
            "items": {
              "$ref": "#/components/schemas/StudioProjectImportDto"
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
  "summary": "List the files imported into a Studio project",
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

## importStudioProjectFile

`POST /api/studio/projects/{id}/imports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project-import.controller.ts#L126).

Import a file into a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectImportCreateDto](models-35.md#studioprojectimportcreatedto), [StudioProjectImportDto](models-35.md#studioprojectimportdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/imports')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A file to import into the project', type: StudioProjectImportCreateDto })
@UseInterceptors(StudioProjectImportUploadInterceptor)
@Endpoint({
    summary: 'Import a file into a Studio project',
    description:
      'Keeps a recording, sound, image, short video, SVG or Lottie graphic, caption file (.srt or .vtt) or .cube LUT with the project rather than the library. The type is read from the bytes; an SVG with scripts is refused, external subresources of a graphic are counted, and a caption file or LUT must be well formed throughout. The same id and file again answers the stored import.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Keeps a recording, sound, image, short video, SVG or Lottie graphic, caption file (.srt or .vtt) or .cube LUT with the project rather than the library. The type is read from the bytes; an SVG with scripts is refused, external subresources of a graphic are counted, and a caption file or LUT must be well formed throughout. The same id and file again answers the stored import.",
  "operationId": "importStudioProjectFile",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/StudioProjectImportCreateDto"
        }
      }
    },
    "description": "A file to import into the project",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioProjectImportDto"
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
  "summary": "Import a file into a Studio project",
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

## getStudioImportPublications

`GET /api/studio/projects/{id}/imports/publications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project-import.controller.ts#L83).

Discover Studio import publications

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioImportPublicationPageDto](models-34.md#studioimportpublicationpagedto), [StudioImportPublicationState](models-34.md#studioimportpublicationstate).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/imports/publications')
@Authenticated()
@Endpoint({
    summary: 'Discover Studio import publications',
    description: 'Owner-only receipts, at most100 per page; pass nextCursor explicitly to continue.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner-only receipts, at most100 per page; pass nextCursor explicitly to continue.",
  "operationId": "getStudioImportPublications",
  "parameters": [
    {
      "name": "cursor",
      "required": false,
      "in": "query",
      "schema": {
        "minLength": 1,
        "maxLength": 1024,
        "pattern": "^[A-Za-z0-9_-]+$",
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
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/StudioImportPublicationState"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioImportPublicationPageDto"
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
  "summary": "Discover Studio import publications",
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

## registerStudioImportPublication

`POST /api/studio/projects/{id}/imports/publications`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project-import.controller.ts#L68).

Register a Studio import publication

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioImportPublicationDto](models-34.md#studioimportpublicationdto), [StudioImportPublicationRegisterDto](models-34.md#studioimportpublicationregisterdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Post(':id/imports/publications')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Register a Studio import publication',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "registerStudioImportPublication",
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
          "$ref": "#/components/schemas/StudioImportPublicationRegisterDto"
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
            "$ref": "#/components/schemas/StudioImportPublicationDto"
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
  "summary": "Register a Studio import publication",
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

## getStudioImportPublication

`GET /api/studio/projects/{id}/imports/publications/{publicationId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/server/src/controllers/studio-project-import.controller.ts#L98).

Read a Studio import publication

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioImportPublicationDto](models-34.md#studioimportpublicationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/projects')
@Get(':id/imports/publications/:publicationId')
@Authenticated()
@Endpoint({
    summary: 'Read a Studio import publication',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getStudioImportPublication",
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
      "name": "publicationId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioImportPublicationDto"
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
  "summary": "Read a Studio import publication",
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
