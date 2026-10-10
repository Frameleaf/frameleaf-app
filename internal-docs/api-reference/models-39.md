# Server API models 39

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## VideoMomentFrameDto


```json
{
  "properties": {
    "frameIndex": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "height": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "indexed": {
      "description": "Has a search embedding from the saved search model",
      "type": "boolean"
    },
    "isCover": {
      "type": "boolean"
    },
    "rank": {
      "description": "1 is the best frame",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "score": {
      "format": "double",
      "type": "number"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "width": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "frameIndex",
    "height",
    "id",
    "indexed",
    "isCover",
    "rank",
    "score",
    "timestampMs",
    "width"
  ],
  "type": "object"
}
```

## VideoMomentIndexState


```json
{
  "description": "Whether the video has current reusable frames",
  "enum": [
    "none",
    "ready",
    "stale"
  ],
  "type": "string"
}
```

## VideoMomentMatch


```json
{
  "description": "What a moment search hit matched on",
  "enum": [
    "visual",
    "caption",
    "transcript"
  ],
  "type": "string"
}
```

## VideoMomentSearchDto


```json
{
  "properties": {
    "limit": {
      "default": 24,
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "query": {
      "maxLength": 500,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "query"
  ],
  "type": "object"
}
```

## VideoMomentSearchHitDto

Related models: [VideoMomentMatch](models-39.md#videomomentmatch).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "caption": {
      "nullable": true,
      "type": "string"
    },
    "frameId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "match": {
      "$ref": "#/components/schemas/VideoMomentMatch"
    },
    "momentId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "score": {
      "description": "Higher is closer",
      "format": "double",
      "type": "number"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "caption",
    "frameId",
    "match",
    "momentId",
    "score",
    "timestampMs"
  ],
  "type": "object"
}
```

## VideoMomentSearchResponseDto

Related models: [VideoMomentSearchHitDto](models-39.md#videomomentsearchhitdto).

```json
{
  "properties": {
    "hits": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentSearchHitDto"
      },
      "type": "array"
    }
  },
  "required": [
    "hits"
  ],
  "type": "object"
}
```

## VideoMomentSource


```json
{
  "description": "Video moment source",
  "enum": [
    "generated",
    "manual"
  ],
  "type": "string"
}
```

## VideoMomentUpdateDto


```json
{
  "properties": {
    "caption": {
      "maxLength": 500,
      "nullable": true,
      "type": "string"
    },
    "endMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "timestampMs": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "transcript": {
      "maxLength": 20000,
      "nullable": true,
      "type": "string"
    }
  },
  "type": "object"
}
```

## VideoMomentsResponseDto

Related models: [EnrichmentStaleReason](models-11.md#enrichmentstalereason), [VideoMomentDto](models-38.md#videomomentdto), [VideoMomentFrameDto](models-39.md#videomomentframedto), [VideoMomentIndexState](models-39.md#videomomentindexstate).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "captionModel": {
      "nullable": true,
      "type": "string"
    },
    "captionedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "coverFrameId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "coverTimestampMs": {
      "description": "The owner's chosen cover time; null means the best frame",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "embeddingModel": {
      "nullable": true,
      "type": "string"
    },
    "extractorVersion": {
      "nullable": true,
      "type": "string"
    },
    "frames": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentFrameDto"
      },
      "type": "array"
    },
    "framesExtractedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "indexedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "moments": {
      "items": {
        "$ref": "#/components/schemas/VideoMomentDto"
      },
      "type": "array"
    },
    "staleReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/EnrichmentStaleReason"
        }
      ],
      "nullable": true
    },
    "state": {
      "$ref": "#/components/schemas/VideoMomentIndexState"
    }
  },
  "required": [
    "assetId",
    "captionModel",
    "captionedAt",
    "coverFrameId",
    "coverTimestampMs",
    "embeddingModel",
    "extractorVersion",
    "frames",
    "framesExtractedAt",
    "indexedAt",
    "moments",
    "staleReason",
    "state"
  ],
  "type": "object"
}
```

## VideoTrimMode


```json
{
  "description": "Precise cuts are frame accurate and re-encode; fast cuts snap to keyframes and copy the streams when nothing else in the recipe needs a re-encode",
  "enum": [
    "precise",
    "fast"
  ],
  "type": "string"
}
```

## WarmLibrarySetupDto


