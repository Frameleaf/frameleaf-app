# Server API — Studio projects 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## photographyList

`GET /api/photography/workflows`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L152).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowListDto](models-27.md#photographyworkflowlistdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L159).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L256).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyApprovalDto](models-20.md#photographyapprovaldto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L211).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyAssemblyDto](models-20.md#photographyassemblydto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L199).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-26.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-27.md#photographyworkflowmutationdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L166).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowConfigDto](models-25.md#photographyworkflowconfigdto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L192).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyIntakeDto](models-21.md#photographyintakedto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L237).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyOrderCreateDto](models-23.md#photographyordercreatedto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L244).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPaymentDto](models-23.md#photographypaymentdto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L173).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPresetSaveDto](models-23.md#photographypresetsavedto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L180).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-26.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-27.md#photographyworkflowmutationdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L263).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyPublicationDto](models-23.md#photographypublicationdto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L218).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyInvitationDto](models-22.md#photographyinvitationdto), [PhotographyRecipientCreateDto](models-23.md#photographyrecipientcreatedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L225).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyRecipientUpdateDto](models-23.md#photographyrecipientupdatedto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L270).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyWorkflowDto](models-26.md#photographyworkflowdto), [PhotographyWorkflowMutationDto](models-27.md#photographyworkflowmutationdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/photography-workflow.controller.ts#L79).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PhotographyStudioPresetApplyDto](models-24.md#photographystudiopresetapplydto), [PhotographyWorkflowDto](models-26.md#photographyworkflowdto).

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

## getStudioMediaFacts

`GET /api/studio/assets/{id}/media-facts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-catalog.controller.ts#L80).

Get the Studio media facts of an asset

Permission: `asset.read`. Admin only: `false`.

Models: [StudioMediaFactsDto](models-34.md#studiomediafactsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('assets/:id/media-facts')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Get the Studio media facts of an asset',
    description:
      'What placing this photo or video in Studio needs (graph protocol 3.5), read from the original: its exact frame rate as a reduced fraction, whether it has an audio track and its codec, its display size and length. When the original cannot be read, the stored metadata is answered and `source` says so.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What placing this photo or video in Studio needs (graph protocol 3.5), read from the original: its exact frame rate as a reduced fraction, whether it has an audio track and its codec, its display size and length. When the original cannot be read, the stored metadata is answered and `source` says so.",
  "operationId": "getStudioMediaFacts",
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
            "$ref": "#/components/schemas/StudioMediaFactsDto"
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
  "summary": "Get the Studio media facts of an asset",
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
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## downloadStudioBundle

`GET /api/studio/bundles/exports/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L172).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L148).

Import a Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaOperationDto](models-17.md#mediaoperationdto), [StudioBundleImportCreateDto](models-34.md#studiobundleimportcreatedto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L161).

Get a Studio bundle job

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleOperationDto](models-34.md#studiobundleoperationdto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L105).

Upload a Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleUploadCreateDto](models-34.md#studiobundleuploadcreatedto), [StudioBundleUploadDto](models-34.md#studiobundleuploaddto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio/bundles')
@Post('uploads')
@HttpCode(HttpStatus.CREATED)
@Authenticated()
@ApiConsumes('multipart/form-data')
@ApiBody({ description: 'A Studio bundle to import', type: StudioBundleUploadCreateDto })
@UseInterceptors(StudioBundleUploadInterceptor)
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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L136).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-bundle.controller.ts#L125).

Get an uploaded Studio bundle

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioBundleUploadDto](models-34.md#studiobundleuploaddto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-export.controller.ts#L81).

Get a Studio export

Permission: `See authentication declaration`. Admin only: `false`.

Models: [StudioExportVersionDto](models-34.md#studioexportversiondto).

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

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-export.controller.ts#L92).

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

## downloadStudioExportSubtitle

`GET /api/studio/exports/{id}/subtitle`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-export.controller.ts#L111).

Download the owner-private SRT sibling

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.StudioProjects)
@Controller('studio')
@Get('exports/:id/subtitle')
@FileResponse()
@Authenticated()
@OriginalTransfer()
@Endpoint({
    summary: 'Download the owner-private SRT sibling',
    description:
      'Available only for a published sealed pair with current source access, source epochs and session privacy. Supports one byte range. No public subtitle grant.',
    history: history(),
  })
```

Complete operation contract:

```json
{
  "description": "Available only for a published sealed pair with current source access, source epochs and session privacy. Supports one byte range. No public subtitle grant.",
  "operationId": "downloadStudioExportSubtitle",
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
  "summary": "Download the owner-private SRT sibling",
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

## getStudioFonts

`GET /api/studio/fonts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/studio-catalog.controller.ts#L45).

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
