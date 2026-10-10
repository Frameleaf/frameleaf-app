# Server API — ML destinations

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getWorkerInventory

`GET /api/admin/workers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/worker-inventory.controller.ts#L18).

Get the worker inventory

Permission: `systemConfig.read`. Admin only: `true`.

Models: [WorkerInventoryResponseDto](models-39.md#workerinventoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('admin/workers')
@Get()
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get the worker inventory',
    description:
      'Every machine-learning, restoration and render endpoint with its last known state, acceleration, allowed and served workloads, library routes, per-workload admission and load, plus the server processes running restorations. Read-only; nothing is contacted.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every machine-learning, restoration and render endpoint with its last known state, acceleration, allowed and served workloads, library routes, per-workload admission and load, plus the server processes running restorations. Read-only; nothing is contacted.",
  "operationId": "getWorkerInventory",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/WorkerInventoryResponseDto"
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
  "summary": "Get the worker inventory",
  "tags": [
    "ML destinations"
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

## listMlDestinations

`GET /api/ml-destinations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L79).

List machine-learning destinations

Permission: `systemConfig.read`. Admin only: `true`.

Models: [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Get()
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    operationId: 'listMlDestinations',
    summary: 'List machine-learning destinations',
    description: 'Every configured destination with its consent state, cost controls and last probe.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every configured destination with its consent state, cost controls and last probe.",
  "operationId": "listMlDestinations",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/MlDestinationResponseDto"
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
  "summary": "List machine-learning destinations",
  "tags": [
    "ML destinations"
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

## createMlDestination

`POST /api/ml-destinations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L91).

Create a machine-learning destination

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlDestinationCreateDto](models-18.md#mldestinationcreatedto), [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Post()
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'createMlDestination',
    summary: 'Create a machine-learning destination',
    description: 'Add a LAN worker. Frameleaf Cloud is added from its own endpoint (POST admin/cloud/ml/destination).',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Add a LAN worker. Frameleaf Cloud is added from its own endpoint (POST admin/cloud/ml/destination).",
  "operationId": "createMlDestination",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MlDestinationCreateDto"
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
  "summary": "Create a machine-learning destination",
  "tags": [
    "ML destinations"
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

## getMlCapabilities

`GET /api/ml-destinations/capabilities`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L37).

Get machine-learning capabilities

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MlCapabilitiesResponseDto](models-17.md#mlcapabilitiesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Get('capabilities')
@Authenticated()
@Endpoint({
    operationId: 'getMlCapabilities',
    summary: 'Get machine-learning capabilities',
    description:
      'What this deployment can run right now, per workload and destination, from the last health probes. Includes the Studio capability row the Studio host reads.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "What this deployment can run right now, per workload and destination, from the last health probes. Includes the Studio capability row the Studio host reads.",
  "operationId": "getMlCapabilities",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MlCapabilitiesResponseDto"
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
  "summary": "Get machine-learning capabilities",
  "tags": [
    "ML destinations"
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

## getMlWorkloadRoutes

`GET /api/ml-destinations/routes`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L50).

List workload routes

Permission: `systemConfig.read`. Admin only: `true`.

Models: [MlWorkloadRoutesResponseDto](models-18.md#mlworkloadroutesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Get('routes')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    operationId: 'getMlWorkloadRoutes',
    summary: 'List workload routes',
    description:
      'The destination each workload is routed to. A workload without a route is refused, never sent anywhere.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The destination each workload is routed to. A workload without a route is refused, never sent anywhere.",
  "operationId": "getMlWorkloadRoutes",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MlWorkloadRoutesResponseDto"
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
  "summary": "List workload routes",
  "tags": [
    "ML destinations"
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

## setMlWorkloadRoute

`PUT /api/ml-destinations/routes/{workload}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L63).

Route a workload

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlWorkload](models-18.md#mlworkload), [MlWorkloadRouteUpdateDto](models-18.md#mlworkloadrouteupdatedto), [MlWorkloadRoutesResponseDto](models-18.md#mlworkloadroutesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Put('routes/:workload')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'setMlWorkloadRoute',
    summary: 'Route a workload',
    description:
      'Route a workload to one destination, or remove its route with a null destination. Routing to a cloud destination requires its consent to be recorded first.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Route a workload to one destination, or remove its route with a null destination. Routing to a cloud destination requires its consent to be recorded first.",
  "operationId": "setMlWorkloadRoute",
  "parameters": [
    {
      "name": "workload",
      "required": true,
      "in": "path",
      "schema": {
        "$ref": "#/components/schemas/MlWorkload"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MlWorkloadRouteUpdateDto"
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
            "$ref": "#/components/schemas/MlWorkloadRoutesResponseDto"
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
  "summary": "Route a workload",
  "tags": [
    "ML destinations"
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

## deleteMlDestination

`DELETE /api/ml-destinations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L129).

Delete a machine-learning destination

Permission: `systemConfig.update`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Delete(':id')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'deleteMlDestination',
    summary: 'Delete a machine-learning destination',
    description:
      'Removes the destination and every route to it; the affected workloads are refused until routed again.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the destination and every route to it; the affected workloads are refused until routed again.",
  "operationId": "deleteMlDestination",
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
  "summary": "Delete a machine-learning destination",
  "tags": [
    "ML destinations"
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

## getMlDestination

`GET /api/ml-destinations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L103).

Get a machine-learning destination

Permission: `systemConfig.read`. Admin only: `true`.

Models: [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Get(':id')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    operationId: 'getMlDestination',
    summary: 'Get a machine-learning destination',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "getMlDestination",
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
  "summary": "Get a machine-learning destination",
  "tags": [
    "ML destinations"
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

## updateMlDestination

`PUT /api/ml-destinations/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L114).

Update a machine-learning destination

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlDestinationResponseDto](models-18.md#mldestinationresponsedto), [MlDestinationUpdateDto](models-18.md#mldestinationupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Put(':id')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'updateMlDestination',
    summary: 'Update a machine-learning destination',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "operationId": "updateMlDestination",
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
          "$ref": "#/components/schemas/MlDestinationUpdateDto"
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
  "summary": "Update a machine-learning destination",
  "tags": [
    "ML destinations"
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

## admitMlDestination

`POST /api/ml-destinations/{id}/admission`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L195).

Admit a workload on a destination

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MlAdmissionRequestDto](models-17.md#mladmissionrequestdto), [MlAdmissionResponseDto](models-17.md#mladmissionresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Post(':id/admission')
@HttpCode(HttpStatus.OK)
@Authenticated()
@Endpoint({
    operationId: 'admitMlDestination',
    summary: 'Admit a workload on a destination',
    description:
      'Per-request selection: checks that exactly this destination can run the workload now (enabled, allowed, consented, within budget, healthy, serving it) and returns the measured estimate. A refusal is a 4xx error naming the reason; the server never answers with a different destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Per-request selection: checks that exactly this destination can run the workload now (enabled, allowed, consented, within budget, healthy, serving it) and returns the measured estimate. A refusal is a 4xx error naming the reason; the server never answers with a different destination.",
  "operationId": "admitMlDestination",
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
          "$ref": "#/components/schemas/MlAdmissionRequestDto"
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
            "$ref": "#/components/schemas/MlAdmissionResponseDto"
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
  "summary": "Admit a workload on a destination",
  "tags": [
    "ML destinations"
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

## revokeMlDestinationConsent

`DELETE /api/ml-destinations/{id}/consent`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L183).

Revoke consent for a cloud destination

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Delete(':id/consent')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'revokeMlDestinationConsent',
    summary: 'Revoke consent for a cloud destination',
    description: 'Every workload routed to the destination is refused from the next request on.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Every workload routed to the destination is refused from the next request on.",
  "operationId": "revokeMlDestinationConsent",
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
  "summary": "Revoke consent for a cloud destination",
  "tags": [
    "ML destinations"
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

## grantMlDestinationConsent

`PUT /api/ml-destinations/{id}/consent`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L167).

Record consent for a cloud destination

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlDestinationConsentRequestDto](models-18.md#mldestinationconsentrequestdto), [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Put(':id/consent')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'grantMlDestinationConsent',
    summary: 'Record consent for a cloud destination',
    description: 'Records that an administrator accepts media leaving the network for this destination.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Records that an administrator accepts media leaving the network for this destination.",
  "operationId": "grantMlDestinationConsent",
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
          "$ref": "#/components/schemas/MlDestinationConsentRequestDto"
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
  "summary": "Record consent for a cloud destination",
  "tags": [
    "ML destinations"
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

## probeMlDestination

`POST /api/ml-destinations/{id}/probe`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L142).

Probe a machine-learning destination

Permission: `systemConfig.update`. Admin only: `true`.

Models: [MlDestinationHealthStateDto](models-18.md#mldestinationhealthstatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Post(':id/probe')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    operationId: 'probeMlDestination',
    summary: 'Probe a machine-learning destination',
    description: 'Check reachability, served workloads and hardware now, and record the result.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Check reachability, served workloads and hardware now, and record the result.",
  "operationId": "probeMlDestination",
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
            "$ref": "#/components/schemas/MlDestinationHealthStateDto"
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
  "summary": "Probe a machine-learning destination",
  "tags": [
    "ML destinations"
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

## getMlDestinationRestorationModels

`GET /api/ml-destinations/{id}/restoration-models`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/ml-destination.controller.ts#L155).

Get restoration models of a destination

Permission: `systemConfig.read`. Admin only: `true`.

Models: [MlRestorationModelsResponseDto](models-18.md#mlrestorationmodelsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MlDestinations)
@Controller('ml-destinations')
@Get(':id/restoration-models')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get restoration models of a destination',
    description:
      'Asks the destination which Faithful and Creative restoration models it has, the state of each and every reason one is unavailable, with the throughput measured when it was qualified. No media is sent.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Asks the destination which Faithful and Creative restoration models it has, the state of each and every reason one is unavailable, with the throughput measured when it was qualified. No media is sent.",
  "operationId": "getMlDestinationRestorationModels",
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
            "$ref": "#/components/schemas/MlRestorationModelsResponseDto"
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
  "summary": "Get restoration models of a destination",
  "tags": [
    "ML destinations"
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
