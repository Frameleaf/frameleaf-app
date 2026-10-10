# Server API — Documents

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchDocuments

`GET /api/documents`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L31).

Search documents

Permission: `asset.read`. Admin only: `false`.

Models: [DocumentSearchResponseDto](models-11.md#documentsearchresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Get()
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Search documents',
    description:
      'List the signed-in account’s photos that show recognized text, newest first, optionally matching text read from them or the owner’s corrections.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "List the signed-in account’s photos that show recognized text, newest first, optionally matching text read from them or the owner’s corrections.",
  "operationId": "searchDocuments",
  "parameters": [
    {
      "name": "page",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "query",
      "required": false,
      "in": "query",
      "description": "Text to find in recognized text and in the owner’s corrections",
      "schema": {
        "maxLength": 200,
        "type": "string"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 250,
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
            "$ref": "#/components/schemas/DocumentSearchResponseDto"
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
  "summary": "Search documents",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## getDocument

`GET /api/documents/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L43).

Retrieve a document

Permission: `asset.read`. Admin only: `false`.

Models: [DocumentResponseDto](models-11.md#documentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Get(':id')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve a document',
    description:
      'Retrieve the text read from a photo with the owner’s corrections applied, where each line is in the photo, and, for the owner, the values suggested from it.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the text read from a photo with the owner’s corrections applied, where each line is in the photo, and, for the owner, the values suggested from it.",
  "operationId": "getDocument",
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
            "$ref": "#/components/schemas/DocumentResponseDto"
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
  "summary": "Retrieve a document",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## deleteDocumentField

`DELETE /api/documents/{id}/fields/{field}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L101).

Clear a document field decision

Permission: `asset.update`. Admin only: `false`.

Models: [DocumentField](models-10.md#documentfield), [DocumentResponseDto](models-11.md#documentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Delete(':id/fields/:field')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Clear a document field decision',
    description: 'Remove the owner’s decision about a field, so the text’s suggestion shows again.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the owner’s decision about a field, so the text’s suggestion shows again.",
  "operationId": "deleteDocumentField",
  "parameters": [
    {
      "name": "field",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/DocumentField"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "revision",
      "required": true,
      "in": "query",
      "description": "Revision of the decision being removed",
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
            "$ref": "#/components/schemas/DocumentResponseDto"
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
  "summary": "Clear a document field decision",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## updateDocumentField

`PUT /api/documents/{id}/fields/{field}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L86).

Decide a document field

Permission: `asset.update`. Admin only: `false`.

Models: [DocumentField](models-10.md#documentfield), [DocumentFieldEditDto](models-10.md#documentfieldeditdto), [DocumentResponseDto](models-11.md#documentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Put(':id/fields/:field')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Decide a document field',
    description: 'Confirm, correct or dismiss a value suggested from the text of a photo.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Confirm, correct or dismiss a value suggested from the text of a photo.",
  "operationId": "updateDocumentField",
  "parameters": [
    {
      "name": "field",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/DocumentField"
      }
    },
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
          "$ref": "#/components/schemas/DocumentFieldEditDto"
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
            "$ref": "#/components/schemas/DocumentResponseDto"
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
  "summary": "Decide a document field",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## updateDocumentLine

`PUT /api/documents/{id}/lines`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L55).

Correct or dismiss a line of text

Permission: `asset.update`. Admin only: `false`.

Models: [DocumentLineEditDto](models-11.md#documentlineeditdto), [DocumentResponseDto](models-11.md#documentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Put(':id/lines')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Correct or dismiss a line of text',
    description:
      'Record the owner’s correction or dismissal of one recognized line. The recognized text itself is kept unchanged.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Record the owner’s correction or dismissal of one recognized line. The recognized text itself is kept unchanged.",
  "operationId": "updateDocumentLine",
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
          "$ref": "#/components/schemas/DocumentLineEditDto"
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
            "$ref": "#/components/schemas/DocumentResponseDto"
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
  "summary": "Correct or dismiss a line of text",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```

## deleteDocumentLine

`DELETE /api/documents/{id}/lines/{editId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/document.controller.ts#L71).

Restore a line of text

Permission: `asset.update`. Admin only: `false`.

Models: [DocumentResponseDto](models-11.md#documentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Documents)
@Controller('documents')
@Delete(':id/lines/:editId')
@Authenticated({ permission: Permission.AssetUpdate })
@Endpoint({
    summary: 'Restore a line of text',
    description: 'Remove the owner’s correction or dismissal of a line, so it reads as recognized again.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the owner’s correction or dismissal of a line, so it reads as recognized again.",
  "operationId": "deleteDocumentLine",
  "parameters": [
    {
      "name": "editId",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "revision",
      "required": true,
      "in": "query",
      "description": "Revision of the decision being removed",
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
            "$ref": "#/components/schemas/DocumentResponseDto"
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
  "summary": "Restore a line of text",
  "tags": [
    "Documents"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.update",
  "x-immich-state": "Alpha"
}
```
