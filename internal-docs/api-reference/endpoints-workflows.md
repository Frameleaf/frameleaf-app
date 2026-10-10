# Server API — Workflows

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchWorkflows

`GET /api/workflows`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L37).

List all workflows

Permission: `workflow.read`. Admin only: `false`.

Models: [WorkflowResponseDto](models-39.md#workflowresponsedto), [WorkflowTrigger](models-39.md#workflowtrigger).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Get()
@Authenticated({ permission: Permission.WorkflowRead })
@Endpoint({
    summary: 'List all workflows',
    description: 'Retrieve a list of workflows available to the authenticated user.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of workflows available to the authenticated user.",
  "operationId": "searchWorkflows",
  "parameters": [
    {
      "name": "description",
      "required": false,
      "in": "query",
      "description": "Workflow description",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "enabled",
      "required": false,
      "in": "query",
      "description": "Workflow enabled",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Workflow ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "logging",
      "required": false,
      "in": "query",
      "description": "Workflow logs run results",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "name",
      "required": false,
      "in": "query",
      "description": "Workflow name",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "trigger",
      "required": false,
      "in": "query",
      "description": "Workflow trigger type",
      "schema": {
        "$ref": "#/components/schemas/WorkflowTrigger"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/WorkflowResponseDto"
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
  "summary": "List all workflows",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.read"
}
```

## createWorkflow

`POST /api/workflows`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L26).

Create a workflow

Permission: `workflow.create`. Admin only: `false`.

Models: [WorkflowCreateDto](models-39.md#workflowcreatedto), [WorkflowResponseDto](models-39.md#workflowresponsedto).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Post()
@Authenticated({ permission: Permission.WorkflowCreate })
@Endpoint({
    summary: 'Create a workflow',
    description: 'Create a new workflow, the workflow can also be created with empty filters and actions.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new workflow, the workflow can also be created with empty filters and actions.",
  "operationId": "createWorkflow",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/WorkflowCreateDto"
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
            "$ref": "#/components/schemas/WorkflowResponseDto"
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
  "summary": "Create a workflow",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.create"
}
```

## getWorkflowTriggers

`GET /api/workflows/triggers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L48).

List all workflow triggers

Permission: `See authentication declaration`. Admin only: `false`.

Models: [WorkflowTriggerResponseDto](models-39.md#workflowtriggerresponsedto).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Get('triggers')
@Authenticated({ permission: false })
@Endpoint({
    summary: 'List all workflow triggers',
    description: 'Retrieve a list of all available workflow triggers.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all available workflow triggers.",
  "operationId": "getWorkflowTriggers",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/WorkflowTriggerResponseDto"
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
  "summary": "List all workflow triggers",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ]
}
```

## deleteWorkflow

`DELETE /api/workflows/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L108).

Delete a workflow

Permission: `workflow.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Delete(':id')
@Authenticated({ permission: Permission.WorkflowDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a workflow',
    description: 'Delete a workflow by its ID.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a workflow by its ID.",
  "operationId": "deleteWorkflow",
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
  "summary": "Delete a workflow",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.delete"
}
```

## getWorkflow

`GET /api/workflows/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L59).

Retrieve a workflow

Permission: `workflow.read`. Admin only: `false`.

Models: [WorkflowResponseDto](models-39.md#workflowresponsedto).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Get(':id')
@Authenticated({ permission: Permission.WorkflowRead })
@Endpoint({
    summary: 'Retrieve a workflow',
    description: 'Retrieve information about a specific workflow by its ID.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about a specific workflow by its ID.",
  "operationId": "getWorkflow",
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
            "$ref": "#/components/schemas/WorkflowResponseDto"
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
  "summary": "Retrieve a workflow",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.read"
}
```

## updateWorkflow

`PUT /api/workflows/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L81).

Update a workflow

Permission: `workflow.update`. Admin only: `false`.

Models: [WorkflowResponseDto](models-39.md#workflowresponsedto), [WorkflowUpdateDto](models-39.md#workflowupdatedto).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Put(':id')
@Authenticated({ permission: Permission.WorkflowUpdate })
@Endpoint({
    summary: 'Update a workflow',
    description:
      'Update the information of a specific workflow by its ID. This endpoint can be used to update the workflow name, description, trigger type, filters and actions order, etc.',
    history: new HistoryBuilder().added('v3.0.0').deprecated('v3', { replacementId: 'updateWorkflow' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update the information of a specific workflow by its ID. This endpoint can be used to update the workflow name, description, trigger type, filters and actions order, etc.",
  "operationId": "updateWorkflow",
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
          "$ref": "#/components/schemas/WorkflowUpdateDto"
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
            "$ref": "#/components/schemas/WorkflowResponseDto"
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
  "summary": "Update a workflow",
  "tags": [
    "Workflows",
    "Deprecated"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateWorkflow"
    }
  ],
  "x-immich-permission": "workflow.update",
  "x-immich-state": "Deprecated"
}
```

## getWorkflowLogs

`GET /api/workflows/{id}/logs`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L133).

Retrieve workflow logs

Permission: `workflow.logs`. Admin only: `false`.

Models: [WorkflowLogEntryDto](models-39.md#workflowlogentrydto), [WorkflowResult](models-39.md#workflowresult).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Get(':id/logs')
@Authenticated({ permission: Permission.WorkflowLogs })
@Endpoint({
    summary: 'Retrieve workflow logs',
    description: 'Retrieve logs of a workflows runs by ID',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve logs of a workflows runs by ID",
  "operationId": "getWorkflowLogs",
  "parameters": [
    {
      "name": "before",
      "required": false,
      "in": "query",
      "description": "Filter by runs before a date/time",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
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
      "name": "limit",
      "required": false,
      "in": "query",
      "description": "Maximum number of logs",
      "schema": {
        "maximum": 200,
        "exclusiveMinimum": true,
        "default": 50,
        "type": "integer",
        "minimum": 0
      }
    },
    {
      "name": "result",
      "required": false,
      "in": "query",
      "description": "Filter by run result",
      "schema": {
        "$ref": "#/components/schemas/WorkflowResult"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/WorkflowLogEntryDto"
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
  "summary": "Retrieve workflow logs",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.logs"
}
```

## retryWorkflowRun

`POST /api/workflows/{id}/runs/{runId}/retry`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L120).

Retry a workflow run

Permission: `workflow.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Post(':id/runs/:runId/retry')
@Authenticated({ permission: Permission.WorkflowUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Retry a workflow run',
    description:
      'Run a logged workflow run again, as its next attempt, for the photo or video that started it. The workflow must be enabled and able to run.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Run a logged workflow run again, as its next attempt, for the photo or video that started it. The workflow must be enabled and able to run.",
  "operationId": "retryWorkflowRun",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Workflow ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    },
    {
      "name": "runId",
      "required": true,
      "in": "path",
      "description": "Run ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
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
  "summary": "Retry a workflow run",
  "tags": [
    "Workflows"
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
  "x-immich-permission": "workflow.update",
  "x-immich-state": "Alpha"
}
```

## getWorkflowForShare

`GET /api/workflows/{id}/share`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L70).

Retrieve a workflow

Permission: `workflow.read`. Admin only: `false`.

Models: [WorkflowShareResponseDto](models-39.md#workflowshareresponsedto).

Controller access declarations:

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Get(':id/share')
@Authenticated({ permission: Permission.WorkflowRead })
@Endpoint({
    summary: 'Retrieve a workflow',
    description: 'Retrieve a workflow details without ids, default values, etc.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a workflow details without ids, default values, etc.",
  "operationId": "getWorkflowForShare",
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
            "$ref": "#/components/schemas/WorkflowShareResponseDto"
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
  "summary": "Retrieve a workflow",
  "tags": [
    "Workflows"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "workflow.read"
}
```
