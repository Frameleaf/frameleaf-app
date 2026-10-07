# Server API models 25

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## PhotographyWorkflowListDto


```json
{
  "properties": {
    "galleries": {
      "items": {
        "properties": {
          "expiresAt": {
            "format": "date-time",
            "nullable": true,
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
            "type": "string"
          },
          "mode": {
            "type": "string"
          },
          "pendingEdits": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "published": {
            "type": "boolean"
          },
          "readyCount": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "revision": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "selectionDeadline": {
            "format": "date-time",
            "nullable": true,
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
            "type": "string"
          },
          "shootId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "submittedRounds": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "title": {
            "type": "string"
          },
          "unpaidOrders": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          }
        },
        "required": [
          "shootId",
          "revision",
          "title",
          "mode",
          "selectionDeadline",
          "expiresAt",
          "published",
          "submittedRounds",
          "unpaidOrders",
          "readyCount",
          "pendingEdits"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "galleries"
  ],
  "type": "object"
}
```

## PhotographyWorkflowMutationDto


```json
{
  "additionalProperties": false,
  "properties": {
    "expectedRevision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "expectedRevision"
  ],
  "type": "object"
}
```

## PhotographyWorkspaceDto


```json
{
  "properties": {
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "shoots": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "albumId": {
            "description": "Owned source album; null retains an unavailable existing shoot",
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "assetCount": {
            "maximum": 9007199254740991,
            "minimum": 0,
            "nullable": true,
            "type": "integer"
          },
          "client": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          },
          "coverAssetId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "date": {
            "format": "date",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "name": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          },
          "stage": {
            "enum": [
              "Imported",
              "Selected",
              "Edited",
              "Proofing",
              "Delivered"
            ],
            "type": "string"
          },
          "type": {
            "enum": [
              "Family portrait",
              "Wedding",
              "Portrait",
              "Editorial",
              "Commercial",
              "Event",
              "Personal"
            ],
            "type": "string"
          },
          "unavailable": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "albumId",
          "name",
          "client",
          "type",
          "date",
          "stage",
          "unavailable",
          "coverAssetId",
          "assetCount"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "revision",
    "shoots"
  ],
  "type": "object"
}
```

## PhotographyWorkspaceSaveDto


```json
{
  "additionalProperties": false,
  "properties": {
    "expectedRevision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "shoots": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "albumId": {
            "description": "Owned source album; null retains an unavailable existing shoot",
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "client": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          },
          "date": {
            "format": "date",
            "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "name": {
            "maxLength": 200,
            "minLength": 1,
            "type": "string"
          },
          "stage": {
            "enum": [
              "Imported",
              "Selected",
              "Edited",
              "Proofing",
              "Delivered"
            ],
            "type": "string"
          },
          "type": {
            "enum": [
              "Family portrait",
              "Wedding",
              "Portrait",
              "Editorial",
              "Commercial",
              "Event",
              "Personal"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "albumId",
          "name",
          "client",
          "type",
          "date",
          "stage"
        ],
        "type": "object"
      },
      "maxItems": 200,
      "type": "array"
    }
  },
  "required": [
    "expectedRevision",
    "shoots"
  ],
  "type": "object"
}
```

## PhotographyZipDto


