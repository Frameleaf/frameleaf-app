# Server API — Studio projects 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## photographyList

`GET /api/photography/workflows`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L152).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowListDto](models-25.md#photographyworkflowlistdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('workflows')
@ApiOperation({ operationId: 'photographyList' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyWorkflowListDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyList",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyWorkflowListDto"
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

## photographyGet

`GET /api/photography/workflows/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L159).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Get('workflows/:id')
@ApiOperation({ operationId: 'photographyGet' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyGet",
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
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyApproval

`POST /api/photography/workflows/{id}/approvals`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L256).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyApprovalDto](models-18.md#photographyapprovaldto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/approvals')
@ApiOperation({ operationId: 'photographyApproval' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyApproval",
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
          "$ref": "#/components/schemas/PhotographyApprovalDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyAssembly

`PUT /api/photography/workflows/{id}/assembly`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L211).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyAssemblyDto](models-18.md#photographyassemblydto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Put('workflows/:id/assembly')
@ApiOperation({ operationId: 'photographyAssembly' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyAssembly",
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
          "$ref": "#/components/schemas/PhotographyAssemblyDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyRetryCapture

`POST /api/photography/workflows/{id}/captures/{captureId}/retry-processing`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L199).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-24.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-25.md#photographyworkflowmutationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/captures/:captureId/retry-processing')
@ApiOperation({ operationId: 'photographyRetryCapture' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyRetryCapture",
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyConfig

`PUT /api/photography/workflows/{id}/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L166).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowConfigDto](models-23.md#photographyworkflowconfigdto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Put('workflows/:id/config')
@ApiOperation({ operationId: 'photographyConfig' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyConfig",
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
          "$ref": "#/components/schemas/PhotographyWorkflowConfigDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyIntake

`POST /api/photography/workflows/{id}/intake`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L192).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyIntakeDto](models-19.md#photographyintakedto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/intake')
@ApiOperation({ operationId: 'photographyIntake' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyIntake",
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
          "$ref": "#/components/schemas/PhotographyIntakeDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyOrder

`POST /api/photography/workflows/{id}/orders`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L237).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyOrderCreateDto](models-21.md#photographyordercreatedto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/orders')
@ApiOperation({ operationId: 'photographyOrder' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyOrder",
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
          "$ref": "#/components/schemas/PhotographyOrderCreateDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyPayment

`POST /api/photography/workflows/{id}/orders/{orderId}/payment`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L244).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPaymentDto](models-21.md#photographypaymentdto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/orders/:orderId/payment')
@ApiOperation({ operationId: 'photographyPayment' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyPayment",
  "parameters": [
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
          "$ref": "#/components/schemas/PhotographyPaymentDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographySavePreset

`POST /api/photography/workflows/{id}/presets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L173).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPresetSaveDto](models-21.md#photographypresetsavedto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/presets')
@ApiOperation({ operationId: 'photographySavePreset' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographySavePreset",
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyApplyPreset

`POST /api/photography/workflows/{id}/presets/{presetId}/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L180).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-24.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-25.md#photographyworkflowmutationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/presets/:presetId/apply')
@ApiOperation({ operationId: 'photographyApplyPreset' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyApplyPreset",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "presetId",
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyPublish

`POST /api/photography/workflows/{id}/publish`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L263).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPublicationDto](models-21.md#photographypublicationdto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/publish')
@ApiOperation({ operationId: 'photographyPublish' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyPublish",
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
          "$ref": "#/components/schemas/PhotographyPublicationDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyInvite

`POST /api/photography/workflows/{id}/recipients`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L218).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyInvitationDto](models-20.md#photographyinvitationdto), [PhotographyRecipientCreateDto](models-21.md#photographyrecipientcreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/recipients')
@ApiOperation({ operationId: 'photographyInvite' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyInvitationDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyInvite",
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
          "$ref": "#/components/schemas/PhotographyRecipientCreateDto"
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
            "$ref": "#/components/schemas/PhotographyInvitationDto"
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

## photographyRecipient

`PATCH /api/photography/workflows/{id}/recipients/{recipientId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L225).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyRecipientUpdateDto](models-21.md#photographyrecipientupdatedto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Patch('workflows/:id/recipients/:recipientId')
@ApiOperation({ operationId: 'photographyRecipient' })
@Authenticated()
@ApiResponse({ status: 200, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyRecipient",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "recipientId",
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
          "$ref": "#/components/schemas/PhotographyRecipientUpdateDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyRetry

`POST /api/photography/workflows/{id}/retry`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L270).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-24.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-25.md#photographyworkflowmutationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/retry')
@ApiOperation({ operationId: 'photographyRetry' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyRetry",
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## photographyApplyStudioPreset

`POST /api/photography/workflows/{id}/studio-presets/{presetId}/apply`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/photography-workflow.controller.ts#L79).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyStudioPresetApplyDto](models-22.md#photographystudiopresetapplydto), [PhotographyWorkflowDto](models-24.md#photographyworkflowdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('photography')
@Post('workflows/:id/studio-presets/:presetId/apply')
@ApiOperation({ operationId: 'photographyApplyStudioPreset' })
@Authenticated()
@ApiResponse({ status: 201, type: PhotographyWorkflowDto })
```

Complete operation contract:

```json
{
  "operationId": "photographyApplyStudioPreset",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "presetId",
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
          "$ref": "#/components/schemas/PhotographyStudioPresetApplyDto"
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
            "$ref": "#/components/schemas/PhotographyWorkflowDto"
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

## downloadStudioBundle

`GET /api/studio/bundles/exports/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L137).

Download a Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Get('exports/:id/download')
@Authenticated()
@OriginalTransfer()
@FileResponse()
@Endpoint({
    summary: 'Download a Studio bundle',
    description:
      'The finished file of one of your own exports. It is reachable by no other route and is deleted when it expires.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The finished file of one of your own exports. It is reachable by no other route and is deleted when it expires.",
  "operationId": "downloadStudioBundle",
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
  "summary": "Download a Studio bundle",
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

## importStudioBundle

`POST /api/studio/bundles/imports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L113).

Import a Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-15.md#mediaoperationdto), [StudioBundleImportCreateDto](models-31.md#studiobundleimportcreatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Post('imports')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@Endpoint({
    summary: 'Import a Studio bundle',
    description:
      'Queues an import of an uploaded bundle into a new project of yours. Every item you chose in place of a missing source is checked for access now and again when the import runs. Nothing in your library is changed.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues an import of an uploaded bundle into a new project of yours. Every item you chose in place of a missing source is checked for access now and again when the import runs. Nothing in your library is changed.",
  "operationId": "importStudioBundle",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StudioBundleImportCreateDto"
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
  "summary": "Import a Studio bundle",
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

## getStudioBundleOperation

`GET /api/studio/bundles/operations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L126).

Get a Studio bundle job

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleOperationDto](models-32.md#studiobundleoperationdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Get('operations/:id')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio bundle job',
    description: 'The state of an export or import job, with the file or project it produced.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The state of an export or import job, with the file or project it produced.",
  "operationId": "getStudioBundleOperation",
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
            "$ref": "#/components/schemas/StudioBundleOperationDto"
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
  "summary": "Get a Studio bundle job",
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

## uploadStudioBundle

`POST /api/studio/bundles/uploads`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L69).

Upload a Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleUploadCreateDto](models-32.md#studiobundleuploadcreatedto), [StudioBundleUploadDto](models-32.md#studiobundleuploaddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Post('uploads')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A Studio bundle to import', type: StudioBundleUploadCreateDto })
@UseInterceptors(
    FileInterceptor('file', { storage: bundleUploadStorage, limits: { files: 1, fileSize: STUDIO_BUNDLE_MAX_BYTES } }),
  )
@Endpoint({
    summary: 'Upload a Studio bundle',
    description:
      'Checks the archive against every bundle limit and verifies its manifest and project document before anything is kept. Returns what the import will relink, keep and report missing.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Checks the archive against every bundle limit and verifies its manifest and project document before anything is kept. Returns what the import will relink, keep and report missing.",
  "operationId": "uploadStudioBundle",
  "parameters": [],
  "requestBody": {
    "content": {
      "multipart/form-data": {
        "schema": {
          "$ref": "#/components/schemas/StudioBundleUploadCreateDto"
        }
      }
    },
    "description": "A Studio bundle to import",
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/StudioBundleUploadDto"
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
  "summary": "Upload a Studio bundle",
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

## deleteStudioBundleUpload

`DELETE /api/studio/bundles/uploads/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L101).

Discard an uploaded Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Delete('uploads/:id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Discard an uploaded Studio bundle',
    description: 'Deletes the uploaded file now rather than when it expires.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Deletes the uploaded file now rather than when it expires.",
  "operationId": "deleteStudioBundleUpload",
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
  "summary": "Discard an uploaded Studio bundle",
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

## getStudioBundleUpload

`GET /api/studio/bundles/uploads/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-bundle.controller.ts#L90).

Get an uploaded Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleUploadDto](models-32.md#studiobundleuploaddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Get('uploads/:id')
@Authenticated()
@Endpoint({
    summary: 'Get an uploaded Studio bundle',
    description: 'The review of an uploaded bundle, recomputed for your library as it is now.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The review of an uploaded bundle, recomputed for your library as it is now.",
  "operationId": "getStudioBundleUpload",
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
            "$ref": "#/components/schemas/StudioBundleUploadDto"
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
  "summary": "Get an uploaded Studio bundle",
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

## getStudioExport

`GET /api/studio/exports/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-export.controller.ts#L68).

Get a Studio export

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioExportVersionDto](models-32.md#studioexportversiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('exports/:id')
@Authenticated()
@Endpoint({
    summary: 'Get a Studio export',
    description: 'One export version, with where its result lives and what it inherited.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "One export version, with where its result lives and what it inherited.",
  "operationId": "getStudioExport",
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
            "$ref": "#/components/schemas/StudioExportVersionDto"
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
  "summary": "Get a Studio export",
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

## downloadStudioExport

`GET /api/studio/exports/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-export.controller.ts#L79).

Download a Studio export kept with its project

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('exports/:id/download')
@FileResponse()
@Authenticated()
@OriginalTransfer()
@Endpoint({
    summary: 'Download a Studio export kept with its project',
    description:
      'The file of a published export that uses media shared with you. Available only while every source is still available to you; a result in your library is downloaded like any other photo or video.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "The file of a published export that uses media shared with you. Available only while every source is still available to you; a result in your library is downloaded like any other photo or video.",
  "operationId": "downloadStudioExport",
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
  "summary": "Download a Studio export kept with its project",
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

## searchStudioProjects

`GET /api/studio/projects`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-project.controller.ts#L66).

List Studio projects

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectListResponseDto](models-32.md#studioprojectlistresponsedto), [StudioProjectShelf](models-33.md#studioprojectshelf), [StudioProjectSort](models-33.md#studioprojectsort).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-project.controller.ts#L94).

Create a Studio project

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectCreateDto](models-32.md#studioprojectcreatedto), [StudioProjectDetailDto](models-32.md#studioprojectdetaildto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/studio-project.controller.ts#L81).

Empty the Studio trash

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioProjectTrashEmptyResponseDto](models-33.md#studioprojecttrashemptyresponsedto).

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
