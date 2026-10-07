# Server API — Faces

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getFaces

`GET /api/faces`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L49).

Retrieve faces for asset

Permission: `face.read`. Admin only: `false`.

Models: [AssetFaceResponseDto](models-05.md#assetfaceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Get()
@Authenticated({ permission: Permission.FaceRead })
@Endpoint({
    summary: 'Retrieve faces for asset',
    description: 'Retrieve all faces belonging to an asset.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve all faces belonging to an asset.",
  "operationId": "getFaces",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "query",
      "description": "Face ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "withHidden",
      "required": false,
      "in": "query",
      "description": "Also list faces the asset's owner hid (owner only)",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        }
      ],
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
              "$ref": "#/components/schemas/AssetFaceResponseDto"
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
  "summary": "Retrieve faces for asset",
  "tags": [
    "Faces"
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
  "x-immich-permission": "face.read",
  "x-immich-state": "Stable"
}
```

## createFace

`POST /api/faces`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L25).

Create a face

Permission: `face.create`. Admin only: `false`.

Models: [AssetFaceCreateDto](models-05.md#assetfacecreatedto), [AssetFaceResponseDto](models-05.md#assetfaceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Post()
@Authenticated({ permission: Permission.FaceCreate })
@Endpoint({
    summary: 'Create a face',
    description:
      'Create a new face that has not been discovered by facial recognition. The content of the bounding box is considered a face.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new face that has not been discovered by facial recognition. The content of the bounding box is considered a face.",
  "operationId": "createFace",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AssetFaceCreateDto"
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
            "$ref": "#/components/schemas/AssetFaceResponseDto"
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
  "summary": "Create a face",
  "tags": [
    "Faces"
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
  "x-immich-permission": "face.create",
  "x-immich-state": "Stable"
}
```

## getFaceSource

`GET /api/faces/source`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L37).

Retrieve the face source revision for an asset

Permission: `face.read`. Admin only: `false`.

Models: [AssetFaceSourceResponseDto](models-05.md#assetfacesourceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Get('source')
@Authenticated({ permission: Permission.FaceRead })
@Endpoint({
    summary: 'Retrieve the face source revision for an asset',
    description:
      'Retrieve the revision of the image faces are drawn on. Send it back as expectedSourceRevision when creating or moving a face; it changes when the image, its orientation or its edits change.',
    history: new HistoryBuilder().added('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the revision of the image faces are drawn on. Send it back as expectedSourceRevision when creating or moving a face; it changes when the image, its orientation or its edits change.",
  "operationId": "getFaceSource",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "query",
      "description": "Face ID",
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
            "$ref": "#/components/schemas/AssetFaceSourceResponseDto"
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
  "summary": "Retrieve the face source revision for an asset",
  "tags": [
    "Faces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    }
  ],
  "x-immich-permission": "face.read"
}
```

## deleteFace

`DELETE /api/faces/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L91).

Delete a face

Permission: `face.delete`. Admin only: `false`.

Models: [AssetFaceDeleteDto](models-05.md#assetfacedeletedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Delete(':id')
@Authenticated({ permission: Permission.FaceDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a face',
    description: 'Delete a face identified by the id. Optionally can be force deleted.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a face identified by the id. Optionally can be force deleted.",
  "operationId": "deleteFace",
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
          "$ref": "#/components/schemas/AssetFaceDeleteDto"
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
  "summary": "Delete a face",
  "tags": [
    "Faces"
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
  "x-immich-permission": "face.delete",
  "x-immich-state": "Stable"
}
```

## correctFace

`PATCH /api/faces/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L75).

Correct a face

Permission: `face.update`. Admin only: `false`.

Models: [AssetFaceCorrectionDto](models-05.md#assetfacecorrectiondto), [AssetFaceResponseDto](models-05.md#assetfaceresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Patch(':id')
@Authenticated({ permission: Permission.FaceUpdate })
@Endpoint({
    summary: 'Correct a face',
    description:
      'Reassign or unassign a face, move or resize it, or hide it and show it again. The correction is refused with 409 when the face (or, for a box, the image) changed since expectedRevision.',
    history: new HistoryBuilder().added('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Reassign or unassign a face, move or resize it, or hide it and show it again. The correction is refused with 409 when the face (or, for a box, the image) changed since expectedRevision.",
  "operationId": "correctFace",
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
          "$ref": "#/components/schemas/AssetFaceCorrectionDto"
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
            "$ref": "#/components/schemas/AssetFaceResponseDto"
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
  "summary": "Correct a face",
  "tags": [
    "Faces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    }
  ],
  "x-immich-permission": "face.update"
}
```

## reassignFacesById

`PUT /api/faces/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/face.controller.ts#L60).

Re-assign a face to another person

Permission: `face.update`. Admin only: `false`.

Models: [FaceDto](models-11.md#facedto), [PersonResponseDto](models-18.md#personresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Faces)
@Controller('faces')
@Put(':id')
@Authenticated({ permission: Permission.FaceUpdate })
@Endpoint({
    summary: 'Re-assign a face to another person',
    description: 'Re-assign the face provided in the body to the person identified by the id in the path parameter.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Re-assign the face provided in the body to the person identified by the id in the path parameter.",
  "operationId": "reassignFacesById",
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
          "$ref": "#/components/schemas/FaceDto"
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
            "$ref": "#/components/schemas/PersonResponseDto"
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
  "summary": "Re-assign a face to another person",
  "tags": [
    "Faces"
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
  "x-immich-permission": "face.update",
  "x-immich-state": "Stable"
}
```
