# Server API — Preservation

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getPreservationPackages

`GET /api/preservation/packages`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L85).

List preservation packages

Permission: `asset.download`. Admin only: `false`.

Models: [PreservationPackageDto](models-26.md#preservationpackagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('packages')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'List preservation packages',
    description: 'Your packages, newest first, with their counts, last verification and newest job.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Your packages, newest first, with their counts, last verification and newest job.",
  "operationId": "getPreservationPackages",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PreservationPackageDto"
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
  "summary": "List preservation packages",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## createPreservationPackage

`POST /api/preservation/packages`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L113).

Create a preservation package

Permission: `asset.download`. Admin only: `false`.

Models: [PreservationExportCreateDto](models-25.md#preservationexportcreatedto), [PreservationPackageDto](models-26.md#preservationpackagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('packages')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Create a preservation package',
    description:
      'Freezes a selection of your own items and queues the job that copies their originals, with checksums, metadata sidecars, albums, people, tags and edit recipes. Locked items are included only from an unlocked session.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Freezes a selection of your own items and queues the job that copies their originals, with checksums, metadata sidecars, albums, people, tags and edit recipes. Locked items are included only from an unlocked session.",
  "operationId": "createPreservationPackage",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PreservationExportCreateDto"
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
            "$ref": "#/components/schemas/PreservationPackageDto"
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
  "summary": "Create a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## removePreservationPackage

`DELETE /api/preservation/packages/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L207).

Remove a preservation package

Permission: `asset.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Delete('packages/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Remove a preservation package',
    description:
      'Deletes the package’s own copy on this server. Your library’s originals are never touched, and a package named on the server by an administrator is only forgotten.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes the package’s own copy on this server. Your library’s originals are never touched, and a package named on the server by an administrator is only forgotten.",
  "operationId": "removePreservationPackage",
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
  "summary": "Remove a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## getPreservationPackage

`GET /api/preservation/packages/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L129).

Get a preservation package

Permission: `asset.download`. Admin only: `false`.

Models: [PreservationPackageDto](models-26.md#preservationpackagedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('packages/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({ summary: 'Get a preservation package', description: 'One of your packages.', history: history() })
```

Complete operation contract:

```json
{
  "description": "One of your packages.",
  "operationId": "getPreservationPackage",
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
            "$ref": "#/components/schemas/PreservationPackageDto"
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
  "summary": "Get a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## downloadPreservationPackage

`GET /api/preservation/packages/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L179).

Download a preservation package

Permission: `asset.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('packages/:id/download')
@FileResponse()
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetDownload })
@OriginalTransfer()
@Endpoint({
    summary: 'Download a preservation package',
    description:
      'The package this server wrote, as one ZIP. A package holding Locked items needs an unlocked session. Verify the downloaded copy before relying on it.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The package this server wrote, as one ZIP. A package holding Locked items needs an unlocked session. Verify the downloaded copy before relying on it.",
  "operationId": "downloadPreservationPackage",
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
  "summary": "Download a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## getPreservationPackageItems

`GET /api/preservation/packages/{id}/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L137).

Get a preservation package item report

Permission: `asset.download`. Admin only: `false`.

Models: [PreservationItemState](models-26.md#preservationitemstate), [PreservationItemsResponseDto](models-26.md#preservationitemsresponsedto), [PreservationVerifyState](models-26.md#preservationverifystate).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('packages/:id/items')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Get a preservation package item report',
    description:
      'Each item of the package with its state, last verification and checksum. Locked items are counted but not named until the session is unlocked.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Each item of the package with its state, last verification and checksum. Locked items are counted but not named until the session is unlocked.",
  "operationId": "getPreservationPackageItems",
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
        "type": "integer"
      }
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/PreservationItemState"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "type": "integer"
      }
    },
    {
      "name": "verifyState",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/PreservationVerifyState"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PreservationItemsResponseDto"
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
  "summary": "Get a preservation package item report",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## downloadPreservationManifest

`GET /api/preservation/packages/{id}/manifest`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L194).

