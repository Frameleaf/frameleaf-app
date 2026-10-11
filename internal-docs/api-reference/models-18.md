# Server API models 18

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## MetadataSearchDto

Related models: [AssetOrder](models-06.md#assetorder), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-14.md#imageenrichmentfilter), [SearchFilter](models-31.md#searchfilter), [SearchOrder](models-31.md#searchorder).

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
    "checksum": {
      "deprecated": true,
      "description": "Filter by file checksum",
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
    "cursor": {
      "description": "Cursor for the next page of results",
      "minLength": 1,
      "type": "string",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "description": {
      "deprecated": true,
      "description": "Filter by description text",
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
    "encodedVideoPath": {
      "deprecated": true,
      "description": "Filter by encoded video file path",
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
    "id": {
      "deprecated": true,
      "description": "Filter by asset ID",
      "format": "uuid",
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
    "order": {
      "$ref": "#/components/schemas/AssetOrder",
      "deprecated": true,
      "description": "Sort order",
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
    "orderBy": {
      "$ref": "#/components/schemas/SearchOrder",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "originalFileName": {
      "deprecated": true,
      "description": "Filter by original file name",
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
    "originalPath": {
      "deprecated": true,
      "description": "Filter by original file path",
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
    "page": {
      "deprecated": true,
      "description": "Page number",
      "maximum": 9007199254740991,
      "minimum": 1,
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
    "previewPath": {
      "deprecated": true,
      "description": "Filter by preview file path",
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
    "thumbnailPath": {
      "deprecated": true,
      "description": "Filter by thumbnail file path",
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

## MirrorAxis


```json
{
  "description": "Axis to mirror along",
  "enum": [
    "horizontal",
    "vertical"
  ],
  "type": "string"
}
```

## MirrorParameters

Related models: [MirrorAxis](models-18.md#mirroraxis).

```json
{
  "properties": {
    "axis": {
      "$ref": "#/components/schemas/MirrorAxis"
    }
  },
  "required": [
    "axis"
  ],
  "type": "object"
}
```

## MlAdmissionRefusal


```json
{
  "description": "Reason a destination refused a workload",
  "enum": [
    "destination-missing",
    "destination-disabled",
    "workload-not-routed",
    "workload-not-allowed",
    "workload-not-served",
    "consent-missing",
    "disclosure-pending",
    "budget-exceeded",
    "endpoint-unresolved",
    "destination-unhealthy",
    "role-conflict",
    "cloud-unavailable",
    "entitlement-missing",
    "consent-version-outdated",
    "wallet-insufficient",
    "quota-exceeded",
    "model-mismatch",
    "insufficient-memory",
    "request-invalid"
  ],
  "type": "string"
}
```

## MlAdmissionRequestDto

Related models: [MlStudioFeature](models-18.md#mlstudiofeature), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "jobId": {
      "description": "Job the admission is for, recorded with the accounting row",
      "maxLength": 200,
      "type": "string"
    },
    "studioFeature": {
      "$ref": "#/components/schemas/MlStudioFeature"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "workload"
  ],
  "type": "object"
}
```

## MlAdmissionResponseDto

Related models: [MlDestinationHealthStateDto](models-18.md#mldestinationhealthstatedto), [MlDestinationKind](models-18.md#mldestinationkind), [MlThroughputEstimateDto](models-18.md#mlthroughputestimatedto), [MlWorkload](models-18.md#mlworkload).

```json
{
  "properties": {
    "destinationId": {
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "estimate": {
      "$ref": "#/components/schemas/MlThroughputEstimateDto"
    },
    "health": {
      "$ref": "#/components/schemas/MlDestinationHealthStateDto"
    },
    "kind": {
      "$ref": "#/components/schemas/MlDestinationKind"
    },
    "workload": {
      "$ref": "#/components/schemas/MlWorkload"
    }
  },
  "required": [
    "destinationId",
    "estimate",
    "health",
    "kind",
    "workload"
  ],
  "type": "object"
}
```

## MlCapabilitiesResponseDto

Related models: [MlWorkloadCapabilityDto](models-18.md#mlworkloadcapabilitydto), [StudioCapabilitiesDto](models-34.md#studiocapabilitiesdto).

```json
{
  "properties": {
    "probedAt": {
      "description": "When this snapshot was assembled",
      "type": "string"
    },
    "studio": {
      "$ref": "#/components/schemas/StudioCapabilitiesDto"
    },
    "workloads": {
      "items": {
        "$ref": "#/components/schemas/MlWorkloadCapabilityDto"
      },
      "type": "array"
    }
  },
  "required": [
    "probedAt",
    "studio",
    "workloads"
  ],
  "type": "object"
}
```

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

Related models: [MlAdmissionRefusal](models-18.md#mladmissionrefusal).

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

Related models: [MlWorkload](models-18.md#mlworkload), [RestorationGpuDto](models-30.md#restorationgpudto), [RestorationModelCapabilityDto](models-30.md#restorationmodelcapabilitydto).

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

Related models: [NotificationLevel](models-19.md#notificationlevel), [NotificationType](models-19.md#notificationtype).

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
