# Server API models 38

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

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

Related models: [WorkflowStepDto](models-37.md#workflowstepdto).

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
