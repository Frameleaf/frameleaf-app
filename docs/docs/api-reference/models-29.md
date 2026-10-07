# Server API models 29

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## SearchFacetsDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-13.md#imageenrichmentfilter), [SearchFacetField](models-28.md#searchfacetfield), [SearchFilter](models-29.md#searchfilter).

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
    "facetCovers": {
      "description": "Also return, per value, the newest matching asset (by capture time) as its cover",
      "type": "boolean",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "facetLimit": {
      "description": "Most frequent values per facet (default 10)",
      "maximum": 100,
      "minimum": 1,
      "type": "integer"
    },
    "facets": {
      "description": "Facets to count, each once (repeats are ignored); every facet when omitted",
      "items": {
        "$ref": "#/components/schemas/SearchFacetField"
      },
      "maxItems": 10,
      "minItems": 1,
      "type": "array"
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
    }
  },
  "type": "object"
}
```

## SearchFacetsResponseDto

Related models: [SearchFacetResponseDto](models-28.md#searchfacetresponsedto).

```json
{
  "properties": {
    "facets": {
      "description": "Per facet, the most frequent values, busiest first. type, rating and isFavorite always add up to total; people, places, cameras, lenses and tags count assets that have a value",
      "items": {
        "$ref": "#/components/schemas/SearchFacetResponseDto"
      },
      "type": "array"
    },
    "total": {
      "description": "Number of assets the search body matches, as POST /search/statistics reports",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "facets",
    "total"
  ],
  "type": "object"
}
```

## SearchFilter

Related models: [BoolFilter](models-06.md#boolfilter), [DateFilter](models-10.md#datefilter), [DateFilterNullable](models-10.md#datefilternullable), [EnumFilterAssetType](models-11.md#enumfilterassettype), [EnumFilterAssetVisibility](models-11.md#enumfilterassetvisibility), [IdFilter](models-13.md#idfilter), [IdFilterNullable](models-13.md#idfilternullable), [IdsFilter](models-13.md#idsfilter), [NumberFilter](models-17.md#numberfilter), [NumberFilterNullable](models-17.md#numberfilternullable), [SearchFilterBranch](models-29.md#searchfilterbranch), [StringFilter](models-31.md#stringfilter), [StringFilterNullable](models-31.md#stringfilternullable), [StringPatternFilter](models-31.md#stringpatternfilter), [StringSimilarityFilter](models-31.md#stringsimilarityfilter).

```json
{
  "additionalProperties": false,
  "properties": {
    "albumIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "checksum": {
      "$ref": "#/components/schemas/StringFilter"
    },
    "city": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "country": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "createdAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "description": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "encodedVideoPath": {
      "$ref": "#/components/schemas/StringFilter"
    },
    "fileSizeInBytes": {
      "$ref": "#/components/schemas/NumberFilter"
    },
    "hasAlbums": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "hasPeople": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "hasTags": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "id": {
      "$ref": "#/components/schemas/IdFilter"
    },
    "isEncoded": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isFavorite": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isMotion": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isOffline": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "lensModel": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "libraryId": {
      "$ref": "#/components/schemas/IdFilterNullable"
    },
    "localDateTime": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "make": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "model": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "ocr": {
      "$ref": "#/components/schemas/StringSimilarityFilter"
    },
    "or": {
      "items": {
        "$ref": "#/components/schemas/SearchFilterBranch"
      },
      "minItems": 1,
      "type": "array"
    },
    "originalFileName": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "originalPath": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "personIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "petIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "rating": {
      "$ref": "#/components/schemas/NumberFilterNullable"
    },
    "state": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "tagIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "takenAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "trashedAt": {
      "$ref": "#/components/schemas/DateFilterNullable"
    },
    "type": {
      "$ref": "#/components/schemas/EnumFilterAssetType"
    },
    "updatedAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "visibility": {
      "$ref": "#/components/schemas/EnumFilterAssetVisibility"
    }
  },
  "type": "object"
}
```

## SearchFilterBranch

Related models: [BoolFilter](models-06.md#boolfilter), [DateFilter](models-10.md#datefilter), [DateFilterNullable](models-10.md#datefilternullable), [EnumFilterAssetType](models-11.md#enumfilterassettype), [EnumFilterAssetVisibility](models-11.md#enumfilterassetvisibility), [IdFilter](models-13.md#idfilter), [IdFilterNullable](models-13.md#idfilternullable), [IdsFilter](models-13.md#idsfilter), [NumberFilter](models-17.md#numberfilter), [NumberFilterNullable](models-17.md#numberfilternullable), [StringFilter](models-31.md#stringfilter), [StringFilterNullable](models-31.md#stringfilternullable), [StringPatternFilter](models-31.md#stringpatternfilter), [StringSimilarityFilter](models-31.md#stringsimilarityfilter).

```json
{
  "additionalProperties": false,
  "properties": {
    "albumIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "checksum": {
      "$ref": "#/components/schemas/StringFilter"
    },
    "city": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "country": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "createdAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "description": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "encodedVideoPath": {
      "$ref": "#/components/schemas/StringFilter"
    },
    "fileSizeInBytes": {
      "$ref": "#/components/schemas/NumberFilter"
    },
    "hasAlbums": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "hasPeople": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "hasTags": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "id": {
      "$ref": "#/components/schemas/IdFilter"
    },
    "isEncoded": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isFavorite": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isMotion": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "isOffline": {
      "$ref": "#/components/schemas/BoolFilter"
    },
    "lensModel": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "libraryId": {
      "$ref": "#/components/schemas/IdFilterNullable"
    },
    "localDateTime": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "make": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "model": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "ocr": {
      "$ref": "#/components/schemas/StringSimilarityFilter"
    },
    "originalFileName": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "originalPath": {
      "$ref": "#/components/schemas/StringPatternFilter"
    },
    "personIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "petIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "rating": {
      "$ref": "#/components/schemas/NumberFilterNullable"
    },
    "state": {
      "$ref": "#/components/schemas/StringFilterNullable"
    },
    "tagIds": {
      "$ref": "#/components/schemas/IdsFilter"
    },
    "takenAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "trashedAt": {
      "$ref": "#/components/schemas/DateFilterNullable"
    },
    "type": {
      "$ref": "#/components/schemas/EnumFilterAssetType"
    },
    "updatedAt": {
      "$ref": "#/components/schemas/DateFilter"
    },
    "visibility": {
      "$ref": "#/components/schemas/EnumFilterAssetVisibility"
    }
  },
  "type": "object"
}
```

## SearchHistogramBucketDto


```json
{
  "properties": {
    "count": {
      "maximum": 9007199254740991,
      "minimum": 1,
      "type": "integer"
    },
    "date": {
      "description": "First local capture date of the bucket (YYYY-MM-DD)",
      "format": "date",
      "type": "string"
    }
  },
  "required": [
    "count",
    "date"
  ],
  "type": "object"
}
```

## SearchHistogramDto

Related models: [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-13.md#imageenrichmentfilter), [SearchFilter](models-29.md#searchfilter), [SearchHistogramGranularity](models-29.md#searchhistogramgranularity).

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
    "filter": {
      "$ref": "#/components/schemas/SearchFilter",
      "x-immich-history": [
        {
          "version": "v3.2.0",
          "state": "Added"
        }
      ]
    },
    "granularity": {
      "$ref": "#/components/schemas/SearchHistogramGranularity",
      "default": "month",
      "description": "Bucket size"
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
    }
  },
  "type": "object"
}
```

