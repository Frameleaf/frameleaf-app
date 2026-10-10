# Server API — Libraries

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAllLibraries

`GET /api/libraries`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L31).

Retrieve libraries

Permission: `library.read`. Admin only: `true`.

Models: [LibraryResponseDto](models-15.md#libraryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Get()
@Authenticated({ permission: Permission.LibraryRead, admin: true })
@Endpoint({
    summary: 'Retrieve libraries',
    description: 'Retrieve a list of external libraries, each with its latest scan.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .updated('v3', 'Each library carries its latest scan and removal state'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of external libraries, each with its latest scan.",
  "operationId": "getAllLibraries",
  "parameters": [
    {
      "name": "withDeleted",
      "required": false,
      "in": "query",
      "description": "Include libraries whose removal is still in progress",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/LibraryResponseDto"
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
  "summary": "Retrieve libraries",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
      "state": "Updated",
      "description": "Each library carries its latest scan and removal state"
    }
  ],
  "x-immich-permission": "library.read",
  "x-immich-state": "Stable"
}
```

## createLibrary

`POST /api/libraries`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L58).

Create a library

Permission: `library.create`. Admin only: `true`.

Models: [CreateLibraryDto](models-10.md#createlibrarydto), [LibraryResponseDto](models-15.md#libraryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Post()
@Authenticated({ permission: Permission.LibraryCreate, admin: true })
@Endpoint({
    summary: 'Create a library',
    description: 'Create a new external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new external library.",
  "operationId": "createLibrary",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CreateLibraryDto"
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
            "$ref": "#/components/schemas/LibraryResponseDto"
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
  "summary": "Create a library",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "library.create",
  "x-immich-state": "Stable"
}
```

## getManagedUploadStatistics

`GET /api/libraries/managed-uploads`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L46).

Retrieve managed upload statistics

Permission: `library.statistics`. Admin only: `true`.

Models: [ManagedUploadsStatsResponseDto](models-15.md#manageduploadsstatsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Get('managed-uploads')
@Authenticated({ permission: Permission.LibraryStatistics, admin: true })
@Endpoint({
    summary: 'Retrieve managed upload statistics',
    description:
      'Retrieve, for every active account, the photos, videos and original sizes it keeps in managed upload storage rather than in external libraries.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve, for every active account, the photos, videos and original sizes it keeps in managed upload storage rather than in external libraries.",
  "operationId": "getManagedUploadStatistics",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ManagedUploadsStatsResponseDto"
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
  "summary": "Retrieve managed upload statistics",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "library.statistics"
}
```

## deleteLibrary

`DELETE /api/libraries/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L111).

Delete a library

Permission: `library.delete`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Delete(':id')
@Authenticated({ permission: Permission.LibraryDelete, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a library',
    description: 'Delete an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete an external library by its ID.",
  "operationId": "deleteLibrary",
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
  "summary": "Delete a library",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "library.delete",
  "x-immich-state": "Stable"
}
```

## getLibrary

`GET /api/libraries/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L69).

Retrieve a library

Permission: `library.read`. Admin only: `true`.

Models: [LibraryResponseDto](models-15.md#libraryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Get(':id')
@Authenticated({ permission: Permission.LibraryRead, admin: true })
@Endpoint({
    summary: 'Retrieve a library',
    description: 'Retrieve an external library by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve an external library by its ID.",
  "operationId": "getLibrary",
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
            "$ref": "#/components/schemas/LibraryResponseDto"
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
  "summary": "Retrieve a library",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "library.read",
  "x-immich-state": "Stable"
}
```

## updateLibrary

`PUT /api/libraries/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L81).

Update a library

Permission: `library.update`. Admin only: `true`.

Models: [LibraryResponseDto](models-15.md#libraryresponsedto), [UpdateLibraryDto](models-37.md#updatelibrarydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Put(':id')
@Authenticated({ permission: Permission.LibraryUpdate, admin: true })
@Endpoint({
    summary: 'Update a library',
    description: 'Update an existing external library.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateLibrary' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an existing external library.",
  "operationId": "updateLibrary",
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
          "$ref": "#/components/schemas/UpdateLibraryDto"
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
            "$ref": "#/components/schemas/LibraryResponseDto"
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
  "summary": "Update a library",
  "tags": [
    "Libraries",
    "Deprecated"
  ],
  "x-immich-admin-only": true,
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
      "replacementId": "updateLibrary"
    }
  ],
  "x-immich-permission": "library.update",
  "x-immich-state": "Deprecated"
}
```

## getLibraryRemovalReview

`GET /api/libraries/{id}/removal`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L173).

Review a library removal

Permission: `library.delete`. Admin only: `true`.

Models: [LibraryRemovalReviewDto](models-15.md#libraryremovalreviewdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Get(':id/removal')
@Authenticated({ permission: Permission.LibraryDelete, admin: true })
@Endpoint({
    summary: 'Review a library removal',
    description:
      'The first stage of removing an external library: the indexed items, albums, shared links and faces the removal takes with it, and a token to confirm it with. Source files are never deleted.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The first stage of removing an external library: the indexed items, albums, shared links and faces the removal takes with it, and a token to confirm it with. Source files are never deleted.",
  "operationId": "getLibraryRemovalReview",
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
            "$ref": "#/components/schemas/LibraryRemovalReviewDto"
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
  "summary": "Review a library removal",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "library.delete"
}
```

## removeLibrary

`POST /api/libraries/{id}/removal`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L186).

Remove a library

Permission: `library.delete`. Admin only: `true`.

Models: [LibraryRemovalDto](models-15.md#libraryremovaldto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Post(':id/removal')
@Authenticated({ permission: Permission.LibraryDelete, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove a library',
    description:
      'The second stage of removing an external library: confirm with the typed name and the review token. Refused when the library changed after the review.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The second stage of removing an external library: confirm with the typed name and the review token. Refused when the library changed after the review.",
  "operationId": "removeLibrary",
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
          "$ref": "#/components/schemas/LibraryRemovalDto"
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
  "summary": "Remove a library",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "library.delete"
}
```

## cancelLibraryScan

`DELETE /api/libraries/{id}/scan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L160).

Cancel a library scan

Permission: `library.update`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Delete(':id/scan')
@Authenticated({ permission: Permission.LibraryUpdate, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Cancel a library scan',
    description:
      "Stop the external library's waiting, running or paused scan. Items it already handled stay as they are.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Stop the external library's waiting, running or paused scan. Items it already handled stay as they are.",
  "operationId": "cancelLibraryScan",
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
  "summary": "Cancel a library scan",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "library.update"
}
```

## scanLibrary

`POST /api/libraries/{id}/scan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L148).

Scan a library

Permission: `library.update`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Post(':id/scan')
@Authenticated({ permission: Permission.LibraryUpdate, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Scan a library',
    description: 'Queue a scan for the external library to find and import new assets.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue a scan for the external library to find and import new assets.",
  "operationId": "scanLibrary",
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
  "summary": "Scan a library",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "library.update",
  "x-immich-state": "Stable"
}
```

## getLibraryStatistics

`GET /api/libraries/{id}/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L136).

Retrieve library statistics

Permission: `library.statistics`. Admin only: `true`.

Models: [LibraryStatsResponseDto](models-15.md#librarystatsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Get(':id/statistics')
@Authenticated({ permission: Permission.LibraryStatistics, admin: true })
@Endpoint({
    summary: 'Retrieve library statistics',
    description:
      'Retrieve statistics for a specific external library, including number of videos, images, and storage usage.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve statistics for a specific external library, including number of videos, images, and storage usage.",
  "operationId": "getLibraryStatistics",
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
            "$ref": "#/components/schemas/LibraryStatsResponseDto"
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
  "summary": "Retrieve library statistics",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "library.statistics",
  "x-immich-state": "Stable"
}
```

## validate

`POST /api/libraries/{id}/validate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L123).

Validate library settings

Permission: `See authentication declaration`. Admin only: `true`.

Models: [ValidateLibraryDto](models-38.md#validatelibrarydto), [ValidateLibraryResponseDto](models-38.md#validatelibraryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Post(':id/validate')
@Authenticated({ admin: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Validate library settings',
    description: 'Validate the settings of an external library.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Validate the settings of an external library.",
  "operationId": "validate",
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
          "$ref": "#/components/schemas/ValidateLibraryDto"
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
            "$ref": "#/components/schemas/ValidateLibraryResponseDto"
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
  "summary": "Validate library settings",
  "tags": [
    "Libraries"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-state": "Stable"
}
```
