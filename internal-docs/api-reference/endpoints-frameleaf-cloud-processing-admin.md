# Server API — Frameleaf Cloud processing (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getCloudMlStatus

`GET /api/admin/cloud/ml`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L42).

Get Frameleaf Cloud processing status

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlStatusResponseDto](models-09.md#cloudmlstatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get()
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlStatus',
    summary: 'Get Frameleaf Cloud processing status',
    description:
      'Whether Frameleaf Cloud is configured and linked, the destination once added, the consent version it requires and the AI Wallet. Nothing is contacted unless the server is linked.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether Frameleaf Cloud is configured and linked, the destination once added, the consent version it requires and the AI Wallet. Nothing is contacted unless the server is linked.",
  "operationId": "getCloudMlStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlStatusResponseDto"
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
  "summary": "Get Frameleaf Cloud processing status",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## getCloudMlCatalog

`GET /api/admin/cloud/ml/catalog`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L135).

List Frameleaf Cloud models

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlCatalogResponseDto](models-08.md#cloudmlcatalogresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('catalog')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlCatalog',
    summary: 'List Frameleaf Cloud models',
    description: 'The models Frameleaf Cloud offers now, with their prices, for choosing a model per workload.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The models Frameleaf Cloud offers now, with their prices, for choosing a model per workload.",
  "operationId": "getCloudMlCatalog",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlCatalogResponseDto"
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
  "summary": "List Frameleaf Cloud models",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## getCloudMlConsentHistory

`GET /api/admin/cloud/ml/consent`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L176).

List Frameleaf Cloud consent records

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlConsentHistoryResponseDto](models-08.md#cloudmlconsenthistoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('consent')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlConsentHistory',
    summary: 'List Frameleaf Cloud consent records',
    description: 'Every consent recorded for the Frameleaf Cloud destination, newest first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every consent recorded for the Frameleaf Cloud destination, newest first.",
  "operationId": "getCloudMlConsentHistory",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlConsentHistoryResponseDto"
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
  "summary": "List Frameleaf Cloud consent records",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## getCloudMlConsentTerms

`GET /api/admin/cloud/ml/consent/terms`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L55).