## SearchHistogramGranularity


```json
{
  "enum": [
    "day",
    "month",
    "year"
  ],
  "type": "string"
}
```

## SearchHistogramResponseDto

Related models: [SearchHistogramBucketDto](models-29.md#searchhistogrambucketdto), [SearchHistogramGranularity](models-29.md#searchhistogramgranularity).

```json
{
  "properties": {
    "buckets": {
      "description": "Non-empty buckets by local capture date, oldest first",
      "items": {
        "$ref": "#/components/schemas/SearchHistogramBucketDto"
      },
      "type": "array"
    },
    "granularity": {
      "$ref": "#/components/schemas/SearchHistogramGranularity"
    },
    "total": {
      "description": "Sum of every bucket; equals POST /search/statistics for the same body",
      "maximum": 9007199254740991,
      "minimum": 0,
      "type": "integer"
    }
  },
  "required": [
    "buckets",
    "granularity",
    "total"
  ],
  "type": "object"
}
```

## SearchOrder

Related models: [AssetOrder](models-05.md#assetorder), [SearchOrderField](models-29.md#searchorderfield).

```json
{
  "properties": {
    "direction": {
      "$ref": "#/components/schemas/AssetOrder",
      "default": "desc"
    },
    "field": {
      "$ref": "#/components/schemas/SearchOrderField",
      "default": "fileCreatedAt"
    }
  },
  "type": "object"
}
```

## SearchOrderField


```json
{
  "enum": [
    "fileCreatedAt",
    "localDateTime",
    "fileSizeInBytes",
    "rating"
  ],
  "type": "string"
}
```

## SearchResponseDto

Related models: [SearchAlbumResponseDto](models-28.md#searchalbumresponsedto), [SearchAssetResponseDto](models-28.md#searchassetresponsedto).

```json
{
  "properties": {
    "albums": {
      "$ref": "#/components/schemas/SearchAlbumResponseDto"
    },
    "assets": {
      "$ref": "#/components/schemas/SearchAssetResponseDto"
    }
  },
  "required": [
    "albums",
    "assets"
  ],
  "type": "object"
}
```

## SearchStatisticsResponseDto


```json
{
  "properties": {
    "total": {
      "description": "Total number of matching assets",
      "maximum": 9007199254740991,
      "minimum": -9007199254740991,
      "type": "integer"
    }
  },
  "required": [
    "total"
  ],
  "type": "object"
}
```

## SearchSuggestionType


```json
{
  "description": "Suggestion type",
  "enum": [
    "country",
    "state",
    "city",
    "camera-make",
    "camera-model",
    "camera-lens-model"
  ],
  "type": "string"
}
```

## ServerAboutResponseDto


```json
{
  "properties": {
    "build": {
      "description": "Build identifier",
      "type": "string"
    },
    "buildImage": {
      "description": "Build image name",
      "type": "string"
    },
    "buildImageUrl": {
      "description": "Build image URL",
      "type": "string"
    },
    "buildUrl": {
      "description": "Build URL",
      "type": "string"
    },
    "exiftool": {
      "description": "ExifTool version",
      "type": "string"
    },
    "ffmpeg": {
      "description": "FFmpeg version",
      "type": "string"
    },
    "imagemagick": {
      "description": "ImageMagick version",
      "type": "string"
    },
    "libraw": {
      "description": "LibRaw/dcraw_emu version",
      "type": "string"
    },
    "libvips": {
      "description": "libvips version",
      "type": "string"
    },
    "licensed": {
      "description": "Whether the server is licensed",
      "type": "boolean"
    },
    "nodejs": {
      "description": "Node.js version",
      "type": "string"
    },
    "repository": {
      "description": "Repository name",
      "type": "string"
    },
    "repositoryUrl": {
      "description": "Repository URL",
      "type": "string"
    },
    "sourceCommit": {
      "description": "Source commit hash",
      "type": "string"
    },
    "sourceRef": {
      "description": "Source reference (branch/tag)",
      "type": "string"
    },
    "sourceUrl": {
      "description": "Source URL",
      "type": "string"
    },
    "thirdPartyBugFeatureUrl": {
      "description": "Third-party bug/feature URL",
      "type": "string"
    },
    "thirdPartyDocumentationUrl": {
      "description": "Third-party documentation URL",
      "type": "string"
    },
    "thirdPartySourceUrl": {
      "description": "Third-party source URL",
      "type": "string"
    },
    "thirdPartySupportUrl": {
      "description": "Third-party support URL",
      "type": "string"
    },
    "version": {
      "description": "Server version",
      "type": "string"
    },
    "versionUrl": {
      "description": "URL to version information",
      "type": "string"
    }
  },
  "required": [
    "licensed",
    "version",
    "versionUrl"
  ],
  "type": "object"
}
```

## ServerApkLinksDto


```json
{
  "properties": {
    "arm64v8a": {
      "description": "APK download link for ARM64 v8a architecture",
      "type": "string"
    },
    "armeabiv7a": {
      "description": "APK download link for ARM EABI v7a architecture",
      "type": "string"
    },
    "universal": {
      "description": "APK download link for universal architecture",
      "type": "string"
    },
    "x86_64": {
      "description": "APK download link for x86_64 architecture",
      "type": "string"
    }
  },
  "required": [
    "arm64v8a",
    "armeabiv7a",
    "universal",
    "x86_64"
  ],
  "type": "object"
}
```