```json
{
  "additionalProperties": false,
  "properties": {
    "captureIds": {
      "default": [],
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "type": "array"
    },
    "outputs": {
      "items": {
        "additionalProperties": false,
        "properties": {
          "captureId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "outputId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          }
        },
        "required": [
          "captureId",
          "outputId"
        ],
        "type": "object"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## PhotographyZipResponseDto


```json
{
  "properties": {
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "status": {
      "enum": [
        "ready"
      ],
      "type": "string"
    },
    "url": {
      "type": "string"
    }
  },
  "required": [
    "id",
    "status",
    "url"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationApplyDto

Related models: [MediaOperationStatus](models-15.md#mediaoperationstatus).

```json
{
  "properties": {
    "alreadyApplied": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "applied": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "estimatedBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "fingerprint": {
      "type": "string"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "mine": {
      "description": "Whether the requesting administrator applied it",
      "type": "boolean"
    },
    "operationId": {
      "description": "The media operation applying the plan",
      "type": "string"
    },
    "pauseRequested": {
      "type": "boolean"
    },
    "planId": {
      "type": "string"
    },
    "processed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "progress": {
      "format": "double",
      "type": "number"
    },
    "reclaimedBytes": {
      "description": "Bytes actually removed from disk so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "requestedById": {
      "description": "Administrator who applied the plan; the job is theirs to pause or cancel",
      "type": "string"
    },
    "requestedByName": {
      "type": "string"
    },
    "retrying": {
      "description": "Waiting for its one automatic retry",
      "type": "boolean"
    },
    "skipped": {
      "description": "Copies left alone because their evidence changed",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "total": {
      "description": "Copies in the reviewed plan",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "alreadyApplied",
    "applied",
    "createdAt",
    "error",
    "estimatedBytes",
    "failed",
    "fingerprint",
    "finishedAt",
    "mine",
    "operationId",
    "pauseRequested",
    "planId",
    "processed",
    "progress",
    "reclaimedBytes",
    "requestedById",
    "requestedByName",
    "retrying",
    "skipped",
    "status",
    "total"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationApplyRequestDto


```json
{
  "properties": {
    "confirmation": {
      "description": "`APPLY <planId>`, typed by the administrator",
      "maxLength": 90,
      "type": "string"
    },
    "excludedRetainedAssetIds": {
      "description": "Retained originals whose group the administrator decided to leave as they are",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 500,
      "type": "array"
    },
    "fingerprint": {
      "description": "The fingerprint of the plan on screen, from the preview",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    },
    "reviewToken": {
      "description": "From the review of this plan",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    }
  },
  "required": [
    "confirmation",
    "fingerprint",
    "reviewToken"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationCopyDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [PhysicalDeduplicationDecision](models-25.md#physicaldeduplicationdecision), [PhysicalDeduplicationSkipReason](models-25.md#physicaldeduplicationskipreason).

```json
{
  "properties": {
    "assetId": {
      "description": "Duplicate asset owned by a non-retained account",
      "type": "string"
    },
    "canView": {
      "description": "Whether the requesting administrator may view this asset and its thumbnail",
      "type": "boolean"
    },
    "checksum": {
      "description": "Hex-encoded SHA-1 checksum of the original file",
      "type": "string"
    },
    "checksumMatch": {
      "description": "Whether checksum and byte size match a retained original",
      "type": "boolean"
    },
    "decision": {
      "$ref": "#/components/schemas/PhysicalDeduplicationDecision"
    },
    "duration": {
      "description": "Video length in milliseconds, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "height": {
      "description": "Height in pixels, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "originalFileName": {
      "type": "string"
    },
    "originalPath": {
      "description": "Path of the duplicate copy on disk",
      "type": "string"
    },
    "ownerId": {
      "type": "string"
    },
    "ownerName": {
      "description": "Display name of the copy owner",
      "type": "string"
    },
    "reason": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PhysicalDeduplicationSkipReason"
        }
      ],
      "description": "Present when the decision is skip",
      "nullable": true
    },
    "retainedAssetId": {
      "description": "Retained original this copy matches, if any",
      "nullable": true,
      "type": "string"
    },
    "sizeInBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "width": {
      "description": "Width in pixels, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "canView",
    "checksum",
    "checksumMatch",
    "decision",
    "duration",
    "height",
    "originalFileName",
    "originalPath",
    "ownerId",
    "ownerName",
    "reason",
    "retainedAssetId",
    "sizeInBytes",
    "type",
    "width"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationCopyFile


```json
{
  "description": "The copy's own former file: removed from disk, still the reviewed bytes, or different bytes now",
  "enum": [
    "removed",
    "present",
    "changed"
  ],
  "type": "string"
}
```

## PhysicalDeduplicationDecision


```json
{
  "description": "Physical deduplication plan decision for a duplicate copy",
  "enum": [
    "share",
    "skip"
  ],
  "type": "string"
}
```

## PhysicalDeduplicationPlanDto

Related models: [PhysicalDeduplicationCopyDto](models-25.md#physicaldeduplicationcopydto), [PhysicalDeduplicationPlanMode](models-25.md#physicaldeduplicationplanmode), [PhysicalDeduplicationRetainedDto](models-25.md#physicaldeduplicationretaineddto).

```json
{
  "properties": {
    "applicableCopies": {
      "description": "Copies listed with a share decision: the most this plan can apply. Copies past the list limit wait for a later plan",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "copies": {
      "items": {
        "$ref": "#/components/schemas/PhysicalDeduplicationCopyDto"
      },
      "type": "array"
    },
    "copiesTruncated": {
      "description": "True when more copies were reviewed than the stored preview keeps; totals still cover all of them",
      "type": "boolean"
    },
    "deletedBytes": {
      "description": "Measured: bytes actually removed from disk by applying this plan so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "eligibleAssets": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "fingerprint": {
      "description": "Digest over the plan evidence; changes with every preview (FL-73)",
      "type": "string"
    },
    "hiddenCopies": {
      "description": "Copies left out of the rows because they are Locked media of another account; counted, never named",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "linkedAssets": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "logicalBytes": {
      "description": "Logical asset bytes (FL-73): the sizes of every asset that references a shared original once this plan is applied, counted once per asset",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "masterUserId": {
      "description": "Account whose originals are retained by this plan",
      "type": "string"
    },
    "masterUserName": {
      "description": "Display name of the retained account",
      "type": "string"
    },
    "mode": {
      "$ref": "#/components/schemas/PhysicalDeduplicationPlanMode"
    },
    "planId": {
      "description": "Short name of this plan, typed to confirm applying it (FL-73)",
      "type": "string"
    },
    "ranAt": {
      "description": "When the plan was produced",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "reclaimableBytes": {
      "description": "Estimate: bytes of the copies to share, with their generated files, that applying would free",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retained": {
      "items": {
        "$ref": "#/components/schemas/PhysicalDeduplicationRetainedDto"
      },
      "type": "array"
    },
    "scopeUserId": {
      "description": "When set, only copies owned by this account were reviewed; null means every account",
      "nullable": true,
      "type": "string"
    },
    "scopeUserName": {
      "nullable": true,
      "type": "string"
    },
    "sharedOriginalBytes": {
      "description": "Physical shared-original bytes (FL-73): the retained originals those assets share, counted once per file",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "skippedExternal": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "skippedMissingMaster": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "applicableCopies",
    "copies",
    "copiesTruncated",
    "deletedBytes",
    "eligibleAssets",
    "fingerprint",
    "hiddenCopies",
    "linkedAssets",
    "logicalBytes",
    "masterUserId",
    "masterUserName",
    "mode",
    "planId",
    "ranAt",
    "reclaimableBytes",
    "retained",
    "scopeUserId",
    "scopeUserName",
    "sharedOriginalBytes",
    "skippedExternal",
    "skippedMissingMaster"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationPlanMode


```json
{
  "description": "Whether the physical deduplication plan was a preview or an applied run",
  "enum": [
    "dry-run",
    "apply"
  ],
  "type": "string"
}
```

## PhysicalDeduplicationPreviewRequestDto


```json
{
  "properties": {
    "masterUserId": {
      "description": "Account to retain originals in for this preview; defaults to the saved master account",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "scopeUserId": {
      "description": "Limit the review to copies owned by this account",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PhysicalDeduplicationPreviewResponseDto

Related models: [PhysicalDeduplicationApplyDto](models-25.md#physicaldeduplicationapplydto), [PhysicalDeduplicationPlanDto](models-25.md#physicaldeduplicationplandto).

```json
{
  "properties": {
    "applies": {
      "description": "Recently applied plans, newest first (FL-73)",
      "items": {
        "$ref": "#/components/schemas/PhysicalDeduplicationApplyDto"
      },
      "type": "array"
    },
    "applying": {
      "description": "Whether a reviewed plan is being applied (FL-73)",
      "type": "boolean"
    },
    "enabled": {
      "description": "The saved `physicalDeduplication.enabled`",
      "type": "boolean"
    },
    "plan": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PhysicalDeduplicationPlanDto"
        }
      ],
      "description": "The latest plan, or null when none has run",
      "nullable": true
    },
    "running": {
      "description": "Whether a deduplication preview is queued or active",
      "type": "boolean"
    },
    "savedMasterUserId": {
      "description": "The saved `physicalDeduplication.masterUserId`",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "applies",
    "applying",
    "enabled",
    "plan",
    "running",
    "savedMasterUserId"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationRestoreRequestDto


```json
{
  "properties": {
    "assetId": {
      "description": "A copy of the applied plan whose own file is still on disk",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "assetId"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationRetainedDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum).

```json
{
  "properties": {
    "assetId": {
      "description": "Asset that keeps the original file",
      "type": "string"
    },
    "canView": {
      "description": "Whether the requesting administrator may view this asset and its thumbnail",
      "type": "boolean"
    },
    "checksum": {
      "description": "Hex-encoded SHA-1 checksum of the original file",
      "type": "string"
    },
    "duration": {
      "description": "Video length in milliseconds, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "fileAvailable": {
      "description": "Whether the retained original file is on disk now, checked on every read (FL-71 UT-24)",
      "type": "boolean"
    },
    "height": {
      "description": "Height in pixels, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "hiddenCopies": {
      "description": "Copies this retained original would share that are Locked media of another account; counted, never named (FL-73)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "originalFileName": {
      "type": "string"
    },
    "originalPath": {
      "description": "Path of the retained original file",
      "type": "string"
    },
    "ownerId": {
      "description": "Owner of the retained asset (the retained account)",
      "type": "string"
    },
    "ownerName": {
      "description": "Display name of the retained account",
      "type": "string"
    },
    "referencesAfter": {
      "description": "Assets that would reference this original after the plan is applied",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "referencesBefore": {
      "description": "Assets that reference this original before the plan is applied (including the retained asset)",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "sizeInBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    },
    "width": {
      "description": "Width in pixels, when known",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "assetId",
    "canView",
    "checksum",
    "duration",
    "fileAvailable",
    "height",
    "hiddenCopies",
    "originalFileName",
    "originalPath",
    "ownerId",
    "ownerName",
    "referencesAfter",
    "referencesBefore",
    "sizeInBytes",
    "type",
    "width"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationRetainedFile


```json
{
  "description": "The retained original on disk: still the reviewed bytes, gone, or different bytes",
  "enum": [
    "intact",
    "missing",
    "changed"
  ],
  "type": "string"
}
```

## PhysicalDeduplicationReviewRequestDto


```json
{
  "properties": {
    "excludedRetainedAssetIds": {
      "description": "Retained originals whose group the administrator decided to leave as they are",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 500,
      "type": "array"
    },
    "fingerprint": {
      "description": "The fingerprint of the plan on screen, from the preview",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    }
  },
  "required": [
    "fingerprint"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationReviewResponseDto


```json
{
  "properties": {
    "confirmation": {
      "description": "The phrase to type to apply this plan",
      "type": "string"
    },
    "copies": {
      "description": "Copies the reviewed plan will share",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "estimatedBytes": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "excludedRetainedAssetIds": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "fingerprint": {
      "type": "string"
    },
    "hiddenCopies": {
      "description": "Copies in the reviewed plan that are Locked media of another account; counted, never named",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "planId": {
      "type": "string"
    },
    "retainedOriginals": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "reviewToken": {
      "description": "Binds the plan to these per-group decisions; applying must present it",
      "type": "string"
    },
    "reviewedAt": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    }
  },
  "required": [
    "confirmation",
    "copies",
    "estimatedBytes",
    "excludedRetainedAssetIds",
    "fingerprint",
    "hiddenCopies",
    "planId",
    "retainedOriginals",
    "reviewToken",
    "reviewedAt"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationSkipReason


```json
{
  "description": "Why a duplicate copy is skipped by the physical deduplication plan",
  "enum": [
    "external-library",
    "missing-size",
    "no-retained-match",
    "already-shared",
    "retained-file-missing"
  ],
  "type": "string"
}
```

## PhysicalDeduplicationVerificationDto

Related models: [PhysicalDeduplicationVerificationItemDto](models-25.md#physicaldeduplicationverificationitemdto).

```json
{
  "properties": {
    "copies": {
      "description": "Copies the plan applied, listed or not",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "hiddenCopies": {
      "description": "Copies that are Locked media of another account; counted, never named",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/PhysicalDeduplicationVerificationItemDto"
      },
      "type": "array"
    },
    "notLinked": {
      "description": "Copies that no longer resolve to the retained original",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "operationId": {
      "type": "string"
    },
    "planId": {
      "type": "string"
    },
    "removed": {
      "description": "Copies whose own file is gone: that cannot be undone",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "restorable": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "restored": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedChanged": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedIntact": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedMissing": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "retainedOriginals": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "verified": {
      "description": "Copies that resolve to a retained original still holding the reviewed bytes",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "verifiedAt": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    }
  },
  "required": [
    "copies",
    "hiddenCopies",
    "items",
    "notLinked",
    "operationId",
    "planId",
    "removed",
    "restorable",
    "restored",
    "retainedChanged",
    "retainedIntact",
    "retainedMissing",
    "retainedOriginals",
    "verified",
    "verifiedAt"
  ],
  "type": "object"
}
```

## PhysicalDeduplicationVerificationItemDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [PhysicalDeduplicationCopyFile](models-25.md#physicaldeduplicationcopyfile), [PhysicalDeduplicationRetainedFile](models-25.md#physicaldeduplicationretainedfile).

```json
{
  "properties": {
    "assetId": {
      "type": "string"
    },
    "canView": {
      "description": "Whether the requesting administrator may view this asset and its thumbnail",
      "type": "boolean"
    },
    "copyFile": {
      "$ref": "#/components/schemas/PhysicalDeduplicationCopyFile"
    },
    "linked": {
      "description": "Whether the asset still resolves to the retained original",
      "type": "boolean"
    },
    "originalFileName": {
      "type": "string"
    },
    "ownerName": {
      "type": "string"
    },
    "restorable": {
      "description": "Whether the asset can go back to its own file: it is linked and that file still holds the reviewed bytes",
      "type": "boolean"
    },
    "restored": {
      "description": "Whether the asset is back on its own former file",
      "type": "boolean"
    },
    "retainedFile": {
      "$ref": "#/components/schemas/PhysicalDeduplicationRetainedFile"
    },
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum"
    }
  },
  "required": [
    "assetId",
    "canView",
    "copyFile",
    "linked",
    "originalFileName",
    "ownerName",
    "restorable",
    "restored",
    "retainedFile",
    "type"
  ],
  "type": "object"
}
```

## PinCodeChangeDto


```json
{
  "properties": {
    "newPinCode": {
      "description": "New PIN code (4-6 digits)",
      "pattern": "^\\d{6}$",
      "type": "string"
    },
    "password": {
      "description": "User password (required if PIN code is not provided)",
      "example": "password",
      "type": "string"
    },
    "pinCode": {
      "description": "New PIN code (4-6 digits)",
      "example": "123456",
      "pattern": "^\\d{6}$",
      "type": "string"
    }
  },
  "required": [
    "newPinCode"
  ],
  "type": "object"
}
```

## PinCodeResetDto


```json
{
  "properties": {
    "password": {
      "description": "User password (required if PIN code is not provided)",
      "example": "password",
      "type": "string"
    },
    "pinCode": {
      "description": "New PIN code (4-6 digits)",
      "example": "123456",
      "pattern": "^\\d{6}$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## PinCodeSetupDto


```json
{
  "properties": {
    "pinCode": {
      "description": "PIN code (4-6 digits)",
      "example": "123456",
      "pattern": "^\\d{6}$",
      "type": "string"
    }
  },
  "required": [
    "pinCode"
  ],
  "type": "object"
}
```

## PinnedCollection


```json
{
  "properties": {
    "count": {
      "description": "Current access-filtered item count; null when unavailable",
      "maximum": 9007199254740991,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "countCapped": {
      "description": "Whether a semantic saved-search count reached the existing smart-search cap",
      "type": "boolean"
    },
    "coverAssetId": {
      "description": "Current readable cover asset; null when unavailable or empty",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "enum": [
        "album",
        "smart-album",
        "saved-search",
        "person",
        "pet",
        "memory",
        "builtin"
      ],
      "type": "string"
    },
    "targetId": {
      "description": "Null when unavailable; the inaccessible target identity is not disclosed",
      "nullable": true,
      "type": "string"
    },
    "title": {
      "description": "Current access-filtered title; null when unavailable",
      "nullable": true,
      "type": "string"
    },
    "unavailable": {
      "type": "boolean"
    }
  },
  "required": [
    "count",
    "countCapped",
    "coverAssetId",
    "id",
    "kind",
    "targetId",
    "title",
    "unavailable"
  ],
  "type": "object"
}
```

## PinnedCollectionRef


```json
{
  "additionalProperties": false,
  "properties": {
    "id": {
      "description": "Opaque pin ID chosen by the client and retained across reorders",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "enum": [
        "album",
        "smart-album",
        "saved-search",
        "person",
        "pet",
        "memory",
        "builtin"
      ],
      "type": "string"
    },
    "targetId": {
      "description": "Target UUID, saved-search name, or built-in ID. Null retains an existing unavailable pin by its opaque ID",
      "maxLength": 100,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "id",
    "kind",
    "targetId"
  ],
  "type": "object"
}
```

## PinnedCollectionsResponseDto

Related models: [PinnedCollection](models-25.md#pinnedcollection).

```json
{
  "properties": {
    "pins": {
      "description": "Complete replacement snapshot in user order, including unavailable pins",
      "items": {
        "$ref": "#/components/schemas/PinnedCollection"
      },
      "type": "array"
    },
    "revision": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "pins",
    "revision"
  ],
  "type": "object"
}
```

## PinnedCollectionsUpdateDto

Related models: [PinnedCollectionRef](models-25.md#pinnedcollectionref).

```json
{
  "additionalProperties": false,
  "properties": {
    "expectedRevision": {
      "description": "Revision returned by GET; null only when no pin list exists. A stale save returns 409",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "pins": {
      "description": "Replace the complete ordered list to add, remove or reorder pins; an empty list clears it",
      "items": {
        "$ref": "#/components/schemas/PinnedCollectionRef"
      },
      "maxItems": 50,
      "type": "array"
    }
  },
  "required": [
    "expectedRevision",
    "pins"
  ],
  "type": "object"
}
```

## PlacesResponseDto


```json
{
  "properties": {
    "admin1name": {
      "description": "Administrative level 1 name (state/province)",
      "type": "string"
    },
    "admin2name": {
      "description": "Administrative level 2 name (county/district)",
      "type": "string"
    },
    "latitude": {
      "description": "Latitude coordinate",
      "format": "double",
      "type": "number"
    },
    "longitude": {
      "description": "Longitude coordinate",
      "format": "double",
      "type": "number"
    },
    "name": {
      "description": "Place name",
      "type": "string"
    }
  },
  "required": [
    "latitude",
    "longitude",
    "name"
  ],
  "type": "object"
}
```

## PluginMethodResponseDto

Related models: [WorkflowType](models-38.md#workflowtype).

```json
{
  "properties": {
    "allowedHosts": {
      "description": "Hosts this method may send requests to; empty when it cannot reach other servers",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "description": {
      "description": "Description",
      "type": "string"
    },
    "hostFunctions": {
      "type": "boolean"
    },
    "key": {
      "description": "Key",
      "type": "string"
    },
    "name": {
      "description": "Name",
      "type": "string"
    },
    "schema": {
      "properties": {},
      "type": "object"
    },
    "title": {
      "description": "Title",
      "type": "string"
    },
    "types": {
      "description": "Workflow types",
      "items": {
        "$ref": "#/components/schemas/WorkflowType"
      },
      "type": "array"
    },
    "uiHints": {
      "description": "Ui hints",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "allowedHosts",
    "description",
    "hostFunctions",
    "key",
    "name",
    "title",
    "types",
    "uiHints"
  ],
  "type": "object"
}
```

## PluginResponseDto

Related models: [PluginMethodResponseDto](models-25.md#pluginmethodresponsedto).

```json
{
  "properties": {
    "author": {
      "description": "Plugin author",
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "type": "string"
    },
    "description": {
      "description": "Plugin description",
      "type": "string"
    },
    "id": {
      "description": "Plugin ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "methods": {
      "description": "Plugin methods",
      "items": {
        "$ref": "#/components/schemas/PluginMethodResponseDto"
      },
      "type": "array"
    },
    "name": {
      "description": "Plugin name",
      "type": "string"
    },
    "title": {
      "description": "Plugin title",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "type": "string"
    },
    "version": {
      "description": "Plugin version",
      "type": "string"
    }
  },
  "required": [
    "author",
    "createdAt",
    "description",
    "id",
    "methods",
    "name",
    "title",
    "updatedAt",
    "version"
  ],
  "type": "object"
}
```

## PluginTemplateResponseDto

Related models: [PluginTemplateStepResponseDto](models-25.md#plugintemplatestepresponsedto), [WorkflowTrigger](models-38.md#workflowtrigger).

```json
{
  "properties": {
    "description": {
      "description": "Template description",
      "type": "string"
    },
    "key": {
      "description": "Template key (unique across all templates)",
      "type": "string"
    },
    "steps": {
      "description": "Workflow steps",
      "items": {
        "$ref": "#/components/schemas/PluginTemplateStepResponseDto"
      },
      "type": "array"
    },
    "title": {
      "description": "Template title",
      "type": "string"
    },
    "trigger": {
      "$ref": "#/components/schemas/WorkflowTrigger",
      "description": "Workflow trigger"
    },
    "uiHints": {
      "description": "Ui hints, for example \"smart-album\"",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "description",
    "key",
    "steps",
    "title",
    "trigger",
    "uiHints"
  ],
  "type": "object"
}
```

## PluginTemplateStepResponseDto


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
      "description": "Whether the step is enabled",
      "type": "boolean"
    },
    "method": {
      "description": "Step plugin method",
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

## PreservationConflictDto

Related models: [PreservationConflictField](models-25.md#preservationconflictfield), [PreservationDecision](models-25.md#preservationdecision).

```json
{
  "properties": {
    "archived": {
      "description": "The package’s value",
      "nullable": true,
      "type": "string"
    },
    "current": {
      "description": "The library’s value",
      "nullable": true,
      "type": "string"
    },
    "decision": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PreservationDecision"
        }
      ],
      "description": "Your choice; the restoration default applies when null",
      "nullable": true
    },
    "field": {
      "$ref": "#/components/schemas/PreservationConflictField"
    }
  },
  "required": [
    "archived",
    "current",
    "decision",
    "field"
  ],
  "type": "object"
}
```

## PreservationConflictField


```json
{
  "description": "A field the package and the library can disagree about",
  "enum": [
    "date",
    "description",
    "location",
    "rating",
    "favorite",
    "archive",
    "editRecipe"
  ],
  "type": "string"
}
```

## PreservationDecision


```json
{
  "description": "`keep` the library’s value, or `replace` it with the package’s",
  "enum": [
    "keep",
    "replace"
  ],
  "type": "string"
}
```

## PreservationDecisionsUpdateDto

Related models: [PreservationDecision](models-25.md#preservationdecision), [PreservationItemDecisionsDto](models-25.md#preservationitemdecisionsdto).

```json
{
  "properties": {
    "conflictDefault": {
      "$ref": "#/components/schemas/PreservationDecision"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/PreservationItemDecisionsDto"
      },
      "maxItems": 500,
      "type": "array"
    },
    "restoreEditRecipes": {
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## PreservationExportCreateDto

Related models: [PreservationScopeDto](models-26.md#preservationscopedto).

```json
{
  "properties": {
    "includeLocked": {
      "description": "Include your Locked items. Needs an unlocked session; they are restored Locked.",
      "type": "boolean"
    },
    "includeMetadata": {
      "description": "Include metadata sidecars, albums, people, tags and edit recipes. Checksums are always included.",
      "type": "boolean"
    },
    "name": {
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "requestKey": {
      "description": "Idempotency key; a repeated submit answers with the first package",
      "pattern": "^[\\w.:-]{1,128}$",
      "type": "string"
    },
    "scope": {
      "$ref": "#/components/schemas/PreservationScopeDto"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## PreservationItemDecisionsDto

Related models: [PreservationDecision](models-25.md#preservationdecision).

```json
{
  "properties": {
    "decisions": {
      "additionalProperties": {
        "$ref": "#/components/schemas/PreservationDecision"
      },
      "type": "object"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "decisions",
    "id"
  ],
  "type": "object"
}
```

## PreservationItemDto

Related models: [PreservationItemState](models-26.md#preservationitemstate), [PreservationVerifyState](models-26.md#preservationverifystate).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "error": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "locked": {
      "type": "boolean"
    },
    "name": {
      "nullable": true,
      "type": "string"
    },
    "reasonKey": {
      "nullable": true,
      "type": "string"
    },
    "sha256": {
      "nullable": true,
      "type": "string"
    },
    "sizeBytes": {
      "nullable": true,
      "type": "string"
    },
    "sourceAssetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/PreservationItemState"
    },
    "verifyState": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PreservationVerifyState"
        }
      ],
      "nullable": true
    }
  },
  "required": [
    "assetId",
    "error",
    "id",
    "locked",
    "name",
    "reasonKey",
    "sha256",
    "sizeBytes",
    "sourceAssetId",
    "state",
    "verifyState"
  ],
  "type": "object"
}
```