Download a preservation manifest

Permission: `asset.download`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('packages/:id/manifest')
@FileResponse()
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Download a preservation manifest',
    description: 'The manifest of a package this server wrote.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The manifest of a package this server wrote.",
  "operationId": "downloadPreservationManifest",
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
  "summary": "Download a preservation manifest",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## retryPreservationPackage

`POST /api/preservation/packages/{id}/retry`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L154).

Retry a preservation export

Permission: `asset.download`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('packages/:id/retry')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Retry a preservation export',
    description: 'Queues a job that copies the items the package could not; items already copied are kept.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a job that copies the items the package could not; items already copied are kept.",
  "operationId": "retryPreservationPackage",
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
  "summary": "Retry a preservation export",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## verifyPreservationPackage

`POST /api/preservation/packages/{id}/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L166).

Verify a preservation package

Permission: `asset.download`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('packages/:id/verify')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Verify a preservation package',
    description:
      'Queues a check of every file of the package against its manifest; missing and changed files are reported.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a check of every file of the package against its manifest; missing and changed files are reported.",
  "operationId": "verifyPreservationPackage",
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
  "summary": "Verify a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## previewPreservationExport

`POST /api/preservation/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L97).

Preview a preservation export

Permission: `asset.download`. Admin only: `false`.

Models: [PreservationPreviewDto](models-26.md#preservationpreviewdto), [PreservationPreviewResponseDto](models-26.md#preservationpreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('preview')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetDownload })
@Endpoint({
    summary: 'Preview a preservation export',
    description:
      'How many of your items a selection holds, how large they are, whether they fit in one package and what a restoration brings back. Writes nothing.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "How many of your items a selection holds, how large they are, whether they fit in one package and what a restoration brings back. Writes nothing.",
  "operationId": "previewPreservationExport",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PreservationPreviewDto"
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
            "$ref": "#/components/schemas/PreservationPreviewResponseDto"
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
  "summary": "Preview a preservation export",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.download",
  "x-immich-state": "Alpha"
}
```

## getPreservationRestores

`GET /api/preservation/restores`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L260).

List restorations

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationRestoreDto](models-26.md#preservationrestoredto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('restores')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'List restorations', description: 'Your restorations, newest first.', history: history() })
```

Complete operation contract:

```json
{
  "description": "Your restorations, newest first.",
  "operationId": "getPreservationRestores",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PreservationRestoreDto"
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
  "summary": "List restorations",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## createPreservationRestore

`POST /api/preservation/restores`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L268).

Start a restoration

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationRestoreCreateDto](models-26.md#preservationrestorecreatedto), [PreservationRestoreDto](models-26.md#preservationrestoredto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('restores')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Start a restoration',
    description:
      'Queues a review of the package: every file is verified and compared with your library. Nothing is written until you restore.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues a review of the package: every file is verified and compared with your library. Nothing is written until you restore.",
  "operationId": "createPreservationRestore",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PreservationRestoreCreateDto"
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
            "$ref": "#/components/schemas/PreservationRestoreDto"
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
  "summary": "Start a restoration",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## getPreservationRestore

`GET /api/preservation/restores/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L284).

Get a restoration

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationRestoreDto](models-26.md#preservationrestoredto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('restores/:id')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({ summary: 'Get a restoration', description: 'One of your restorations.', history: history() })
```

Complete operation contract:

```json
{
  "description": "One of your restorations.",
  "operationId": "getPreservationRestore",
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
            "$ref": "#/components/schemas/PreservationRestoreDto"
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
  "summary": "Get a restoration",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## applyPreservationRestore

`POST /api/preservation/restores/{id}/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L325).

Restore a reviewed package

Permission: `asset.upload`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('restores/:id/apply')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Restore a reviewed package',
    description:
      'Queues the restore: originals your library lacks are added, ones it has are matched and never replaced, and metadata is applied by your choices. Asking again carries on a restore that stopped.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Queues the restore: originals your library lacks are added, ones it has are matched and never replaced, and metadata is applied by your choices. Asking again carries on a restore that stopped.",
  "operationId": "applyPreservationRestore",
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
  "summary": "Restore a reviewed package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## updatePreservationRestoreDecisions

`PUT /api/preservation/restores/{id}/decisions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L309).

Record restoration choices

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationDecisionsUpdateDto](models-25.md#preservationdecisionsupdatedto), [PreservationRestoreDto](models-26.md#preservationrestoredto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Put('restores/:id/decisions')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Record restoration choices',
    description:
      'Your choices where the package and your library disagree. They apply to items not yet restored; a retry keeps them.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Your choices where the package and your library disagree. They apply to items not yet restored; a retry keeps them.",
  "operationId": "updatePreservationRestoreDecisions",
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
          "$ref": "#/components/schemas/PreservationDecisionsUpdateDto"
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
            "$ref": "#/components/schemas/PreservationRestoreDto"
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
  "summary": "Record restoration choices",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## getPreservationRestoreItems

`GET /api/preservation/restores/{id}/items`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L292).

