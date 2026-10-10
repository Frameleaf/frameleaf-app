# Server API models 18

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## MlCapabilityDestinationDto

Related models: [MlDestinationHealth](models-18.md#mldestinationhealth), [MlDestinationKind](models-18.md#mldestinationkind), [MlWorkerAcceleration](models-18.md#mlworkeracceleration), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "acceleration": {
      "$ref": "#/components/schemas/MlWorkerAcceleration",
      "description": "CPU or accelerator, from the last check; unknown without facts"
    },
    "available": {
      "description": "Enabled, healthy on a check that is not stale, consented and reporting this workload",
      "type": "boolean"
    },
    "checkedAt": {
      "description": "When the destination was last checked, or null",
      "nullable": true,
      "type": "string"
    },
    "consentGranted": {
      "description": "True when the destination needs no consent or consent is recorded",
      "type": "boolean"
    },
    "gpuMemoryBytes": {
      "description": "Largest GPU memory the worker reported, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "health": {
      "$ref": "#/components/schemas/MlDestinationHealth"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "leavesNetwork": {
      "description": "Work sent here leaves this network (Frameleaf Cloud)",
      "type": "boolean"
    },
    "name": {
      "type": "string"
    },
    "region": {
      "description": "Frameleaf Cloud data region, or null",
      "nullable": true,
      "type": "string"
    },
    "servedWorkloads": {
      "description": "Workloads the last check verified, or null when it never answered",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "nullable": true,
      "type": "array"
    },
    "stale": {
      "description": "The last check is too old to count as evidence; the destination is checked again first",
      "type": "boolean"
    }
  },
  "required": [
    "acceleration",
    "available",
    "checkedAt",
    "consentGranted",
    "gpuMemoryBytes",
    "health",
    "id",
    "kind",
    "leavesNetwork",
    "name",
    "region",
    "servedWorkloads",
    "stale"
  ],
  "type": "object"
}
```

## MlDestinationCloudDto

Related models: [MlAdmissionRefusal](models-17.md#mladmissionrefusal).

```json
{
  "properties": {
    "balanceUsd": {
      "description": "AI Wallet balance, USD",
      "format": "double",
      "type": "number"
    },
    "dailyCapUsd": {
      "description": "Daily AI Wallet limit, USD, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "entitled": {
      "description": "The Frameleaf account has the cloud processing entitlement",
      "type": "boolean"
    },
    "heldUsd": {
      "description": "AI Wallet amount held by running jobs, USD",
      "format": "double",
      "type": "number"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlAdmissionRefusal"
        }
      ],
      "description": "Why the last check refused, or null",
      "nullable": true
    },
    "refusalDetail": {
      "nullable": true,
      "type": "string"
    },
    "region": {
      "description": "Frameleaf Cloud data region",
      "nullable": true,
      "type": "string"
    },
    "spentTodayUsd": {
      "description": "AI Wallet spend today, USD",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "balanceUsd",
    "dailyCapUsd",
    "entitled",
    "heldUsd",
    "refusal",
    "refusalDetail",
    "region",
    "spentTodayUsd"
  ],
  "type": "object"
}
```

## MlDestinationConsentDto


```json
{
  "properties": {
    "acknowledgedAt": {
      "description": "When an administrator recorded consent, or null",
      "nullable": true,
      "type": "string"
    },
    "acknowledgedBy": {
      "description": "Administrator who recorded consent, or null",
      "nullable": true,
      "type": "string"
    },
    "required": {
      "description": "Whether this destination sends media off the network and needs consent",
      "type": "boolean"
    },
    "requiredVersion": {
      "description": "Frameleaf Cloud: the consent version the cloud requires now, from the last check, or null",
      "nullable": true,
      "type": "string"
    },
    "version": {
      "description": "Frameleaf Cloud: the consent version accepted, or null",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "acknowledgedAt",
    "acknowledgedBy",
    "required",
    "requiredVersion",
    "version"
  ],
  "type": "object"
}
```

## MlDestinationConsentRequestDto


```json
{
  "properties": {
    "acknowledgeMediaLeavesNetwork": {
      "description": "The administrator confirms that media sent to this destination leaves the network",
      "enum": [
        true
      ],
      "type": "boolean"
    },
    "features": {
      "description": "Frameleaf Cloud: per-feature choices; every feature is off unless chosen",
      "properties": {
        "identityNames": {
          "default": false,
          "description": "Allow people names in cloud description prompts",
          "type": "boolean"
        },
        "medicalSignals": {
          "default": false,
          "description": "Allow medical signals in cloud descriptions",
          "type": "boolean"
        },
        "ocrAddon": {
          "default": false,
          "description": "Allow the cloud text-recognition add-on",
          "type": "boolean"
        }
      },
      "type": "object"
    },
    "textSha256": {
      "description": "Frameleaf Cloud (FC-62): SHA-256 of the terms text the administrator was shown; refused when the cloud now asks for other terms",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    },
    "version": {
      "description": "Frameleaf Cloud: the consent version being accepted; required for Frameleaf Cloud",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "acknowledgeMediaLeavesNetwork"
  ],
  "type": "object"
}
```

## MlDestinationCostControlsDto


```json
{
  "properties": {
    "budgetLimitUsd": {
      "description": "Spend ceiling over the rolling budget window, or null for no ceiling",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "budgetWindowDays": {
      "description": "Length of the rolling window `spentUsd` covers",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "maxRuntimeMinutes": {
      "description": "Longest single job this destination may run, or null",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "maxUploadBytes": {
      "description": "Largest upload one job may send to this destination, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "spentUsd": {
      "description": "Attributed spend inside the budget window; 0 when no cost has been attributed yet",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "budgetLimitUsd",
    "budgetWindowDays",
    "maxRuntimeMinutes",
    "maxUploadBytes",
    "spentUsd"
  ],
  "type": "object"
}
```

## MlDestinationCreateDto

Related models: [MlDestinationKind](models-18.md#mldestinationkind), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "authToken": {
      "description": "Bearer token for a LAN worker (write-only)",
      "maxLength": 4096,
      "type": "string"
    },
    "budgetLimitUsd": {
      "format": "double",
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "enabled": {
      "default": true,
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "maxRuntimeMinutes": {
      "maximum": 10080,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "maxUploadBytes": {
      "format": "double",
      "maximum": 9007199254740991,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "name": {
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    },
    "sharesLibraryHardware": {
      "description": "Restoration workers only: full restorations wait while library analysis has work",
      "type": "boolean"
    },
    "url": {
      "description": "Required for a LAN destination, optional for a local one; Frameleaf Cloud is added from its own endpoint",
      "format": "uri",
      "type": "string"
    },
    "workloads": {
      "default": [],
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "maxItems": 16,
      "type": "array"
    }
  },
  "required": [
    "kind",
    "name"
  ],
  "type": "object"
}
```

## MlDestinationHealth


```json
{
  "description": "Last probed health of a machine-learning destination",
  "enum": [
    "healthy",
    "unhealthy",
    "unknown"
  ],
  "type": "string"
}
```

## MlDestinationHealthStateDto

Related models: [MlDestinationHealth](models-18.md#mldestinationhealth), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "probedAt": {
      "description": "When the destination was last probed, or null",
      "nullable": true,
      "type": "string"
    },
    "servedWorkloads": {
      "description": "Workloads the worker itself reported on the last probe, or null when it never answered",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "nullable": true,
      "type": "array"
    },
    "status": {
      "$ref": "#/components/schemas/MlDestinationHealth"
    },
    "summary": {
      "description": "Human-readable probe result, or null",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "probedAt",
    "servedWorkloads",
    "status",
    "summary"
  ],
  "type": "object"
}
```

## MlDestinationKind


```json
{
  "description": "Kind of machine-learning destination",
  "enum": [
    "local",
    "lan",
    "frameleaf-cloud"
  ],
  "type": "string"
}
```

## MlDestinationResponseDto

Related models: [MlDestinationCloudDto](models-18.md#mldestinationclouddto), [MlDestinationConsentDto](models-18.md#mldestinationconsentdto), [MlDestinationCostControlsDto](models-18.md#mldestinationcostcontrolsdto), [MlDestinationHealthStateDto](models-18.md#mldestinationhealthstatedto), [MlDestinationKind](models-18.md#mldestinationkind), [MlWorkerRole](models-18.md#mlworkerrole), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "authTokenConfigured": {
      "description": "Whether a bearer token is stored for this destination",
      "type": "boolean"
    },
    "cloud": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlDestinationCloudDto"
        }
      ],
      "description": "Frameleaf Cloud facts from the last check; null for other kinds",
      "nullable": true
    },
    "consent": {
      "$ref": "#/components/schemas/MlDestinationConsentDto"
    },
    "costControls": {
      "$ref": "#/components/schemas/MlDestinationCostControlsDto"
    },
    "createdAt": {
      "type": "string"
    },
    "enabled": {
      "type": "boolean"
    },
    "health": {
      "$ref": "#/components/schemas/MlDestinationHealthStateDto"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "name": {
      "type": "string"
    },
    "role": {
      "$ref": "#/components/schemas/MlWorkerRole"
    },
    "sharesLibraryHardware": {
      "description": "A restoration worker on the GPU library analysis uses; its full restorations wait for library work",
      "type": "boolean"
    },
    "updatedAt": {
      "type": "string"
    },
    "url": {
      "description": "Endpoint URL; always null for Frameleaf Cloud",
      "nullable": true,
      "type": "string"
    },
    "workloads": {
      "description": "Workloads the administrator allows on this destination",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    }
  },
  "required": [
    "authTokenConfigured",
    "cloud",
    "consent",
    "costControls",
    "createdAt",
    "enabled",
    "health",
    "id",
    "kind",
    "name",
    "role",
    "sharesLibraryHardware",
    "updatedAt",
    "url",
    "workloads"
  ],
  "type": "object"
}
```

## MlDestinationUpdateDto

Related models: [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "authToken": {
      "description": "New bearer token; null clears it; omitted keeps the stored token",
      "maxLength": 4096,
      "nullable": true,
      "type": "string"
    },
    "budgetLimitUsd": {
      "format": "double",
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "enabled": {
      "type": "boolean"
    },
    "maxRuntimeMinutes": {
      "maximum": 10080,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "maxUploadBytes": {
      "format": "double",
      "maximum": 9007199254740991,
      "minimum": 1,
      "nullable": true,
      "type": "integer"
    },
    "name": {
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    },
    "sharesLibraryHardware": {
      "description": "Restoration workers only: full restorations wait while library analysis has work",
      "type": "boolean"
    },
    "url": {
      "format": "uri",
      "nullable": true,
      "type": "string"
    },
    "workloads": {
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "maxItems": 16,
      "type": "array"
    }
  },
  "type": "object"
}
```

## MlRestorationModelsResponseDto

Related models: [MlWorkload](models-18.md#mlworkload), [RestorationGpuDto](models-29.md#restorationgpudto), [RestorationModelCapabilityDto](models-29.md#restorationmodelcapabilitydto).

```json
{
  "properties": {
    "checkedAt": {
      "description": "When the destination last verified its models, or null",
      "nullable": true,
      "type": "string"
    },
    "configurationProblems": {
      "description": "Problems reading the model manifest or qualification evidence on the destination",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "destinationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "error": {
      "description": "Why no report could be read, or null",
      "nullable": true,
      "type": "string"
    },
    "gpus": {
      "items": {
        "$ref": "#/components/schemas/RestorationGpuDto"
      },
      "type": "array"
    },
    "models": {
      "items": {
        "$ref": "#/components/schemas/RestorationModelCapabilityDto"
      },
      "type": "array"
    },
    "reachable": {
      "description": "Whether the destination answered with a restoration report",
      "type": "boolean"
    },
    "workloads": {
      "description": "Restoration workloads the destination serves now; empty unless a model is available",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "type": "array"
    }
  },
  "required": [
    "checkedAt",
    "configurationProblems",
    "destinationId",
    "error",
    "gpus",
    "models",
    "reachable",
    "workloads"
  ],
  "type": "object"
}
```

## MlStudioFeature


```json
{
  "description": "Studio AI only: the Studio feature, which decides the Frameleaf Cloud model the job uses (speech to text and captions, or speech)",
  "enum": [
    "speech-to-text",
    "captions",
    "speech"
  ],
  "type": "string"
}
```

## MlThroughputEstimateDto


```json
{
  "properties": {
    "bytesPerSecond": {
      "description": "Measured throughput for this destination and workload, or null with no samples",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "sampleCount": {
      "description": "Successful requests the estimate is measured from",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "windowDays": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "bytesPerSecond",
    "sampleCount",
    "windowDays"
  ],
  "type": "object"
}
```

## MlWorkerAcceleration


```json
{
  "description": "Acceleration a worker reported on its last check",
  "enum": [
    "unknown",
    "cpu",
    "gpu"
  ],
  "type": "string"
}
```

## MlWorkerReadiness


```json
{
  "description": "State of one worker in the inventory",
  "enum": [
    "unknown",
    "disabled",
    "unreachable",
    "not-serving",
    "cpu",
    "model-ready"
  ],
  "type": "string"
}
```

## MlWorkerRole


```json
{
  "description": "What a worker is for",
  "enum": [
    "library-analysis",
    "restoration",
    "studio",
    "mixed",
    "unassigned"
  ],
  "type": "string"
}
```

## MlWorkload


```json
{
  "description": "Machine-learning workload",
  "enum": [
    "face",
    "clip",
    "ocr",
    "enrichment",
    "restoration-faithful",
    "restoration-creative",
    "studio-ai",
    "upscale",
    "interpolation",
    "studio-render",
    "pet-recognition"
  ],
  "type": "string"
}
```

## MlWorkloadCapabilityDto

Related models: [MlCapabilityDestinationDto](models-18.md#mlcapabilitydestinationdto), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "available": {
      "description": "At least one destination can serve this workload right now",
      "type": "boolean"
    },
    "destinations": {
      "items": {
        "$ref": "#/components/schemas/MlCapabilityDestinationDto"
      },
      "type": "array"
    },
    "routedDestinationId": {
      "description": "Destination library jobs use for this workload, or null",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "available",
    "destinations",
    "routedDestinationId",
    "workload"
  ],
  "type": "object"
}
```

## MlWorkloadRouteDto

Related models: [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "destinationId": {
      "description": "Destination the workload is routed to, or null when unrouted",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "destinationId",
    "workload"
  ],
  "type": "object"
}
```

## MlWorkloadRouteUpdateDto


```json
{
  "properties": {
    "destinationId": {
      "description": "Destination to route the workload to; null removes the route",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "destinationId"
  ],
  "type": "object"
}
```

## MlWorkloadRoutesResponseDto

Related models: [MlWorkloadRouteDto](models-18.md#mlworkloadroutedto).

```json
{
  "properties": {
    "routes": {
      "items": {
        "$ref": "#/components/schemas/MlWorkloadRouteDto"
      },
      "type": "array"
    }
  },
  "required": [
    "routes"
  ],
  "type": "object"
}
```

## MoveAlbumDto


```json
{
  "properties": {
    "collectionId": {
      "description": "Collection to move the album into, or null to take it out so it stands on its own",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "expectedParentId": {
      "description": "Where the client last saw the album (its collection, or null for on its own). When given and the album has been moved since, the move is refused with 409 instead of undoing the other change.",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "collectionId"
  ],
  "type": "object"
}
```

## NotificationCreateDto

Related models: [NotificationLevel](models-18.md#notificationlevel), [NotificationType](models-18.md#notificationtype).

```json
{
  "properties": {
    "data": {
      "additionalProperties": {},
      "description": "Additional notification data",
      "type": "object"
    },
    "description": {
      "description": "Notification description",
      "nullable": true,
      "type": "string"
    },
    "level": {
      "$ref": "#/components/schemas/NotificationLevel"
    },
    "readAt": {
      "description": "Date when notification was read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "Notification title",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/NotificationType"
    },
    "userId": {
      "description": "User ID to send notification to",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "title",
    "userId"
  ],
  "type": "object"
}
```

## NotificationDeleteAllDto


```json
{
  "properties": {
    "ids": {
      "description": "Notification IDs to delete",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
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

## NotificationDto

Related models: [NotificationLevel](models-18.md#notificationlevel), [NotificationType](models-18.md#notificationtype).

```json
{
  "properties": {
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "data": {
      "additionalProperties": {},
      "description": "Additional notification data",
      "type": "object"
    },
    "description": {
      "description": "Notification description",
      "type": "string"
    },
    "id": {
      "description": "Notification ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "level": {
      "$ref": "#/components/schemas/NotificationLevel"
    },
    "readAt": {
      "description": "Date when notification was read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "title": {
      "description": "Notification title",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/NotificationType"
    }
  },
  "required": [
    "createdAt",
    "id",
    "level",
    "title",
    "type"
  ],
  "type": "object"
}
```

## NotificationLevel


```json
{
  "description": "Notification level",
  "enum": [
    "success",
    "error",
    "warning",
    "info"
  ],
  "type": "string"
}
```

## NotificationType


```json
{
  "description": "Notification type",
  "enum": [
    "JobFailed",
    "BackupFailed",
    "SystemMessage",
    "AlbumInvite",
    "AlbumUpdate",
    "ItemShare",
    "ClusterGroupRequest",
    "SharedSpaceMention",
    "SharedSpaceReply",
    "Custom"
  ],
  "type": "string"
}
```

## NotificationUpdateAllDto


```json
{
  "properties": {
    "ids": {
      "description": "Notification IDs to update",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "minItems": 1,
      "type": "array"
    },
    "readAt": {
      "description": "Date when notifications were read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## NotificationUpdateDto


```json
{
  "properties": {
    "readAt": {
      "description": "Date when notification was read",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "nullable": true,
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    }
  },
  "type": "object"
}
```

## NsfwDetectionEnrichmentResponseDto

Related models: [ImageEnrichmentReview](models-14.md#imageenrichmentreview).

```json
{
  "properties": {
    "appliedTags": {
      "type": "boolean"
    },
    "effectiveIsNsfw": {
      "type": "boolean"
    },
    "error": {
      "type": "string"
    },
    "isNsfw": {
      "type": "boolean"
    },
    "labels": {
      "additionalProperties": {
        "format": "double",
        "type": "number"
      },
      "type": "object"
    },
    "modelName": {
      "type": "string"
    },
    "review": {
      "$ref": "#/components/schemas/ImageEnrichmentReview"
    },
    "score": {
      "format": "double",
      "type": "number"
    },
    "status": {
      "enum": [
        "missing",
        "success",
        "failed"
      ],
      "type": "string"
    },
    "updatedAt": {
      "type": "string"
    }
  },
  "required": [
    "appliedTags",
    "effectiveIsNsfw",
    "status"
  ],
  "type": "object"
}
```

## NumberFilter


```json
{
  "properties": {
    "eq": {
      "format": "double",
      "type": "number"
    },
    "gt": {
      "format": "double",
      "type": "number"
    },
    "gte": {
      "format": "double",
      "type": "number"
    },
    "in": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    },
    "lt": {
      "format": "double",
      "type": "number"
    },
    "lte": {
      "format": "double",
      "type": "number"
    },
    "ne": {
      "format": "double",
      "type": "number"
    },
    "notIn": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## NumberFilterNullable


```json
{
  "properties": {
    "eq": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "gt": {
      "format": "double",
      "type": "number"
    },
    "gte": {
      "format": "double",
      "type": "number"
    },
    "in": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    },
    "lt": {
      "format": "double",
      "type": "number"
    },
    "lte": {
      "format": "double",
      "type": "number"
    },
    "ne": {
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "notIn": {
      "items": {
        "format": "double",
        "type": "number"
      },
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## OAuthAuthorizeResponseDto


```json
{
  "properties": {
    "url": {
      "description": "OAuth authorization URL",
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```

## OAuthBackchannelLogoutDto


```json
{
  "properties": {
    "logout_token": {
      "description": "OAuth logout token",
      "type": "string"
    }
  },
  "required": [
    "logout_token"
  ],
  "type": "object"
}
```

## OAuthCallbackDto


```json
{
  "properties": {
    "codeVerifier": {
      "description": "OAuth code verifier (PKCE)",
      "type": "string"
    },
    "rememberMe": {
      "description": "Persist authentication cookies across browser sessions (default true)",
      "type": "boolean"
    },
    "state": {
      "description": "OAuth state parameter",
      "type": "string"
    },
    "url": {
      "description": "OAuth callback URL",
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "url"
  ],
  "type": "object"
}
```

## OAuthConfigDto


```json
{
  "properties": {
    "codeChallenge": {
      "description": "OAuth code challenge (PKCE)",
      "type": "string"
    },
    "redirectUri": {
      "description": "OAuth redirect URI",
      "type": "string"
    },
    "state": {
      "description": "OAuth state parameter",
      "type": "string"
    }
  },
  "required": [
    "redirectUri"
  ],
  "type": "object"
}
```

## OAuthTokenEndpointAuthMethod


```json
{
  "description": "OAuth token endpoint auth method",
  "enum": [
    "client_secret_post",
    "client_secret_basic"
  ],
  "type": "string"
}
```

## OnThisDayDto


```json
{
  "properties": {
    "year": {
      "description": "Year for on this day memory",
      "maximum": 9999,
      "minimum": 1000,
      "type": "integer"
    }
  },
  "required": [
    "year"
  ],
  "type": "object"
}
```

## OnboardingDto


```json
{
  "properties": {
    "isOnboarded": {
      "description": "Is user onboarded",
      "type": "boolean"
    }
  },
  "required": [
    "isOnboarded"
  ],
  "type": "object"
}
```

## OnboardingResponseDto


```json
{
  "properties": {
    "isOnboarded": {
      "description": "Is user onboarded",
      "type": "boolean"
    }
  },
  "required": [
    "isOnboarded"
  ],
  "type": "object"
}
```

## OwnerBackupDeletionDateState


```json
{
  "enum": [
    "available",
    "unavailable"
  ],
  "type": "string"
}
```

## OwnerBackupHistoryResponseDto

Related models: [OwnerBackupDeletionDateState](models-18.md#ownerbackupdeletiondatestate), [OwnerBackupItemState](models-18.md#ownerbackupitemstate).

```json
{
  "properties": {
    "items": {
      "items": {
        "properties": {
          "assetId": {
            "type": "string"
          },
          "backupDate": {
            "type": "string"
          },
          "deletionDate": {
            "properties": {
              "at": {
                "nullable": true,
                "type": "string"
              },
              "state": {
                "$ref": "#/components/schemas/OwnerBackupDeletionDateState"
              }
            },
            "required": [
              "state",
              "at"
            ],
            "type": "object"
          },
          "name": {
            "type": "string"
          },
          "state": {
            "$ref": "#/components/schemas/OwnerBackupItemState"
          },
          "thumbnailAvailable": {
            "description": "An eligible recorded thumbnail; remote availability/integrity is checked when read",
            "type": "boolean"
          },
          "trashDate": {
            "description": "Known current trash timestamp; distinct from physical deletion",
            "nullable": true,
            "type": "string"
          }
        },
        "required": [
          "assetId",
          "name",
          "backupDate",
          "state",
          "trashDate",
          "deletionDate",
          "thumbnailAvailable"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "total": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "items",
    "nextOffset",
    "total"
  ],
  "type": "object"
}
```

## OwnerBackupItemState


```json
{
  "enum": [
    "trashed",
    "deleted"
  ],
  "type": "string"
}
```

## OwnerBackupKeptStatus


```json
{
  "enum": [
    "complete",
    "degraded"
  ],
  "type": "string"
}
```

## OwnerBackupRestoreDto


```json
{
  "properties": {
    "assetIds": {
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      },
      "maxItems": 100,
      "minItems": 1,
      "type": "array"
    },
    "manifestKey": {
      "maxLength": 300,
      "pattern": "^m\\/\\d{8}T\\d{6}Z\\.json\\.gz$",
      "type": "string"
    }
  },
  "required": [
    "assetIds",
    "manifestKey"
  ],
  "type": "object"
}
```

## OwnerBackupRestoreResponseDto


```json
{
  "properties": {
    "operationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "status": {
      "type": "string"
    }
  },
  "required": [
    "operationId",
    "status"
  ],
  "type": "object"
}
```

## OwnerBackupsResponseDto

Related models: [OwnerBackupKeptStatus](models-18.md#ownerbackupkeptstatus).

```json
{
  "properties": {
    "backups": {
      "items": {
        "properties": {
          "backupDate": {
            "type": "string"
          },
          "manifestKey": {
            "type": "string"
          },
          "status": {
            "$ref": "#/components/schemas/OwnerBackupKeptStatus"
          }
        },
        "required": [
          "manifestKey",
          "backupDate",
          "status"
        ],
        "type": "object"
      },
      "type": "array"
    },
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    }
  },
  "required": [
    "backups",
    "nextOffset"
  ],
  "type": "object"
}
```

## PartnerBackfillDto


```json
{
  "properties": {
    "done": {
      "description": "Items copied so far",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "state": {
      "description": "Where the first copy stands",
      "enum": [
        "pending",
        "running",
        "done",
        "stopped"
      ],
      "type": "string"
    },
    "total": {
      "description": "Items to copy",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "done",
    "state",
    "total"
  ],
  "type": "object"
}
```

## PartnerCreateDto


```json
{
  "properties": {
    "sharedWithId": {
      "description": "User ID to share with",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "sharedWithId"
  ],
  "type": "object"
}
```

## PartnerDirection


```json
{
  "description": "Partner direction",
  "enum": [
    "shared-by",
    "shared-with"
  ],
  "type": "string"
}
```

## PartnerLockedNoticeResponseDto


```json
{
  "properties": {
    "flaggedAt": {
      "description": "When the first Locked item arrived for an account without a PIN",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "show": {
      "description": "Whether to show the notice: Locked items arrived from a partner, no PIN is set, and it was not dismissed",
      "type": "boolean"
    }
  },
  "required": [
    "flaggedAt",
    "show"
  ],
  "type": "object"
}
```

## PartnerOriginDto


```json
{
  "properties": {
    "rootOwnerId": {
      "description": "The account that originally uploaded or created it",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "rootOwnerName": {
      "description": "That account's name",
      "type": "string"
    }
  },
  "required": [
    "rootOwnerId",
    "rootOwnerName"
  ],
  "type": "object"
}
```

## PartnerResponseDto

Related models: [PartnerBackfillDto](models-18.md#partnerbackfilldto), [UserAvatarColor](models-37.md#useravatarcolor).

```json
{
  "description": "Partner response",
  "properties": {
    "avatarColor": {
      "$ref": "#/components/schemas/UserAvatarColor"
    },
    "backfill": {
      "allOf": [
        {
          "$ref": "#/components/schemas/PartnerBackfillDto"
        }
      ],
      "description": "FL-326: copy progress of the library shared this way; null when it was never copied",
      "nullable": true
    },
    "email": {
      "description": "User email",
      "format": "email",
      "pattern": "^[\\p{L}\\p{M}\\p{N}.!#$%&'*+/=?^_`{|}~-]+@[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{M}\\p{N}-]{0,61}[\\p{L}\\p{M}\\p{N}])?)*$",
      "type": "string"
    },
    "id": {
      "description": "User ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "User name",
      "type": "string"
    },
    "profileChangedAt": {
      "description": "Profile change date",
      "format": "date-time",
      "type": "string"
    },
    "profileImagePath": {
      "description": "Profile image path",
      "type": "string"
    }
  },
  "required": [
    "avatarColor",
    "email",
    "id",
    "name",
    "profileChangedAt",
    "profileImagePath"
  ],
  "type": "object"
}
```

## PartnerUpdateDto


```json
{
  "properties": {},
  "type": "object"
}
```

## PeopleListItemDto


```json
{
  "properties": {
    "assetCount": {
      "description": "Number of timeline assets showing this person",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "featuredAssetId": {
      "description": "The photo the person's featured face is in (FL-37). Returned only to the person's owner, by GET and PUT /people/:id; null when there is none, when it is another account's photo, or when it may not be shown (trashed, hidden, Locked, a removed or invisible face, or hidden as NSFW)",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.1",
          "state": "Added"
        },
        {
          "version": "v3.2.1",
          "state": "Alpha"
        }
      ],
      "x-immich-state": "Alpha"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Is favorite",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.126.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "isHidden": {
      "description": "Is hidden",
      "type": "boolean"
    },
    "lastSeenAt": {
      "description": "Capture date of the most recent timeline asset showing this person",
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    },
    "thumbnailPath": {
      "description": "Thumbnail path",
      "type": "string"
    },
    "updatedAt": {
      "description": "Last update date",
      "format": "date-time",
      "type": "string",
      "x-immich-history": [
        {
          "version": "v1.107.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    }
  },
  "required": [
    "assetCount",
    "birthDate",
    "id",
    "isHidden",
    "lastSeenAt",
    "name",
    "thumbnailPath"
  ],
  "type": "object"
}
```

## PeopleResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether people are enabled",
      "type": "boolean"
    },
    "minimumFaces": {
      "description": "People face threshold",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sidebarWeb": {
      "description": "Whether people appear in web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "enabled",
    "sidebarWeb"
  ],
  "type": "object"
}
```

## PeopleResponseDto

Related models: [PeopleListItemDto](models-18.md#peoplelistitemdto).

```json
{
  "description": "People response",
  "properties": {
    "hasNextPage": {
      "description": "Whether there are more pages",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v1.110.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable"
    },
    "hidden": {
      "description": "Number of hidden people",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    },
    "people": {
      "items": {
        "$ref": "#/components/schemas/PeopleListItemDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Total number of people",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "hidden",
    "people",
    "total"
  ],
  "type": "object"
}
```

## PeopleUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether people are enabled",
      "type": "boolean"
    },
    "minimumFaces": {
      "description": "People face threshold",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "sidebarWeb": {
      "description": "Whether people appear in web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## PeopleUpdateDto

Related models: [PeopleUpdateItem](models-18.md#peopleupdateitem).

```json
{
  "properties": {
    "people": {
      "description": "People to update",
      "items": {
        "$ref": "#/components/schemas/PeopleUpdateItem"
      },
      "type": "array"
    }
  },
  "required": [
    "people"
  ],
  "type": "object"
}
```

## PeopleUpdateItem


```json
{
  "properties": {
    "birthDate": {
      "description": "Person date of birth",
      "format": "date",
      "nullable": true,
      "type": "string"
    },
    "color": {
      "description": "Person color (hex)",
      "nullable": true,
      "pattern": "^#?([0-9A-Fa-f]{3}|[0-9A-Fa-f]{4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$",
      "type": "string"
    },
    "featureFaceAssetId": {
      "description": "Asset ID used for feature face thumbnail",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Person ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "isHidden": {
      "description": "Person visibility (hidden)",
      "type": "boolean"
    },
    "name": {
      "description": "Person name",
      "type": "string"
    }
  },
  "required": [
    "id"
  ],
  "type": "object"
}
```

## Permission


```json
{
  "description": "List of permissions",
  "enum": [
    "all",
    "activity.create",
    "activity.read",
    "activity.update",
    "activity.delete",
    "activity.statistics",
    "apiKey.create",
    "apiKey.read",
    "apiKey.update",
    "apiKey.delete",
    "apiKey.rotate",
    "asset.read",
    "asset.update",
    "asset.delete",
    "asset.statistics",
    "asset.share",
    "asset.view",
    "asset.download",
    "asset.upload",
    "asset.copy",
    "asset.derive",
    "assetFile.read",
    "assetFile.delete",
    "assetFile.download",
    "asset.edit.get",
    "asset.edit.create",
    "asset.edit.delete",
    "album.create",
    "album.read",
    "album.update",
    "album.delete",
    "album.statistics",
    "album.share",
    "album.download",
    "albumAsset.create",
    "albumAsset.delete",
    "albumUser.create",
    "albumUser.update",
    "albumUser.delete",
    "auth.changePassword",
    "authDevice.delete",
    "archive.read",
    "backup.list",
    "backup.download",
    "backup.upload",
    "backup.delete",
    "clusterGroup.read",
    "clusterGroup.leave",
    "clusterGroupRequest.create",
    "clusterGroupRequest.read",
    "clusterGroupRequest.delete",
    "adminConfig.read",
    "adminConfig.update",
    "userConfig.read",
    "duplicate.read",
    "duplicate.delete",
    "face.create",
    "face.read",
    "face.update",
    "face.delete",
    "folder.read",
    "job.create",
    "job.read",
    "library.create",
    "library.read",
    "library.update",
    "library.delete",
    "library.statistics",
    "timeline.read",
    "timeline.download",
    "maintenance",
    "map.read",
    "map.search",
    "memory.create",
    "memory.read",
    "memory.update",
    "memory.delete",
    "memory.statistics",
    "memoryAsset.create",
    "memoryAsset.delete",
    "notification.create",
    "notification.read",
    "notification.update",
    "notification.delete",
    "partner.create",
    "partner.read",
    "partner.update",
    "partner.delete",
    "person.create",
    "person.read",
    "person.update",
    "person.delete",
    "person.statistics",
    "person.merge",
    "person.reassign",
    "pinCode.create",
    "pinCode.update",
    "pinCode.delete",
    "plugin.create",
    "plugin.read",
    "plugin.update",
    "plugin.delete",
    "server.about",
    "server.apkLinks",
    "server.storage",
    "server.statistics",
    "server.versionCheck",
    "adminCloud.read",
    "adminCloud.update",
    "adminCloud.link",
    "adminRemoteAccess.update",
    "frameleafAccount.read",
    "frameleafAccount.update",
    "adminCloudMl.read",
    "adminCloudMl.update",
    "cloudMlJob.create",
    "cloudMlJob.read",
    "adminCloudBackup.read",
    "adminCloudBackup.update",
    "adminCloudBackup.run",
    "serverLicense.read",
    "serverLicense.update",
    "serverLicense.delete",
    "session.create",
    "session.read",
    "session.update",
    "session.delete",
    "session.lock",
    "sharedLink.create",
    "sharedLink.read",
    "sharedLink.update",
    "sharedLink.delete",
    "stack.create",
    "stack.read",
    "stack.update",
    "stack.delete",
    "sync.stream",
    "syncCheckpoint.read",
    "syncCheckpoint.update",
    "syncCheckpoint.delete",
    "systemConfig.read",
    "systemConfig.update",
    "systemMetadata.read",
    "systemMetadata.update",
    "tag.create",
    "tag.read",
    "tag.update",
    "tag.delete",
    "tag.asset",
    "user.read",
    "user.update",
    "userLicense.create",
    "userLicense.read",
    "userLicense.update",
    "userLicense.delete",
    "userOnboarding.read",
    "userOnboarding.update",
    "userOnboarding.delete",
    "userPreference.read",
    "userPreference.update",
    "userProfileImage.create",
    "userProfileImage.read",
    "userProfileImage.update",
    "userProfileImage.delete",
    "queue.read",
    "queue.update",
    "queueJob.create",
    "queueJob.read",
    "queueJob.update",
    "queueJob.delete",
    "workflow.create",
    "workflow.read",
    "workflow.update",
    "workflow.delete",
    "workflow.logs",
    "adminUser.create",
    "adminUser.read",
    "adminUser.update",
    "adminUser.delete",
    "adminSession.read",
    "adminSession.delete",
    "adminAuth.unlinkAll"
  ],
  "type": "string"
}
```
