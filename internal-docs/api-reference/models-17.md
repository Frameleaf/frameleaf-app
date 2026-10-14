# Server API models 17

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/3674dd2d103d87bf1dc40ef71a63b86a29ce810a/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## MediaHealthStatus


```json
{
  "description": "Media health status",
  "enum": [
    "found",
    "missing",
    "candidate",
    "relinked",
    "dismissed",
    "resolved",
    "unsupported_raw",
    "corrupt_suspect",
    "corrupt_confirmed",
    "trash_queued",
    "trashed",
    "delete_queued",
    "deleted"
  ],
  "type": "string"
}
```

## MediaHealthSummaryResponseDto

Related models: [MediaHealthActivityDto](models-16.md#mediahealthactivitydto), [MediaHealthCareSettingsDto](models-16.md#mediahealthcaresettingsdto), [MediaHealthOperationDto](models-16.md#mediahealthoperationdto), [MediaHealthQueuesDto](models-16.md#mediahealthqueuesdto), [MediaHealthRunsDto](models-16.md#mediahealthrunsdto).

```json
{
  "properties": {
    "care": {
      "$ref": "#/components/schemas/MediaHealthCareSettingsDto"
    },
    "operation": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthOperationDto"
        }
      ],
      "nullable": true
    },
    "queues": {
      "$ref": "#/components/schemas/MediaHealthQueuesDto"
    },
    "recent": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthActivityDto"
      },
      "type": "array"
    },
    "recoveryAvailable": {
      "description": "At least one recovery location is configured for this reader",
      "type": "boolean"
    },
    "runs": {
      "$ref": "#/components/schemas/MediaHealthRunsDto"
    }
  },
  "required": [
    "care",
    "operation",
    "queues",
    "recent",
    "recoveryAvailable",
    "runs"
  ],
  "type": "object"
}
```

## MediaOperationAggregateDto

Related models: [MediaOperationDestination](models-17.md#mediaoperationdestination), [MediaOperationKind](models-17.md#mediaoperationkind), [MediaOperationStatus](models-17.md#mediaoperationstatus).

```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "oldestCreatedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    }
  },
  "required": [
    "count",
    "destination",
    "kind",
    "oldestCreatedAt",
    "status"
  ],
  "type": "object"
}
```

## MediaOperationBulkAction


```json
{
  "description": "Bulk action a durable media operation applies",
  "enum": [
    "favorite",
    "unfavorite",
    "archive",
    "unarchive",
    "add-to-album",
    "remove-from-album",
    "tag",
    "untag",
    "change-date",
    "change-description",
    "change-location",
    "mark-sensitive",
    "unmark-sensitive",
    "delete",
    "delete-permanently",
    "restore",
    "stack",
    "unstack",
    "refresh-thumbnails",
    "refresh-metadata",
    "refresh-encoded",
    "refresh-faces",
    "relink-live-photo",
    "resolve-duplicates",
    "undo-duplicates",
    "relink-missing-media",
    "recover-damaged-media",
    "trash-damaged-media",
    "apply-classification-rule"
  ],
  "type": "string"
}
```

## MediaOperationBulkCreateDto

Related models: [MediaOperationBulkAction](models-17.md#mediaoperationbulkaction), [MediaOperationBulkPayloadDto](models-17.md#mediaoperationbulkpayloaddto).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "assetIds": {
      "description": "The frozen matching set, in order",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "minItems": 1,
      "type": "array"
    },
    "payload": {
      "$ref": "#/components/schemas/MediaOperationBulkPayloadDto"
    },
    "requestId": {
      "description": "Client idempotency key; submitting the same key again returns the existing operation",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "scope": {
      "additionalProperties": {},
      "description": "A record of the view the set came from; never re-resolved",
      "type": "object"
    },
    "submittedTotal": {
      "description": "The count shown to the person at submit",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "truncated": {
      "description": "The client could not resolve the whole matching set",
      "type": "boolean"
    }
  },
  "required": [
    "action",
    "assetIds"
  ],
  "type": "object"
}
```

## MediaOperationBulkItemDto

Related models: [MediaOperationItemStatus](models-17.md#mediaoperationitemstatus).

```json
{
  "properties": {
    "id": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "message": {
      "description": "Operator detail from the server",
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "description": "Stable key the client turns into a message",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationItemStatus"
    }
  },
  "required": [
    "id",
    "message",
    "reasonKey",
    "status"
  ],
  "type": "object"
}
```

## MediaOperationBulkPayloadDto

Related models: [MediaOperationDuplicateGroupDto](models-17.md#mediaoperationduplicategroupdto), [MediaOperationLivePhotoPairDto](models-17.md#mediaoperationlivephotopairdto), [MediaOperationMediaHealthEntryDto](models-17.md#mediaoperationmediahealthentrydto).

```json
{
  "properties": {
    "albumId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "classificationRuleId": {
      "description": "For `apply-classification-rule`: the rule to apply to the items (FL-60)",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "dateMode": {
      "enum": [
        "set",
        "shift"
      ],
      "type": "string"
    },
    "dateTimeOriginal": {
      "type": "string"
    },
    "description": {
      "maxLength": 10000,
      "type": "string"
    },
    "duplicateGroups": {
      "description": "Duplicate review decisions, one complete group each (FL-61)",
      "items": {
        "$ref": "#/components/schemas/MediaOperationDuplicateGroupDto"
      },
      "maxItems": 5000,
      "type": "array"
    },
    "latitude": {
      "format": "double",
      "maximum": 90,
      "minimum": -90,
      "type": "number"
    },
    "longitude": {
      "format": "double",
      "maximum": 180,
      "minimum": -180,
      "type": "number"
    },
    "mediaHealth": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationMediaHealthEntryDto"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "minutes": {
      "description": "Relative shift in minutes, for `dateMode: shift`",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pairs": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationLivePhotoPairDto"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "primaryId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stackIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "tagIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50,
      "type": "array"
    },
    "timeZone": {
      "type": "string"
    }
  },
  "type": "object"
}
```

## MediaOperationBulkSummaryDto

Related models: [MediaOperationBulkAction](models-17.md#mediaoperationbulkaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaOperationBulkAction"
    },
    "failed": {
      "description": "Items the server attempted and could not apply; a retry covers these",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "itemsTruncated": {
      "type": "boolean"
    },
    "requested": {
      "description": "Items in the frozen set",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "retried": {
      "description": "Items that failed and were given their one automatic retry",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "skipped": {
      "description": "Items refused before anything changed, e.g. no access",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "snapshotTruncated": {
      "type": "boolean"
    },
    "succeeded": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "action",
    "failed",
    "itemsTruncated",
    "requested",
    "retried",
    "skipped",
    "snapshotTruncated",
    "succeeded"
  ],
  "type": "object"
}
```

## MediaOperationCheckpointDto

Related models: [MediaOperationCheckpointState](models-17.md#mediaoperationcheckpointstate).

```json
{
  "properties": {
    "chunkKey": {
      "description": "Digest over every input to this chunk; the reuse key",
      "type": "string"
    },
    "completedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "endTicks": {
      "description": "Chunk end, in ticks of the timebase",
      "type": "string"
    },
    "id": {
      "description": "Checkpoint ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "requiresSequentialContext": {
      "description": "A render may not start inside this chunk",
      "type": "boolean"
    },
    "sequence": {
      "description": "Chunk order within the render",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "sizeInBytes": {
      "nullable": true,
      "type": "string"
    },
    "startTicks": {
      "description": "Chunk start, in ticks of the timebase",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/MediaOperationCheckpointState"
    },
    "timebase": {
      "description": "Rational timebase for the tick range, e.g. 30000/1001",
      "type": "string"
    }
  },
  "required": [
    "chunkKey",
    "completedAt",
    "endTicks",
    "id",
    "requiresSequentialContext",
    "sequence",
    "sizeInBytes",
    "startTicks",
    "state",
    "timebase"
  ],
  "type": "object"
}
```

## MediaOperationCheckpointState


```json
{
  "description": "Media operation checkpoint state",
  "enum": [
    "pending",
    "complete",
    "invalid"
  ],
  "type": "string"
}
```

## MediaOperationDestination


```json
{
  "description": "Media operation destination",
  "enum": [
    "local",
    "lan",
    "frameleaf-cloud"
  ],
  "type": "string"
}
```

## MediaOperationDetailDto

Related models: [CloudMlJobActivityDto](models-09.md#cloudmljobactivitydto), [MediaOperationBulkItemDto](models-17.md#mediaoperationbulkitemdto), [MediaOperationBulkSummaryDto](models-17.md#mediaoperationbulksummarydto), [MediaOperationCheckpointDto](models-17.md#mediaoperationcheckpointdto), [MediaOperationDestination](models-17.md#mediaoperationdestination), [MediaOperationEstimateDto](models-17.md#mediaoperationestimatedto), [MediaOperationKind](models-17.md#mediaoperationkind), [MediaOperationStatus](models-17.md#mediaoperationstatus), [RenderWorkerRefusalReason](models-30.md#renderworkerrefusalreason).

```json
{
  "properties": {
    "assetId": {
      "description": "Source asset, when the workload has exactly one",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "attempt": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "autoRetries": {
      "description": "Automatic retries this job has used; every job gets one before a failure is reported",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bulk": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationBulkSummaryDto"
        }
      ],
      "nullable": true
    },
    "bulkItems": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationBulkItemDto"
      },
      "type": "array"
    },
    "bulkRetryPending": {
      "description": "Asset IDs waiting for their automatic retry",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "cancelAcknowledgedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "cancelRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "checkpoints": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationCheckpointDto"
      },
      "type": "array"
    },
    "cloudJob": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlJobActivityDto"
        }
      ],
      "nullable": true
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "destinationDetail": {
      "description": "Which worker or endpoint the destination resolved to",
      "nullable": true,
      "type": "string"
    },
    "error": {
      "description": "Operator detail about a failure; on a queued job, the failure it is being retried after",
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "description": "Stable code the client turns into a message",
      "nullable": true,
      "type": "string"
    },
    "estimate": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationEstimateDto"
        }
      ],
      "nullable": true
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "label": {
      "description": "What the person sees in Activity; empty when withheld",
      "type": "string"
    },
    "lastAdmissionRefusalReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RenderWorkerRefusalReason"
        }
      ],
      "description": "Why the last render worker that looked at this queued job did not take it; null when none has refused it since it was last claimed",
      "nullable": true
    },
    "lastAdmissionRefusedAt": {
      "description": "When that worker refused it; null with lastAdmissionRefusalReason",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "maxAttempts": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pausable": {
      "description": "Whether this kind of job can pause and carry on later; one-shot kinds cannot",
      "type": "boolean"
    },
    "pauseRequestedAt": {
      "description": "When the owner asked to pause; a running job keeps working until its next checkpoint",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "processedUnits": {
      "type": "string"
    },
    "progress": {
      "description": "Percent complete, from counted work",
      "format": "double",
      "type": "number"
    },
    "projectId": {
      "nullable": true,
      "type": "string"
    },
    "resultAssetId": {
      "description": "The asset a completed job published",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "retryAt": {
      "description": "When a job waiting for its automatic retry may run again",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "retryOfId": {
      "description": "The job this one retries",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revisionId": {
      "nullable": true,
      "type": "string"
    },
    "settings": {
      "additionalProperties": {},
      "description": "User-visible render settings",
      "type": "object"
    },
    "snapshot": {
      "additionalProperties": {},
      "type": "object"
    },
    "startedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "totalUnits": {
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "withheld": {
      "description": "The job is about a Locked item this session has not unlocked; its label and snapshot are withheld",
      "type": "boolean"
    }
  },
  "required": [
    "assetId",
    "attempt",
    "autoRetries",
    "bulk",
    "bulkItems",
    "bulkRetryPending",
    "cancelAcknowledgedAt",
    "cancelRequestedAt",
    "checkpoints",
    "createdAt",
    "destination",
    "destinationDetail",
    "error",
    "errorCode",
    "estimate",
    "finishedAt",
    "id",
    "kind",
    "label",
    "maxAttempts",
    "pausable",
    "pauseRequestedAt",
    "processedUnits",
    "progress",
    "projectId",
    "resultAssetId",
    "retryAt",
    "retryOfId",
    "revisionId",
    "settings",
    "snapshot",
    "startedAt",
    "status",
    "totalUnits",
    "updatedAt",
    "withheld"
  ],
  "type": "object"
}
```

## MediaOperationDto

Related models: [CloudMlJobActivityDto](models-09.md#cloudmljobactivitydto), [MediaOperationBulkSummaryDto](models-17.md#mediaoperationbulksummarydto), [MediaOperationDestination](models-17.md#mediaoperationdestination), [MediaOperationEstimateDto](models-17.md#mediaoperationestimatedto), [MediaOperationKind](models-17.md#mediaoperationkind), [MediaOperationStatus](models-17.md#mediaoperationstatus), [RenderWorkerRefusalReason](models-30.md#renderworkerrefusalreason).

```json
{
  "properties": {
    "assetId": {
      "description": "Source asset, when the workload has exactly one",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "attempt": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "autoRetries": {
      "description": "Automatic retries this job has used; every job gets one before a failure is reported",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "bulk": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationBulkSummaryDto"
        }
      ],
      "nullable": true
    },
    "cancelAcknowledgedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "cancelRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "cloudJob": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlJobActivityDto"
        }
      ],
      "nullable": true
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "destination": {
      "$ref": "#/components/schemas/MediaOperationDestination"
    },
    "destinationDetail": {
      "description": "Which worker or endpoint the destination resolved to",
      "nullable": true,
      "type": "string"
    },
    "error": {
      "description": "Operator detail about a failure; on a queued job, the failure it is being retried after",
      "nullable": true,
      "type": "string"
    },
    "errorCode": {
      "description": "Stable code the client turns into a message",
      "nullable": true,
      "type": "string"
    },
    "estimate": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaOperationEstimateDto"
        }
      ],
      "nullable": true
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaOperationKind"
    },
    "label": {
      "description": "What the person sees in Activity; empty when withheld",
      "type": "string"
    },
    "lastAdmissionRefusalReason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RenderWorkerRefusalReason"
        }
      ],
      "description": "Why the last render worker that looked at this queued job did not take it; null when none has refused it since it was last claimed",
      "nullable": true
    },
    "lastAdmissionRefusedAt": {
      "description": "When that worker refused it; null with lastAdmissionRefusalReason",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "maxAttempts": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "pausable": {
      "description": "Whether this kind of job can pause and carry on later; one-shot kinds cannot",
      "type": "boolean"
    },
    "pauseRequestedAt": {
      "description": "When the owner asked to pause; a running job keeps working until its next checkpoint",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "processedUnits": {
      "type": "string"
    },
    "progress": {
      "description": "Percent complete, from counted work",
      "format": "double",
      "type": "number"
    },
    "projectId": {
      "nullable": true,
      "type": "string"
    },
    "resultAssetId": {
      "description": "The asset a completed job published",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "retryAt": {
      "description": "When a job waiting for its automatic retry may run again",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "retryOfId": {
      "description": "The job this one retries",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "revisionId": {
      "nullable": true,
      "type": "string"
    },
    "settings": {
      "additionalProperties": {},
      "description": "User-visible render settings",
      "type": "object"
    },
    "startedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "totalUnits": {
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    },
    "withheld": {
      "description": "The job is about a Locked item this session has not unlocked; its label and snapshot are withheld",
      "type": "boolean"
    }
  },
  "required": [
    "assetId",
    "attempt",
    "autoRetries",
    "bulk",
    "cancelAcknowledgedAt",
    "cancelRequestedAt",
    "createdAt",
    "destination",
    "destinationDetail",
    "error",
    "errorCode",
    "estimate",
    "finishedAt",
    "id",
    "kind",
    "label",
    "maxAttempts",
    "pausable",
    "pauseRequestedAt",
    "processedUnits",
    "progress",
    "projectId",
    "resultAssetId",
    "retryAt",
    "retryOfId",
    "revisionId",
    "settings",
    "startedAt",
    "status",
    "totalUnits",
    "updatedAt",
    "withheld"
  ],
  "type": "object"
}
```

## MediaOperationDuplicateGroupDto

Related models: [DuplicateDecisionKind](models-11.md#duplicatedecisionkind).

```json
{
  "properties": {
    "decision": {
      "$ref": "#/components/schemas/DuplicateDecisionKind"
    },
    "decisionId": {
      "description": "For `undo-duplicates`: the recorded decision to reverse",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "keepAssetIds": {
      "description": "Photos to keep; the first is a stack cover. Other members of a `keepers` group are trashed",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "type": "array"
    },
    "memberIds": {
      "description": "Every photo of the group, as reviewed",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 50000,
      "minItems": 2,
      "type": "array"
    }
  },
  "required": [
    "decision",
    "duplicateId",
    "keepAssetIds",
    "memberIds"
  ],
  "type": "object"
}
```

## MediaOperationEstimateDto


```json
{
  "properties": {
    "cloudCost": {
      "additionalProperties": {},
      "description": "Configured cloud rate detail, when one applies",
      "nullable": true,
      "type": "object"
    },
    "seconds": {
      "description": "Measured estimate of remaining work",
      "format": "double",
      "type": "number"
    },
    "sizeBytes": {
      "description": "Estimated output size",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "cloudCost",
    "seconds",
    "sizeBytes"
  ],
  "type": "object"
}
```

## MediaOperationItemStatus


```json
{
  "description": "Per-item outcome of a bulk media operation",
  "enum": [
    "ok",
    "skipped",
    "failed"
  ],
  "type": "string"
}
```

## MediaOperationKind


```json
{
  "description": "Media operation kind",
  "enum": [
    "studio_export",
    "studio_preview",
    "studio_reverse_conform",
    "studio_transcription",
    "studio_preview_stream",
    "restoration",
    "restoration_preview",
    "quick_edit",
    "bulk",
    "studio_bundle_export",
    "studio_bundle_import",
    "enrichment_plan",
    "media_health",
    "icloud_sync",
    "takeout_import",
    "physical_deduplication",
    "library_scan",
    "preservation_export",
    "preservation_verify",
    "preservation_review",
    "preservation_restore",
    "studio_export_publish",
    "cloud_description_batch",
    "cloud_ml_job",
    "cloud_backup",
    "cloud_restore",
    "buddy_backup",
    "buddy_restore"
  ],
  "type": "string"
}
```

## MediaOperationListResponseDto

Related models: [MediaOperationDto](models-17.md#mediaoperationdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Matching jobs, before paging",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "total"
  ],
  "type": "object"
}
```

## MediaOperationLivePhotoPairDto


```json
{
  "properties": {
    "photoId": {
      "description": "Still image asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "videoId": {
      "description": "Motion video asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "photoId",
    "videoId"
  ],
  "type": "object"
}
```

## MediaOperationMediaHealthEntryDto


```json
{
  "properties": {
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidateId": {
      "description": "Reviewed candidate ID, for a relink or a recovery",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "findingId": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId",
    "findingId"
  ],
  "type": "object"
}
```

## MediaOperationStatisticsDto

Related models: [MediaOperationAggregateDto](models-17.md#mediaoperationaggregatedto).

```json
{
  "properties": {
    "active": {
      "description": "Jobs the server is still working on",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "buckets": {
      "items": {
        "$ref": "#/components/schemas/MediaOperationAggregateDto"
      },
      "type": "array"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "unreleasedRemote": {
      "description": "Remote jobs whose cleanup has not been acknowledged",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "buckets",
    "failed",
    "unreleasedRemote"
  ],
  "type": "object"
}
```

## MediaOperationStatus


```json
{
  "description": "Media operation status",
  "enum": [
    "queued",
    "preparing",
    "rendering",
    "validating",
    "completed",
    "cancelling",
    "cancelled",
    "failed",
    "paused"
  ],
  "type": "string"
}
```

## MemoriesResponse


```json
{
  "properties": {
    "duration": {
      "description": "Memory duration in seconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "enabled": {
      "description": "Whether memories are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether memories appear in web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "duration",
    "enabled",
    "sidebarWeb"
  ],
  "type": "object"
}
```

## MemoriesUpdate


```json
{
  "properties": {
    "duration": {
      "description": "Memory duration in seconds",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "enabled": {
      "description": "Whether memories are enabled",
      "type": "boolean"
    },
    "sidebarWeb": {
      "description": "Whether memories appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## MemoryCreateDto

Related models: [MemoryData](models-17.md#memorydata), [MemoryType](models-18.md#memorytype).

```json
{
  "properties": {
    "assetIds": {
      "description": "Asset IDs to associate with memory",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "data": {
      "$ref": "#/components/schemas/MemoryData"
    },
    "hideAt": {
      "description": "Date when memory should be hidden",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v2.6.0",
          "state": "Added"
        },
        {
          "version": "v2.6.0",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isSaved": {
      "description": "Is memory saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "seenAt": {
      "description": "Date when memory was seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Date when memory should be shown",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v2.6.0",
          "state": "Added"
        },
        {
          "version": "v2.6.0",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
    }
  },
  "required": [
    "data",
    "memoryAt",
    "type"
  ],
  "type": "object"
}
```

## MemoryData

Related models: [BirthdayMemoryDto](models-07.md#birthdaymemorydto), [EventStoryDto](models-11.md#eventstorydto), [OnThisDayDto](models-19.md#onthisdaydto), [PersonRecapDto](models-19.md#personrecapdto), [PetStoryDto](models-20.md#petstorydto), [YearInReviewDto](models-40.md#yearinreviewdto).

```json
{
  "anyOf": [
    {
      "$ref": "#/components/schemas/EventStoryDto"
    },
    {
      "$ref": "#/components/schemas/YearInReviewDto"
    },
    {
      "$ref": "#/components/schemas/PetStoryDto"
    },
    {
      "$ref": "#/components/schemas/BirthdayMemoryDto"
    },
    {
      "$ref": "#/components/schemas/PersonRecapDto"
    },
    {
      "$ref": "#/components/schemas/OnThisDayDto"
    }
  ],
  "description": "Memory data"
}
```

## MemoryExportCreateDto

Related models: [MemoryExportFormat](models-17.md#memoryexportformat), [MemoryHighlightOptionsDto](models-17.md#memoryhighlightoptionsdto).

```json
{
  "properties": {
    "format": {
      "$ref": "#/components/schemas/MemoryExportFormat",
      "description": "Export format, defaults to an archive of the originals"
    },
    "highlight": {
      "$ref": "#/components/schemas/MemoryHighlightOptionsDto",
      "description": "Options for a `highlight` export",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    }
  },
  "type": "object"
}
```

## MemoryExportFormat


```json
{
  "description": "Memory export format",
  "enum": [
    "archive",
    "highlight"
  ],
  "type": "string"
}
```

## MemoryExportResponseDto

Related models: [MemoryExportFormat](models-17.md#memoryexportformat), [MemoryExportStatus](models-17.md#memoryexportstatus), [MemoryHighlightResponseDto](models-17.md#memoryhighlightresponsedto).

```json
{
  "properties": {
    "assetCount": {
      "description": "Number of assets in the export",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "description": "When the export was requested",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "error": {
      "description": "Failure reason, when the export failed",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "When the archive is deleted",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "finishedAt": {
      "description": "When the export reached a terminal state",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "format": {
      "$ref": "#/components/schemas/MemoryExportFormat"
    },
    "highlight": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MemoryHighlightResponseDto"
        }
      ],
      "description": "The highlight video settings and render state, for a `highlight` export",
      "nullable": true,
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "id": {
      "description": "Export ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isDownloadable": {
      "description": "Whether the archive can be downloaded right now",
      "type": "boolean"
    },
    "memoryId": {
      "description": "Memory the export was requested for",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "processedAssets": {
      "description": "Number of assets written so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sizeInBytes": {
      "description": "Size of the finished archive",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "startedAt": {
      "description": "When the worker picked the export up",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MemoryExportStatus"
    },
    "title": {
      "description": "The memory's title when the export was requested",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "assetCount",
    "createdAt",
    "error",
    "expiresAt",
    "finishedAt",
    "format",
    "highlight",
    "id",
    "isDownloadable",
    "memoryId",
    "ownerId",
    "processedAssets",
    "sizeInBytes",
    "startedAt",
    "status",
    "title",
    "updatedAt"
  ],
  "type": "object"
}
```

## MemoryExportStatus


```json
{
  "description": "Memory export status",
  "enum": [
    "pending",
    "running",
    "ready",
    "failed",
    "cancelling",
    "cancelled"
  ],
  "type": "string"
}
```

## MemoryHighlightAudio


```json
{
  "description": "Sound of a memory highlight video",
  "enum": [
    "original",
    "silent"
  ],
  "type": "string"
}
```

## MemoryHighlightDestination


```json
{
  "description": "Where the highlight renders: this server or another computer on your home network",
  "enum": [
    "local",
    "lan"
  ],
  "type": "string"
}
```

## MemoryHighlightOptionsDto

Related models: [MemoryHighlightAudio](models-17.md#memoryhighlightaudio), [MemoryHighlightDestination](models-17.md#memoryhighlightdestination), [StudioExportResolution](models-34.md#studioexportresolution).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/MemoryHighlightAudio",
      "description": "Sound policy, each video's own sound by default"
    },
    "destination": {
      "$ref": "#/components/schemas/MemoryHighlightDestination",
      "description": "Where it renders, this server by default"
    },
    "lengthSeconds": {
      "description": "Target length in seconds, 60 by default",
      "maximum": 300,
      "minimum": 15,
      "type": "integer"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution",
      "description": "Output resolution, 2160p by default"
    }
  },
  "type": "object"
}
```

## MemoryHighlightResponseDto

Related models: [MemoryHighlightAudio](models-17.md#memoryhighlightaudio), [MemoryHighlightDestination](models-17.md#memoryhighlightdestination), [StudioExportResolution](models-34.md#studioexportresolution).

```json
{
  "properties": {
    "audio": {
      "$ref": "#/components/schemas/MemoryHighlightAudio"
    },
    "destination": {
      "$ref": "#/components/schemas/MemoryHighlightDestination"
    },
    "lengthSeconds": {
      "description": "Target length in seconds",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progress": {
      "description": "Render progress, 0 to 100",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "resolution": {
      "$ref": "#/components/schemas/StudioExportResolution"
    },
    "savedAssetId": {
      "description": "The library asset the highlight was saved as, once saved",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "audio",
    "destination",
    "lengthSeconds",
    "progress",
    "resolution",
    "savedAssetId"
  ],
  "type": "object"
}
```

## MemoryResponseDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [MemoryData](models-17.md#memorydata), [MemoryType](models-18.md#memorytype).

```json
{
  "properties": {
    "assets": {
      "items": {
        "$ref": "#/components/schemas/AssetResponseDto"
      },
      "type": "array"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "data": {
      "$ref": "#/components/schemas/MemoryData"
    },
    "deletedAt": {
      "description": "Deletion date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "hideAt": {
      "description": "Date when memory should be hidden",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Memory ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isHidden": {
      "description": "Hidden by the owner; shown only in the hidden memories list",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "isSaved": {
      "description": "Is memory saved",
      "type": "boolean"
    },
    "memoryAt": {
      "description": "Memory date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner user ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "seenAt": {
      "description": "Date when memory was seen",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "showAt": {
      "description": "Date when memory should be shown",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "The owner's own title, when they set one",
      "nullable": true,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ]
    },
    "type": {
      "$ref": "#/components/schemas/MemoryType"
    },
    "updatedAt": {
      "description": "Last update date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "assets",
    "createdAt",
    "data",
    "id",
    "isHidden",
    "isSaved",
    "memoryAt",
    "ownerId",
    "title",
    "type",
    "updatedAt"
  ],
  "type": "object"
}
```

## MemorySearchOrder


```json
{
  "description": "Sort order",
  "enum": [
    "asc",
    "desc",
    "random"
  ],
  "type": "string"
}
```

## MemoryShowLessDto

Related models: [MemoryShowLessKind](models-17.md#memoryshowlesskind).

```json
{
  "properties": {
    "kind": {
      "$ref": "#/components/schemas/MemoryShowLessKind"
    },
    "value": {
      "description": "A person or pet id, a date as 'MM-dd', or a memory type",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "kind",
    "value"
  ],
  "type": "object"
}
```

## MemoryShowLessKind


```json
{
  "description": "What a memories show-less rule names",
  "enum": [
    "person",
    "pet",
    "date",
    "type"
  ],
  "type": "string"
}
```