Get restoration items

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationRestoreItemFilter](models-26.md#preservationrestoreitemfilter), [PreservationRestoreItemsResponseDto](models-26.md#preservationrestoreitemsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Get('restores/:id/items')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Get restoration items',
    description:
      'What the review found for each item — new, already in your library, or in the trash — the fields that disagree, your choices and what the restore left for you to look at.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "What the review found for each item — new, already in your library, or in the trash — the fields that disagree, your choices and what the restore left for you to look at.",
  "operationId": "getPreservationRestoreItems",
  "parameters": [
    {
      "name": "filter",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/PreservationRestoreItemFilter"
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
      "name": "skip",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
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
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PreservationRestoreItemsResponseDto"
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
  "summary": "Get restoration items",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## registerPreservationServerPackage

`POST /api/preservation/server-packages`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L244).

Register a preservation package on the server

Permission: `asset.upload`. Admin only: `true`.

Models: [PreservationPackageDto](models-26.md#preservationpackagedto), [PreservationServerPackageCreateDto](models-26.md#preservationserverpackagecreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('server-packages')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload, admin: true })
@Endpoint({
    summary: 'Register a preservation package on the server',
    description:
      'An administrator names a package directory or ZIP on this server, outside its media storage, to verify or restore into their own library. It is read in place and never modified.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "An administrator names a package directory or ZIP on this server, outside its media storage, to verify or restore into their own library. It is read in place and never modified.",
  "operationId": "registerPreservationServerPackage",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PreservationServerPackageCreateDto"
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
            "$ref": "#/components/schemas/PreservationPackageDto"
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
  "summary": "Register a preservation package on the server",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## uploadPreservationPackage

`POST /api/preservation/uploads`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/preservation.controller.ts#L220).

Upload a preservation package

Permission: `asset.upload`. Admin only: `false`.

Models: [PreservationPackageDto](models-26.md#preservationpackagedto), [PreservationUploadCreateDto](models-26.md#preservationuploadcreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Preservation)
@Controller('preservation')
@Post('uploads')
@HttpCode(HttpStatus.CREATED)
@Authenticated({ permission: Permission.AssetUpload })
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A preservation package to verify or restore', type: PreservationUploadCreateDto })
@UseInterceptors(
    FileInterceptor('file', {
      storage: packageUploadStorage,
      limits: { files: 1, fileSize: PRESERVATION_UPLOAD_MAX_BYTES },
    }),
  )
@Endpoint({
    summary: 'Upload a preservation package',
    description:
      'Reads the package’s manifest before anything is kept. The upload is kept for three days for verification and restoration.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Reads the package’s manifest before anything is kept. The upload is kept for three days for verification and restoration.",
  "operationId": "uploadPreservationPackage",
  "parameters": [],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/PreservationUploadCreateDto"
        }
      }
    },
    "description": "A preservation package to verify or restore",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PreservationPackageDto"
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
  "summary": "Upload a preservation package",
  "tags": [
    "Preservation"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```
