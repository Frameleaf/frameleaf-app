# Server API models 16

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## MediaHealthBulkResponseDto

Related models: [MediaHealthBulkResultDto](models-16.md#mediahealthbulkresultdto).

```json
{
  "properties": {
    "operationId": {
      "description": "The durable job applying the accepted findings, in Activity; null when none was accepted",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "results": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthBulkResultDto"
      },
      "type": "array"
    }
  },
  "required": [
    "results"
  ],
  "type": "object"
}
```

## MediaHealthBulkResultDto

Related models: [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "error": {
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    },
    "success": {
      "type": "boolean"
    }
  },
  "required": [
    "id",
    "success"
  ],
  "type": "object"
}
```

## MediaHealthCandidateChoiceDto


```json
{
  "properties": {
    "candidateId": {
      "description": "Candidate ID",
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
    "candidateId",
    "findingId"
  ],
  "type": "object"
}
```

## MediaHealthCandidateDto

Related models: [MediaHealthChecksumDto](models-16.md#mediahealthchecksumdto), [MediaHealthRootKind](models-16.md#mediahealthrootkind), [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "candidatePath": {
      "description": "Candidate file path",
      "type": "string"
    },
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "checksumMatch": {
      "description": "The candidate has exactly the checksum recorded for the original",
      "type": "boolean"
    },
    "checksums": {
      "description": "The checksums the candidate matched, as measured",
      "items": {
        "$ref": "#/components/schemas/MediaHealthChecksumDto"
      },
      "type": "array"
    },
    "chosen": {
      "description": "The reviewer chose this candidate for the finding",
      "type": "boolean"
    },
    "decodeValid": {
      "description": "The candidate decoded successfully; null when not checked",
      "nullable": true,
      "type": "boolean"
    },
    "evidence": {
      "additionalProperties": {},
      "type": "object"
    },
    "healthId": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Candidate ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "resolution": {
      "additionalProperties": {},
      "type": "object"
    },
    "rootId": {
      "description": "Search location the candidate was found in",
      "nullable": true,
      "type": "string"
    },
    "rootKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRootKind"
        }
      ],
      "nullable": true
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    },
    "visualMatchScore": {
      "description": "Visual match score from 0 to 1",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "candidatePath",
    "checkedAt",
    "checksumMatch",
    "checksums",
    "chosen",
    "decodeValid",
    "evidence",
    "healthId",
    "id",
    "resolution",
    "rootId",
    "rootKind",
    "status",
    "visualMatchScore"
  ],
  "type": "object"
}
```

## MediaHealthCareSettingsDto


```json
{
  "properties": {
    "checksumScan": {
      "description": "Health scans verify original checksums",
      "type": "boolean"
    },
    "duplicateReview": {
      "description": "Near-duplicates are grouped for review",
      "type": "boolean"
    },
    "healthScan": {
      "description": "Incremental health scans run on a schedule",
      "type": "boolean"
    },
    "integrityAudit": {
      "description": "Database and file reference audits run on their schedules",
      "type": "boolean"
    },
    "rawRecovery": {
      "description": "Searches for originals include RAW originals",
      "type": "boolean"
    }
  },
  "required": [
    "checksumScan",
    "duplicateReview",
    "healthScan",
    "integrityAudit",
    "rawRecovery"
  ],
  "type": "object"
}
```

## MediaHealthCategory


```json
{
  "description": "Media health category",
  "enum": [
    "missing",
    "corrupt"
  ],
  "type": "string"
}
```

## MediaHealthChecksumAlgorithm


```json
{
  "description": "Checksum algorithm",
  "enum": [
    "sha1",
    "sha256"
  ],
  "type": "string"
}
```

## MediaHealthChecksumDto

Related models: [MediaHealthChecksumAlgorithm](models-16.md#mediahealthchecksumalgorithm).

```json
{
  "properties": {
    "algorithm": {
      "$ref": "#/components/schemas/MediaHealthChecksumAlgorithm"
    },
    "value": {
      "description": "Checksum as lowercase hex",
      "type": "string"
    }
  },
  "required": [
    "algorithm",
    "value"
  ],
  "type": "object"
}
```

## MediaHealthChooseCandidatesDto

Related models: [MediaHealthCandidateChoiceDto](models-16.md#mediahealthcandidatechoicedto).

```json
{
  "properties": {
    "choices": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateChoiceDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "choices"
  ],
  "type": "object"
}
```

## MediaHealthDeleteCorruptDto


```json
{
  "properties": {
    "confirmText": {
      "description": "Typed confirmation text",
      "type": "string"
    },
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "confirmText",
    "ids"
  ],
  "type": "object"
}
```

## MediaHealthItemDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [MediaHealthCandidateDto](models-16.md#mediahealthcandidatedto), [MediaHealthCategory](models-16.md#mediahealthcategory), [MediaHealthChecksumDto](models-16.md#mediahealthchecksumdto), [MediaHealthProvenanceDto](models-16.md#mediahealthprovenancedto), [MediaHealthSeverity](models-16.md#mediahealthseverity), [MediaHealthStatus](models-16.md#mediahealthstatus).

```json
{
  "properties": {
    "asset": {
      "$ref": "#/components/schemas/AssetResponseDto"
    },
    "assetId": {
      "description": "Asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "candidates": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateDto"
      },
      "type": "array"
    },
    "category": {
      "$ref": "#/components/schemas/MediaHealthCategory"
    },
    "checkedAt": {
      "format": "date-time",
      "type": "string"
    },
    "dismissedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "evidence": {
      "additionalProperties": {},
      "type": "object"
    },
    "expectedChecksums": {
      "description": "The checksums recorded for the original, which a copy must match exactly",
      "items": {
        "$ref": "#/components/schemas/MediaHealthChecksumDto"
      },
      "type": "array"
    },
    "id": {
      "description": "Media health finding ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "originalFileName": {
      "description": "Original media filename",
      "type": "string"
    },
    "originalPath": {
      "description": "Original media path",
      "type": "string"
    },
    "provenance": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthProvenanceDto"
        }
      ],
      "nullable": true
    },
    "resolution": {
      "additionalProperties": {},
      "type": "object"
    },
    "resolvedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "severity": {
      "$ref": "#/components/schemas/MediaHealthSeverity"
    },
    "status": {
      "$ref": "#/components/schemas/MediaHealthStatus"
    }
  },
  "required": [
    "asset",
    "assetId",
    "candidates",
    "category",
    "checkedAt",
    "dismissedAt",
    "evidence",
    "expectedChecksums",
    "id",
    "originalFileName",
    "originalPath",
    "provenance",
    "resolution",
    "resolvedAt",
    "severity",
    "status"
  ],
  "type": "object"
}
```

## MediaHealthListResponseDto

Related models: [MediaHealthBucketDto](models-15.md#mediahealthbucketdto), [MediaHealthRunResponseDto](models-16.md#mediahealthrunresponsedto).

```json
{
  "properties": {
    "buckets": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthBucketDto"
      },
      "type": "array"
    },
    "run": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "buckets",
    "run",
    "total"
  ],
  "type": "object"
}
```

## MediaHealthLocateDto


```json
{
  "properties": {
    "ids": {
      "description": "Media health finding IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "rootIds": {
      "description": "Search locations; library storage and external libraries when omitted",
      "items": {
        "maxLength": 200,
        "minLength": 1,
        "type": "string"
      },
      "maxItems": 50,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## MediaHealthOperationDto

Related models: [MediaHealthOperationMode](models-16.md#mediahealthoperationmode), [MediaOperationStatus](models-16.md#mediaoperationstatus).

```json
{
  "properties": {
    "autoRetries": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "cancelRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "createdAt": {
      "format": "date-time",
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
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
    "mode": {
      "$ref": "#/components/schemas/MediaHealthOperationMode"
    },
    "pauseRequestedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "processedUnits": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progress": {
      "format": "double",
      "type": "number"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "totalUnits": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "updatedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "autoRetries",
    "cancelRequestedAt",
    "createdAt",
    "error",
    "finishedAt",
    "id",
    "mode",
    "pauseRequestedAt",
    "processedUnits",
    "progress",
    "status",
    "totalUnits",
    "updatedAt"
  ],
  "type": "object"
}
```

## MediaHealthOperationMode


```json
{
  "description": "A library scan or a search for originals",
  "enum": [
    "scan",
    "locate"
  ],
  "type": "string"
}
```

## MediaHealthProvenanceAction


```json
{
  "description": "What was done",
  "enum": [
    "relinked",
    "recovered"
  ],
  "type": "string"
}
```

## MediaHealthProvenanceDto

Related models: [MediaHealthProvenanceAction](models-16.md#mediahealthprovenanceaction), [MediaHealthRootKind](models-16.md#mediahealthrootkind).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/MediaHealthProvenanceAction"
    },
    "at": {
      "description": "When it was done",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "previousPath": {
      "description": "The path the original had before",
      "nullable": true,
      "type": "string"
    },
    "rootId": {
      "description": "Search location the copy came from",
      "nullable": true,
      "type": "string"
    },
    "rootKind": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRootKind"
        }
      ],
      "nullable": true
    },
    "rootLabel": {
      "description": "Name of the search location",
      "nullable": true,
      "type": "string"
    },
    "sourcePath": {
      "description": "The verified copy that was used",
      "nullable": true,
      "type": "string"
    },
    "userId": {
      "description": "The account that did it",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "action",
    "at",
    "previousPath",
    "rootId",
    "rootKind",
    "rootLabel",
    "sourcePath",
    "userId"
  ],
  "type": "object"
}
```

## MediaHealthQueuesDto


```json
{
  "properties": {
    "damagedConfirmed": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "damagedSuspected": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "duplicates": {
      "description": "Duplicate groups waiting for review",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "enrichmentPending": {
      "description": "Items whose metadata has not been read yet",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "importReview": {
      "description": "Imported items that need review; null when unavailable",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "missing": {
      "description": "Missing originals that still need a decision",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "missingVerified": {
      "description": "Missing originals with a verified exact copy",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "unsupportedRaw": {
      "description": "Kept apart from damage: the decoder cannot read the format",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "damagedConfirmed",
    "damagedSuspected",
    "duplicates",
    "enrichmentPending",
    "importReview",
    "missing",
    "missingVerified",
    "unsupportedRaw"
  ],
  "type": "object"
}
```

## MediaHealthRecoverDto

Related models: [MediaHealthCandidateChoiceDto](models-16.md#mediahealthcandidatechoicedto).

```json
{
  "properties": {
    "choices": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthCandidateChoiceDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "confirmed": {
      "description": "Must be true: the reviewer checked the checksum and decode evidence and keeps the damaged source",
      "type": "boolean"
    }
  },
  "required": [
    "choices",
    "confirmed"
  ],
  "type": "object"
}
```

## MediaHealthRootDto

Related models: [MediaHealthRootKind](models-16.md#mediahealthrootkind).

```json
{
  "properties": {
    "id": {
      "description": "Search location ID",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MediaHealthRootKind"
    },
    "label": {
      "type": "string"
    },
    "paths": {
      "description": "Folders searched, for review",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "id",
    "kind",
    "label",
    "paths"
  ],
  "type": "object"
}
```

## MediaHealthRootKind


```json
{
  "description": "Kind of search location",
  "enum": [
    "managed",
    "library",
    "recovery"
  ],
  "type": "string"
}
```

## MediaHealthRootsResponseDto

Related models: [MediaHealthRootDto](models-16.md#mediahealthrootdto).

```json
{
  "properties": {
    "roots": {
      "items": {
        "$ref": "#/components/schemas/MediaHealthRootDto"
      },
      "type": "array"
    }
  },
  "required": [
    "roots"
  ],
  "type": "object"
}
```

## MediaHealthRunResponseDto

Related models: [MediaHealthCategory](models-16.md#mediahealthcategory).

```json
{
  "properties": {
    "category": {
      "$ref": "#/components/schemas/MediaHealthCategory"
    },
    "checkedAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "foundAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "id": {
      "description": "Media health run ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "startedAt": {
      "format": "date-time",
      "type": "string"
    },
    "status": {
      "description": "Run status",
      "type": "string"
    },
    "totalAssets": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "category",
    "checkedAssets",
    "error",
    "finishedAt",
    "foundAssets",
    "id",
    "startedAt",
    "status",
    "totalAssets"
  ],
  "type": "object"
}
```

## MediaHealthRunsDto

Related models: [MediaHealthRunResponseDto](models-16.md#mediahealthrunresponsedto).

```json
{
  "properties": {
    "corrupt": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    },
    "missing": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MediaHealthRunResponseDto"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "corrupt",
    "missing"
  ],
  "type": "object"
}
```

## MediaHealthScanResponseDto


```json
{
  "properties": {
    "operationId": {
      "description": "The durable job doing the work, in Activity",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "runId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "runId"
  ],
  "type": "object"
}
```

## MediaHealthSeverity


```json
{
  "description": "Media health severity",
  "enum": [
    "info",
    "warning",
    "critical"
  ],
  "type": "string"
}
```

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

Related models: [MediaHealthActivityDto](models-15.md#mediahealthactivitydto), [MediaHealthCareSettingsDto](models-16.md#mediahealthcaresettingsdto), [MediaHealthOperationDto](models-16.md#mediahealthoperationdto), [MediaHealthQueuesDto](models-16.md#mediahealthqueuesdto), [MediaHealthRunsDto](models-16.md#mediahealthrunsdto).

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

Related models: [MediaOperationDestination](models-16.md#mediaoperationdestination), [MediaOperationKind](models-16.md#mediaoperationkind), [MediaOperationStatus](models-16.md#mediaoperationstatus).

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

Related models: [MediaOperationBulkAction](models-16.md#mediaoperationbulkaction), [MediaOperationBulkPayloadDto](models-16.md#mediaoperationbulkpayloaddto).

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

Related models: [MediaOperationItemStatus](models-16.md#mediaoperationitemstatus).

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

Related models: [MediaOperationDuplicateGroupDto](models-16.md#mediaoperationduplicategroupdto), [MediaOperationLivePhotoPairDto](models-16.md#mediaoperationlivephotopairdto), [MediaOperationMediaHealthEntryDto](models-16.md#mediaoperationmediahealthentrydto).

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

Related models: [MediaOperationBulkAction](models-16.md#mediaoperationbulkaction).

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

Related models: [MediaOperationCheckpointState](models-16.md#mediaoperationcheckpointstate).

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

Related models: [CloudMlJobActivityDto](models-09.md#cloudmljobactivitydto), [MediaOperationBulkItemDto](models-16.md#mediaoperationbulkitemdto), [MediaOperationBulkSummaryDto](models-16.md#mediaoperationbulksummarydto), [MediaOperationCheckpointDto](models-16.md#mediaoperationcheckpointdto), [MediaOperationDestination](models-16.md#mediaoperationdestination), [MediaOperationEstimateDto](models-16.md#mediaoperationestimatedto), [MediaOperationKind](models-16.md#mediaoperationkind), [MediaOperationStatus](models-16.md#mediaoperationstatus).

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

Related models: [CloudMlJobActivityDto](models-09.md#cloudmljobactivitydto), [MediaOperationBulkSummaryDto](models-16.md#mediaoperationbulksummarydto), [MediaOperationDestination](models-16.md#mediaoperationdestination), [MediaOperationEstimateDto](models-16.md#mediaoperationestimatedto), [MediaOperationKind](models-16.md#mediaoperationkind), [MediaOperationStatus](models-16.md#mediaoperationstatus).

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

Related models: [MediaOperationDto](models-16.md#mediaoperationdto).

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

Related models: [MediaOperationAggregateDto](models-16.md#mediaoperationaggregatedto).

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
