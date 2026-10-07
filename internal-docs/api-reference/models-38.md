# Server API models 38

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## WorkflowLogEntryDto

Related models: [WorkflowResult](models-38.md#workflowresult), [WorkflowRunErrorCode](models-38.md#workflowrunerrorcode).

```json
{
  "properties": {
    "at": {
      "description": "Workflow run date/time",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "attempt": {
      "description": "0 for the first attempt, 1 for the automatic retry, then manual retries",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "error": {
      "description": "Why the run failed, without stored credentials",
      "type": "string"
    },
    "errorCode": {
      "$ref": "#/components/schemas/WorkflowRunErrorCode"
    },
    "id": {
      "description": "Workflow log entry ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "lastStep": {
      "description": "Last step ran, if the workflow ended early",
      "properties": {
        "index": {
          "description": "Index of the step in the workflow",
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "method": {
          "description": "Method of the step",
          "type": "string"
        }
      },
      "required": [
        "method",
        "index"
      ],
      "type": "object"
    },
    "result": {
      "$ref": "#/components/schemas/WorkflowResult"
    },
    "runId": {
      "description": "Run ID shared by every attempt of one run",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "triggerDataId": {
      "description": "Workflow trigger data ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "at",
    "attempt",
    "id",
    "result",
    "runId"
  ],
  "type": "object"
}
```

## WorkflowResponseDto

Related models: [WorkflowIssueDto](models-37.md#workflowissuedto), [WorkflowStepResponseDto](models-38.md#workflowstepresponsedto).

```json
{
  "properties": {
    "createdAt": {
      "description": "Creation date",
      "type": "string"
    },
    "description": {
      "description": "Workflow description",
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "description": "Workflow enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "id": {
      "description": "Workflow ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "issues": {
      "description": "What prevents this definition from running on this server; empty when it can run",
      "items": {
        "$ref": "#/components/schemas/WorkflowIssueDto"
      },
      "type": "array"
    },
    "logging": {
      "description": "Workflow logs run results",
      "type": "boolean"
    },
    "name": {
      "description": "Workflow name",
      "nullable": true,
      "type": "string"
    },
    "steps": {
      "description": "Workflow steps",
      "items": {
        "$ref": "#/components/schemas/WorkflowStepResponseDto"
      },
      "type": "array"
    },
    "trigger": {
      "description": "Workflow trigger type",
      "type": "string"
    },
    "updatedAt": {
      "description": "Update date",
      "type": "string"
    }
  },
  "required": [
    "createdAt",
    "description",
    "enabled",
    "extra",
    "id",
    "issues",
    "logging",
    "name",
    "steps",
    "trigger",
    "updatedAt"
  ],
  "type": "object"
}
```

## WorkflowResult


```json
{
  "description": "Workflow run result",
  "enum": [
    "completed",
    "halted",
    "error"
  ],
  "type": "string"
}
```

## WorkflowRunErrorCode


```json
{
  "description": "Why a workflow run failed",
  "enum": [
    "unsupported",
    "step_failed"
  ],
  "type": "string"
}
```

## WorkflowShareResponseDto

Related models: [WorkflowShareStepDto](models-38.md#workflowsharestepdto).

```json
{
  "properties": {
    "description": {
      "description": "Workflow description",
      "nullable": true,
      "type": "string"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "name": {
      "description": "Workflow name",
      "nullable": true,
      "type": "string"
    },
    "steps": {
      "description": "Workflow steps",
      "items": {
        "$ref": "#/components/schemas/WorkflowShareStepDto"
      },
      "type": "array"
    },
    "trigger": {
      "description": "Workflow trigger type",
      "type": "string"
    }
  },
  "required": [
    "description",
    "extra",
    "name",
    "steps",
    "trigger"
  ],
  "type": "object"
}
```

## WorkflowShareStepDto


```json
{
  "properties": {
    "config": {
      "additionalProperties": {},
      "description": "Step configuration, without credentials",
      "nullable": true,
      "type": "object"
    },
    "enabled": {
      "description": "Step is enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "method": {
      "description": "Step plugin method",
      "type": "string"
    }
  },
  "required": [
    "config",
    "extra",
    "method"
  ],
  "type": "object"
}
```

## WorkflowStepDto


```json
{
  "properties": {
    "config": {
      "additionalProperties": {},
      "description": "Step configuration",
      "nullable": true,
      "type": "object"
    },
    "enabled": {
      "description": "Step is enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "id": {
      "description": "Step ID from a previous response. A credential left out of its configuration keeps its stored value",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "method": {
      "description": "Step plugin method, as plugin#method",
      "maxLength": 300,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "config",
    "method"
  ],
  "type": "object"
}
```

## WorkflowStepResponseDto


```json
{
  "properties": {
    "config": {
      "additionalProperties": {},
      "description": "Step configuration, without stored credential values",
      "nullable": true,
      "type": "object"
    },
    "enabled": {
      "description": "Step is enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "id": {
      "description": "Step ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "method": {
      "description": "Step plugin method, as plugin#method",
      "type": "string"
    },
    "storedSecrets": {
      "description": "Configuration paths (keys joined with \".\") holding a stored credential that is never returned",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "config",
    "enabled",
    "extra",
    "id",
    "method",
    "storedSecrets"
  ],
  "type": "object"
}
```

## WorkflowTrigger


```json
{
  "description": "Plugin trigger type",
  "enum": [
    "AssetCreate",
    "AssetMetadataExtraction",
    "AssetTagged"
  ],
  "type": "string"
}
```

## WorkflowTriggerResponseDto

Related models: [WorkflowTrigger](models-38.md#workflowtrigger), [WorkflowType](models-38.md#workflowtype).

```json
{
  "properties": {
    "trigger": {
      "$ref": "#/components/schemas/WorkflowTrigger",
      "description": "Trigger type"
    },
    "types": {
      "description": "Workflow types",
      "items": {
        "$ref": "#/components/schemas/WorkflowType"
      },
      "type": "array"
    }
  },
  "required": [
    "trigger",
    "types"
  ],
  "type": "object"
}
```

## WorkflowType


```json
{
  "description": "Workflow type",
  "enum": [
    "AssetV1"
  ],
  "type": "string"
}
```

## WorkflowUpdateDto

Related models: [WorkflowStepDto](models-38.md#workflowstepdto).

```json
{
  "properties": {
    "description": {
      "description": "Workflow description",
      "maxLength": 2000,
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "description": "Workflow enabled",
      "type": "boolean"
    },
    "extra": {
      "additionalProperties": {},
      "description": "Additional fields of an imported definition, kept and exported unchanged",
      "type": "object"
    },
    "logging": {
      "description": "Workflow logs run results",
      "type": "boolean"
    },
    "name": {
      "description": "Workflow name",
      "maxLength": 300,
      "nullable": true,
      "type": "string"
    },
    "steps": {
      "items": {
        "$ref": "#/components/schemas/WorkflowStepDto"
      },
      "maxItems": 100,
      "type": "array"
    },
    "trigger": {
      "description": "Workflow trigger type. An unavailable trigger is kept, but the workflow cannot be enabled",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## YearInReviewDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets captured that year",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "kind": {
      "description": "Discriminator for a year in review recap",
      "enum": [
        "year_in_review"
      ],
      "type": "string"
    },
    "monthCount": {
      "description": "Number of distinct months represented",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "year": {
      "description": "Calendar year being recapped",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "assetCount",
    "kind",
    "monthCount",
    "year"
  ],
  "type": "object"
}
```
