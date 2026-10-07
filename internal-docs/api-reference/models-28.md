# Server API models 28

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## RenderWorkerAuditDto

Related models: [RenderWorkerAuditEvent](models-28.md#renderworkerauditevent), [RenderWorkerRefusalReason](models-28.md#renderworkerrefusalreason).

```json
{
  "properties": {
    "actorId": {
      "description": "The administrator who acted, when one did",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "detail": {
      "additionalProperties": {},
      "description": "Operator detail. Never a secret, never a path",
      "nullable": true,
      "type": "object"
    },
    "event": {
      "$ref": "#/components/schemas/RenderWorkerAuditEvent"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "operationId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RenderWorkerRefusalReason"
        }
      ],
      "nullable": true
    },
    "workerId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "actorId",
    "createdAt",
    "detail",
    "event",
    "id",
    "operationId",
    "reason",
    "workerId"
  ],
  "type": "object"
}
```

## RenderWorkerAuditEvent


```json
{
  "description": "Render worker audit event",
  "enum": [
    "enrolled",
    "admitted",
    "refused",
    "claim_refused",
    "limit_exceeded",
    "revoked",
    "updated",
    "device_lost"
  ],
  "type": "string"
}
```

## RenderWorkerCancelAckDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "released": {
      "description": "True when remote resources are confirmed gone",
      "type": "boolean"
    }
  },
  "required": [
    "claimToken",
    "released"
  ],
  "type": "object"
}
```

## RenderWorkerCheckpointCompleteDto


```json
{
  "properties": {
    "chunkKey": {
      "description": "Must match the planned chunk; a re-planned chunk cannot be completed",
      "minLength": 1,
      "type": "string"
    },
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "outputChecksum": {
      "pattern": "^[\\da-f]+$",
      "type": "string"
    },
    "outputPath": {
      "minLength": 1,
      "type": "string"
    },
    "sizeInBytes": {
      "pattern": "^\\d+$",
      "type": "string"
    }
  },
  "required": [
    "chunkKey",
    "claimToken",
    "outputChecksum",
    "outputPath",
    "sizeInBytes"
  ],
  "type": "object"
}
```

## RenderWorkerCheckpointPlanDto


```json
{
  "properties": {
    "chunkKey": {
      "minLength": 1,
      "type": "string"
    },
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "configDigest": {
      "minLength": 1,
      "type": "string"
    },
    "endTicks": {
      "pattern": "^\\d+$",
      "type": "string"
    },
    "historyDigest": {
      "minLength": 1,
      "type": "string"
    },
    "inputDigest": {
      "minLength": 1,
      "type": "string"
    },
    "prerollTicks": {
      "pattern": "^\\d+$",
      "type": "string"
    },
    "requiresSequentialContext": {
      "type": "boolean"
    },
    "seed": {
      "nullable": true,
      "type": "string"
    },
    "sequence": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "startTicks": {
      "pattern": "^\\d+$",
      "type": "string"
    },
    "timebase": {
      "pattern": "^\\d+\\/\\d+$",
      "type": "string"
    }
  },
  "required": [
    "chunkKey",
    "claimToken",
    "configDigest",
    "endTicks",
    "historyDigest",
    "inputDigest",
    "seed",
    "sequence",
    "startTicks",
    "timebase"
  ],
  "type": "object"
}
```

## RenderWorkerClaimDto

Related models: [MediaOperationCheckpointDto](models-15.md#mediaoperationcheckpointdto), [MediaOperationKind](models-15.md#mediaoperationkind), [RenderWorkerClaimLimitsDto](models-28.md#renderworkerclaimlimitsdto), [RenderWorkerInputGrantDto](models-28.md#renderworkerinputgrantdto).

```json
{
  "properties": {
    "artifactInputDigest": {
      "description": "Server source/revision binding required by whole-export checkpoint plans",
      "pattern": "^[a-f\\d]{64}$",
      "type": "string"
    },
    "attempt": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "checkpoints": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationCheckpointDto"
      },
      "type": "array"
    },
    "claimToken": {
      "description": "Required on every write to this operation",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "inputs": {
      "items": {
        "$ref": "#/components/schemas/RenderWorkerInputGrantDto"
      },
      "type": "array"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "leaseMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "limits": {
      "$ref": "#/components/schemas/RenderWorkerClaimLimitsDto"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "projectId": {
      "nullable": true,
      "type": "string"
    },
    "revisionId": {
      "nullable": true,
      "type": "string"
    },
    "settings": {
      "additionalProperties": {},
      "type": "object"
    },
    "snapshot": {
      "additionalProperties": {},
      "type": "object"
    }
  },
  "required": [
    "attempt",
    "checkpoints",
    "claimToken",
    "inputs",
    "kind",
    "leaseMs",
    "limits",
    "operationId",
    "projectId",
    "revisionId",
    "settings",
    "snapshot"
  ],
  "type": "object"
}
```

## RenderWorkerClaimLimitsDto


```json
{
  "properties": {
    "maxOutputBytes": {
      "nullable": true,
      "type": "string"
    },
    "maxWallClockMs": {
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "maxOutputBytes",
    "maxWallClockMs"
  ],
  "type": "object"
}
```

## RenderWorkerClaimRequestDto

Related models: [MediaOperationKind](models-15.md#mediaoperationkind).

```json
{
  "properties": {
    "kinds": {
      "description": "Narrow the claim to these kinds",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## RenderWorkerCompatibilityResponseDto

Related models: [MediaOperationKind](models-15.md#mediaoperationkind).

```json
{
  "properties": {
    "qualified": {
      "description": "Render kinds a qualified worker can take now",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "unavailable": {
      "description": "Render kinds no qualified worker can take now",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    }
  },
  "required": [
    "qualified",
    "unavailable"
  ],
  "type": "object"
}
```

## RenderWorkerCompleteDto

Related models: [RenderWorkerOutputDto](models-28.md#renderworkeroutputdto).

```json
{
  "properties": {
    "artifactSequence": {
      "description": "Server-verified whole-export checkpoint; required for Studio exports",
      "maximum": 0,
      "minimum": 0,
      "type": "integer"
    },
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "output": {
      "$ref": "#/components/schemas/RenderWorkerOutputDto",
      "description": "Legacy non-export render output"
    },
    "resultAssetId": {
      "description": "Must be null for a Studio export: its result is adopted by publication, never named by a worker",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "claimToken",
    "resultAssetId"
  ],
  "type": "object"
}
```

## RenderWorkerCreateDto

Related models: [MediaOperationDestination](models-15.md#mediaoperationdestination), [MediaOperationKind](models-15.md#mediaoperationkind).

```json
{
  "properties": {
    "conformanceMaxAgeMs": {
      "maximum": 9007199254740991,
      "minimum": 60000,
      "type": "integer"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "engineDigest": {
      "maxLength": 200,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "gpuMemoryBytes": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "kinds": {
      "description": "Operation kinds this worker may claim",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "minItems": 1,
      "type": "array"
    },
    "maxConcurrentOperations": {
      "maximum": 64,
      "minimum": 1,
      "type": "integer"
    },
    "maxOutputBytes": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "maxWallClockMs": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "name": {
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "destination",
    "kinds",
    "name"
  ],
  "type": "object"
}
```

## RenderWorkerCreateResponseDto

Related models: [RenderWorkerDto](models-28.md#renderworkerdto).

```json
{
  "properties": {
    "enrolmentSecret": {
      "description": "Shown once. Give it to the worker; the server keeps only its hash",
      "type": "string"
    },
    "worker": {
      "$ref": "#/components/schemas/RenderWorkerDto"
    }
  },
  "required": [
    "enrolmentSecret",
    "worker"
  ],
  "type": "object"
}
```

## RenderWorkerDto

Related models: [MediaOperationDestination](models-15.md#mediaoperationdestination), [MediaOperationKind](models-15.md#mediaoperationkind), [RenderWorkerStatus](models-28.md#renderworkerstatus).

```json
{
  "properties": {
    "activeOperations": {
      "description": "Operations the worker currently holds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "conformanceMaxAgeMs": {
      "description": "Oldest conformance evidence admission accepts, in milliseconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "engineDigest": {
      "description": "Engine and patch digest the worker must keep reporting",
      "nullable": true,
      "type": "string"
    },
    "gpuMemoryBytes": {
      "description": "GPU memory the worker was qualified with, in bytes",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Render worker ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kinds": {
      "description": "Operation kinds this worker may claim",
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "lastAdmittedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lastSeenAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "maxConcurrentOperations": {
      "description": "Operations this worker may hold at once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxOutputBytes": {
      "description": "Most output bytes one operation may produce here",
      "nullable": true,
      "type": "string"
    },
    "maxWallClockMs": {
      "description": "Longest one operation may run here, in milliseconds",
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "What the administrator calls this worker",
      "type": "string"
    },
    "revokedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/RenderWorkerStatus"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "activeOperations",
    "conformanceMaxAgeMs",
    "createdAt",
    "destination",
    "engineDigest",
    "gpuMemoryBytes",
    "id",
    "kinds",
    "lastAdmittedAt",
    "lastSeenAt",
    "maxConcurrentOperations",
    "maxOutputBytes",
    "maxWallClockMs",
    "name",
    "revokedAt",
    "status",
    "updatedAt"
  ],
  "type": "object"
}
```

## RenderWorkerFailDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "error": {
      "maxLength": 4000,
      "type": "string"
    },
    "errorCode": {
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "claimToken",
    "error",
    "errorCode"
  ],
  "type": "object"
}
```

## RenderWorkerHeartbeatDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "outputBytes": {
      "description": "Total output bytes produced so far",
      "pattern": "^\\d+$",
      "type": "string"
    }
  },
  "required": [
    "claimToken"
  ],
  "type": "object"
}
```

## RenderWorkerHeartbeatResponseDto

Related models: [RenderWorkerRefusalReason](models-28.md#renderworkerrefusalreason).

```json
{
  "properties": {
    "cancelRequested": {
      "description": "The owner asked to stop; acknowledge with cancel-ack",
      "type": "boolean"
    },
    "leaseExtended": {
      "type": "boolean"
    },
    "leaseMs": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pauseRequested": {
      "description": "The owner paused the job and its claim has been handed back; stop without reporting a failure",
      "type": "boolean"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RenderWorkerRefusalReason"
        }
      ],
      "description": "Set when a limit stopped the operation",
      "nullable": true
    }
  },
  "required": [
    "cancelRequested",
    "leaseExtended",
    "leaseMs",
    "pauseRequested",
    "refusal"
  ],
  "type": "object"
}
```

## RenderWorkerInputGrantDto


```json
{
  "properties": {
    "checksum": {
      "description": "Digest the manifest was resolved against, when known",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "format": "date-time",
      "type": "string"
    },
    "inputId": {
      "description": "FL-90 resource key, or `source` for a single-asset workload",
      "type": "string"
    },
    "kind": {
      "description": "Resource class: library-asset, edited-master, font, lut, …",
      "type": "string"
    },
    "resourceId": {
      "description": "Asset or resource id. Never a path",
      "type": "string"
    },
    "url": {
      "description": "Relative URL, valid for this claim only and only until expiresAt",
      "type": "string"
    }
  },
  "required": [
    "checksum",
    "expiresAt",
    "inputId",
    "kind",
    "resourceId",
    "url"
  ],
  "type": "object"
}
```

## RenderWorkerLimitDto


```json
{
  "properties": {
    "maxConcurrentOperations": {
      "description": "Operations one account may have claimed at once",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxOutputBytes": {
      "nullable": true,
      "type": "string"
    },
    "maxWallClockMs": {
      "nullable": true,
      "type": "string"
    },
    "subject": {
      "description": "`instance` for the default, otherwise a user ID",
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "userId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "maxConcurrentOperations",
    "maxOutputBytes",
    "maxWallClockMs",
    "subject",
    "updatedAt",
    "userId"
  ],
  "type": "object"
}
```

## RenderWorkerLimitUpdateDto


```json
{
  "properties": {
    "maxConcurrentOperations": {
      "maximum": 64,
      "minimum": 0,
      "type": "integer"
    },
    "maxOutputBytes": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "maxWallClockMs": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "userId": {
      "description": "Omit or null for the instance default",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "maxConcurrentOperations",
    "maxOutputBytes",
    "maxWallClockMs"
  ],
  "type": "object"
}
```

## RenderWorkerLimitsResponseDto

Related models: [RenderWorkerLimitDto](models-28.md#renderworkerlimitdto).

```json
{
  "properties": {
    "instance": {
      "$ref": "#/components/schemas/RenderWorkerLimitDto"
    },
    "users": {
      "items": {
        "$ref": "#/components/schemas/RenderWorkerLimitDto"
      },
      "type": "array"
    }
  },
  "required": [
    "instance",
    "users"
  ],
  "type": "object"
}
```

## RenderWorkerOutputDto


```json
{
  "properties": {
    "checksum": {
      "description": "SHA-256 of the whole file",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    },
    "contentType": {
      "description": "`video/mp4`, `video/webm` or `video/quicktime`",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "path": {
      "description": "Absolute path inside the render directory the claim named",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    },
    "remoteRef": {
      "description": "What the worker calls a copy it kept; it is asked to delete it until it acknowledges",
      "maxLength": 512,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "sizeInBytes": {
      "pattern": "^\\d+$",
      "type": "string"
    }
  },
  "required": [
    "checksum",
    "contentType",
    "path",
    "sizeInBytes"
  ],
  "type": "object"
}
```

## RenderWorkerProgressDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "outputBytes": {
      "pattern": "^\\d+$",
      "type": "string"
    },
    "processedUnits": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "status": {
      "enum": [
        "preparing",
        "rendering"
      ],
      "type": "string"
    },
    "totalUnits": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "claimToken",
    "processedUnits",
    "status",
    "totalUnits"
  ],
  "type": "object"
}
```

## RenderWorkerRefusalReason


```json
{
  "description": "Render worker refusal reason",
  "enum": [
    "invalid_credential",
    "worker_revoked",
    "session_expired",
    "conformance_stale",
    "conformance_replayed",
    "engine_digest_mismatch",
    "software_renderer",
    "destination_mismatch",
    "worker_mismatch",
    "scope_exceeded",
    "worker_concurrency_exceeded",
    "user_concurrency_exceeded",
    "gpu_memory_insufficient",
    "wall_clock_exceeded",
    "output_bytes_exceeded",
    "destination_unavailable",
    "manifest_incomplete",
    "codec_unsupported"
  ],
  "type": "string"
}
```

## RenderWorkerRemoteReferenceDto

Related models: [StudioExportRemoteReason](models-32.md#studioexportremotereason).

```json
{
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "operationId": {
      "description": "The render job",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "reason": {
      "$ref": "#/components/schemas/StudioExportRemoteReason"
    },
    "remoteRef": {
      "description": "The copy to delete, for a `delete` reference",
      "nullable": true,
      "type": "string"
    },
    "requestedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "id",
    "operationId",
    "reason",
    "remoteRef",
    "requestedAt"
  ],
  "type": "object"
}
```

## RenderWorkerSessionDto

Related models: [MediaOperationKind](models-15.md#mediaoperationkind).

```json
{
  "properties": {
    "expiresAt": {
      "format": "date-time",
      "type": "string"
    },
    "heartbeatIntervalMs": {
      "description": "How often the worker should heartbeat a held claim",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "leaseMs": {
      "description": "How long a claim lasts without a heartbeat",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "scopes": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "type": "array"
    },
    "sessionToken": {
      "description": "Present as the x-frameleaf-worker-session header on every worker call",
      "type": "string"
    },
    "workerId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "expiresAt",
    "heartbeatIntervalMs",
    "leaseMs",
    "scopes",
    "sessionToken",
    "workerId"
  ],
  "type": "object"
}
```

## RenderWorkerStatus


```json
{
  "description": "Render worker status",
  "enum": [
    "active",
    "revoked"
  ],
  "type": "string"
}
```

## RenderWorkerStreamOfferDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "negotiation": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sdp": {
      "description": "A complete session description (SDP)",
      "maxLength": 65536,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "claimToken",
    "negotiation",
    "sdp"
  ],
  "type": "object"
}
```

## RenderWorkerStreamSignalDto

Related models: [StudioPreviewStreamBoundsDto](models-32.md#studiopreviewstreamboundsdto), [StudioPreviewStreamCloseReason](models-32.md#studiopreviewstreamclosereason), [StudioPreviewTimeDto](models-32.md#studiopreviewtimedto).

```json
{
  "properties": {
    "answer": {
      "description": "The browser's answer, with the server's bitrate bound written in",
      "maxLength": 65536,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "bounds": {
      "$ref": "#/components/schemas/StudioPreviewStreamBoundsDto"
    },
    "close": {
      "type": "boolean"
    },
    "closeReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/StudioPreviewStreamCloseReason"
        }
      ],
      "nullable": true
    },
    "negotiation": {
      "description": "The round to offer on",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "offerNeeded": {
      "description": "No offer from this claim for this round yet: create one (with an ICE restart)",
      "type": "boolean"
    },
    "revision": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "start": {
      "$ref": "#/components/schemas/StudioPreviewTimeDto"
    }
  },
  "required": [
    "answer",
    "bounds",
    "close",
    "closeReason",
    "negotiation",
    "offerNeeded",
    "revision",
    "start"
  ],
  "type": "object"
}
```

## RenderWorkerStreamSignalRequestDto


```json
{
  "properties": {
    "claimToken": {
      "description": "The claim token this operation was handed out with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "claimToken"
  ],
  "type": "object"
}
```

## RenderWorkerUpdateDto

Related models: [MediaOperationKind](models-15.md#mediaoperationkind).

```json
{
  "properties": {
    "conformanceMaxAgeMs": {
      "maximum": 9007199254740991,
      "minimum": 60000,
      "type": "integer"
    },
    "engineDigest": {
      "maxLength": 200,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "gpuMemoryBytes": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "kinds": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationKind"
      },
      "minItems": 1,
      "type": "array"
    },
    "maxConcurrentOperations": {
      "maximum": 64,
      "minimum": 1,
      "type": "integer"
    },
    "maxOutputBytes": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "maxWallClockMs": {
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "name": {
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    }
  },
  "type": "object"
}
```

## RenderWorkerWriteResultDto

Related models: [RenderWorkerRefusalReason](models-28.md#renderworkerrefusalreason).

```json
{
  "properties": {
    "accepted": {
      "type": "boolean"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RenderWorkerRefusalReason"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "accepted",
    "refusal"
  ],
  "type": "object"
}
```

## RestorationDynamicRange


```json
{
  "description": "Dynamic range a restoration model accepts",
  "enum": [
    "sdr",
    "hdr"
  ],
  "type": "string"
}
```

## RestorationGpuDto


```json
{
  "properties": {
    "driverVersion": {
      "type": "string"
    },
    "memoryTotalBytes": {
      "format": "double",
      "type": "number"
    },
    "name": {
      "type": "string"
    }
  },
  "required": [
    "driverVersion",
    "memoryTotalBytes",
    "name"
  ],
  "type": "object"
}
```

## RestorationMeasuredThroughputDto


```json
{
  "properties": {
    "frames": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "framesPerSecond": {
      "description": "Measured frames restored per second",
      "format": "double",
      "type": "number"
    },
    "gpu": {
      "description": "GPU the measurement was made on, as nvidia-smi names it",
      "type": "string"
    },
    "inputHeight": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "inputWidth": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "peakVramBytes": {
      "description": "Measured peak GPU memory",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "frames",
    "framesPerSecond",
    "gpu",
    "inputHeight",
    "inputWidth",
    "peakVramBytes"
  ],
  "type": "object"
}
```

## RestorationModelCapabilityDto

Related models: [AssetRestorationMode](models-06.md#assetrestorationmode), [RestorationDynamicRange](models-28.md#restorationdynamicrange), [RestorationMeasuredThroughputDto](models-28.md#restorationmeasuredthroughputdto), [RestorationModelState](models-28.md#restorationmodelstate).

```json
{
  "properties": {
    "displayName": {
      "type": "string"
    },
    "dynamicRanges": {
      "description": "Source dynamic ranges the model accepts",
      "items": {
        "$ref": "#/components/schemas/RestorationDynamicRange"
      },
      "type": "array"
    },
    "family": {
      "description": "Model family, for example realbasicvsr or seedvr2",
      "type": "string"
    },
    "fingerprint": {
      "description": "Identity of the model and its verified weights, or null until the weights are verified",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "type": "string"
    },
    "maxFrames": {
      "description": "Largest number of frames one inference may restore",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxInputLongEdge": {
      "description": "Largest source long edge the model is qualified for",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "measured": {
      "description": "Throughput measured during qualification; estimates come from these",
      "items": {
        "$ref": "#/components/schemas/RestorationMeasuredThroughputDto"
      },
      "type": "array"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode"
    },
    "nativeScale": {
      "description": "Fixed enlargement the model restores at, or null",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "qualificationId": {
      "description": "Qualification record covering this model, or null",
      "nullable": true,
      "type": "string"
    },
    "reasons": {
      "description": "Every reason the model is not available; empty when it is",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "revision": {
      "description": "Pinned upstream commit",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/RestorationModelState"
    }
  },
  "required": [
    "displayName",
    "dynamicRanges",
    "family",
    "fingerprint",
    "id",
    "maxFrames",
    "maxInputLongEdge",
    "measured",
    "mode",
    "nativeScale",
    "qualificationId",
    "reasons",
    "revision",
    "state"
  ],
  "type": "object"
}
```

## RestorationModelState


```json
{
  "description": "Why a restoration model can or cannot run; only available admits a request",
  "enum": [
    "available",
    "verifying",
    "not-pinned",
    "runtime-missing",
    "runtime-dirty",
    "weights-missing",
    "weights-mismatch",
    "unqualified",
    "license-unreviewed",
    "no-gpu",
    "gpu-unqualified",
    "insufficient-vram"
  ],
  "type": "string"
}
```

## ReverseGeocodingStateResponseDto


```json
{
  "properties": {
    "lastImportFileName": {
      "description": "Last import file name",
      "nullable": true,
      "type": "string"
    },
    "lastUpdate": {
      "description": "Last update timestamp",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "lastImportFileName",
    "lastUpdate"
  ],
  "type": "object"
}
```

## RotateParameters


```json
{
  "properties": {
    "angle": {
      "description": "Rotation angle in degrees",
      "maximum": 270,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "angle"
  ],
  "type": "object"
}
```

## RunningJobsResponseDto

Related models: [JobRunResponseDto](models-13.md#jobrunresponsedto), [MediaOperationDto](models-15.md#mediaoperationdto), [MemoryExportResponseDto](models-16.md#memoryexportresponsedto), [QueueRunDto](models-26.md#queuerundto).

```json
{
  "properties": {
    "canManageQueues": {
      "description": "Whether the viewer may see and pause the server job queues",
      "type": "boolean"
    },
    "canReadJobRuns": {
      "type": "boolean"
    },
    "durableRuns": {
      "description": "Operational summaries; JobRead administrators only",
      "items": {
        "$ref": "#/components/schemas/JobRunResponseDto"
      },
      "type": "array"
    },
    "durableRunsUnavailable": {
      "type": "boolean"
    },
    "memoryExports": {
      "items": {
        "$ref": "#/components/schemas/MemoryExportResponseDto"
      },
      "type": "array"
    },
    "operations": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationDto"
      },
      "type": "array"
    },
    "queues": {
      "description": "Server job queues with work; always empty for non-administrators",
      "items": {
        "$ref": "#/components/schemas/QueueRunDto"
      },
      "type": "array"
    }
  },
  "required": [
    "canManageQueues",
    "memoryExports",
    "operations",
    "queues"
  ],
  "type": "object"
}
```

## SafetyLookupDto


```json
{
  "properties": {
    "hashes": {
      "description": "SHA-256 hex hashes; inaccessible and foreign assets are omitted, including for administrators",
      "items": {
        "pattern": "^[\\dA-Fa-f]{64}$",
        "type": "string"
      },
      "maxItems": 2000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "hashes"
  ],
  "type": "object"
}
```

## SafetyLookupResponseDto

Related models: [AssetSafetyDto](models-06.md#assetsafetydto).

```json
{
  "properties": {
    "assets": {
      "items": {
        "$ref": "#/components/schemas/AssetSafetyDto"
      },
      "type": "array"
    },
    "cloudAvailability": {
      "enum": [
        "off",
        "not-linked",
        "not-configured",
        "paused-key-unloaded",
        "ready"
      ],
      "type": "string"
    },
    "cloudReadOnly": {
      "description": "Frameleaf-managed backup storage is read-only, so new items wait to be backed up; restores keep working and nothing already backed up is touched",
      "type": "boolean"
    },
    "cloudReadOnlyReason": {
      "description": "Why the backup storage is read-only, as Frameleaf Cloud says: purge_hold, entitlement, unlinked, suspended, purging or plan_full (Backup paused: plan full). Open-ended: show an unknown value generically. Null when it is writable or no reason was given",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "assets",
    "cloudAvailability",
    "cloudReadOnly",
    "cloudReadOnlyReason"
  ],
  "type": "object"
}
```

## SafetySummaryDto


```json
{
  "properties": {
    "backedUp": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "backedUpPercent": {
      "description": "Retained completed original membership with current object presence; null if no configured accessible backup target",
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "cloudAvailability": {
      "enum": [
        "off",
        "not-linked",
        "not-configured",
        "paused-key-unloaded",
        "ready"
      ],
      "type": "string"
    },
    "cloudReadOnly": {
      "description": "Frameleaf-managed backup storage is read-only, so new items wait to be backed up; restores keep working and nothing already backed up is touched",
      "type": "boolean"
    },
    "cloudReadOnlyReason": {
      "description": "Why the backup storage is read-only, as Frameleaf Cloud says: purge_hold, entitlement, unlinked, suspended, purging or plan_full (Backup paused: plan full). Open-ended: show an unknown value generically. Null when it is writable or no reason was given",
      "nullable": true,
      "type": "string"
    },
    "fromICloudSync": {
      "description": "Current own accessible assets whose first recorded delivery of the current original is iCloud Photos Sync",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "lastCompletedRunAt": {
      "description": "Latest qualifying completion containing at least one current own accessible asset",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lastVerifiedRunAt": {
      "description": "Latest successful completed GET + SHA-256 run qualifying a current own accessible backed-up asset",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "onServer": {
      "description": "Registered assets not marked offline or last checked missing; not a new filesystem verification",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "onServerPercent": {
      "format": "double",
      "maximum": 100,
      "minimum": 0,
      "type": "number"
    },
    "total": {
      "description": "Current own accessible, non-trashed server library; excludes deleted libraries. Device-only items are not known to the server",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "backedUp",
    "backedUpPercent",
    "cloudAvailability",
    "cloudReadOnly",
    "cloudReadOnlyReason",
    "fromICloudSync",
    "lastCompletedRunAt",
    "lastVerifiedRunAt",
    "onServer",
    "onServerPercent",
    "total"
  ],
  "type": "object"
}
```

## SavedSearch


```json
{
  "properties": {
    "name": {
      "description": "Name shown in the search palette",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "query": {
      "additionalProperties": {},
      "description": "The search body to run, as the client sends it to the search endpoints",
      "type": "object"
    }
  },
  "required": [
    "name",
    "query"
  ],
  "type": "object"
}
```

## SearchAlbumResponseDto

Related models: [AlbumResponseDto](models-02.md#albumresponsedto), [SearchFacetResponseDto](models-28.md#searchfacetresponsedto).

```json
{
  "properties": {
    "count": {
      "description": "Number of albums in this page",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "facets": {
      "items": {
        "$ref": "#/components/schemas/SearchFacetResponseDto"
      },
      "type": "array"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/AlbumResponseDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Total number of matching albums",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "count",
    "facets",
    "items",
    "total"
  ],
  "type": "object"
}
```

## SearchAskMode


```json
{
  "description": "Search mode used to answer the query",
  "enum": [
    "smart",
    "metadata"
  ],
  "type": "string"
}
```

## SearchAssetResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [SearchFacetResponseDto](models-28.md#searchfacetresponsedto).

```json
{
  "properties": {
    "count": {
      "description": "Number of assets in this page",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "facets": {
      "items": {
        "$ref": "#/components/schemas/SearchFacetResponseDto"
      },
      "type": "array"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "nextCursor": {
      "description": "Cursor for the next page of results",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "nextPage": {
      "deprecated": true,
      "description": "Next page token",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        },
        {
          "version": "v3.2.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "total": {
      "description": "Total number of matching assets",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer",
      "x-immich-history": [
        {
          "version": "v3.0.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    }
  },
  "required": [
    "count",
    "facets",
    "items",
    "nextCursor",
    "nextPage",
    "total"
  ],
  "type": "object"
}
```

## SearchCityCountResponseDto


```json
{
  "properties": {
    "city": {
      "description": "City name, grouped as in GET /search/cities (which lists only cities with a photo)",
      "type": "string"
    },
    "count": {
      "description": "Number of timeline photos and videos in this city",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "city",
    "count"
  ],
  "type": "object"
}
```

## SearchExploreItem

Related models: [AssetResponseDto](models-06.md#assetresponsedto).

```json
{
  "properties": {
    "data": {
      "$ref": "#/components/schemas/AssetResponseDto"
    },
    "value": {
      "description": "Explore value",
      "type": "string"
    }
  },
  "required": [
    "data",
    "value"
  ],
  "type": "object"
}
```

## SearchExploreResponseDto

Related models: [SearchExploreItem](models-28.md#searchexploreitem).

```json
{
  "properties": {
    "fieldName": {
      "description": "Explore field name",
      "type": "string"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/SearchExploreItem"
      },
      "type": "array"
    }
  },
  "required": [
    "fieldName",
    "items"
  ],
  "type": "object"
}
```

## SearchFacetCountResponseDto


```json
{
  "properties": {
    "count": {
      "description": "Number of assets with this facet value",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "coverAssetId": {
      "description": "The newest matching asset with this value (by capture time), when `facetCovers` was asked for",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "label": {
      "description": "Display name when the value is an id (a person or a tag); the viewer's own name for it",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "value": {
      "description": "Facet value",
      "type": "string"
    }
  },
  "required": [
    "count",
    "value"
  ],
  "type": "object"
}
```

## SearchFacetField


```json
{
  "enum": [
    "people",
    "type",
    "city",
    "country",
    "make",
    "model",
    "lensModel",
    "rating",
    "isFavorite",
    "tags"
  ],
  "type": "string"
}
```

## SearchFacetResponseDto

Related models: [SearchFacetCountResponseDto](models-28.md#searchfacetcountresponsedto).

```json
{
  "properties": {
    "counts": {
      "items": {
        "$ref": "#/components/schemas/SearchFacetCountResponseDto"
      },
      "type": "array"
    },
    "fieldName": {
      "description": "Facet field name",
      "type": "string"
    }
  },
  "required": [
    "counts",
    "fieldName"
  ],
  "type": "object"
}
```
