# Server API models 4

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## AskSearchPlanDto

Related models: [AssetOrder](models-06.md#assetorder), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-14.md#imageenrichmentfilter), [SearchAskMode](models-30.md#searchaskmode), [SearchFilter](models-31.md#searchfilter), [SearchOrder](models-31.md#searchorder).

```json
{
  "properties": {
    "filters": {
      "description": "Structured filters applied to the search",
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
    },
    "mode": {
      "$ref": "#/components/schemas/SearchAskMode"
    },
    "normalizedQuery": {
      "description": "Normalized query text",
      "type": "string"
    }
  },
  "required": [
    "filters",
    "mode",
    "normalizedQuery"
  ],
  "type": "object"
}
```

## AskSearchResponseDto

Related models: [AskSearchPlanDto](models-04.md#asksearchplandto), [SearchResponseDto](models-31.md#searchresponsedto).

```json
{
  "properties": {
    "explanation": {
      "description": "Short explanation of how the query was interpreted",
      "type": "string"
    },
    "plan": {
      "$ref": "#/components/schemas/AskSearchPlanDto"
    },
    "query": {
      "description": "Original Ask Search query",
      "type": "string"
    },
    "results": {
      "$ref": "#/components/schemas/SearchResponseDto"
    },
    "warnings": {
      "description": "Unsupported or ambiguous parts of the query",
      "items": {
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "explanation",
    "plan",
    "query",
    "results",
    "warnings"
  ],
  "type": "object"
}
```

## AssetBulkDeleteDto


```json
{
  "properties": {
    "force": {
      "description": "Force delete even if in use",
      "type": "boolean"
    },
    "ids": {
      "description": "IDs to process",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## AssetBulkUpdateDto

Related models: [AssetVisibility](models-06.md#assetvisibility).

```json
{
  "properties": {
    "dateTimeOriginal": {
      "description": "Original date and time",
      "type": "string"
    },
    "dateTimeRelative": {
      "description": "Relative time offset in minutes",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    },
    "description": {
      "description": "Asset description",
      "type": "string"
    },
    "duplicateId": {
      "description": "Duplicate ID",
      "nullable": true,
      "type": "string"
    },
    "ids": {
      "description": "Asset IDs to update",
      "items": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      },
      "type": "array"
    },
    "isFavorite": {
      "description": "Mark as favorite",
      "type": "boolean"
    },
    "latitude": {
      "description": "Latitude coordinate; null together with a null longitude removes the location",
      "format": "double",
      "maximum": 90,
      "minimum": -90,
      "nullable": true,
      "type": "number"
    },
    "longitude": {
      "description": "Longitude coordinate; null together with a null latitude removes the location",
      "format": "double",
      "maximum": 180,
      "minimum": -180,
      "nullable": true,
      "type": "number"
    },
    "rating": {
      "description": "Rating in range [1-5] (starred), -1 (rejected), or null (unrated)",
      "maximum": 5,
      "minimum": -1,
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
          "version": "v3",
          "state": "Updated",
          "description": "Using 0 as a rating is no longer valid."
        }
      ],
      "x-immich-state": "Stable"
    },
    "timeZone": {
      "description": "Time zone (IANA timezone)",
      "type": "string"
    },
    "visibility": {
      "$ref": "#/components/schemas/AssetVisibility"
    }
  },
  "required": [
    "ids"
  ],
  "type": "object"
}
```

## AssetBulkUploadCheckDto

Related models: [AssetBulkUploadCheckItem](models-04.md#assetbulkuploadcheckitem).

```json
{
  "properties": {
    "assets": {
      "description": "Assets to check",
      "items": {
        "$ref": "#/components/schemas/AssetBulkUploadCheckItem"
      },
      "type": "array"
    }
  },
  "required": [
    "assets"
  ],
  "type": "object"
}
```

## AssetBulkUploadCheckItem


```json
{
  "properties": {
    "checksum": {
      "description": "Base64 or hex encoded checksum. SHA-256 (32 bytes / 64 hex / 44 base64) for new uploads; SHA-1 (20 bytes / 40 hex / 28 base64) accepted for legacy assets.",
      "type": "string"
    },
    "id": {
      "description": "Client-side identifier echoed in the response to match results to inputs (e.g. filename)",
      "type": "string"
    }
  },
  "required": [
    "checksum",
    "id"
  ],
  "type": "object"
}
```

## AssetBulkUploadCheckResponseDto

Related models: [AssetBulkUploadCheckResult](models-04.md#assetbulkuploadcheckresult).

```json
{
  "properties": {
    "results": {
      "description": "Upload check results",
      "items": {
        "$ref": "#/components/schemas/AssetBulkUploadCheckResult"
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

## AssetBulkUploadCheckResult

Related models: [AssetRejectReason](models-06.md#assetrejectreason), [AssetUploadAction](models-06.md#assetuploadaction).

```json
{
  "properties": {
    "action": {
      "$ref": "#/components/schemas/AssetUploadAction"
    },
    "assetId": {
      "description": "Existing asset ID if duplicate",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "id": {
      "description": "Client-side identifier echoed from the request to match results to inputs",
      "type": "string"
    },
    "isTrashed": {
      "description": "Whether existing asset is trashed",
      "type": "boolean"
    },
    "reason": {
      "$ref": "#/components/schemas/AssetRejectReason"
    }
  },
  "required": [
    "action",
    "id"
  ],
  "type": "object"
}
```

## AssetCopyDto


```json
{
  "properties": {
    "albums": {
      "default": true,
      "description": "Copy album associations",
      "type": "boolean"
    },
    "favorite": {
      "default": true,
      "description": "Copy favorite status",
      "type": "boolean"
    },
    "sharedLinks": {
      "default": true,
      "description": "Copy shared links",
      "type": "boolean"
    },
    "sidecar": {
      "default": true,
      "description": "Copy sidecar file",
      "type": "boolean"
    },
    "sourceId": {
      "description": "Source asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "stack": {
      "default": true,
      "description": "Copy stack association",
      "type": "boolean"
    },
    "targetId": {
      "description": "Target asset ID",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    }
  },
  "required": [
    "sourceId",
    "targetId"
  ],
  "type": "object"
}
```

## AssetDevelopArtifactKind


```json
{
  "description": "What a develop artifact is used for",
  "enum": [
    "mask",
    "fill"
  ],
  "type": "string"
}
```

## AssetDevelopArtifactResponseDto

Related models: [AssetDevelopArtifactKind](models-04.md#assetdevelopartifactkind).

```json
{
  "properties": {
    "height": {
      "description": "Height of the stored bitmap in pixels",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "id": {
      "description": "A develop artifact uploaded for this asset: the lowercase hex SHA-256 of its stored PNG",
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AssetDevelopArtifactKind"
    },
    "width": {
      "description": "Width of the stored bitmap in pixels",
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    }
  },
  "required": [
    "height",
    "id",
    "kind",
    "width"
  ],
  "type": "object"
}
```

## AssetDevelopArtifactUploadDto

Related models: [AssetDevelopArtifactKind](models-04.md#assetdevelopartifactkind).

```json
{
  "properties": {
    "file": {
      "description": "A PNG (or another still image the server can read): greyscale for a mask, with alpha for a fill",
      "format": "binary",
      "type": "string"
    },
    "kind": {
      "$ref": "#/components/schemas/AssetDevelopArtifactKind"
    }
  },
  "required": [
    "file",
    "kind"
  ],
  "type": "object"
}
```

## AssetDevelopCleanup

Related models: [AssetDevelopCleanupMethod](models-04.md#assetdevelopcleanupmethod), [AssetDevelopRegion](models-05.md#assetdevelopregion), [AssetDevelopStroke](models-05.md#assetdevelopstroke).

```json
{
  "properties": {
    "blockSize": {
      "default": 0.02,
      "description": "Pixelate: block size as a fraction of the original image's shorter side",
      "format": "double",
      "maximum": 0.2,
      "minimum": 0.002,
      "type": "number"
    },
    "enabled": {
      "default": true,
      "description": "A disabled operation is kept but not rendered",
      "type": "boolean"
    },
    "feather": {
      "default": 0,
      "description": "Softness of the area's edge, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "fill": {
      "description": "Remove: the generated fill, an RGBA artifact covering the bounding box of the area",
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "id": {
      "description": "Client-chosen identifier, unique within the recipe",
      "maxLength": 40,
      "minLength": 1,
      "type": "string"
    },
    "method": {
      "$ref": "#/components/schemas/AssetDevelopCleanupMethod"
    },
    "region": {
      "$ref": "#/components/schemas/AssetDevelopRegion"
    },
    "source": {
      "description": "Heal and clone: where the pixels come from, relative to the area, in original-image fractions",
      "properties": {
        "dx": {
          "description": "Horizontal offset, fraction of the width",
          "format": "double",
          "maximum": 1,
          "minimum": -1,
          "type": "number"
        },
        "dy": {
          "description": "Vertical offset, fraction of the height",
          "format": "double",
          "maximum": 1,
          "minimum": -1,
          "type": "number"
        }
      },
      "required": [
        "dx",
        "dy"
      ],
      "type": "object"
    },
    "strokes": {
      "items": {
        "$ref": "#/components/schemas/AssetDevelopStroke"
      },
      "maxItems": 64,
      "minItems": 1,
      "type": "array"
    }
  },
  "required": [
    "id",
    "method"
  ],
  "type": "object"
}
```

## AssetDevelopCleanupMethod


```json
{
  "description": "How a Clean Up operation changes its area",
  "enum": [
    "heal",
    "clone",
    "remove",
    "pixelate"
  ],
  "type": "string"
}
```

## AssetDevelopCrop


```json
{
  "additionalProperties": {},
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

## AssetDevelopFileKind


```json
{
  "description": "Which rendered file of a revision to fetch",
  "enum": [
    "master",
    "preview"
  ],
  "type": "string"
}
```

## AssetDevelopFillGenerateDto

Related models: [AssetDevelopRegion](models-05.md#assetdevelopregion), [AssetDevelopStroke](models-05.md#assetdevelopstroke).

```json
{
  "additionalProperties": false,
  "properties": {
    "feather": {
      "default": 0,
      "description": "Softness of the area's edge, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "region": {
      "$ref": "#/components/schemas/AssetDevelopRegion"
    },
    "strokes": {
      "items": {
        "$ref": "#/components/schemas/AssetDevelopStroke"
      },
      "maxItems": 64,
      "minItems": 1,
      "type": "array"
    }
  },
  "type": "object"
}
```

## AssetDevelopImportDto


```json
{
  "properties": {
    "exportId": {
      "description": "The export this file was developed from",
      "format": "uuid",
      "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
      "type": "string"
    },
    "file": {
      "description": "The developed file: JPEG, PNG, TIFF, WebP or HEIF",
      "format": "binary",
      "type": "string"
    },
    "label": {
      "description": "Optional name for the new version",
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "renditionChecksum": {
      "description": "SHA-256 (hex) of the file as the client sent it; a transfer that does not match is refused",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    },
    "software": {
      "description": "Application the file was developed with",
      "maxLength": 120,
      "minLength": 1,
      "type": "string"
    },
    "sourceChecksum": {
      "description": "SHA-256 (hex) of the original the file was developed from",
      "pattern": "^[\\da-f]{64}$",
      "type": "string"
    }
  },
  "required": [
    "file"
  ],
  "type": "object"
}
```

## AssetDevelopKeyFrame


```json
{
  "properties": {
    "timeMs": {
      "description": "Offset into the motion clip, in milliseconds, of the frame the still is rendered from",
      "maximum": 600000,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "timeMs"
  ],
  "type": "object"
}
```

## AssetDevelopMask

Related models: [AssetDevelopMaskAdjustments](models-04.md#assetdevelopmaskadjustments), [AssetDevelopMaskKind](models-04.md#assetdevelopmaskkind), [AssetDevelopStroke](models-05.md#assetdevelopstroke).

```json
{
  "properties": {
    "adjustments": {
      "$ref": "#/components/schemas/AssetDevelopMaskAdjustments",
      "default": {
        "blacks": 0,
        "contrast": 0,
        "dehaze": 0,
        "exposure": 0,
        "highlights": 0,
        "saturation": 0,
        "shadows": 0,
        "temperature": 0,
        "tint": 0,
        "vibrance": 0,
        "whites": 0
      }
    },
    "amount": {
      "default": 100,
      "description": "How much of the adjustment is applied, as a percentage",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "artifact": {
      "description": "Subject, sky and background masks: the stored greyscale mask bitmap, covering the whole original image",
      "nullable": true,
      "pattern": "^[0-9a-f]{64}$",
      "type": "string"
    },
    "detector": {
      "additionalProperties": {},
      "description": "Subject, sky and background masks: an opaque descriptor that lets a client detect the mask again; the server never runs it",
      "type": "object"
    },
    "enabled": {
      "default": true,
      "description": "A disabled mask is kept but not rendered",
      "type": "boolean"
    },
    "endX": {
      "default": 0.5,
      "description": "Where a linear mask has faded out, across the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "endY": {
      "default": 1,
      "description": "Where a linear mask has faded out, down the frame",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "feather": {
      "default": 50,
      "description": "Softness of a radial edge as a percentage of the radius, or of a brush stroke as one of its radius",
      "maximum": 100,
      "minimum": 0,
      "type": "integer"
    },
    "id": {
      "description": "Client-chosen identifier, unique within the recipe",
      "maxLength": 40,
      "minLength": 1,
      "type": "string"
    },
    "invert": {
      "default": false,
      "description": "Apply the adjustment outside the shape instead of inside",
      "type": "boolean"
    },
    "kind": {
      "$ref": "#/components/schemas/AssetDevelopMaskKind"
    },
    "name": {
      "default": null,
      "description": "Optional name shown in the editor",
      "maxLength": 60,
      "minLength": 1,
      "nullable": true,
      "type": "string"
    },
    "radiusX": {
      "default": 0.25,
      "description": "Horizontal radius of a radial mask as a fraction of the frame width",
      "format": "double",
      "maximum": 1,
      "minimum": 0.01,
      "type": "number"
    },
    "radiusY": {
      "default": 0.25,
      "description": "Vertical radius of a radial mask as a fraction of the frame height",
      "format": "double",
      "maximum": 1,
      "minimum": 0.01,
      "type": "number"
    },
    "strokes": {
      "description": "Brush masks: the painted strokes, in order",
      "items": {
        "$ref": "#/components/schemas/AssetDevelopStroke"
      },
      "maxItems": 64,
      "type": "array"
    },
    "x": {
      "description": "Centre (radial) or start (linear) across the oriented frame; any value for brush and bitmap masks",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    },
    "y": {
      "description": "Centre (radial) or start (linear) down the oriented frame; any value for brush and bitmap masks",
      "format": "double",
      "maximum": 1,
      "minimum": 0,
      "type": "number"
    }
  },
  "required": [
    "id",
    "kind",
    "x",
    "y"
  ],
  "type": "object"
}
```

## AssetDevelopMaskAdjustments


```json
{
  "properties": {
    "blacks": {
      "default": 0,
      "description": "Black point inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "contrast": {
      "default": 0,
      "description": "Contrast inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "dehaze": {
      "default": 0,
      "description": "Dehaze inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "exposure": {
      "default": 0,
      "description": "Exposure in EV inside the mask",
      "format": "double",
      "maximum": 2,
      "minimum": -2,
      "type": "number"
    },
    "highlights": {
      "default": 0,
      "description": "Highlights inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "saturation": {
      "default": 0,
      "description": "Saturation inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "shadows": {
      "default": 0,
      "description": "Shadows inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "temperature": {
      "default": 0,
      "description": "White balance shift inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "tint": {
      "default": 0,
      "description": "Tint inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vibrance": {
      "default": 0,
      "description": "Vibrance inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "whites": {
      "default": 0,
      "description": "White point inside the mask",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "type": "object"
}
```

## AssetDevelopMaskKind


```json
{
  "description": "Shape of a selective adjustment mask",
  "enum": [
    "radial",
    "linear",
    "brush",
    "subject",
    "sky",
    "background"
  ],
  "type": "string"
}
```

## AssetDevelopPerspective


```json
{
  "properties": {
    "horizontal": {
      "default": 0,
      "description": "Positive widens the right side of the picture, negative the left side",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    },
    "vertical": {
      "default": 0,
      "description": "Positive widens the top of the picture (verticals converging upwards), negative the bottom",
      "format": "double",
      "maximum": 100,
      "minimum": -100,
      "type": "number"
    }
  },
  "type": "object"
}
```

## AssetDevelopPreset


```json
{
  "description": "Named look applied on top of the develop sliders",
  "enum": [
    "Original",
    "Vivid",
    "Natural",
    "Warm",
    "Cool",
    "Mono",
    "Silvertone",
    "Noir",
    "Fade"
  ],
  "type": "string"
}
```

## AssetDevelopPreviewDto

Related models: [AssetDevelopRecipeDto](models-05.md#assetdeveloprecipedto).

```json
{
  "properties": {
    "dynamicRange": {
      "description": "Omitted requests retain SDR-compatible previews",
      "enum": [
        "auto",
        "sdr",
        "hdr"
      ],
      "type": "string"
    },
    "recipe": {
      "$ref": "#/components/schemas/AssetDevelopRecipeDto"
    },
    "size": {
      "default": 1280,
      "description": "Longest edge of the preview in pixels; the original is never upscaled",
      "maximum": 2048,
      "minimum": 256,
      "type": "integer"
    }
  },
  "required": [
    "recipe"
  ],
  "type": "object"
}
```

## AssetDevelopProposalCoordinates


```json
{
  "enum": [
    "sensor-active",
    "original"
  ],
  "type": "string"
}
```
