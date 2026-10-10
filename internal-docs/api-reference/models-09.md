# Server API models 9

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## CloudMlConsentStateDto

Related models: [CloudMlConsentFeaturesDto](models-08.md#cloudmlconsentfeaturesdto).

```json
{
  "properties": {
    "acceptedVersion": {
      "description": "The version an administrator accepted on this server",
      "nullable": true,
      "type": "string"
    },
    "documentUrl": {
      "description": "The full consent text, when Frameleaf Cloud links one",
      "nullable": true,
      "type": "string"
    },
    "features": {
      "$ref": "#/components/schemas/CloudMlConsentFeaturesDto",
      "description": "The feature choices on record"
    },
    "outdated": {
      "description": "Consent was given, but for an older version; processing is refused until renewed",
      "type": "boolean"
    },
    "recordedVersion": {
      "description": "The version Frameleaf Cloud has on record for this server",
      "nullable": true,
      "type": "string"
    },
    "requiredVersion": {
      "description": "The consent version Frameleaf Cloud requires now",
      "type": "string"
    },
    "summary": {
      "description": "What the consent covers, as Frameleaf Cloud words it",
      "type": "string"
    }
  },
  "required": [
    "acceptedVersion",
    "documentUrl",
    "features",
    "outdated",
    "recordedVersion",
    "requiredVersion",
    "summary"
  ],
  "type": "object"
}
```

## CloudMlConsentTermsDto


```json
{
  "properties": {
    "documentUrl": {
      "description": "The full consent text, when Frameleaf Cloud links one",
      "nullable": true,
      "type": "string"
    },
    "recordedVersion": {
      "description": "The version Frameleaf Cloud has on record for this server",
      "nullable": true,
      "type": "string"
    },
    "requiredVersion": {
      "description": "The consent version the chosen features need now",
      "type": "string"
    },
    "summary": {
      "description": "What that version covers, as Frameleaf Cloud words it",
      "type": "string"
    },
    "textSha256": {
      "description": "SHA-256 of that version’s text; sent back when accepting, so only the terms shown are recorded",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "documentUrl",
    "recordedVersion",
    "requiredVersion",
    "summary",
    "textSha256"
  ],
  "type": "object"
}
```

## CloudMlDescriptionBatchCreateDto


```json
{
  "properties": {
    "estimateId": {
      "description": "The estimate to queue; its model, photos and prices are read from the server, never sent",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    }
  },
  "required": [
    "estimateId"
  ],
  "type": "object"
}
```

## CloudMlDescriptionBatchesResponseDto


```json
{
  "properties": {
    "batches": {
      "description": "Batches queued",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "operationIds": {
      "description": "The queued batches; each shows in Activity",
      "items": {
        "type": "string"
      },
      "type": "array"
    },
    "photos": {
      "description": "Photos in them",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "batches",
    "operationIds",
    "photos"
  ],
  "type": "object"
}
```

## CloudMlDescriptionEstimateResponseDto

Related models: [CloudMlDescriptionGuidanceDto](models-09.md#cloudmldescriptionguidancedto).

```json
{
  "properties": {
    "availableUsd": {
      "description": "AI Wallet balance minus holds, USD",
      "format": "double",
      "type": "number"
    },
    "basis": {
      "description": "measured: from the model's measured GPU time; modelled: from its expected GPU time",
      "type": "string"
    },
    "batches": {
      "description": "Batches they would be sent in; each batch is one cloud job",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "dailyCapUsd": {
      "description": "The daily AI Wallet limit, USD, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "estimateId": {
      "description": "The estimate the server keeps; queueing the backfill names only this, or null when there is nothing to queue",
      "nullable": true,
      "type": "string"
    },
    "expiresAt": {
      "description": "Until when the estimate may be queued, or null",
      "nullable": true,
      "type": "string"
    },
    "guidance": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlDescriptionGuidanceDto"
        }
      ],
      "description": "Set when the model is of the 72B class and some batches are too small for its start fee to pay off",
      "nullable": true
    },
    "holdUsd": {
      "description": "What the AI Wallet would hold while the batches run, USD",
      "format": "double",
      "type": "number"
    },
    "modelId": {
      "description": "The catalogue model SKU the batches would use",
      "type": "string"
    },
    "modelName": {
      "description": "Its catalogue name",
      "type": "string"
    },
    "p50Usd": {
      "description": "Likely cost of every batch together, USD",
      "format": "double",
      "type": "number"
    },
    "p90Usd": {
      "description": "Cost at most, in nine cases out of ten, USD",
      "format": "double",
      "type": "number"
    },
    "perPhotoP50Usd": {
      "description": "Likely GPU time cost per photo, USD",
      "format": "double",
      "type": "number"
    },
    "perPhotoP90Usd": {
      "description": "GPU time cost per photo at most, in nine cases out of ten, USD",
      "format": "double",
      "type": "number"
    },
    "photos": {
      "description": "Photos that would be described",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "refusal": {
      "description": "Why the backfill cannot start now, or null when it can",
      "nullable": true,
      "type": "string"
    },
    "spentTodayUsd": {
      "description": "Spent today, USD",
      "format": "double",
      "type": "number"
    },
    "startupUsd": {
      "description": "The start fee each batch pays, USD",
      "format": "double",
      "type": "number"
    },
    "truncated": {
      "description": "More photos need a description than one backfill covers; run another afterwards for the rest",
      "type": "boolean"
    }
  },
  "required": [
    "availableUsd",
    "basis",
    "batches",
    "dailyCapUsd",
    "estimateId",
    "expiresAt",
    "guidance",
    "holdUsd",
    "modelId",
    "modelName",
    "p50Usd",
    "p90Usd",
    "perPhotoP50Usd",
    "perPhotoP90Usd",
    "photos",
    "refusal",
    "spentTodayUsd",
    "startupUsd",
    "truncated"
  ],
  "type": "object"
}
```

## CloudMlDescriptionGuidanceDto


```json
{
  "properties": {
    "minimumBatch": {
      "description": "The batch size below which the start fee makes up most of the cost with this model",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "smallBatches": {
      "description": "How many of the batches are smaller than that",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "suggestedModelId": {
      "description": "A model of the 27B/35B class the catalogue offers for small batches, when there is one",
      "nullable": true,
      "type": "string"
    },
    "suggestedModelName": {
      "description": "Its catalogue name",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "minimumBatch",
    "smallBatches",
    "suggestedModelId",
    "suggestedModelName"
  ],
  "type": "object"
}
```

## CloudMlDestinationCreateDto

Related models: [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "budgetLimitUsd": {
      "format": "double",
      "minimum": 0,
      "nullable": true,
      "type": "number"
    },
    "name": {
      "default": "Frameleaf Cloud",
      "maxLength": 80,
      "minLength": 1,
      "type": "string"
    },
    "workloads": {
      "description": "The workloads Frameleaf Cloud may run; faces, search and text recognition are refused",
      "items": {
        "$ref": "#/components/schemas/MlWorkload"
      },
      "maxItems": 16,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "workloads"
  ],
  "type": "object"
}
```

## CloudMlJobActivityDto

Related models: [CloudMlJobActivityStage](models-09.md#cloudmljobactivitystage), [CloudMlJobCostDto](models-09.md#cloudmljobcostdto), [CloudMlJobPurpose](models-09.md#cloudmljobpurpose), [CloudMlJobStage](models-09.md#cloudmljobstage).

```json
{
  "properties": {
    "activityStage": {
      "$ref": "#/components/schemas/CloudMlJobActivityStage"
    },
    "cloudStatus": {
      "description": "Frameleaf Cloud’s own state of the job, or null before it was sent",
      "nullable": true,
      "type": "string"
    },
    "cost": {
      "$ref": "#/components/schemas/CloudMlJobCostDto"
    },
    "model": {
      "description": "The catalogue name of the model the job runs",
      "type": "string"
    },
    "modelSku": {
      "type": "string"
    },
    "plannedWorkers": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "progressUnit": {
      "description": "items, seconds or segments, when Frameleaf Cloud reports progress",
      "nullable": true,
      "type": "string"
    },
    "purpose": {
      "$ref": "#/components/schemas/CloudMlJobPurpose"
    },
    "stage": {
      "$ref": "#/components/schemas/CloudMlJobStage"
    },
    "workers": {
      "description": "Workers started so far",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "activityStage",
    "cloudStatus",
    "cost",
    "model",
    "modelSku",
    "plannedWorkers",
    "progressUnit",
    "purpose",
    "stage",
    "workers"
  ],
  "type": "object"
}
```

## CloudMlJobActivityStage


```json
{
  "description": "Where the job is, as Activity shows it; starting is a worker cold start",
  "enum": [
    "queued",
    "starting",
    "running",
    "paused",
    "done",
    "failed",
    "cancelled"
  ],
  "type": "string"
}
```

## CloudMlJobConsentDto


```json
{
  "properties": {
    "documentUrl": {
      "description": "The full text, when Frameleaf Cloud links one",
      "nullable": true,
      "type": "string"
    },
    "summary": {
      "description": "What leaves this server and what is kept, as Frameleaf Cloud words it",
      "type": "string"
    },
    "version": {
      "description": "The consent version this job is confirmed under; send it back with the job",
      "type": "string"
    }
  },
  "required": [
    "documentUrl",
    "summary",
    "version"
  ],
  "type": "object"
}
```

## CloudMlJobCostDto

Related models: [CloudMlJobCostOutcome](models-09.md#cloudmljobcostoutcome).

```json
{
  "properties": {
    "estimatedP50Usd": {
      "description": "The likely total the owner confirmed, USD",
      "format": "double",
      "type": "number"
    },
    "estimatedP90Usd": {
      "description": "The high end the owner confirmed, USD",
      "format": "double",
      "type": "number"
    },
    "holdUsd": {
      "description": "What the AI Wallet holds for the job, USD",
      "format": "double",
      "type": "number"
    },
    "note": {
      "description": "Frameleaf Cloud’s note on the settlement",
      "nullable": true,
      "type": "string"
    },
    "outcome": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlJobCostOutcome"
        }
      ],
      "description": "not_charged: the hold went back in full (a failure on the cloud side, or a job that never ran)",
      "nullable": true
    },
    "settledUsd": {
      "description": "What the job was charged once settled, USD; null until then",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "soFarUsd": {
      "description": "Metered so far, never above the hold, USD; null before a worker starts",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "estimatedP50Usd",
    "estimatedP90Usd",
    "holdUsd",
    "note",
    "outcome",
    "settledUsd",
    "soFarUsd"
  ],
  "type": "object"
}
```

## CloudMlJobCostOutcome


```json
{
  "enum": [
    "charged",
    "not_charged",
    "refunded"
  ],
  "type": "string"
}
```

## CloudMlJobCreateDto


```json
{
  "properties": {
    "acknowledgeDataLeaves": {
      "description": "The owner confirmed that the preview or file leaves this server for Frameleaf Cloud",
      "enum": [
        true
      ],
      "type": "boolean"
    },
    "consentVersion": {
      "description": "The consent version shown with the estimate",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    },
    "estimateId": {
      "description": "The estimate the owner saw and confirmed",
      "maxLength": 64,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "acknowledgeDataLeaves",
    "consentVersion",
    "estimateId"
  ],
  "type": "object"
}
```

## CloudMlJobEstimateRequestDto

Related models: [AssetRestorationMode](models-06.md#assetrestorationmode), [AssetRestorationRegionDto](models-06.md#assetrestorationregiondto), [CloudMlJobPurpose](models-09.md#cloudmljobpurpose), [CloudMlJobStage](models-09.md#cloudmljobstage).

```json
{
  "properties": {
    "assetId": {
      "description": "The photo or video",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "destinationId": {
      "description": "The Frameleaf Cloud processing destination; never inferred",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "factor": {
      "anyOf": [
        {
          "type": "number",
          "format": "double",
          "enum": [
            2
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            4
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            8
          ]
        }
      ],
      "description": "Smooth motion preview: how many frames each frame becomes (2×, 4× or 8×)"
    },
    "keepGrain": {
      "description": "Restoration preview: keep fine film grain",
      "type": "boolean"
    },
    "mode": {
      "$ref": "#/components/schemas/AssetRestorationMode",
      "description": "Restoration preview: faithful or creative"
    },
    "modelSku": {
      "description": "The model chosen on the slider; omitted, the chosen or recommended model for this work",
      "pattern": "^ms_[\\dA-HJKMNP-TV-Z]{8}$",
      "type": "string"
    },
    "purpose": {
      "$ref": "#/components/schemas/CloudMlJobPurpose"
    },
    "region": {
      "$ref": "#/components/schemas/AssetRestorationRegionDto",
      "description": "Preview: the part of the frame to preview"
    },
    "restorationId": {
      "description": "For the full stage: the reviewed preview it renders in full, with the same model and settings. Omitted, a full-stage estimate is a quote for the whole file from the source alone (quoteOnly), priced with the given settings; it cannot be confirmed",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stage": {
      "$ref": "#/components/schemas/CloudMlJobStage"
    },
    "upscale": {
      "anyOf": [
        {
          "type": "number",
          "format": "double",
          "enum": [
            2
          ]
        },
        {
          "type": "number",
          "format": "double",
          "enum": [
            4
          ]
        }
      ],
      "description": "Restoration preview: 2× or 4×, capped at 4K"
    }
  },
  "required": [
    "assetId",
    "destinationId",
    "purpose",
    "stage"
  ],
  "type": "object"
}
```

## CloudMlJobEstimateResponseDto

Related models: [CloudMlJobConsentDto](models-09.md#cloudmljobconsentdto), [CloudMlJobModelDto](models-09.md#cloudmljobmodeldto), [CloudMlJobPerUnitDto](models-09.md#cloudmljobperunitdto), [CloudMlJobPermissionDto](models-09.md#cloudmljobpermissiondto), [CloudMlJobRefusalDto](models-09.md#cloudmljobrefusaldto), [CloudMlJobUpscaleDto](models-09.md#cloudmljobupscaledto), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "availableUsd": {
      "description": "AI Wallet balance minus holds, USD",
      "format": "double",
      "type": "number"
    },
    "basis": {
      "description": "measured: from the model's measured GPU time; modelled: from its expected GPU time",
      "type": "string"
    },
    "coldStartSeconds": {
      "description": "Expected time to start a worker",
      "format": "double",
      "type": "number"
    },
    "consent": {
      "$ref": "#/components/schemas/CloudMlJobConsentDto"
    },
    "dailyCapUsd": {
      "description": "The daily AI Wallet limit, USD, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "estimateId": {
      "description": "What confirming the job names; the server keeps everything else",
      "type": "string"
    },
    "expiresAt": {
      "description": "After this, estimate again; it is never reused",
      "format": "date-time",
      "type": "string"
    },
    "holdUsd": {
      "description": "What the AI Wallet holds while the job runs, USD; released when it settles",
      "format": "double",
      "type": "number"
    },
    "minimumUsd": {
      "description": "The least the job can cost once a worker starts (one start fee), USD",
      "format": "double",
      "type": "number"
    },
    "model": {
      "$ref": "#/components/schemas/CloudMlJobModelDto"
    },
    "models": {
      "description": "Every model Frameleaf Cloud offers for this work here, light to heavy, for the model slider",
      "items": {
        "$ref": "#/components/schemas/CloudMlJobModelDto"
      },
      "type": "array"
    },
    "p50Usd": {
      "description": "Likely total: GPU time × rate + start fees, USD",
      "format": "double",
      "type": "number"
    },
    "p90Usd": {
      "description": "High end, in nine cases out of ten, USD",
      "format": "double",
      "type": "number"
    },
    "perSecondUsd": {
      "description": "The GPU rate per metered second, USD",
      "format": "double",
      "type": "number"
    },
    "perUnit": {
      "$ref": "#/components/schemas/CloudMlJobPerUnitDto"
    },
    "permission": {
      "$ref": "#/components/schemas/CloudMlJobPermissionDto"
    },
    "plannedWorkers": {
      "description": "Serverless workers the job is planned on, at most 5; each adds a start fee",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "quoteOnly": {
      "description": "A full-stage quote made without a reviewed preview (FL-348): what the whole file would cost with these settings. It cannot be confirmed; preview first, then estimate the reviewed preview in full",
      "type": "boolean"
    },
    "refusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlJobRefusalDto"
        }
      ],
      "description": "Why the job cannot be sent now, or null when it can",
      "nullable": true
    },
    "runSeconds": {
      "description": "Expected GPU time once running (p50)",
      "format": "double",
      "type": "number"
    },
    "spentTodayUsd": {
      "description": "Spent today, USD",
      "format": "double",
      "type": "number"
    },
    "startFeeUsd": {
      "description": "One start fee, USD",
      "format": "double",
      "type": "number"
    },
    "startupUsd": {
      "description": "Start fees: one start fee per planned worker, USD",
      "format": "double",
      "type": "number"
    },
    "upscale": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlJobUpscaleDto"
        }
      ],
      "description": "Photo upscales only (FC-46): the factor each photo really gets under the 64 MP output cap; null otherwise",
      "nullable": true
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "availableUsd",
    "basis",
    "coldStartSeconds",
    "consent",
    "dailyCapUsd",
    "estimateId",
    "expiresAt",
    "holdUsd",
    "minimumUsd",
    "model",
    "models",
    "p50Usd",
    "p90Usd",
    "perSecondUsd",
    "perUnit",
    "permission",
    "plannedWorkers",
    "quoteOnly",
    "refusal",
    "runSeconds",
    "spentTodayUsd",
    "startFeeUsd",
    "startupUsd",
    "upscale",
    "workload"
  ],
  "type": "object"
}
```

## CloudMlJobModelDto


```json
{
  "properties": {
    "gpu": {
      "description": "The GPU class it runs on, for people only",
      "type": "string"
    },
    "label": {
      "description": "The catalogue name",
      "type": "string"
    },
    "perSecondUsd": {
      "description": "The GPU rate per metered second, USD",
      "format": "double",
      "type": "number"
    },
    "rank": {
      "description": "Position on the model slider, 1 = lightest",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "rev": {
      "description": "The model revision the estimate is bound to",
      "type": "string"
    },
    "sku": {
      "description": "The catalogue model SKU",
      "type": "string"
    },
    "startFeeUsd": {
      "description": "One start fee, USD",
      "format": "double",
      "type": "number"
    }
  },
  "required": [
    "gpu",
    "label",
    "perSecondUsd",
    "rank",
    "rev",
    "sku",
    "startFeeUsd"
  ],
  "type": "object"
}
```

## CloudMlJobPerUnitDto


```json
{
  "properties": {
    "p50Usd": {
      "description": "Likely cost per unit, start fees included, USD; an estimate, never a price",
      "format": "double",
      "type": "number"
    },
    "p90Usd": {
      "description": "Cost per unit at most, in nine cases out of ten, start fees included, USD",
      "format": "double",
      "type": "number"
    },
    "quantity": {
      "description": "How many units the job has",
      "format": "double",
      "type": "number"
    },
    "unit": {
      "description": "What one unit is",
      "enum": [
        "photo",
        "minute"
      ],
      "type": "string"
    }
  },
  "required": [
    "p50Usd",
    "p90Usd",
    "quantity",
    "unit"
  ],
  "type": "object"
}
```

## CloudMlJobPermissionDto


```json
{
  "properties": {
    "canConfirm": {
      "description": "Whether this person may confirm the job; administrators always may",
      "type": "boolean"
    },
    "monthlyCapUsd": {
      "description": "This person's monthly Frameleaf Cloud limit, USD, or null when none applies",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "reason": {
      "description": "not-allowed (an administrator has not allowed this person) or monthly-cap, when they may not",
      "nullable": true,
      "type": "string"
    },
    "spentThisMonthUsd": {
      "description": "Settled this month plus the holds of their running jobs, USD, or null when no limit applies",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "canConfirm",
    "monthlyCapUsd",
    "reason",
    "spentThisMonthUsd"
  ],
  "type": "object"
}
```

## CloudMlJobPurpose


```json
{
  "description": "restoration: restore or upscale; smooth-motion: frame interpolation for slow motion or frame rate",
  "enum": [
    "restoration",
    "smooth-motion"
  ],
  "type": "string"
}
```

## CloudMlJobRefusalDto


```json
{
  "properties": {
    "code": {
      "description": "insufficient-credits, daily-cap or budget-exceeded; nothing is sent and the model is never changed",
      "type": "string"
    },
    "message": {
      "type": "string"
    }
  },
  "required": [
    "code",
    "message"
  ],
  "type": "object"
}
```

## CloudMlJobResponseDto

Related models: [CloudMlJobStage](models-09.md#cloudmljobstage).

```json
{
  "properties": {
    "operationId": {
      "description": "The job in Activity; cancel it there",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "restorationId": {
      "description": "The restoration or Smooth motion version it renders",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stage": {
      "$ref": "#/components/schemas/CloudMlJobStage"
    }
  },
  "required": [
    "operationId",
    "restorationId",
    "stage"
  ],
  "type": "object"
}
```

## CloudMlJobStage


```json
{
  "description": "preview: a short clip or a crop first; full: the whole file, after the preview was reviewed",
  "enum": [
    "preview",
    "full"
  ],
  "type": "string"
}
```

## CloudMlJobUpscaleDto


```json
{
  "properties": {
    "appliedScale": {
      "description": "The factor Frameleaf Cloud will really use and prices: lower when the 64 MP output cap needs it",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "lowered": {
      "description": "Whether the 64 MP output cap lowered the factor; shown before confirming",
      "type": "boolean"
    },
    "outputHeight": {
      "description": "The height the result will have, in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "outputWidth": {
      "description": "The width the result will have, in pixels",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "requestedScale": {
      "description": "The upscale factor that was asked for (2 or 4)",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "appliedScale",
    "lowered",
    "outputHeight",
    "outputWidth",
    "requestedScale"
  ],
  "type": "object"
}
```

## CloudMlModelChoiceDto

Related models: [CloudMlModelGroup](models-09.md#cloudmlmodelgroup).

```json
{
  "properties": {
    "group": {
      "$ref": "#/components/schemas/CloudMlModelGroup"
    },
    "modelId": {
      "description": "The chosen catalogue model SKU, or null when the group uses the catalogue default",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "group",
    "modelId"
  ],
  "type": "object"
}
```

## CloudMlModelChoiceUpdateDto


```json
{
  "properties": {
    "modelId": {
      "description": "A catalogue model SKU of exactly this group; null uses the catalogue default",
      "maxLength": 200,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "modelId"
  ],
  "type": "object"
}
```

## CloudMlModelChoicesResponseDto

Related models: [CloudMlModelChoiceDto](models-09.md#cloudmlmodelchoicedto).

```json
{
  "properties": {
    "choices": {
      "description": "Every model group, in a fixed order",
      "items": {
        "$ref": "#/components/schemas/CloudMlModelChoiceDto"
      },
      "type": "array"
    }
  },
  "required": [
    "choices"
  ],
  "type": "object"
}
```

## CloudMlModelDto

Related models: [CloudMlModelGroup](models-09.md#cloudmlmodelgroup), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "description": {
      "type": "string"
    },
    "fingerprint": {
      "type": "string"
    },
    "group": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlModelGroup"
        }
      ],
      "description": "The group this model is chosen for, or null for one this server does not know",
      "nullable": true
    },
    "id": {
      "type": "string"
    },
    "isDefault": {
      "description": "Frameleaf Cloud recommends this model for its workload (and restoration mode) in this region; work with no chosen model uses it",
      "type": "boolean"
    },
    "name": {
      "type": "string"
    },
    "priceUsd": {
      "description": "Price per unit, USD",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "pricingUnit": {
      "description": "What one price unit is (for example an image or a video minute)",
      "nullable": true,
      "type": "string"
    },
    "rank": {
      "description": "Position on its workload's ladder, 1 = lightest",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "workload": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlWorkload"
        }
      ],
      "description": "The workload this model serves, or null for one this server does not know",
      "nullable": true
    }
  },
  "required": [
    "description",
    "fingerprint",
    "group",
    "id",
    "isDefault",
    "name",
    "priceUsd",
    "pricingUnit",
    "rank",
    "workload"
  ],
  "type": "object"
}
```

## CloudMlModelGroup


```json
{
  "description": "What a Frameleaf Cloud model is chosen for: a cloud workload, restoration per mode, and Studio AI speech to text (transcription) and speech (tts)",
  "enum": [
    "descriptions",
    "upscale",
    "restoration-faithful",
    "restoration-creative",
    "interpolation",
    "transcription",
    "tts"
  ],
  "type": "string"
}
```

## CloudMlSettlementDto

Related models: [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "cloudJobId": {
      "description": "The job id Frameleaf Cloud settled",
      "type": "string"
    },
    "computeSku": {
      "description": "The compute SKU the job ran on, when reported",
      "nullable": true,
      "type": "string"
    },
    "costUsd": {
      "description": "The settled charge, USD",
      "format": "double",
      "type": "number"
    },
    "credits": {
      "description": "Credits the charge used, when reported",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "estimateUsd": {
      "description": "The estimate shown before the job, USD",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "finishedAt": {
      "type": "string"
    },
    "gpuSeconds": {
      "description": "Metered GPU time, seconds, when reported",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "jobName": {
      "description": "The server job that sent the work, when recorded",
      "nullable": true,
      "type": "string"
    },
    "modelSku": {
      "description": "The catalogue model SKU the job used, when reported",
      "nullable": true,
      "type": "string"
    },
    "succeeded": {
      "description": "The request finished successfully",
      "type": "boolean"
    },
    "workers": {
      "description": "Workers the job ran on (each paid a start fee), when reported",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "cloudJobId",
    "computeSku",
    "costUsd",
    "credits",
    "estimateUsd",
    "finishedAt",
    "gpuSeconds",
    "jobName",
    "modelSku",
    "succeeded",
    "workers",
    "workload"
  ],
  "type": "object"
}
```

## CloudMlSettlementsResponseDto

Related models: [CloudMlSettlementDto](models-09.md#cloudmlsettlementdto).

```json
{
  "properties": {
    "items": {
      "description": "Settled charges, newest first (at most 50)",
      "items": {
        "$ref": "#/components/schemas/CloudMlSettlementDto"
      },
      "type": "array"
    }
  },
  "required": [
    "items"
  ],
  "type": "object"
}
```

## CloudMlStatusResponseDto

Related models: [CloudMlConnection](models-08.md#cloudmlconnection), [CloudMlConsentStateDto](models-09.md#cloudmlconsentstatedto), [CloudMlWalletDto](models-09.md#cloudmlwalletdto), [MlDestinationResponseDto](models-18.md#mldestinationresponsedto).

```json
{
  "properties": {
    "checkedAt": {
      "type": "string"
    },
    "connection": {
      "$ref": "#/components/schemas/CloudMlConnection"
    },
    "consent": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlConsentStateDto"
        }
      ],
      "nullable": true
    },
    "destination": {
      "allOf": [
        {
          "$ref": "#/components/schemas/MlDestinationResponseDto"
        }
      ],
      "description": "The Frameleaf Cloud destination, once added",
      "nullable": true
    },
    "detail": {
      "description": "Why the connection is not ready, in plain words",
      "nullable": true,
      "type": "string"
    },
    "enabled": {
      "description": "Frameleaf Cloud processing is turned on in settings",
      "type": "boolean"
    },
    "entitled": {
      "description": "Cloud processing entitlement, when the cloud answered",
      "nullable": true,
      "type": "boolean"
    },
    "region": {
      "description": "The Frameleaf account's data region",
      "nullable": true,
      "type": "string"
    },
    "wallet": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudMlWalletDto"
        }
      ],
      "description": "The last AI Wallet read, or null",
      "nullable": true
    }
  },
  "required": [
    "checkedAt",
    "connection",
    "consent",
    "destination",
    "detail",
    "enabled",
    "entitled",
    "region",
    "wallet"
  ],
  "type": "object"
}
```

## CloudMlWalletDto


```json
{
  "properties": {
    "autoTopUp": {
      "description": "Automatic top-up with the payment method saved on the account",
      "type": "boolean"
    },
    "availableUsd": {
      "description": "Balance minus holds, USD",
      "format": "double",
      "type": "number"
    },
    "balanceUsd": {
      "description": "AI Wallet balance, USD",
      "format": "double",
      "type": "number"
    },
    "dailyCapUsd": {
      "description": "Daily limit, USD, or null",
      "format": "double",
      "nullable": true,
      "type": "number"
    },
    "heldUsd": {
      "description": "Held by running jobs, USD",
      "format": "double",
      "type": "number"
    },
    "settingsUrl": {
      "description": "Where the account owner raises the daily cap or turns on automatic top-up, when Frameleaf Cloud named it; this server can only lower the cap or turn automatic top-up off",
      "nullable": true,
      "type": "string"
    },
    "spentTodayUsd": {
      "description": "Spent today, USD",
      "format": "double",
      "type": "number"
    },
    "topUpUrl": {
      "description": "Where to add credit; only when Frameleaf Cloud returned one",
      "nullable": true,
      "type": "string"
    },
    "updatedAt": {
      "description": "When this balance was read",
      "type": "string"
    }
  },
  "required": [
    "autoTopUp",
    "availableUsd",
    "balanceUsd",
    "dailyCapUsd",
    "heldUsd",
    "settingsUrl",
    "spentTodayUsd",
    "topUpUrl",
    "updatedAt"
  ],
  "type": "object"
}
```

## CloudMlWalletUpdateDto


```json
{
  "properties": {
    "autoTopUp": {
      "description": "Top up automatically when available credit runs low",
      "type": "boolean"
    },
    "dailyCapUsd": {
      "description": "Daily spending cap, USD",
      "format": "double",
      "maximum": 1000,
      "minimum": 1,
      "type": "number"
    }
  },
  "type": "object"
}
```

## CloudPermissionsDto


```json
{
  "properties": {
    "allowBackupTrigger": {
      "description": "Frameleaf Cloud may start a cloud backup run",
      "type": "boolean"
    },
    "allowEntitlementRefresh": {
      "description": "Frameleaf Cloud may refresh the plan and rotate this server’s credentials",
      "type": "boolean"
    },
    "allowRemoteEnable": {
      "description": "Frameleaf Cloud may turn remote access on or off",
      "type": "boolean"
    }
  },
  "required": [
    "allowBackupTrigger",
    "allowEntitlementRefresh",
    "allowRemoteEnable"
  ],
  "type": "object"
}
```

## CloudPermissionsUpdateDto


```json
{
  "properties": {
    "allowBackupTrigger": {
      "description": "Frameleaf Cloud may start a cloud backup run",
      "type": "boolean"
    },
    "allowEntitlementRefresh": {
      "description": "Frameleaf Cloud may refresh the plan and rotate this server’s credentials",
      "type": "boolean"
    },
    "allowRemoteEnable": {
      "description": "Frameleaf Cloud may turn remote access on or off",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## CloudRemoteAccessUpdateDto


```json
{
  "properties": {
    "allowOriginalsOverRelay": {
      "description": "Allow original downloads, archives and database backups through the relay",
      "type": "boolean"
    },
    "allowPasswordOverRelay": {
      "description": "Allow password sign-in away from home",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## CloudRouteMode


```json
{
  "description": "local: this server or a home-network worker only; both: each job lets the person pick; cloud: Frameleaf Cloud only",
  "enum": [
    "local",
    "both",
    "cloud"
  ],
  "type": "string"
}
```

## CloudSignInUpdateDto


```json
{
  "properties": {
    "buttonText": {
      "description": "The Sign in with Frameleaf button text",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "invitedStorageQuota": {
      "description": "Storage quota in GiB for accounts created through a Frameleaf invitation from now on; null is unlimited",
      "maximum": 1000000,
      "minimum": 0,
      "nullable": true,
      "type": "integer"
    },
    "showOnLocalLogin": {
      "description": "Offer Sign in with Frameleaf on the login page at home",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## CloudStatusResponseDto

Related models: [CloudHeartbeatField](models-08.md#cloudheartbeatfield), [CloudLinkPendingDto](models-08.md#cloudlinkpendingdto), [CloudLinkRefusal](models-08.md#cloudlinkrefusal), [CloudLinkResult](models-08.md#cloudlinkresult), [CloudLinkState](models-08.md#cloudlinkstate), [CloudPermissionsDto](models-09.md#cloudpermissionsdto).

```json
{
  "properties": {
    "account": {
      "description": "The linked Frameleaf account",
      "nullable": true,
      "properties": {
        "id": {
          "nullable": true,
          "type": "string"
        },
        "label": {
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "id",
        "label"
      ],
      "type": "object"
    },
    "allowOriginalsOverRelay": {
      "description": "Originals, archives and database backups may be downloaded through the relay",
      "type": "boolean"
    },
    "allowPasswordOverRelay": {
      "description": "Password sign-in is allowed away from home",
      "type": "boolean"
    },
    "cloneSuspected": {
      "description": "Frameleaf Cloud saw this server’s identity start from two places",
      "type": "boolean"
    },
    "cloudHost": {
      "description": "Host of the configured Frameleaf Cloud address",
      "nullable": true,
      "type": "string"
    },
    "configured": {
      "description": "FRAMELEAF_CLOUD_URL is set",
      "type": "boolean"
    },
    "dataRegion": {
      "nullable": true,
      "type": "string"
    },
    "heartbeatFailures": {
      "description": "Check-ins that failed in a row",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "heartbeatFields": {
      "description": "Exactly the fields each check-in sends; the \"What this server sends\" panel lists them",
      "items": {
        "$ref": "#/components/schemas/CloudHeartbeatField"
      },
      "type": "array"
    },
    "instanceId": {
      "description": "This server’s instance ID, once its identity exists",
      "nullable": true,
      "type": "string"
    },
    "keyFingerprint": {
      "description": "RFC 7638 thumbprint of this server’s key",
      "nullable": true,
      "type": "string"
    },
    "lastContactAt": {
      "nullable": true,
      "type": "string"
    },
    "lastError": {
      "description": "The last link or check-in problem, in plain words",
      "nullable": true,
      "type": "string"
    },
    "linkRefusal": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudLinkRefusal"
        }
      ],
      "description": "Why Frameleaf Cloud refused the last link attempt, while unlinked; null when it gave no such reason",
      "nullable": true
    },
    "linkResult": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudLinkResult"
        }
      ],
      "nullable": true
    },
    "linkTokenConfigured": {
      "description": "FRAMELEAF_LINK_TOKEN is set",
      "type": "boolean"
    },
    "linkedAt": {
      "nullable": true,
      "type": "string"
    },
    "manageUrl": {
      "description": "This server’s page on the Frameleaf account site, while linked; opened in a new tab",
      "nullable": true,
      "type": "string"
    },
    "pending": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudLinkPendingDto"
        }
      ],
      "nullable": true
    },
    "permissions": {
      "$ref": "#/components/schemas/CloudPermissionsDto"
    },
    "regionMismatch": {
      "description": "FC-18: Frameleaf Cloud refused the link because the account keeps its data in another region; lastError carries its message",
      "nullable": true,
      "properties": {
        "accountRegion": {
          "description": "The data region the Frameleaf account keeps its data in (eu, na)",
          "type": "string"
        },
        "canContinue": {
          "description": "The approved link is kept: linking again in the account’s region needs no new code",
          "type": "boolean"
        },
        "requestedRegion": {
          "description": "The data region this server asked for",
          "nullable": true,
          "type": "string"
        }
      },
      "required": [
        "accountRegion",
        "requestedRegion",
        "canContinue"
      ],
      "type": "object"
    },
    "relinkRequested": {
      "description": "Frameleaf Cloud asked an administrator to link again",
      "type": "boolean"
    },
    "remoteAccessEnabled": {
      "description": "Remote access is switched on for this linked server",
      "type": "boolean"
    },
    "revoked": {
      "nullable": true,
      "properties": {
        "at": {
          "type": "string"
        },
        "reason": {
          "type": "string"
        }
      },
      "required": [
        "at",
        "reason"
      ],
      "type": "object"
    },
    "signInButtonText": {
      "description": "The Sign in with Frameleaf button text",
      "type": "string"
    },
    "signInClientId": {
      "description": "The OpenID client ID for Sign in with Frameleaf",
      "nullable": true,
      "type": "string"
    },
    "signInInvitedStorageQuota": {
      "description": "Storage quota in GiB for accounts created through a Frameleaf invitation; null is unlimited",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "signInIssuer": {
      "nullable": true,
      "type": "string"
    },
    "signInLinkedAccounts": {
      "description": "Accounts here linked to a Frameleaf account",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "signInShowOnLocalLogin": {
      "description": "Sign in with Frameleaf is offered at home too",
      "type": "boolean"
    },
    "state": {
      "$ref": "#/components/schemas/CloudLinkState"
    }
  },
  "required": [
    "account",
    "allowOriginalsOverRelay",
    "allowPasswordOverRelay",
    "cloneSuspected",
    "cloudHost",
    "configured",
    "dataRegion",
    "heartbeatFailures",
    "heartbeatFields",
    "instanceId",
    "keyFingerprint",
    "lastContactAt",
    "lastError",
    "linkRefusal",
    "linkResult",
    "linkTokenConfigured",
    "linkedAt",
    "manageUrl",
    "pending",
    "permissions",
    "regionMismatch",
    "relinkRequested",
    "remoteAccessEnabled",
    "revoked",
    "signInButtonText",
    "signInClientId",
    "signInInvitedStorageQuota",
    "signInIssuer",
    "signInLinkedAccounts",
    "signInShowOnLocalLogin",
    "state"
  ],
  "type": "object"
}
```

## CloudTourEnding


```json
{
  "description": "How the tour ended: finished (Done), skipped (Skip tour or Escape), opened-settings (an \"Open …\" link), setup (the server was linked during first-run setup, which has its own summary)",
  "enum": [
    "finished",
    "skipped",
    "opened-settings",
    "setup"
  ],
  "type": "string"
}
```

## CloudTourResponseDto

Related models: [CloudTourEnding](models-09.md#cloudtourending).

```json
{
  "properties": {
    "backupConfigured": {
      "description": "Cloud backup is set up",
      "type": "boolean"
    },
    "customHostnameVerified": {
      "description": "Remote access answers on a domain you own, and its DNS is verified",
      "type": "boolean"
    },
    "ending": {
      "allOf": [
        {
          "$ref": "#/components/schemas/CloudTourEnding"
        }
      ],
      "description": "How you first ended the tour; later endings keep this one",
      "nullable": true
    },
    "offer": {
      "description": "Open the tour now: this server is linked to a Frameleaf account and you have not seen it",
      "type": "boolean"
    },
    "processingEnabled": {
      "description": "Frameleaf Cloud processing is switched on",
      "type": "boolean"
    },
    "seen": {
      "description": "You have seen the tour (or were shown setup’s summary instead)",
      "type": "boolean"
    },
    "seenAt": {
      "description": "When you first ended the tour",
      "nullable": true,
      "type": "string"
    },
    "walletAvailableUsd": {
      "description": "AI Wallet credit available at the last read (US dollars, balance less holds); null before any read",
      "format": "double",
      "nullable": true,
      "type": "number"
    }
  },
  "required": [
    "backupConfigured",
    "customHostnameVerified",
    "ending",
    "offer",
    "processingEnabled",
    "seen",
    "seenAt",
    "walletAvailableUsd"
  ],
  "type": "object"
}
```

## CloudTourSeenDto

Related models: [CloudTourEnding](models-09.md#cloudtourending).

```json
{
  "properties": {
    "ending": {
      "$ref": "#/components/schemas/CloudTourEnding"
    }
  },
  "required": [
    "ending"
  ],
  "type": "object"
}
```

## ClusterGroupRequestCreateDto


```json
{
  "properties": {
    "userId": {
      "description": "User to invite into the cluster group",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "userId"
  ],
  "type": "object"
}
```

## ClusterGroupRequestResponseDto


```json
{
  "properties": {
    "clusterGroupId": {
      "description": "Cluster group the user is invited to join",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "createdAt": {
      "description": "Creation date",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
      "type": "string"
    },
    "id": {
      "description": "Request ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "userId": {
      "description": "User the request was created for",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "clusterGroupId",
    "createdAt",
    "id",
    "userId"
  ],
  "type": "object"
}
```

## Colorspace


```json
{
  "description": "Colorspace",
  "enum": [
    "srgb",
    "p3"
  ],
  "type": "string"
}
```

## ConfigCredential


```json
{
  "description": "A server secret that can be replaced or cleared but never read back",
  "enum": [
    "smtp-password",
    "oauth-client-secret",
    "cloud-backup-s3-secret-key"
  ],
  "type": "string"
}
```

## ConfigCredentialResponseDto

Related models: [ConfigCredential](models-09.md#configcredential).

```json
{
  "properties": {
    "configured": {
      "description": "Whether a value is stored. The value itself is never returned",
      "type": "boolean"
    },
    "name": {
      "$ref": "#/components/schemas/ConfigCredential"
    }
  },
  "required": [
    "configured",
    "name"
  ],
  "type": "object"
}
```

## ConfigCredentialUpdateDto


```json
{
  "properties": {
    "value": {
      "description": "The new secret. Stored as sent and never returned",
      "maxLength": 4096,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "value"
  ],
  "type": "object"
}
```
