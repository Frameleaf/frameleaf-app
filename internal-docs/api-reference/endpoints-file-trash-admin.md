# Server API — File trash (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getFileTrash

`GET /api/admin/file-trash`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-file-trash.controller.ts#L19).

List the file trash

Permission: `maintenance`. Admin only: `true`.

Models: [FileTrashResponseDto](models-11.md#filetrashresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FileTrash)
@Controller('admin/file-trash')
@Get()
@Authenticated({ permission: Permission.Maintenance, admin: true })
@Endpoint({
    summary: 'List the file trash',
    description:
      'Originals no library references any more, newest first, with the total disk space the file trash holds. Nothing here is deleted automatically.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Originals no library references any more, newest first, with the total disk space the file trash holds. Nothing here is deleted automatically.",
  "operationId": "getFileTrash",
  "parameters": [
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number, from 1",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Entries per page",
      "schema": {
        "minimum": 1,
        "maximum": 500,
        "default": 100,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/FileTrashResponseDto"
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
  "summary": "List the file trash",
  "tags": [
    "File trash (admin)"
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
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## deleteFileTrashItem

`DELETE /api/admin/file-trash/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-file-trash.controller.ts#L44).

Delete a file permanently

Permission: `maintenance`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.FileTrash)
@Controller('admin/file-trash')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.Maintenance, admin: true })
@Endpoint({
    summary: 'Delete a file permanently',
    description: 'Delete the file from disk for good. This cannot be undone.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete the file from disk for good. This cannot be undone.",
  "operationId": "deleteFileTrashItem",
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
  "summary": "Delete a file permanently",
  "tags": [
    "File trash (admin)"
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
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```

## restoreFileTrashItem

`POST /api/admin/file-trash/{id}/restore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/physical-file-trash.controller.ts#L31).

Restore a file from the file trash

Permission: `maintenance`. Admin only: `true`.

Models: [FileTrashRestoreResponseDto](models-11.md#filetrashrestoreresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FileTrash)
@Controller('admin/file-trash')
@Post(':id/restore')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.Maintenance, admin: true })
@Endpoint({
    summary: 'Restore a file from the file trash',
    description:
      'Re-import the file as a new asset in the library it was last in, reading its metadata again. Answers 400 when that account is unknown or gone and 409 when its library already holds the file.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Re-import the file as a new asset in the library it was last in, reading its metadata again. Answers 400 when that account is unknown or gone and 409 when its library already holds the file.",
  "operationId": "restoreFileTrashItem",
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
            "$ref": "#/components/schemas/FileTrashRestoreResponseDto"
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
  "summary": "Restore a file from the file trash",
  "tags": [
    "File trash (admin)"
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
  "x-immich-permission": "maintenance",
  "x-immich-state": "Alpha"
}
```
