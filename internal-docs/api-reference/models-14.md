# Server API models 14

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## ICloudInventoryResponseDto

Related models: [ICloudLibraryArea](models-14.md#icloudlibraryarea), [ICloudReviewKind](models-14.md#icloudreviewkind).

```json
{
  "properties": {
    "albums": {
      "items": {
        "properties": {
          "id": {
            "type": "string"
          },
          "libraryId": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "parentId": {
            "nullable": true,
            "type": "string"
          }
        },
        "required": [
          "id",
          "libraryId",
          "name",
          "parentId"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "complete": {
      "type": "boolean"
    },
    "libraries": {
      "items": {
        "properties": {
          "area": {
            "$ref": "#/components/schemas/ICloudLibraryArea"
          },
          "id": {
            "type": "string"
          },
          "name": {
            "type": "string"
          },
          "supported": {
            "type": "boolean"
          }
        },
        "required": [
          "id",
          "name",
          "area",
          "supported"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "recent": {
      "items": {
        "properties": {
          "assetId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "fileName": {
            "type": "string"
          },
          "outcome": {
            "type": "string"
          },
          "resourceId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          }
        },
        "required": [
          "assetId",
          "resourceId",
          "outcome",
          "fileName"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "review": {
      "description": "Reconciliation findings; private items only for an unlocked session",
      "items": {
        "properties": {
          "assetId": {
            "format": "uuid",
            "nullable": true,
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "fileName": {
            "nullable": true,
            "type": "string"
          },
          "kind": {
            "$ref": "#/components/schemas/ICloudReviewKind"
          },
          "reason": {
            "nullable": true,
            "type": "string"
          },
          "resourceId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "role": {
            "type": "string"
          }
        },
        "required": [
          "resourceId",
          "kind",
          "reason",
          "fileName",
          "role",
          "assetId"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "albums",
    "complete",
    "libraries",
    "review"
  ],
  "type": "object"
}
```

## ICloudItemState


```json
{
  "description": "on-server: the server has it; sync-pending: a healthy sync will import it; claimed: a path is fetching it; out-of-scope: a known library, outside the sync selection; unknown: nothing known; review: conflicting identities",
  "enum": [
    "on-server",
    "sync-pending",
    "claimed",
    "out-of-scope",
    "unknown",
    "review"
  ],
  "type": "string"
}
```

## ICloudLibraryArea


```json
{
  "enum": [
    "private",
    "shared"
  ],
  "type": "string"
}
```

## ICloudLookupAnswerDto

Related models: [ICloudEditOwnerKind](models-13.md#icloudeditownerkind), [ICloudLookupRoleDto](models-14.md#icloudlookuproledto).

```json
{
  "properties": {
    "cplAssetRecordName": {
      "nullable": true,
      "type": "string"
    },
    "editOwner": {
      "description": "Who delivers edit renders for this item; the other path never uploads one",
      "properties": {
        "connectionId": {
          "format": "uuid",
          "nullable": true,
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
          "type": "string"
        },
        "kind": {
          "$ref": "#/components/schemas/ICloudEditOwnerKind"
        }
      },
      "required": [
        "kind",
        "connectionId"
      ],
      "type": "object"
    },
    "id": {
      "type": "string"
    },
    "roles": {
      "items": {
        "$ref": "#/components/schemas/ICloudLookupRoleDto"
      },
      "type": "array"
    }
  },
  "required": [
    "cplAssetRecordName",
    "editOwner",
    "id",
    "roles"
  ],
  "type": "object"
}
```

## ICloudLookupDto

Related models: [ICloudLookupItemDto](models-14.md#icloudlookupitemdto).

```json
{
  "properties": {
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudLookupItemDto"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "items"
  ],
  "type": "object"
}
```

## ICloudLookupItemDto

Related models: [ICloudIdentityRole](models-13.md#icloudidentityrole).

```json
{
  "properties": {
    "cloudIdentifier": {
      "description": "PHCloudIdentifier.stringValue, as the device reports it",
      "maxLength": 512,
      "minLength": 1,
      "type": "string"
    },
    "creationDate": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "editVersion": {
      "description": "The device's edit version (SHA-256 of the adjustment data and the modification date)",
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    },
    "id": {
      "description": "The client's own key for the item, echoed back",
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    },
    "originalFilename": {
      "maxLength": 1024,
      "minLength": 1,
      "type": "string"
    },
    "pixelHeight": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "pixelWidth": {
      "maximum": 1000000,
      "minimum": 1,
      "type": "integer"
    },
    "roles": {
      "items": {
        "$ref": "#/components/schemas/ICloudIdentityRole"
      },
      "maxItems": 4,
      "minItems": 1,
      "type": "array"
    },
    "sha256ByRole": {
      "additionalProperties": {
        "pattern": "^[\\dA-Fa-f]{64}$",
        "type": "string"
      },
      "description": "SHA-256 of the resources the device holds locally, by role",
      "type": "object"
    },
    "uti": {
      "maxLength": 256,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "cloudIdentifier",
    "id",
    "roles"
  ],
  "type": "object"
}
```

## ICloudLookupResponseDto

Related models: [ICloudLookupAnswerDto](models-14.md#icloudlookupanswerdto).

```json
{
  "properties": {
    "identityMatching": {
      "description": "False when identity matching is switched off: only SHA-256 matches count",
      "type": "boolean"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/ICloudLookupAnswerDto"
      },
      "type": "array"
    }
  },
  "required": [
    "identityMatching",
    "items"
  ],
  "type": "object"
}
```

## ICloudLookupRoleDto

Related models: [ICloudClaimHolder](models-13.md#icloudclaimholder), [ICloudIdentityRole](models-13.md#icloudidentityrole), [ICloudItemState](models-14.md#iclouditemstate), [ICloudMatchStrength](models-14.md#icloudmatchstrength).

```json
{
  "properties": {
    "assetId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "auditVerifiedAt": {
      "description": "When an audit download proved an identity reuse; Free Up Space needs it",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "claimExpiresAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "claimedBy": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ICloudClaimHolder"
        }
      ],
      "description": "claimed: who is fetching it",
      "nullable": true
    },
    "connectionId": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "deliveredBy": {
      "description": "icloud-sync:<connectionId> or device:<deviceKey>",
      "nullable": true,
      "type": "string"
    },
    "expectedBy": {
      "description": "sync-pending: the next sync run",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "lastVerifiedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "matchStrength": {
      "allOf": [
        {
          "$ref": "#/components/schemas/ICloudMatchStrength"
        }
      ],
      "nullable": true
    },
    "pendingSince": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "role": {
      "$ref": "#/components/schemas/ICloudIdentityRole"
    },
    "sha256": {
      "nullable": true,
      "type": "string"
    },
    "state": {
      "$ref": "#/components/schemas/ICloudItemState"
    }
  },
  "required": [
    "assetId",
    "auditVerifiedAt",
    "claimExpiresAt",
    "claimedBy",
    "connectionId",
    "deliveredBy",
    "expectedBy",
    "lastVerifiedAt",
    "matchStrength",
    "pendingSince",
    "role",
    "sha256",
    "state"
  ],
  "type": "object"
}
```

## ICloudMatchStrength


```json
{
  "description": "exact: the record names match and the bytes are proven (Apple fingerprint or the same SHA-256); corroborated: the names match and filename, type, size and date agree; hint: weaker, reported but never acted on",
  "enum": [
    "exact",
    "corroborated",
    "hint"
  ],
  "type": "string"
}
```

## ICloudReviewKind


```json
{
  "enum": [
    "review",
    "failed",
    "unsupported",
    "kept-trashed",
    "source-removed"
  ],
  "type": "string"
}
```

## ICloudSyncRunDto

Related models: [MediaOperationStatus](models-16.md#mediaoperationstatus).

```json
{
  "properties": {
    "createdAt": {
      "type": "string"
    },
    "errorCode": {
      "description": "Stable failure code, translated by the client",
      "nullable": true,
      "type": "string"
    },
    "finishedAt": {
      "nullable": true,
      "type": "string"
    },
    "id": {
      "description": "Media operation ID of the run",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "pauseRequested": {
      "description": "A pause was asked for and the worker has not reached it yet",
      "type": "boolean"
    },
    "processedUnits": {
      "description": "Resources settled so far",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progress": {
      "description": "0 to 100, from resources settled out of those known so far",
      "format": "double",
      "type": "number"
    },
    "retrying": {
      "description": "Back in the queue for its automatic retry after a failure",
      "type": "boolean"
    },
    "startedAt": {
      "nullable": true,
      "type": "string"
    },
    "status": {
      "$ref": "#/components/schemas/MediaOperationStatus"
    },
    "totalUnits": {
      "description": "Resources known so far; null until the inventory is counted",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "waiting": {
      "description": "Handed back to wait for the provider or a backed-off item",
      "type": "boolean"
    }
  },
  "required": [
    "createdAt",
    "errorCode",
    "finishedAt",
    "id",
    "pauseRequested",
    "processedUnits",
    "progress",
    "retrying",
    "startedAt",
    "status",
    "totalUnits",
    "waiting"
  ],
  "type": "object"
}
```

## ICloudVerifyDto

Related models: [ICloudIdentityRole](models-13.md#icloudidentityrole).

```json
{
  "properties": {
    "connectionId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "items": {
      "items": {
        "properties": {
          "assetId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "cloudIdentifier": {
            "description": "PHCloudIdentifier.stringValue, as the device reports it",
            "maxLength": 512,
            "minLength": 1,
            "type": "string"
          },
          "editVersion": {
            "default": "",
            "maxLength": 256,
            "type": "string"
          },
          "id": {
            "maxLength": 256,
            "minLength": 1,
            "type": "string"
          },
          "role": {
            "$ref": "#/components/schemas/ICloudIdentityRole"
          }
        },
        "required": [
          "id",
          "assetId",
          "cloudIdentifier",
          "role"
        ],
        "type": "object"
      },
      "maxItems": 100,
      "minItems": 1,
      "type": "array"
    },
    "requestKey": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "connectionId",
    "items",
    "requestKey"
  ],
  "type": "object"
}
```

## ICloudVerifyResponseDto


```json
{
  "properties": {
    "items": {
      "items": {
        "properties": {
          "id": {
            "type": "string"
          },
          "state": {
            "enum": [
              "queued",
              "unavailable"
            ],
            "type": "string"
          }
        },
        "required": [
          "id",
          "state"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "items",
    "operationId"
  ],
  "type": "object"
}
```

## IdFilter


```json
{
  "properties": {
    "eq": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "ne": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## IdFilterNullable


```json
{
  "properties": {
    "eq": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "ne": {
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## IdsFilter


```json
{
  "properties": {
    "all": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "any": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "none": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ImageCapabilitiesDto


```json
{
  "properties": {
    "codecs": {
      "additionalProperties": {
        "type": "string"
      },
      "description": "Versions reported by the installed isolated codec",
      "type": "object"
    },
    "decode": {
      "description": "Available source decoders; availability alone does not establish qualification",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "experimentalEnabled": {
      "description": "Whether the administrator enabled experimental HDR processing and delivery",
      "type": "boolean"
    },
    "export": {
      "description": "Available encoded still output formats, independently of input formats",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "qualified": {
      "description": "Whether the exact build passed the real-media and physical-display acceptance gates",
      "type": "boolean"
    },
    "render": {
      "description": "Available still-image render operations",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "renderer": {
      "description": "HDR renderer identity, or null when the isolated codec is unavailable",
      "nullable": true,
      "type": "string"
    },
    "unavailable": {
      "description": "Known unsupported capabilities; never infer support from the container extension",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "codecs",
    "decode",
    "experimentalEnabled",
    "export",
    "qualified",
    "render",
    "renderer",
    "unavailable"
  ],
  "type": "object"
}
```

## ImageDescriptionEnrichmentResponseDto

Related models: [EnrichmentStaleReason](models-11.md#enrichmentstalereason).

```json
{
  "properties": {
    "appliedDescription": {
      "type": "boolean"
    },
    "appliedTags": {
      "type": "boolean"
    },
    "confidence": {
      "description": "The model's confidence in the description, 0 to 1, when the processing destination reported one; null otherwise",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "nullable": true,
      "type": "number",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "context": {
      "type": "string"
    },
    "description": {
      "type": "string"
    },
    "destinationId": {
      "description": "The processing destination that generated the description",
      "type": "string"
    },
    "environment": {
      "type": "string"
    },
    "error": {
      "type": "string"
    },
    "modelName": {
      "type": "string"
    },
    "objects": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "people": {
      "items": {
        "properties": {
          "activity": {
            "type": "string"
          },
          "apparent_age_group": {
            "type": "string"
          },
          "confidence": {
            "type": "string"
          },
          "count": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          }
        },
        "required": [
          "count",
          "apparent_age_group",
          "activity",
          "confidence"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "skipReason": {
      "description": "Machine-readable reason when status === \"skipped\"",
      "type": "string"
    },
    "staleReason": {
      "$ref": "#/components/schemas/EnrichmentStaleReason",
      "description": "Set when the generated description is out of date: the original was replaced, confirmed names changed, or the saved prompt changed"
    },
    "status": {
      "enum": [
        "missing",
        "success",
        "failed",
        "skipped"
      ],
      "type": "string"
    },
    "tags": {
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "updatedAt": {
      "type": "string"
    },
    "visibleText": {
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "appliedDescription",
    "appliedTags",
    "status"
  ],
  "type": "object"
}
```

## ImageDescriptionRequeueEstimateDto


```json
{
  "properties": {
    "activeBackend": {
      "description": "Configured hardware acceleration backend (e.g. \"auto\", \"cuda\")",
      "type": "string"
    },
    "activeModel": {
      "description": "Configured image description model name",
      "type": "string"
    },
    "estimatedTotalSeconds": {
      "description": "Estimated wall-clock time to re-describe every eligible asset (force mode: every asset is re-processed, not just those without descriptions).",
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "rollingAvgSeconds": {
      "description": "Average seconds per asset, computed as a rolling mean of the most recent 100 completed image-description jobs. Falls back to a 1.5s default when no jobs have completed since the server started.",
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "totalAssets": {
      "description": "Total eligible image assets",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "withDescription": {
      "description": "Number of eligible assets that currently have a description (will be re-run on force-requeue).",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "withoutDescription": {
      "description": "Number of eligible assets that currently have no description.",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "activeBackend",
    "activeModel",
    "estimatedTotalSeconds",
    "rollingAvgSeconds",
    "totalAssets",
    "withDescription",
    "withoutDescription"
  ],
  "type": "object"
}
```

## ImageDescriptionRequeueResponseDto


```json
{
  "properties": {
    "cloudBatches": {
      "description": "Descriptions are routed to Frameleaf Cloud, which describes photos in batches from Frameleaf Cloud processing with an estimate first; nothing was queued here",
      "type": "boolean"
    },
    "queued": {
      "description": "Whether the queue-all job was newly enqueued (false = already in-flight)",
      "type": "boolean"
    },
    "runId": {
      "description": "Canonical run accepted by this request; absent when no local work was accepted",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "cloudBatches",
    "queued"
  ],
  "type": "object"
}
```

## ImageEncodingInfo


```json
{
  "properties": {
    "bitDepth": {
      "maximum": 32,
      "minimum": 1,
      "type": "integer"
    },
    "codec": {
      "maxLength": 40,
      "type": "string"
    },
    "colorPrimaries": {
      "maximum": 65535,
      "minimum": 0,
      "type": "integer"
    },
    "container": {
      "maxLength": 40,
      "type": "string"
    },
    "contentHeadroom": {
      "format": "double",
      "minimum": 1,
      "type": "number"
    },
    "dynamicRange": {
      "enum": [
        "unknown",
        "sdr",
        "hdr"
      ],
      "type": "string"
    },
    "fallbackReason": {
      "maxLength": 80,
      "type": "string"
    },
    "gainMap": {
      "description": "Gain-map interpretation; unknown values do not imply reconstruction support",
      "maxLength": 80,
      "type": "string"
    },
    "height": {
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "inspectionStatus": {
      "enum": [
        "identified",
        "failed"
      ],
      "type": "string"
    },
    "reconstructionAvailable": {
      "description": "Decoder can reconstruct this source; does not imply a published HDR rendition or qualified display",
      "type": "boolean"
    },
    "referenceWhite": {
      "description": "Processing reference white in cd/m²; not measured display brightness",
      "exclusiveMinimum": true,
      "format": "double",
      "minimum": 0,
      "type": "number"
    },
    "renderingPolicy": {
      "maxLength": 80,
      "type": "string"
    },
    "transfer": {
      "anyOf": [
        {
          "type": "integer",
          "minimum": 0,
          "maximum": 65535
        },
        {
          "type": "string",
          "enum": [
            "adaptive"
          ]
        }
      ]
    },
    "width": {
      "exclusiveMinimum": true,
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "dynamicRange",
    "gainMap",
    "reconstructionAvailable"
  ],
  "type": "object"
}
```

## ImageEnrichmentFilter


```json
{
  "description": "Filter by private image enrichment state",
  "enum": [
    "nsfw",
    "nsfw-review",
    "nsfw-reviewed",
    "nsfw-overridden",
    "image-description-failed",
    "nsfw-detection-failed",
    "missing-image-description",
    "missing-nsfw-detection"
  ],
  "type": "string"
}
```

## ImageEnrichmentReview


```json
{
  "properties": {
    "action": {
      "enum": [
        "accepted",
        "marked-safe",
        "marked-nsfw"
      ],
      "type": "string"
    },
    "isNsfw": {
      "type": "boolean"
    },
    "reviewedAt": {
      "description": "Review timestamp",
      "type": "string"
    },
    "reviewedBy": {
      "description": "Reviewer user ID",
      "type": "string"
    }
  },
  "required": [
    "action",
    "isNsfw",
    "reviewedAt",
    "reviewedBy"
  ],
  "type": "object"
}
```

## ImageFormat


```json
{
  "description": "Image format",
  "enum": [
    "jpeg",
    "webp"
  ],
  "type": "string"
}
```

## IntegrityCheckRunsResponseDto


```json
{
  "properties": {
    "checksum_mismatch": {
      "description": "When the checksum check last completed a full pass",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "missing_file": {
      "description": "When the missing-file check last completed",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "untracked_file": {
      "description": "When the untracked-file check last completed",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "checksum_mismatch",
    "missing_file",
    "untracked_file"
  ],
  "type": "object"
}
```

## IntegrityReport


```json
{
  "description": "Integrity report type",
  "enum": [
    "untracked_file",
    "missing_file",
    "checksum_mismatch"
  ],
  "type": "string"
}
```

## IntegrityReportResponseDto

Related models: [IntegrityReport](models-14.md#integrityreport).

```json
{
  "properties": {
    "items": {
      "items": {
        "properties": {
          "id": {
            "description": "Integrity report item id",
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
            "type": "string"
          },
          "path": {
            "description": "Integrity report item path",
            "type": "string"
          },
          "type": {
            "$ref": "#/components/schemas/IntegrityReport"
          }
        },
        "required": [
          "id",
          "type",
          "path"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextCursor": {
      "type": "string"
    }
  },
  "required": [
    "items"
  ],
  "type": "object"
}
```

## IntegrityReportSummaryResponseDto


```json
{
  "properties": {
    "checksum_mismatch": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "missing_file": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "untracked_file": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "checksum_mismatch",
    "missing_file",
    "untracked_file"
  ],
  "type": "object"
}
```

## ItemShareChangeDto


```json
{
  "properties": {
    "assetIds": {
      "description": "The items (your own) to share or stop sharing",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 1000,
      "minItems": 1,
      "type": "array"
    },
    "userIds": {
      "description": "The people in this library to share them with, or to stop sharing them with",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 100,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "assetIds",
    "userIds"
  ],
  "type": "object"
}
```

## ItemShareChangeResponseDto

Related models: [ItemShareResponseDto](models-14.md#itemshareresponsedto).

```json
{
  "properties": {
    "added": {
      "description": "Shares this change added",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "link": {
      "description": "Where recipients open what is shared with them: the Public server URL when set, otherwise the direct-connection address (or a custom hostname pointed at it); null when the server has no address",
      "nullable": true,
      "type": "string"
    },
    "removed": {
      "description": "Shares this change removed",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "shares": {
      "description": "Every share of these items after the change",
      "items": {
        "$ref": "#/components/schemas/ItemShareResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "added",
    "link",
    "removed",
    "shares"
  ],
  "type": "object"
}
```

## ItemShareQueryDto


```json
{
  "properties": {
    "assetIds": {
      "description": "The items (your own) to list the shares of",
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
    "assetIds"
  ],
  "type": "object"
}
```

## ItemShareReceivedDto

Related models: [AssetResponseDto](models-06.md#assetresponsedto), [UserResponseDto](models-38.md#userresponsedto).

```json
{
  "properties": {
    "asset": {
      "$ref": "#/components/schemas/AssetResponseDto",
      "description": "The shared item"
    },
    "id": {
      "description": "Share ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "owner": {
      "$ref": "#/components/schemas/UserResponseDto",
      "description": "Who shared it"
    },
    "sharedAt": {
      "description": "When it was shared",
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "asset",
    "id",
    "owner",
    "sharedAt"
  ],
  "type": "object"
}
```

## ItemShareReceivedResponseDto

Related models: [ItemShareReceivedDto](models-14.md#itemsharereceiveddto).

```json
{
  "properties": {
    "items": {
      "description": "Items shared with you, newest share first",
      "items": {
        "$ref": "#/components/schemas/ItemShareReceivedDto"
      },
      "type": "array"
    },
    "link": {
      "description": "The address of this list, as sent in share notifications",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "items",
    "link"
  ],
  "type": "object"
}
```

## ItemShareResponseDto

Related models: [UserResponseDto](models-38.md#userresponsedto).

```json
{
  "properties": {
    "assetId": {
      "description": "The shared item",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "description": "When it was shared",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Share ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "sharedWith": {
      "$ref": "#/components/schemas/UserResponseDto",
      "description": "Who the item is shared with"
    }
  },
  "required": [
    "assetId",
    "createdAt",
    "id",
    "sharedWith"
  ],
  "type": "object"
}
```

## JobCreateDto

Related models: [ManualJobName](models-15.md#manualjobname).

```json
{
  "properties": {
    "name": {
      "$ref": "#/components/schemas/ManualJobName"
    }
  },
  "required": [
    "name"
  ],
  "type": "object"
}
```

## JobName


```json
{
  "description": "Job name",
  "enum": [
    "ICloudSync",
    "ICloudRelations",
    "AnalyticsCollect",
    "AssetDelete",
    "AssetDeleteCheck",
    "AssetDetectFacesQueueAll",
    "AssetDetectFaces",
    "AssetDetectDuplicatesQueueAll",
    "AssetDetectDuplicates",
    "DuplicateResolutionLifecycle",
    "AssetGenerateVideoDuplicateFramesQueueAll",
    "AssetGenerateVideoDuplicateFrames",
    "AssetEditThumbnailGeneration",
    "AssetDevelopRender",
    "AssetVideoEditGeneration",
    "AssetEncodeVideoQueueAll",
    "AssetEncodeVideo",
    "StudioHdrProxyGenerate",
    "AssetEmptyTrash",
    "AssetExtractMetadataQueueAll",
    "AssetExtractMetadata",
    "AssetFileMigration",
    "AssetGenerateThumbnailsQueueAll",
    "AssetGenerateThumbnails",
    "BestPhotosScoreQueueAll",
    "BestPhotosScore",
    "MediaHealthScanMissing",
    "MediaHealthLocateMissing",
    "MediaHealthScanCorrupt",
    "MediaHealthDeleteCorrupt",
    "AuditTableCleanup",
    "DatabaseBackup",
    "FacialRecognitionQueueAll",
    "FacialRecognition",
    "FileDelete",
    "FileMigrationQueueAll",
    "LibraryDeleteCheck",
    "LibraryDelete",
    "LibraryRemoveAsset",
    "LibraryScanAssetsQueueAll",
    "LibrarySyncAssets",
    "LibrarySyncFilesQueueAll",
    "LibrarySyncFiles",
    "LibraryScanQueueAll",
    "LibraryScanRun",
    "HlsSessionCleanup",
    "MemoryCleanup",
    "MemoryGenerate",
    "MemoryExport",
    "NotificationsCleanup",
    "NotifyUserSignup",
    "NotifyAlbumInvite",
    "NotifyAlbumUpdate",
    "UserDelete",
    "UserDeleteCheck",
    "UserSyncUsage",
    "PersonCleanup",
    "PersonFileMigration",
    "profile-image-repair",
    "PersonGenerateThumbnail",
    "PersonIdentityRefresh",
    "SessionCleanup",
    "SendMail",
    "SidecarQueueAll",
    "SidecarCheck",
    "SidecarWrite",
    "SmartSearchQueueAll",
    "SmartSearch",
    "SmartSearchPostprocess",
    "AssetMetadataPostprocess",
    "ImageEnrichmentPostprocess",
    "StorageTemplateMigration",
    "StorageTemplateMigrationSingle",
    "PhysicalDeduplicationMigrationDryRun",
    "PhysicalDeduplicationMigrationApply",
    "TagCleanup",
    "VersionCheck",
    "FrameleafHeartbeat",
    "FrameleafLicenseRefresh",
    "CloudMlDescriptionBatch",
    "CloudBackupSchedule",
    "CloudBackupVerify",
    "PushDeliver",
    "PushBackupStaleCheck",
    "PartnerBackfill",
    "PartnerCopyAsset",
    "PartnerCopyAlbum",
    "PartnerPropagate",
    "OcrQueueAll",
    "Ocr",
    "ImageDescriptionQueueAll",
    "ImageDescription",
    "VideoMomentCaptions",
    "NsfwDetectionQueueAll",
    "NsfwDetection",
    "PetRecognitionQueueAll",
    "PetRecognition",
    "PetRecognitionNearest",
    "SmartAlbumReevaluateAll",
    "SmartAlbumReevaluate",
    "WorkflowAssetTrigger",
    "IntegrityUntrackedFilesQueueAll",
    "IntegrityUntrackedFiles",
    "IntegrityUntrackedRefresh",
    "IntegrityMissingFilesQueueAll",
    "IntegrityMissingFiles",
    "IntegrityMissingFilesRefresh",
    "IntegrityChecksumFiles",
    "IntegrityChecksumFilesRefresh",
    "IntegrityDeleteReportType",
    "IntegrityDeleteReports"
  ],
  "type": "string"
}
```

## JobRunItemPageDto

Related models: [JobRunItemResponseDto](models-14.md#jobrunitemresponsedto).

```json
{
  "properties": {
    "hasNextPage": {
      "type": "boolean"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/JobRunItemResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "hasNextPage",
    "items"
  ],
  "type": "object"
}
```

## JobRunItemResponseDto


```json
{
  "properties": {
    "id": {
      "type": "string"
    },
    "lastProgressAt": {
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "lastStage": {
      "nullable": true,
      "type": "string"
    },
    "outcome": {
      "enum": [
        "completed",
        "failed",
        "needsAttention",
        "cancelled",
        "active",
        "retrying",
        "delayed",
        "paused",
        "waiting",
        "blocked"
      ],
      "type": "string"
    },
    "reasons": {
      "items": {
        "enum": [
          "worker_unavailable",
          "no_dispatch_backlog",
          "first_setup_pending",
          "dependency_unavailable",
          "dependency_wait",
          "dependency_failed",
          "retry_backoff",
          "scheduled_delay",
          "queue_paused",
          "needs_attention",
          "stage_failed",
          "enumerating",
          "workload-disabled",
          "destination-unavailable",
          "destination-configuration",
          "destination-consent",
          "destination-budget",
          "source-unavailable",
          "local-capacity"
        ],
        "type": "string"
      },
      "type": "array"
    },
    "stageTotals": {
      "properties": {
        "active": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "blocked": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "cancelled": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "completed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "delayed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "failed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "needsAttention": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "paused": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "retrying": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "total": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "waiting": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "total",
        "completed",
        "failed",
        "needsAttention",
        "cancelled",
        "active",
        "retrying",
        "delayed",
        "paused",
        "waiting",
        "blocked"
      ],
      "type": "object"
    }
  },
  "required": [
    "id",
    "lastProgressAt",
    "lastStage",
    "outcome",
    "reasons",
    "stageTotals"
  ],
  "type": "object"
}
```

## JobRunPageDto

Related models: [JobRunResponseDto](models-14.md#jobrunresponsedto).

```json
{
  "properties": {
    "hasNextPage": {
      "type": "boolean"
    },
    "items": {
      "items": {
        "$ref": "#/components/schemas/JobRunResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "hasNextPage",
    "items"
  ],
  "type": "object"
}
```

## JobRunResponseDto


```json
{
  "properties": {
    "active": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "blocked": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "cancelled": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "completed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "createdAt": {
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "delayed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "enumerationDone": {
      "type": "boolean"
    },
    "failed": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "finishedAt": {
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "kind": {
      "type": "string"
    },
    "lastProgressAt": {
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z))$",
      "type": "string"
    },
    "lastStage": {
      "nullable": true,
      "type": "string"
    },
    "needsAttention": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "noDispatchBacklog": {
      "type": "boolean"
    },
    "paused": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "reasons": {
      "items": {
        "enum": [
          "worker_unavailable",
          "no_dispatch_backlog",
          "first_setup_pending",
          "dependency_unavailable",
          "dependency_wait",
          "dependency_failed",
          "retry_backoff",
          "scheduled_delay",
          "queue_paused",
          "needs_attention",
          "stage_failed",
          "enumerating",
          "workload-disabled",
          "destination-unavailable",
          "destination-configuration",
          "destination-consent",
          "destination-budget",
          "source-unavailable",
          "local-capacity"
        ],
        "type": "string"
      },
      "type": "array"
    },
    "retrying": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "stageTotals": {
      "properties": {
        "active": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "blocked": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "cancelled": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "completed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "delayed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "failed": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "needsAttention": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "paused": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "retrying": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "total": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        },
        "waiting": {
          "maximum": 9007199254740991,
          "minimum": 0,
          "type": "integer"
        }
      },
      "required": [
        "total",
        "completed",
        "failed",
        "needsAttention",
        "cancelled",
        "active",
        "retrying",
        "delayed",
        "paused",
        "waiting",
        "blocked"
      ],
      "type": "object"
    },
    "state": {
      "enum": [
        "running",
        "retrying",
        "delayed",
        "paused",
        "waiting",
        "blocked",
        "unavailable",
        "needs_attention",
        "completed",
        "completed_with_errors",
        "cancelled"
      ],
      "type": "string"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "waiting": {
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "active",
    "blocked",
    "cancelled",
    "completed",
    "createdAt",
    "delayed",
    "enumerationDone",
    "failed",
    "finishedAt",
    "id",
    "kind",
    "lastProgressAt",
    "lastStage",
    "needsAttention",
    "noDispatchBacklog",
    "paused",
    "reasons",
    "retrying",
    "stageTotals",
    "state",
    "total",
    "waiting"
  ],
  "type": "object"
}
```

## KnownAssetDevelopCrop


```json
{
  "properties": {
    "h": {
      "description": "Crop height as a fraction of the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0.05,
      "type": "number"
    },
    "w": {
      "description": "Crop width as a fraction of the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0.05,
      "type": "number"
    },
    "x": {
      "description": "Left edge of the crop as a fraction of the oriented frame width",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Top edge of the crop as a fraction of the oriented frame height",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "h",
    "w",
    "x",
    "y"
  ],
  "type": "object"
}
```