```json
{
  "additionalProperties": false,
  "properties": {
    "reset": {
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## WorkerCredentialState


```json
{
  "description": "How a worker credential is held",
  "enum": [
    "none",
    "stored",
    "managed",
    "enrolled"
  ],
  "type": "string"
}
```

## WorkerGpuDto


```json
{
  "properties": {
    "memoryTotalBytes": {
      "format": "double",
      "type": "number"
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "memoryTotalBytes",
    "name"
  ],
  "type": "object"
}
```

## WorkerInventoryEntryDto

Related models: [MediaOperationKind](models-16.md#mediaoperationkind), [MlWorkerAcceleration](models-18.md#mlworkeracceleration), [MlWorkerReadiness](models-18.md#mlworkerreadiness), [MlWorkerRole](models-18.md#mlworkerrole), [MlWorkload](models-18.md#mlworkload), [WorkerCredentialState](models-39.md#workercredentialstate), [WorkerGpuDto](models-39.md#workergpudto), [WorkerInventorySource](models-39.md#workerinventorysource), [WorkerWorkloadAdmissionDto](models-39.md#workerworkloadadmissiondto).

```json
{
  "properties": {
    "acceleration": {
      "$ref": "#/components/schemas/MlWorkerAcceleration"
    },
    "activeOperations": {
      "description": "Jobs running here now",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "admission": {
      "description": "Per allowed workload, from the last check",
      "items": {
        "$ref": "#/components/schemas/WorkerWorkloadAdmissionDto"
      },
      "type": "array"
    },
    "allowedWorkloads": {
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    },
    "checkedAt": {
      "description": "Last check or check-in",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "configured": {
      "description": "For a local destination: its URL is still in the machine-learning URL list. Always true otherwise",
      "type": "boolean"
    },
    "consentGranted": {
      "description": "True when no consent is needed or it is recorded",
      "type": "boolean"
    },
    "credential": {
      "$ref": "#/components/schemas/WorkerCredentialState"
    },
    "enabled": {
      "type": "boolean"
    },
    "gpuMemoryBytes": {
      "description": "Largest GPU memory reported or qualified, or null when unknown",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "gpus": {
      "description": "GPUs the worker reported, with memory; empty when not reported",
      "items": {
        "$ref": "#/components/schemas/WorkerGpuDto"
      },
      "type": "array"
    },
    "id": {
      "description": "ML destination ID or render worker ID",
      "type": "string"
    },
    "kind": {
      "description": "ML destination kind, or the render worker destination",
      "type": "string"
    },
    "latencyMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "leavesNetwork": {
      "description": "Work sent here leaves the network",
      "type": "boolean"
    },
    "maxConcurrentOperations": {
      "description": "Render workers: the most they may hold at once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "name": {
      "type": "string"
    },
    "queuedOperations": {
      "description": "Jobs waiting for this worker",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "readiness": {
      "$ref": "#/components/schemas/MlWorkerReadiness"
    },
    "renderKinds": {
      "description": "Operation kinds a render worker may claim",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "role": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlWorkerRole"
        }
      ],
      "description": "What an ML destination is for; null for a render worker",
      "nullable": true
    },
    "routedWorkloads": {
      "description": "Workloads whose route names this destination",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    },
    "servedWorkloads": {
      "description": "Workloads the worker reported on its last check, or null when it never answered",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "nullable": true,
      "type": "array"
    },
    "sharesLibraryHardware": {
      "type": "boolean"
    },
    "source": {
      "$ref": "#/components/schemas/WorkerInventorySource"
    },
    "summary": {
      "nullable": true,
      "type": "string"
    },
    "url": {
      "description": "Endpoint URL, or null when there is none to show",
      "nullable": true,
      "type": "string"
    },
    "waitingForLibraryAnalysis": {
      "description": "Full restorations bound here are waiting because library analysis has work",
      "type": "boolean"
    }
  },
  "required": [
    "acceleration",
    "activeOperations",
    "admission",
    "allowedWorkloads",
    "checkedAt",
    "configured",
    "consentGranted",
    "credential",
    "enabled",
    "gpuMemoryBytes",
    "gpus",
    "id",
    "kind",
    "latencyMs",
    "leavesNetwork",
    "maxConcurrentOperations",
    "name",
    "queuedOperations",
    "readiness",
    "renderKinds",
    "role",
    "routedWorkloads",
    "servedWorkloads",
    "sharesLibraryHardware",
    "source",
    "summary",
    "url",
    "waitingForLibraryAnalysis"
  ],
  "type": "object"
}
```

## WorkerInventoryResponseDto

Related models: [WorkerInventoryEntryDto](models-39.md#workerinventoryentrydto), [WorkerLibraryRouteDto](models-39.md#workerlibraryroutedto), [WorkerQueueBacklogDto](models-39.md#workerqueuebacklogdto), [WorkerRunnerDto](models-39.md#workerrunnerdto).

```json
{
  "properties": {
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "configuredUrls": {
      "description": "The machine-learning URL list, in order",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "entries": {
      "items": {
        "$ref": "#/components/schemas/WorkerInventoryEntryDto"
      },
      "type": "array"
    },
    "libraryBacklog": {
      "description": "Library-analysis jobs active or waiting, not counting paused queues",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "libraryQueues": {
      "items": {
        "$ref": "#/components/schemas/WorkerQueueBacklogDto"
      },
      "type": "array"
    },
    "libraryRoutes": {
      "items": {
        "$ref": "#/components/schemas/WorkerLibraryRouteDto"
      },
      "type": "array"
    },
    "machineLearningEnabled": {
      "type": "boolean"
    },
    "runners": {
      "description": "Server processes running restorations now",
      "items": {
        "$ref": "#/components/schemas/WorkerRunnerDto"
      },
      "type": "array"
    }
  },
  "required": [
    "checkedAt",
    "configuredUrls",
    "entries",
    "libraryBacklog",
    "libraryQueues",
    "libraryRoutes",
    "machineLearningEnabled",
    "runners"
  ],
  "type": "object"
}
```

## WorkerInventorySource


```json
{
  "description": "Where an inventory entry comes from",
  "enum": [
    "ml-destination",
    "render-worker"
  ],
  "type": "string"
}
```

## WorkerLibraryRouteDto

Related models: [MlWorkload](models-18.md#mlworkload), [QueueName](models-27.md#queuename).

```json
{
  "properties": {
    "destinationId": {
      "nullable": true,
      "type": "string"
    },
    "queues": {
      "description": "Queues whose jobs run this workload",
      "items": {
        "$ref": "#/components/schemas/QueueName"
      },
      "type": "array"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "destinationId",
    "queues",
    "workload"
  ],
  "type": "object"
}
```

## WorkerQueueBacklogDto

Related models: [QueueName](models-27.md#queuename).

```json
{
  "properties": {
    "active": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "paused": {
      "type": "boolean"
    },
    "queue": {
      "$ref": "#/components/schemas/QueueName"
    },
    "waiting": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "paused",
    "queue",
    "waiting"
  ],
  "type": "object"
}
```

## WorkerRunnerDto

Related models: [MediaOperationKind](models-16.md#mediaoperationkind).

```json
{
  "properties": {
    "activeOperations": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "kinds": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "lastHeartbeatAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "workerId": {
      "description": "The server process holding the claims",
      "type": "string"
    }
  },
  "required": [
    "activeOperations",
    "kinds",
    "lastHeartbeatAt",
    "workerId"
  ],
  "type": "object"
}
```

## WorkerWorkloadAdmissionDto

Related models: [MlAdmissionRefusal](models-17.md#mladmissionrefusal), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "admitted": {
      "description": "Whether the last check would admit this workload here",
      "type": "boolean"
    },
    "detail": {
      "description": "Why it would be refused, or null",
      "nullable": true,
      "type": "string"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlAdmissionRefusal"
        }
      ],
      "nullable": true
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "admitted",
    "detail",
    "refusal",
    "workload"
  ],
  "type": "object"
}
```

## WorkflowCreateDto

Related models: [WorkflowStepDto](models-39.md#workflowstepdto).

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
  "required": [
    "trigger"
  ],
  "type": "object"
}
```

## WorkflowIssueCode


```json
{
  "description": "Why a workflow definition cannot run",
  "enum": [
    "trigger_unavailable",
    "method_unavailable",
    "method_incompatible",
    "config_invalid"
  ],
  "type": "string"
}
```

## WorkflowIssueDto

Related models: [WorkflowIssueCode](models-39.md#workflowissuecode).

```json
{
  "properties": {
    "code": {
      "$ref": "#/components/schemas/WorkflowIssueCode"
    },
    "message": {
      "description": "What prevents the workflow from running",
      "type": "string"
    },
    "step": {
      "description": "Index of the step the issue belongs to",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "code",
    "message"
  ],
  "type": "object"
}
```

## WorkflowLogEntryDto

Related models: [WorkflowResult](models-39.md#workflowresult), [WorkflowRunErrorCode](models-39.md#workflowrunerrorcode).

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

Related models: [WorkflowIssueDto](models-39.md#workflowissuedto), [WorkflowStepResponseDto](models-39.md#workflowstepresponsedto).

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

Related models: [WorkflowShareStepDto](models-39.md#workflowsharestepdto).

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

Related models: [WorkflowTrigger](models-39.md#workflowtrigger), [WorkflowType](models-39.md#workflowtype).

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

Related models: [WorkflowStepDto](models-39.md#workflowstepdto).

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
