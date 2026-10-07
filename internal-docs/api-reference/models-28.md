# Server API models 28

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## QueuesResponseLegacyDto

Related models: [QueueResponseLegacyDto](models-27.md#queueresponselegacydto).

```json
{
  "properties": {
    "backgroundTask": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "backupDatabase": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "duplicateDetection": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "editor": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "faceDetection": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "facialRecognition": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "imageDescription": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "imageEnrichment": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "integrityCheck": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "library": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "mediaHealth": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "metadataExtraction": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "migration": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "notifications": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "nsfwDetection": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "ocr": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "petRecognition": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "search": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "sidecar": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "smartSearch": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "storageTemplateMigration": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "thumbnailGeneration": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "videoConversion": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "videoDuplicateDetection": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    },
    "workflow": {
      "$ref": "#/components/schemas/QueueResponseLegacyDto"
    }
  },
  "required": [
    "backgroundTask",
    "backupDatabase",
    "duplicateDetection",
    "editor",
    "faceDetection",
    "facialRecognition",
    "imageDescription",
    "imageEnrichment",
    "integrityCheck",
    "library",
    "mediaHealth",
    "metadataExtraction",
    "migration",
    "notifications",
    "nsfwDetection",
    "ocr",
    "petRecognition",
    "search",
    "sidecar",
    "smartSearch",
    "storageTemplateMigration",
    "thumbnailGeneration",
    "videoConversion",
    "videoDuplicateDetection",
    "workflow"
  ],
  "type": "object"
}
```

## RandomSearchDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-13.md#imageenrichmentfilter), [SearchFilter](models-30.md#searchfilter).

```json
{
  "properties": {
    "albumIds": {
      "deprecated": true,
      "description": "Filter by album IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array",
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
    "city": {
      "deprecated": true,
      "description": "Filter by city name",
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
    "country": {
      "deprecated": true,
      "description": "Filter by country name",
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
    "createdAfter": {
      "deprecated": true,
      "description": "Filter by creation date (after)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "createdBefore": {
      "deprecated": true,
      "description": "Filter by creation date (before)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "filter": {
      "$ref": "#/components/schemas/SearchFilter",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "imageEnrichment": {
      "$ref": "#/components/schemas/ImageEnrichmentFilter"
    },
    "isEncoded": {
      "deprecated": true,
      "description": "Filter by encoded status",
      "type": "boolean",
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
    "isFavorite": {
      "deprecated": true,
      "description": "Filter by favorite status",
      "type": "boolean",
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
    "isMotion": {
      "deprecated": true,
      "description": "Filter by motion photo status",
      "type": "boolean",
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
    "isNotInAlbum": {
      "deprecated": true,
      "description": "Filter assets not in any album",
      "type": "boolean",
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
    "isOffline": {
      "deprecated": true,
      "description": "Filter by offline status",
      "type": "boolean",
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
    "lensModel": {
      "deprecated": true,
      "description": "Filter by lens model",
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
    "libraryId": {
      "deprecated": true,
      "description": "Library ID to filter by",
      "format": "uuid",
      "nullable": true,
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
    "make": {
      "deprecated": true,
      "description": "Filter by camera make",
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
    "model": {
      "deprecated": true,
      "description": "Filter by camera model",
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
    "ocr": {
      "deprecated": true,
      "description": "Filter by OCR text content",
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
    "personIds": {
      "deprecated": true,
      "description": "Filter by person IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array",
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
    "petIds": {
      "deprecated": true,
      "description": "Filter by the caller's own pet IDs (confirmed pet observations only)",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        },
        {
          "version": "v3.2.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "rating": {
      "deprecated": true,
      "description": "Filter by rating [1-5], or null for unrated",
      "maximum": 5,
      "minimum": 1,
      "nullable": true,
      "type": "integer",
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
          "version": "v2.6.0",
          "state": "Updated",
          "description": "Using -1 as a rating is deprecated and will be removed in the next major version."
        },
        {
          "version": "v3",
          "state": "Updated",
          "description": "Using -1 as a rating is no longer valid."
        },
        {
          "version": "v3.2.0",
          "state": "Deprecated"
        }
      ],
      "x-immich-state": "Deprecated"
    },
    "size": {
      "description": "Number of results to return",
      "maximum": 1000,
      "minimum": 1,
      "type": "integer"
    },
    "state": {
      "deprecated": true,
      "description": "Filter by state/province name",
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
    "suppressedOnly": {
      "description": "Return only suppressed content. Requires an elevated session.",
      "type": "boolean"
    },
    "tagIds": {
      "deprecated": true,
      "description": "Filter by tag IDs",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "nullable": true,
      "type": "array",
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
    "takenAfter": {
      "deprecated": true,
      "description": "Filter by taken date (after)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "takenBefore": {
      "deprecated": true,
      "description": "Filter by taken date (before)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "trashedAfter": {
      "deprecated": true,
      "description": "Filter by trash date (after)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "trashedBefore": {
      "deprecated": true,
      "description": "Filter by trash date (before)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "type": {
      "$ref": "#/components/schemas/AssetTypeEnum",
      "deprecated": true,
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
    "updatedAfter": {
      "deprecated": true,
      "description": "Filter by update date (after)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "updatedBefore": {
      "deprecated": true,
      "description": "Filter by update date (before)",
      "example": "2024-01-01T00:00:00.000Z",
      "format": "date-time",
      "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
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
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility",
      "deprecated": true,
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
    "withDeleted": {
      "deprecated": true,
      "description": "Include deleted assets",
      "type": "boolean",
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
    "withExif": {
      "description": "Include EXIF data in response",
      "type": "boolean"
    },
    "withPeople": {
      "description": "Include people data in response",
      "type": "boolean"
    },
    "withStacked": {
      "description": "Include stacked assets",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## RatingsResponse


```json
{
  "properties": {
    "enabled": {
      "description": "Whether ratings are enabled",
      "type": "boolean"
    }
  },
  "required": [
    "enabled"
  ],
  "type": "object"
}
```

## RatingsUpdate


```json
{
  "properties": {
    "enabled": {
      "description": "Whether ratings are enabled",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## ReactionLevel


```json
{
  "description": "Reaction level",
  "enum": [
    "album",
    "asset"
  ],
  "type": "string"
}
```

## ReactionType


```json
{
  "description": "Reaction type",
  "enum": [
    "comment",
    "like"
  ],
  "type": "string"
}
```

## RecentlyAddedResponse


```json
{
  "properties": {
    "sidebarWeb": {
      "description": "Whether the recently added page appears in the web sidebar",
      "type": "boolean"
    }
  },
  "required": [
    "sidebarWeb"
  ],
  "type": "object"
}
```

## RecentlyAddedUpdate


```json
{
  "properties": {
    "sidebarWeb": {
      "description": "Whether the recently added page appears in the web sidebar",
      "type": "boolean"
    }
  },
  "type": "object"
}
```

## RecipientGroupCreateDto


```json
{
  "properties": {
    "name": {
      "description": "Name, visible to its owner only",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "userIds": {
      "description": "People in the group. Yourself and repeats are dropped.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 200,
      "type": "array"
    }
  },
  "required": [
    "name",
    "userIds"
  ],
  "type": "object"
}
```

## RecipientGroupResponseDto

Related models: [UserResponseDto](models-38.md#userresponsedto).

```json
{
  "properties": {
    "createdAt": {
      "description": "When the group was saved",
      "format": "date-time",
      "type": "string"
    },
    "id": {
      "description": "Recipient group ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "name": {
      "description": "Name, visible to its owner only",
      "type": "string"
    },
    "updatedAt": {
      "description": "When the group last changed",
      "format": "date-time",
      "type": "string"
    },
    "users": {
      "description": "People in the group who still have an account, by name",
      "items": {
        "$ref": "#/components/schemas/UserResponseDto"
      },
      "type": "array"
    }
  },
  "required": [
    "createdAt",
    "id",
    "name",
    "updatedAt",
    "users"
  ],
  "type": "object"
}
```

## RecipientGroupUpdateDto


```json
{
  "properties": {
    "name": {
      "description": "Name, visible to its owner only",
      "maxLength": 100,
      "minLength": 1,
      "type": "string"
    },
    "userIds": {
      "description": "People in the group. Yourself and repeats are dropped.",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "maxItems": 200,
      "type": "array"
    }
  },
  "type": "object"
}
```

## ReconciliationBucketDto


```json
{
  "properties": {
    "bucket": {
      "maximum": 255,
      "minimum": 0,
      "type": "integer"
    },
    "hashes": {
      "items": {
        "pattern": "^[a-f\\d]{64}$",
        "type": "string"
      },
      "maxItems": 2000,
      "type": "array"
    }
  },
  "required": [
    "bucket",
    "hashes"
  ],
  "type": "object"
}
```

## ReconciliationHistoryDto


```json
{
  "properties": {
    "nextOffset": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "runs": {
      "items": {
        "properties": {
          "checkedAt": {
            "description": "Inventory snapshot time, not a promise after commit",
            "format": "date-time",
            "type": "string"
          },
          "completedAt": {
            "format": "date-time",
            "nullable": true,
            "type": "string"
          },
          "deviceId": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "differingBuckets": {
            "items": {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            "type": "array"
          },
          "evidence": {
            "description": "Current database inventory, excludes offline/last-checked-missing; not a fresh filesystem integrity check",
            "enum": [
              "registered-current-originals"
            ],
            "type": "string"
          },
          "id": {
            "format": "uuid",
            "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
            "type": "string"
          },
          "itemsChecked": {
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "itemsMissing": {
            "description": "Provided SHA256 hashes absent from current registered inventory; not a filesystem loss diagnosis",
            "maximum": 9007199254740991,
            "minimum": -9007199254740991,
            "type": "integer"
          },
          "pendingBuckets": {
            "items": {
              "maximum": 9007199254740991,
              "minimum": -9007199254740991,
              "type": "integer"
            },
            "type": "array"
          },
          "startedAt": {
            "format": "date-time",
            "type": "string"
          }
        },
        "required": [
          "id",
          "deviceId",
          "startedAt",
          "checkedAt",
          "completedAt",
          "differingBuckets",
          "pendingBuckets",
          "itemsChecked",
          "itemsMissing",
          "evidence"
        ],
        "type": "object"
      },
      "type": "array"
    }
  },
  "required": [
    "nextOffset",
    "runs"
  ],
  "type": "object"
}
```

## ReconciliationResultDto


```json
{
  "properties": {
    "checkedAt": {
      "description": "Inventory snapshot time, not a promise after commit",
      "format": "date-time",
      "type": "string"
    },
    "completedAt": {
      "format": "date-time",
      "nullable": true,
      "type": "string"
    },
    "deviceId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "differingBuckets": {
      "items": {
        "maximum": 9007199254740991,
        "minimum": -9007199254740991,
        "type": "integer"
      },
      "type": "array"
    },
    "evidence": {
      "description": "Current database inventory, excludes offline/last-checked-missing; not a fresh filesystem integrity check",
      "enum": [
        "registered-current-originals"
      ],
      "type": "string"
    },
    "id": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
      "type": "string"
    },
    "itemsChecked": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "itemsMissing": {
      "description": "Provided SHA256 hashes absent from current registered inventory; not a filesystem loss diagnosis",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "missingHashes": {
      "items": {
        "pattern": "^[a-f\\d]{64}$",
        "type": "string"
      },
      "type": "array"
    },
    "pendingBuckets": {
      "items": {
        "maximum": 9007199254740991,
        "minimum": -9007199254740991,
        "type": "integer"
      },
      "type": "array"
    },
    "startedAt": {
      "format": "date-time",
      "type": "string"
    }
  },
  "required": [
    "checkedAt",
    "completedAt",
    "deviceId",
    "differingBuckets",
    "evidence",
    "id",
    "itemsChecked",
    "itemsMissing",
    "missingHashes",
    "pendingBuckets",
    "startedAt"
  ],
  "type": "object"
}
```

## ReconciliationStartDto


```json
{
  "properties": {
    "buckets": {
      "description": "First byte buckets in index order. Digest SHA256 of sorted distinct raw32-byte hashes; empty digest SHA256(empty). Maximum2000 hashes per bucket; larger sets refused.",
      "items": {
        "properties": {
          "count": {
            "maximum": 2000,
            "minimum": 0,
            "type": "integer"
          },
          "digest": {
            "pattern": "^[a-f\\d]{64}$",
            "type": "string"
          }
        },
        "required": [
          "count",
          "digest"
        ],
        "type": "object"
      },
      "maxItems": 256,
      "minItems": 256,
      "type": "array"
    }
  },
  "required": [
    "buckets"
  ],
  "type": "object"
}
```

## ReleaseChannel


```json
{
  "description": "Release channel",
  "enum": [
    "stable",
    "releaseCandidate"
  ],
  "type": "string"
}
```

## ReleaseEventV1

Related models: [ReleaseType](models-28.md#releasetype), [ServerVersionResponseDto](models-31.md#serverversionresponsedto).

```json
{
  "properties": {
    "checkedAt": {
      "description": "When the server last checked for a latest version. As an ISO timestamp",
      "type": "string"
    },
    "isAvailable": {
      "description": "Whether a new version is available",
      "type": "boolean"
    },
    "releaseVersion": {
      "$ref": "#/components/schemas/ServerVersionResponseDto"
    },
    "serverVersion": {
      "$ref": "#/components/schemas/ServerVersionResponseDto"
    },
    "type": {
      "$ref": "#/components/schemas/ReleaseType",
      "description": "Release type",
      "nullable": true
    }
  },
  "required": [
    "checkedAt",
    "isAvailable",
    "releaseVersion",
    "serverVersion",
    "type"
  ],
  "type": "object"
}
```

## ReleaseType


```json
{
  "enum": [
    "major",
    "premajor",
    "minor",
    "preminor",
    "patch",
    "prepatch",
    "prerelease"
  ],
  "type": "string"
}
```

## RemoteAccessMode


```json
{
  "description": "relay: every remote connection goes through the relay; relay-and-direct: direct connections too",
  "enum": [
    "relay",
    "relay-and-direct"
  ],
  "type": "string"
}
```

## RemoteAccessPublicUrl


```json
{
  "description": "The published address: the Frameleaf address, or the verified custom hostname",
  "enum": [
    "frameleaf",
    "custom"
  ],
  "type": "string"
}
```

## RemoteAccessState


```json
{
  "description": "What the edge worker is doing; unknown when no edge worker reported recently",
  "enum": [
    "off",
    "idle",
    "starting",
    "ready",
    "error",
    "unknown"
  ],
  "type": "string"
}
```

## RemoteAccessStatusResponseDto

Related models: [RemoteAccessMode](models-28.md#remoteaccessmode), [RemoteAccessPublicUrl](models-28.md#remoteaccesspublicurl), [RemoteAccessState](models-28.md#remoteaccessstate), [RemoteAccessTestCheckDto](models-28.md#remoteaccesstestcheckdto), [RemoteConnectionDto](models-28.md#remoteconnectiondto), [RemoteDirectGuidance](models-28.md#remotedirectguidance), [RemoteDnsRecordDto](models-28.md#remotednsrecorddto), [RemoteHostnameStatus](models-28.md#remotehostnamestatus), [RemoteMappingMethod](models-28.md#remotemappingmethod).

```json
{
  "properties": {
    "candidates": {
      "items": {
        "$ref": "#/components/schemas/RemoteConnectionDto"
      },
      "type": "array"
    },
    "certificateError": {
      "description": "The last issuance or renewal problem",
      "nullable": true,
      "type": "string"
    },
    "certificateExpiresAt": {
      "nullable": true,
      "type": "string"
    },
    "certificateName": {
      "description": "The wildcard name the certificate covers",
      "nullable": true,
      "type": "string"
    },
    "cgnatSuspected": {
      "type": "boolean"
    },
    "customHostname": {
      "description": "The custom hostname, when one was added",
      "nullable": true,
      "type": "string"
    },
    "customHostnameCheckedAt": {
      "nullable": true,
      "type": "string"
    },
    "customHostnameProblem": {
      "description": "Why the hostname is not verified yet",
      "nullable": true,
      "type": "string"
    },
    "customHostnameRecords": {
      "description": "The two records to add at the DNS provider; empty until enrolled",
      "items": {
        "$ref": "#/components/schemas/RemoteDnsRecordDto"
      },
      "type": "array"
    },
    "customHostnameStatus": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RemoteHostnameStatus"
        }
      ],
      "nullable": true
    },
    "directExternalIp": {
      "description": "The public address direct connections reach",
      "nullable": true,
      "type": "string"
    },
    "directGuidance": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RemoteDirectGuidance"
        }
      ],
      "nullable": true
    },
    "directListening": {
      "type": "boolean"
    },
    "directPort": {
      "description": "External port for direct connections",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "enabled": {
      "description": "Remote access is switched on",
      "type": "boolean"
    },
    "frameleafAddress": {
      "description": "https://r.<label>.<direct domain>, once enrolled",
      "nullable": true,
      "type": "string"
    },
    "lastTestAt": {
      "nullable": true,
      "type": "string"
    },
    "lastTestChecks": {
      "items": {
        "$ref": "#/components/schemas/RemoteAccessTestCheckDto"
      },
      "type": "array"
    },
    "lastTestOk": {
      "nullable": true,
      "type": "boolean"
    },
    "mappingError": {
      "description": "Why the router did not open the direct port",
      "nullable": true,
      "type": "string"
    },
    "mappingMethod": {
      "allOf": [
        {
          "$ref": "#/components/schemas/RemoteMappingMethod"
        }
      ],
      "description": "How the direct port is open right now; null when it is not",
      "nullable": true
    },
    "mode": {
      "$ref": "#/components/schemas/RemoteAccessMode"
    },
    "portMapping": {
      "description": "The router is asked to open the direct port automatically",
      "type": "boolean"
    },
    "publicUrl": {
      "description": "The address this server publishes",
      "nullable": true,
      "type": "string"
    },
    "publicUrlChoice": {
      "$ref": "#/components/schemas/RemoteAccessPublicUrl"
    },
    "reason": {
      "description": "Why it is off, idle or failing, in plain words",
      "nullable": true,
      "type": "string"
    },
    "relayBytesIn": {
      "description": "Bytes received through the relay since the edge worker started",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "relayBytesOut": {
      "description": "Bytes sent through the relay since the edge worker started",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "relayConnected": {
      "type": "boolean"
    },
    "relayConnectedAt": {
      "description": "When the current relay connection was made",
      "nullable": true,
      "type": "string"
    },
    "relayLastError": {
      "description": "The last relay problem, in plain words",
      "nullable": true,
      "type": "string"
    },
    "relayLastErrorAt": {
      "nullable": true,
      "type": "string"
    },
    "relayLatencyMs": {
      "description": "Round trip to the relay, from its last keepalive",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "relayRegion": {
      "description": "The relay this server uses (eu1, us1)",
      "nullable": true,
      "type": "string"
    },
    "relayRevoked": {
      "description": "Frameleaf Cloud stopped the relay for this server; it is tried again once relinked",
      "type": "boolean"
    },
    "status": {
      "$ref": "#/components/schemas/RemoteAccessState"
    },
    "unavailableReason": {
      "description": "Why remote access cannot be turned on (not set up, not linked, no plan); null when it can",
      "nullable": true,
      "type": "string"
    },
    "wanAddress": {
      "description": "The direct address Frameleaf Cloud tested",
      "nullable": true,
      "type": "string"
    },
    "wanProblem": {
      "description": "Why Frameleaf Cloud could not reach it: unreachable, timeout, certificate or not_public",
      "nullable": true,
      "type": "string"
    },
    "wanVerified": {
      "description": "Frameleaf Cloud reached this server directly at wanAddress",
      "type": "boolean"
    }
  },
  "required": [
    "candidates",
    "certificateError",
    "certificateExpiresAt",
    "certificateName",
    "cgnatSuspected",
    "customHostname",
    "customHostnameCheckedAt",
    "customHostnameProblem",
    "customHostnameRecords",
    "customHostnameStatus",
    "directExternalIp",
    "directGuidance",
    "directListening",
    "directPort",
    "enabled",
    "frameleafAddress",
    "lastTestAt",
    "lastTestChecks",
    "lastTestOk",
    "mappingError",
    "mappingMethod",
    "mode",
    "portMapping",
    "publicUrl",
    "publicUrlChoice",
    "reason",
    "relayBytesIn",
    "relayBytesOut",
    "relayConnected",
    "relayConnectedAt",
    "relayLastError",
    "relayLastErrorAt",
    "relayLatencyMs",
    "relayRegion",
    "relayRevoked",
    "status",
    "unavailableReason",
    "wanAddress",
    "wanProblem",
    "wanVerified"
  ],
  "type": "object"
}
```

## RemoteAccessTestCheckDto


```json
{
  "properties": {
    "detail": {
      "type": "string"
    },
    "id": {
      "description": "certificate, listener, api, relay or direct",
      "type": "string"
    },
    "ok": {
      "type": "boolean"
    }
  },
  "required": [
    "detail",
    "id",
    "ok"
  ],
  "type": "object"
}
```

## RemoteAccessUpdateDto

Related models: [RemoteAccessMode](models-28.md#remoteaccessmode), [RemoteAccessPublicUrl](models-28.md#remoteaccesspublicurl).

```json
{
  "properties": {
    "directPort": {
      "description": "External port for direct connections",
      "maximum": 65535,
      "minimum": 1024,
      "type": "integer"
    },
    "enabled": {
      "description": "Turn remote access on or off",
      "type": "boolean"
    },
    "mode": {
      "$ref": "#/components/schemas/RemoteAccessMode"
    },
    "portMapping": {
      "description": "Ask the router to open the direct port automatically",
      "type": "boolean"
    },
    "publicUrl": {
      "$ref": "#/components/schemas/RemoteAccessPublicUrl"
    }
  },
  "type": "object"
}
```

## RemoteAccessUsageResponseDto


```json
{
  "properties": {
    "bytes": {
      "description": "Bytes through the relay this month, in and out, custom hostnames included",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "limitBytes": {
      "description": "The relay allowance the plan includes each month",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "period": {
      "description": "The month, YYYY-MM (UTC)",
      "type": "string"
    },
    "periodEnd": {
      "type": "string"
    },
    "periodStart": {
      "type": "string"
    },
    "throttleBps": {
      "description": "The slowed-down speed in bits per second, while throttled",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "nullable": true,
      "type": "integer"
    },
    "throttleUntil": {
      "description": "When the slowdown lifts, while throttled",
      "nullable": true,
      "type": "string"
    },
    "throttled": {
      "description": "The allowance is used up: the relay is slowed down, never cut off",
      "type": "boolean"
    }
  },
  "required": [
    "bytes",
    "limitBytes",
    "period",
    "periodEnd",
    "periodStart",
    "throttleBps",
    "throttleUntil",
    "throttled"
  ],
  "type": "object"
}
```

## RemoteConnectionDto

Related models: [RemoteConnectionKind](models-28.md#remoteconnectionkind), [RemoteConnectionProtocol](models-28.md#remoteconnectionprotocol).

```json
{
  "description": "One way to reach this server, in the order apps should try them",
  "properties": {
    "address": {
      "description": "Host name or address, without brackets for IPv6",
      "type": "string"
    },
    "custom": {
      "description": "The administrator’s own hostname, verified by Frameleaf Cloud",
      "type": "boolean"
    },
    "dnsRebindingProtection": {
      "description": "The server refuses requests for another Host",
      "type": "boolean"
    },
    "httpsRequired": {
      "type": "boolean"
    },
    "ipv6": {
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/RemoteConnectionKind"
    },
    "local": {
      "type": "boolean"
    },
    "port": {
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "protocol": {
      "$ref": "#/components/schemas/RemoteConnectionProtocol"
    },
    "relay": {
      "description": "Carried by the Frameleaf relay",
      "type": "boolean"
    },
    "uri": {
      "description": "The address to connect to, https only",
      "type": "string"
    },
    "verified": {
      "description": "Frameleaf Cloud verified this entry itself",
      "type": "boolean"
    }
  },
  "required": [
    "address",
    "custom",
    "dnsRebindingProtection",
    "httpsRequired",
    "ipv6",
    "kind",
    "local",
    "port",
    "protocol",
    "relay",
    "uri",
    "verified"
  ],
  "type": "object"
}
```

## RemoteConnectionKind


```json
{
  "description": "local, wan (a custom hostname too), ipv6 or relay",
  "enum": [
    "local",
    "wan",
    "relay",
    "ipv6"
  ],
  "type": "string"
}
```

## RemoteConnectionProtocol


```json
{
  "enum": [
    "http",
    "https"
  ],
  "type": "string"
}
```

## RemoteConnectionsResponseDto

Related models: [RemoteConnectionDto](models-28.md#remoteconnectiondto).

```json
{
  "properties": {
    "connections": {
      "description": "Ordered local, wan, ipv6, custom hostname, relay",
      "items": {
        "$ref": "#/components/schemas/RemoteConnectionDto"
      },
      "type": "array"
    },
    "instanceId": {
      "description": "This server’s Frameleaf instance ID while it is linked",
      "nullable": true,
      "type": "string"
    },
    "publicUrl": {
      "description": "The address this server publishes for remote access",
      "nullable": true,
      "type": "string"
    }
  },
  "required": [
    "connections",
    "instanceId",
    "publicUrl"
  ],
  "type": "object"
}
```

## RemoteDirectGuidance


```json
{
  "description": "bridge: running in a container whose network cannot reach the router",
  "enum": [
    "bridge"
  ],
  "type": "string"
}
```

## RemoteDnsRecordDto

Related models: [RemoteDnsRecordType](models-28.md#remotednsrecordtype).

```json
{
  "properties": {
    "name": {
      "type": "string"
    },
    "purpose": {
      "description": "What the record is for, in plain words",
      "type": "string"
    },
    "type": {
      "$ref": "#/components/schemas/RemoteDnsRecordType"
    },
    "value": {
      "type": "string"
    }
  },
  "required": [
    "name",
    "purpose",
    "type",
    "value"
  ],
  "type": "object"
}
```

## RemoteDnsRecordType


```json
{
  "enum": [
    "CNAME"
  ],
  "type": "string"
}
```

## RemoteHostnameStatus


```json
{
  "description": "pending: waiting for its DNS records; verified: Frameleaf Cloud verified them",
  "enum": [
    "pending",
    "verified"
  ],
  "type": "string"
}
```

## RemoteHostnameUpdateDto


```json
{
  "properties": {
    "hostname": {
      "description": "A subdomain of a domain you own, such as photos.example.com",
      "maxLength": 254,
      "minLength": 1,
      "type": "string"
    }
  },
  "required": [
    "hostname"
  ],
  "type": "object"
}
```

## RemoteMappingMethod


```json
{
  "description": "How the direct port is opened: by the router (UPnP, NAT-PMP) or forwarded by hand",
  "enum": [
    "upnp",
    "nat-pmp",
    "manual"
  ],
  "type": "string"
}
```

## RenderWorkerAdmissionDto


```json
{
  "properties": {
    "codecs": {
      "description": "Encoder and decoder names the check verified",
      "items": {
        "maxLength": 60,
        "type": "string"
      },
      "maxItems": 64,
      "type": "array"
    },
    "colorPrecision": {
      "description": "Colour precision the conformance check verified; absent means 8-bit SDR only (FL-42)",
      "properties": {
        "dolbyVision": {
          "description": "The check verified Dolby Vision output",
          "type": "boolean"
        },
        "hdr10": {
          "description": "The check verified HDR10 (PQ, BT.2020) output",
          "type": "boolean"
        },
        "maxBitDepth": {
          "description": "Highest bit depth the check rendered and verified",
          "maximum": 16,
          "minimum": 8,
          "type": "integer"
        }
      },
      "required": [
        "maxBitDepth",
        "hdr10",
        "dolbyVision"
      ],
      "type": "object"
    },
    "conformanceReportedAt": {
      "description": "When the conformance check ran",
      "format": "date-time",
      "type": "string"
    },
    "engineDigest": {
      "description": "Digest of the engine and patches actually loaded",
      "maxLength": 200,
      "minLength": 1,
      "type": "string"
    },
    "enrolmentSecret": {
      "minLength": 16,
      "type": "string"
    },
    "formats": {
      "description": "Containers the check verified writing, such as `mp4`, `webm` or `mov`",
      "items": {
        "maxLength": 30,
        "type": "string"
      },
      "maxItems": 32,
      "type": "array"
    },
    "gpuMemoryBytes": {
      "description": "GPU memory measured by the conformance check",
      "nullable": true,
      "pattern": "^\\d+$",
      "type": "string"
    },
    "softwareRenderer": {
      "description": "True when the renderer is a software or fallback device",
      "type": "boolean"
    },
    "workerId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-7[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "conformanceReportedAt",
    "engineDigest",
    "enrolmentSecret",
    "gpuMemoryBytes",
    "softwareRenderer",
    "workerId"
  ],
  "type": "object"
}
```