Get the Frameleaf Cloud consent terms for chosen features

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlConsentTermsDto](models-08.md#cloudmlconsenttermsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('consent/terms')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlConsentTerms',
    summary: 'Get the Frameleaf Cloud consent terms for chosen features',
    description:
      'The consent version, summary and text digest Frameleaf Cloud asks this server to accept for the features the administrator chose, read from Frameleaf Cloud each time. Accepting sends that version and digest back.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The consent version, summary and text digest Frameleaf Cloud asks this server to accept for the features the administrator chose, read from Frameleaf Cloud each time. Accepting sends that version and digest back.",
  "operationId": "getCloudMlConsentTerms",
  "parameters": [
    {
      "name": "identityNames",
      "required": false,
      "in": "query",
      "description": "The names-in-photos feature as the administrator chose it",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "medicalSignals",
      "required": false,
      "in": "query",
      "description": "The medical-signals feature as the administrator chose it",
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
            "$ref": "#/components/schemas/CloudMlConsentTermsDto"
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
  "summary": "Get the Frameleaf Cloud consent terms for chosen features",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## startCloudMlDescriptionBackfill

`POST /api/admin/cloud/ml/descriptions/batches`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L68).

Describe photos with Frameleaf Cloud

Permission: `adminCloudMl.update`. Admin only: `true`.

Models: [CloudMlDescriptionBatchCreateDto](models-08.md#cloudmldescriptionbatchcreatedto), [CloudMlDescriptionBatchesResponseDto](models-08.md#cloudmldescriptionbatchesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Post('descriptions/batches')
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'startCloudMlDescriptionBackfill',
    summary: 'Describe photos with Frameleaf Cloud',
    description:
      'Queues the estimated backfill as batches, one owner per batch and one cloud job per batch. Refused when the model changed, more photos need a description than were estimated, or the AI Wallet or a budget cannot cover it; nothing is sent to another destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queues the estimated backfill as batches, one owner per batch and one cloud job per batch. Refused when the model changed, more photos need a description than were estimated, or the AI Wallet or a budget cannot cover it; nothing is sent to another destination.",
  "operationId": "startCloudMlDescriptionBackfill",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlDescriptionBatchCreateDto"
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
            "$ref": "#/components/schemas/CloudMlDescriptionBatchesResponseDto"
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
  "summary": "Describe photos with Frameleaf Cloud",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## estimateCloudMlDescriptionBackfill

`POST /api/admin/cloud/ml/descriptions/estimate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L83).

Estimate describing photos with Frameleaf Cloud

Permission: `adminCloudMl.update`. Admin only: `true`.

Models: [CloudMlDescriptionEstimateResponseDto](models-09.md#cloudmldescriptionestimateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Post('descriptions/estimate')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'estimateCloudMlDescriptionBackfill',
    summary: 'Estimate describing photos with Frameleaf Cloud',
    description:
      'What describing every photo still without a description would cost, from the metered GPU time of the chosen model: a p50–p90 range, a per-photo figure, the start fee per batch and the AI Wallet balance. Nothing is queued.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What describing every photo still without a description would cost, from the metered GPU time of the chosen model: a p50–p90 range, a per-photo figure, the start fee per batch and the AI Wallet balance. Nothing is queued.",
  "operationId": "estimateCloudMlDescriptionBackfill",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlDescriptionEstimateResponseDto"
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
  "summary": "Estimate describing photos with Frameleaf Cloud",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## createCloudMlDestination

`POST /api/admin/cloud/ml/destination`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L97).

Add Frameleaf Cloud as a processing destination

Permission: `adminCloudMl.update`. Admin only: `true`.

Models: [CloudMlDestinationCreateDto](models-09.md#cloudmldestinationcreatedto), [MlDestinationResponseDto](models-17.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Post('destination')
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'createCloudMlDestination',
    summary: 'Add Frameleaf Cloud as a processing destination',
    description:
      'The only way the Frameleaf Cloud destination is created. It has no URL or token, is not routed automatically, and refuses all work until consent is recorded.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The only way the Frameleaf Cloud destination is created. It has no URL or token, is not routed automatically, and refuses all work until consent is recorded.",
  "operationId": "createCloudMlDestination",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlDestinationCreateDto"
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
            "$ref": "#/components/schemas/MlDestinationResponseDto"
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
  "summary": "Add Frameleaf Cloud as a processing destination",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## getCloudMlModelChoices

`GET /api/admin/cloud/ml/models`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L147).

List the chosen Frameleaf Cloud models

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlModelChoicesResponseDto](models-09.md#cloudmlmodelchoicesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('models')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlModelChoices',
    summary: 'List the chosen Frameleaf Cloud models',
    description:
      'The Frameleaf Cloud model chosen for each model group, or null where the group uses the model the catalogue recommends. A cloud job reads its group whatever its workload is routed to.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The Frameleaf Cloud model chosen for each model group, or null where the group uses the model the catalogue recommends. A cloud job reads its group whatever its workload is routed to.",
  "operationId": "getCloudMlModelChoices",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlModelChoicesResponseDto"
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
  "summary": "List the chosen Frameleaf Cloud models",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## setCloudMlModelChoice

`PUT /api/admin/cloud/ml/models/{group}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L160).

Choose the Frameleaf Cloud model of a model group

Permission: `adminCloudMl.update`. Admin only: `true`.

Models: [CloudMlModelChoiceUpdateDto](models-09.md#cloudmlmodelchoiceupdatedto), [CloudMlModelChoicesResponseDto](models-09.md#cloudmlmodelchoicesresponsedto), [CloudMlModelGroup](models-09.md#cloudmlmodelgroup).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Put('models/:group')
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'setCloudMlModelChoice',
    summary: 'Choose the Frameleaf Cloud model of a model group',
    description:
      'Choose a catalogue model for one model group, checked against the catalogue for exactly that group, or null to use the model the catalogue recommends.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Choose a catalogue model for one model group, checked against the catalogue for exactly that group, or null to use the model the catalogue recommends.",
  "operationId": "setCloudMlModelChoice",
  "parameters": [
    {
      "name": "group",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/CloudMlModelGroup"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlModelChoiceUpdateDto"
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
            "$ref": "#/components/schemas/CloudMlModelChoicesResponseDto"
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
  "summary": "Choose the Frameleaf Cloud model of a model group",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## getCloudMlSettlements

`GET /api/admin/cloud/ml/settlements`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L188).

List settled Frameleaf Cloud charges

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlSettlementsResponseDto](models-09.md#cloudmlsettlementsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('settlements')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlSettlements',
    summary: 'List settled Frameleaf Cloud charges',
    description:
      'The charges Frameleaf Cloud settled for this server, newest first, as recorded against the jobs that incurred them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The charges Frameleaf Cloud settled for this server, newest first, as recorded against the jobs that incurred them.",
  "operationId": "getCloudMlSettlements",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlSettlementsResponseDto"
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
  "summary": "List settled Frameleaf Cloud charges",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## reconcileCloudMlUsage

`POST /api/admin/cloud/ml/usage`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L201).

Apply Frameleaf Cloud settlements

Permission: `adminCloudMl.update`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Post('usage')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'reconcileCloudMlUsage',
    summary: 'Apply Frameleaf Cloud settlements',
    description: 'Reads settled charges from Frameleaf Cloud and records them against the jobs that incurred them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Reads settled charges from Frameleaf Cloud and records them against the jobs that incurred them.",
  "operationId": "reconcileCloudMlUsage",
  "parameters": [],
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
  "summary": "Apply Frameleaf Cloud settlements",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## getCloudMlWallet

`GET /api/admin/cloud/ml/wallet`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L110).

Get the AI Wallet

Permission: `adminCloudMl.read`. Admin only: `true`.

Models: [CloudMlWalletDto](models-09.md#cloudmlwalletdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Get('wallet')
@Authenticated({ permission: Permission.AdminCloudMlRead, admin: true })
@Endpoint({
    operationId: 'getCloudMlWallet',
    summary: 'Get the AI Wallet',
    description: 'The AI Wallet balance and holds, read now from Frameleaf Cloud (USD).',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The AI Wallet balance and holds, read now from Frameleaf Cloud (USD).",
  "operationId": "getCloudMlWallet",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/CloudMlWalletDto"
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
  "summary": "Get the AI Wallet",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.read",
  "x-immich-state": "Alpha"
}
```

## updateCloudMlWallet

`PUT /api/admin/cloud/ml/wallet`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/cloud-ml-admin.controller.ts#L122).

Change the AI Wallet daily cap or automatic top-up

Permission: `adminCloudMl.update`. Admin only: `true`.

Models: [CloudMlWalletDto](models-09.md#cloudmlwalletdto), [CloudMlWalletUpdateDto](models-09.md#cloudmlwalletupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/cloud/ml')
@Put('wallet')
@Authenticated({ permission: Permission.AdminCloudMlUpdate, admin: true })
@Endpoint({
    operationId: 'updateCloudMlWallet',
    summary: 'Change the AI Wallet daily cap or automatic top-up',
    description:
      'Lowers the daily spending cap or turns automatic top-up off on the linked Frameleaf account. Raising the cap or turning automatic top-up on is done by the account owner in the Frameleaf account; Frameleaf Cloud refuses it here with 403. Payment details stay on frameleaf.cloud.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Lowers the daily spending cap or turns automatic top-up off on the linked Frameleaf account. Raising the cap or turning automatic top-up on is done by the account owner in the Frameleaf account; Frameleaf Cloud refuses it here with 403. Payment details stay on frameleaf.cloud.",
  "operationId": "updateCloudMlWallet",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/CloudMlWalletUpdateDto"
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
            "$ref": "#/components/schemas/CloudMlWalletDto"
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
  "summary": "Change the AI Wallet daily cap or automatic top-up",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "adminCloudMl.update",
  "x-immich-state": "Alpha"
}
```

## getHardwareCheck

`GET /api/admin/hardware`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/hardware-check.controller.ts#L15).

Get the Hardware & GPU check

Permission: `systemConfig.read`. Admin only: `true`.

Models: [HardwareCheckResponseDto](models-12.md#hardwarecheckresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/hardware')
@Get()
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    operationId: 'getHardwareCheck',
    summary: 'Get the Hardware & GPU check',
    description:
      'The last check of the GPU the server container and the ML container can each use, with any set-up problems found and the last benchmark. Runs a first check when there is none.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The last check of the GPU the server container and the ML container can each use, with any set-up problems found and the last benchmark. Runs a first check when there is none.",
  "operationId": "getHardwareCheck",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/HardwareCheckResponseDto"
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
  "summary": "Get the Hardware & GPU check",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Alpha"
}
```

## runHardwareBenchmark

`POST /api/admin/hardware/benchmark`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/hardware-check.controller.ts#L41).

Run a short benchmark

Permission: `systemConfig.update`. Admin only: `true`.

Models: [HardwareCheckResponseDto](models-12.md#hardwarecheckresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/hardware')
@Post('benchmark')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'runHardwareBenchmark',
    summary: 'Run a short benchmark',
    description:
      'Times a few search embeddings and a test transcode, and keeps how this hardware compares with the estimates so the model sliders show measured times.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Times a few search embeddings and a test transcode, and keeps how this hardware compares with the estimates so the model sliders show measured times.",
  "operationId": "runHardwareBenchmark",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/HardwareCheckResponseDto"
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
  "summary": "Run a short benchmark",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Alpha"
}
```

## runHardwareCheck

`POST /api/admin/hardware/check`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/hardware-check.controller.ts#L28).

Check the GPU again

Permission: `systemConfig.update`. Admin only: `true`.

Models: [HardwareCheckResponseDto](models-12.md#hardwarecheckresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafCloudMl)
@Controller('admin/hardware')
@Post('check')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'runHardwareCheck',
    summary: 'Check the GPU again',
    description: 'Checks both containers again: devices, driver, backend and a short test job in each.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Checks both containers again: devices, driver, backend and a short test job in each.",
  "operationId": "runHardwareCheck",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/HardwareCheckResponseDto"
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
  "summary": "Check the GPU again",
  "tags": [
    "Frameleaf Cloud processing (admin)"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Alpha"
}
```
