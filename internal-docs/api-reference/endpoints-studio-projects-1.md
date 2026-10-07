# Server API — Studio projects 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## photographyGallery

`GET /api/photography/galleries/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L285).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyGalleryDto](models-20.md#photographygallerydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('galleries/:id')
@ApiOperation({ operationId: 'photographyGallery' })
@Authenticated({ public: true })
@ApiResponse({ status: 200, type: PhotographyGalleryDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyGallery",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyGalleryDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyApprove

`POST /api/photography/galleries/{id}/approve`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L322).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyGalleryDto](models-20.md#photographygallerydto), [PhotographyGuestApprovalDto](models-20.md#photographyguestapprovaldto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/approve')
@ApiOperation({ operationId: 'photographyApprove' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyGalleryDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyApprove",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
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
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyGuestApprovalDto"
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
            "$ref": "#/components/schemas/PhotographyGalleryDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyChoices

`PUT /api/photography/galleries/{id}/choices`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L298).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyChoicesDto](models-19.md#photographychoicesdto), [PhotographyGalleryDto](models-20.md#photographygallerydto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Put('galleries/:id/choices')
@ApiOperation({ operationId: 'photographyChoices' })
@Authenticated({ public: true })
@ApiResponse({ status: 200, type: PhotographyGalleryDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyChoices",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
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
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyChoicesDto"
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
            "$ref": "#/components/schemas/PhotographyGalleryDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyLogo

`GET /api/photography/galleries/{id}/logo`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L137).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('galleries/:id/logo')
@ApiOperation({ operationId: 'photographyLogo' })
@Authenticated({ public: true })
@FileResponse()
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyLogo",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyAccept

`POST /api/photography/galleries/{id}/orders/{orderId}/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L334).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyGalleryDto](models-20.md#photographygallerydto), [PhotographyOrderAcceptDto](models-22.md#photographyorderacceptdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/orders/:orderId/accept')
@ApiOperation({ operationId: 'photographyAccept' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyGalleryDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyAccept",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "orderId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyOrderAcceptDto"
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
            "$ref": "#/components/schemas/PhotographyGalleryDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyCheckout

`POST /api/photography/galleries/{id}/orders/{orderId}/checkout`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L347).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyCheckoutDto](models-19.md#photographycheckoutdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/orders/:orderId/checkout')
@ApiOperation({ operationId: 'photographyCheckout' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyCheckoutDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyCheckout",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "orderId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyCheckoutDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyOutput

`GET /api/photography/galleries/{id}/photos/{captureId}/outputs/{outputId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L413).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('galleries/:id/photos/:captureId/outputs/:outputId')
@ApiOperation({ operationId: 'photographyOutput' })
@Authenticated({ public: true })
@FileResponse()
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyOutput",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "captureId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "outputId",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyOutputPreview

`GET /api/photography/galleries/{id}/photos/{captureId}/outputs/{outputId}/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L396).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('galleries/:id/photos/:captureId/outputs/:outputId/preview')
@ApiOperation({ operationId: 'photographyOutputPreview' })
@Authenticated({ public: true })
@FileResponse()
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyOutputPreview",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "captureId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "outputId",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyFile

`GET /api/photography/galleries/{id}/photos/{captureId}/{kind}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L436).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('galleries/:id/photos/:captureId/:kind')
@ApiOperation({ operationId: 'photographyFile' })
@Authenticated({ public: true })
@FileResponse()
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyFile",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "captureId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "kind",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographySession

`POST /api/photography/galleries/{id}/session`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L277).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyGallerySessionDto](models-20.md#photographygallerysessiondto), [PhotographyGallerySessionResponseDto](models-20.md#photographygallerysessionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/session')
@ApiOperation({ operationId: 'photographySession' })
@RateLimited({ bucket: 'photography-gallery-session', limit: 30, windowSeconds: 600 })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyGallerySessionResponseDto })
```

Complete operation contract:

```json
{
  "operationId": "photographySession",
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
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyGallerySessionDto"
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
            "$ref": "#/components/schemas/PhotographyGallerySessionResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographySubmit

`POST /api/photography/galleries/{id}/submit`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L310).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyGalleryDto](models-20.md#photographygallerydto), [PhotographyWorkflowMutationDto](models-26.md#photographyworkflowmutationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/submit')
@ApiOperation({ operationId: 'photographySubmit' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyGalleryDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographySubmit",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
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
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyWorkflowMutationDto"
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
            "$ref": "#/components/schemas/PhotographyGalleryDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyZip

`POST /api/photography/galleries/{id}/zip`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L359).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyZipDto](models-26.md#photographyzipdto), [PhotographyZipResponseDto](models-26.md#photographyzipresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('galleries/:id/zip')
@ApiOperation({ operationId: 'photographyZip' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyZipResponseDto })
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyZip",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
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
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyZipDto"
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
            "$ref": "#/components/schemas/PhotographyZipResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyArchive

`GET /api/photography/galleries/{id}/zip/{zipId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L371).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('galleries/:id/zip/:zipId')
@ApiOperation({ operationId: 'photographyArchive' })
@Authenticated({ public: true })
@FileResponse()
@ApiHeader({ name: 'X-Photography-Session', required: true, schema: { type: 'string', pattern: '^[a-f0-9]{64}$' } })
```

Complete operation contract:

```json
{
  "operationId": "photographyArchive",
  "parameters": [
    {
      "name": "X-Photography-Session",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string",
        "pattern": "^[a-f0-9]{64}$"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "zipId",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyCallback

`POST /api/photography/payments/stripe`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L460).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyCallbackDto](models-19.md#photographycallbackdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('payments/stripe')
@ApiOperation({ operationId: 'photographyCallback' })
@Authenticated({ public: true })
@ApiResponse({ status: 201, type: PhotographyCallbackDto })
@ApiHeader({ name: 'Stripe-Signature', required: true })
@ApiBody({
    schema: {
      type: 'object',
      additionalProperties: true,
      description: 'Signed Stripe event JSON. Signature verification requires its unchanged raw bytes.',
    },
  })
```

Complete operation contract:

```json
{
  "operationId": "photographyCallback",
  "parameters": [
    {
      "name": "Stripe-Signature",
      "in": "header",
      "required": true,
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "additionalProperties": true,
          "description": "Signed Stripe event JSON. Signature verification requires its unchanged raw bytes.",
          "type": "object"
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
            "$ref": "#/components/schemas/PhotographyCallbackDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyStudioPresets

`GET /api/photography/presets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L65).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyStudioPresetsDto](models-23.md#photographystudiopresetsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('presets')
@ApiOperation({ operationId: 'photographyStudioPresets' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyStudioPresetsDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyStudioPresets",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyStudioPresetsDto"
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographySaveStudioPreset

`POST /api/photography/presets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L72).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPresetSaveDto](models-22.md#photographypresetsavedto), [PhotographyStudioPresetsDto](models-23.md#photographystudiopresetsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('presets')
@ApiOperation({ operationId: 'photographySaveStudioPreset' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyStudioPresetsDto })
```

Complete operation contract:

```json
{
  "operationId": "photographySaveStudioPreset",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyPresetSaveDto"
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
            "$ref": "#/components/schemas/PhotographyStudioPresetsDto"
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
  "tags": [
    "Studio projects"
  ]
}
```

## getPhotographyWorkspace

`GET /api/photography/shoots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L32).

Read your private shoots

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkspaceDto](models-26.md#photographyworkspacedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Get()
@Authenticated()
@Endpoint({ summary: 'Read your private shoots', history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "getPhotographyWorkspace",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyWorkspaceDto"
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
  "summary": "Read your private shoots",
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

## savePhotographyWorkspace

`PUT /api/photography/shoots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L39).

Save your shoots using the loaded revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkspaceDto](models-26.md#photographyworkspacedto), [PhotographyWorkspaceSaveDto](models-26.md#photographyworkspacesavedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Put()
@Authenticated()
@Endpoint({
    summary: 'Save your shoots using the loaded revision',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "savePhotographyWorkspace",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyWorkspaceSaveDto"
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
            "$ref": "#/components/schemas/PhotographyWorkspaceDto"
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
  "summary": "Save your shoots using the loaded revision",
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

## getPhotographyBrand

`GET /api/photography/shoots/branding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L52).

Read your private studio branding

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyBrandDto](models-19.md#photographybranddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Get('branding')
@Authenticated()
@Endpoint({
    summary: 'Read your private studio branding',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getPhotographyBrand",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyBrandDto"
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
  "summary": "Read your private studio branding",
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

## savePhotographyBrand

`PUT /api/photography/shoots/branding`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L62).

Save private studio branding with the workspace revision

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyBrandDto](models-19.md#photographybranddto), [PhotographyBrandSaveDto](models-19.md#photographybrandsavedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Put('branding')
@Authenticated()
@Endpoint({
    summary: 'Save private studio branding with the workspace revision',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "savePhotographyBrand",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyBrandSaveDto"
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
            "$ref": "#/components/schemas/PhotographyBrandDto"
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
  "summary": "Save private studio branding with the workspace revision",
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

## getPhotographyLogos

`GET /api/photography/shoots/branding/logos`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L72).

List your eligible unlocked studio logo images

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyLogoCandidatesDto](models-22.md#photographylogocandidatesdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Get('branding/logos')
@Authenticated()
@Endpoint({
    summary: 'List your eligible unlocked studio logo images',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getPhotographyLogos",
  "parameters": [
    {
      "name": "cursor",
      "required": false,
      "in": "query",
      "schema": {
        "minLength": 1,
        "maxLength": 500,
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyLogoCandidatesDto"
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
  "summary": "List your eligible unlocked studio logo images",
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

## getPhotographyLogoThumbnail

`GET /api/photography/shoots/branding/logos/{id}/thumbnail`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L85).

View an eligible owned logo thumbnail without original metadata

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Get('branding/logos/:id/thumbnail')
@FileResponse()
@Authenticated()
@Endpoint({
    summary: 'View an eligible owned logo thumbnail without original metadata',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getPhotographyLogoThumbnail",
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
    },
    {
      "name": "variant",
      "required": false,
      "in": "query",
      "schema": {
        "default": "original",
        "type": "string",
        "enum": [
          "original",
          "light",
          "dark"
        ]
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
  "summary": "View an eligible owned logo thumbnail without original metadata",
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

## previewPhotographyWatermark

`POST /api/photography/shoots/branding/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L108).

Preview a watermark using the production font metrics and renderer

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyRenditionPreviewDto](models-22.md#photographyrenditionpreviewdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Post('branding/preview')
@Authenticated()
@Endpoint({
    summary: 'Preview a watermark using the production font metrics and renderer',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "previewPhotographyWatermark",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographyRenditionPreviewDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
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
  "summary": "Preview a watermark using the production font metrics and renderer",
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

## getPhotographyPhotos

`GET /api/photography/shoots/{id}/photos`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L124).

Read a page of unlocked shoot photos

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPhotosDto](models-22.md#photographyphotosdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Get(':id/photos')
@Authenticated()
@Endpoint({
    summary: 'Read a page of unlocked shoot photos',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getPhotographyPhotos",
  "parameters": [
    {
      "name": "cursor",
      "required": false,
      "in": "query",
      "schema": {
        "minLength": 1,
        "maxLength": 500,
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
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyPhotosDto"
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
  "summary": "Read a page of unlocked shoot photos",
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

## ratePhotographyPhoto

`PATCH /api/photography/shoots/{id}/rating`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workspace.controller.ts#L138).

Rate or reject an owned photo in your shoot

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyRatingDto](models-22.md#photographyratingdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography/shoots')
@Patch(':id/rating')
@Authenticated()
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Rate or reject an owned photo in your shoot',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "ratePhotographyPhoto",
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
          "$ref": "#/components/schemas/PhotographyRatingDto"
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
  "summary": "Rate or reject an owned photo in your shoot",
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

## photographySite

`GET /api/photography/site`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L91).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographySiteDto](models-23.md#photographysitedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('site')
@ApiOperation({ operationId: 'photographySite' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographySiteDto })
```

Complete operation contract:

```json
{
  "operationId": "photographySite",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographySiteDto"
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographySaveSite

`PUT /api/photography/site`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L98).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographySiteDto](models-23.md#photographysitedto), [PhotographySiteSaveDto](models-23.md#photographysitesavedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Put('site')
@ApiOperation({ operationId: 'photographySaveSite' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographySiteDto })
```

Complete operation contract:

```json
{
  "operationId": "photographySaveSite",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PhotographySiteSaveDto"
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
            "$ref": "#/components/schemas/PhotographySiteDto"
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyPublicSite

`GET /api/photography/studios/{ownerId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L105).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPublicSiteDto](models-22.md#photographypublicsitedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('studios/:ownerId')
@ApiOperation({ operationId: 'photographyPublicSite' })
@Authenticated({ public: true })
@ApiResponse({ status: 200, type: PhotographyPublicSiteDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyPublicSite",
  "parameters": [
    {
      "name": "ownerId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyPublicSiteDto"
          }
        }
      },
      "description": ""
    }
  },
  "tags": [
    "Studio projects"
  ]
}
```

## photographyPublicLogo

`GET /api/photography/studios/{ownerId}/logo`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L113).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('studios/:ownerId/logo')
@ApiOperation({ operationId: 'photographyPublicLogo' })
@Authenticated({ public: true })
@FileResponse()
```

Complete operation contract:

```json
{
  "operationId": "photographyPublicLogo",
  "parameters": [
    {
      "name": "ownerId",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```

## photographyPublicPhoto

`GET /api/photography/studios/{ownerId}/photos/{shootId}/{captureId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/photography-workflow.controller.ts#L122).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@RemoteMediaCeiling()
@Get('studios/:ownerId/photos/:shootId/:captureId')
@ApiOperation({ operationId: 'photographyPublicPhoto' })
@Authenticated({ public: true })
@FileResponse()
```

Complete operation contract:

```json
{
  "operationId": "photographyPublicPhoto",
  "parameters": [
    {
      "name": "captureId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "ownerId",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "shootId",
      "required": true,
      "in": "path",
      "schema": {
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
  "tags": [
    "Studio projects"
  ]
}
```
