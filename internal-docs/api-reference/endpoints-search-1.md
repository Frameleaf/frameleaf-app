# Server API — Search 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## askSearch

`POST /api/search/ask`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L137).

Ask Search

Permission: `asset.read`. Admin only: `false`.

Models: [AskSearchDto](models-03.md#asksearchdto), [AskSearchResponseDto](models-04.md#asksearchresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('ask')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Ask Search',
    description: 'Interpret a natural language query locally and search assets with existing search primitives.',
    history: new HistoryBuilder().added('v2.7.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Interpret a natural language query locally and search assets with existing search primitives.",
  "operationId": "askSearch",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AskSearchDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AskSearchResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Ask Search",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v2.7.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.read"
}
```

## getAssetsByCity

`GET /api/search/cities`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L182).

Retrieve assets by city

Permission: `asset.read`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('cities')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve assets by city',
    description:
      'Retrieve a list of assets with each asset belonging to a different city. This endpoint is used on the places pages to show a single thumbnail for each city the user has assets in.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of assets with each asset belonging to a different city. This endpoint is used on the places pages to show a single thumbnail for each city the user has assets in.",
  "operationId": "getAssetsByCity",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve assets by city",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## getCityAssetCounts

`GET /api/search/cities/counts`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L194).

Retrieve asset counts by city

Permission: `asset.read`. Admin only: `false`.

Models: [SearchCityCountResponseDto](models-29.md#searchcitycountresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('cities/counts')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve asset counts by city',
    description:
      'Retrieve how many timeline photos and videos the user can see in each city. Counts include videos, while GET /search/cities lists only cities with at least one photo, so a city that has only videos appears here but not in that list. Locked, hidden and trashed media are never counted.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve how many timeline photos and videos the user can see in each city. Counts include videos, while GET /search/cities lists only cities with at least one photo, so a city that has only videos appears here but not in that list. Locked, hidden and trashed media are never counted.",
  "operationId": "getCityAssetCounts",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SearchCityCountResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve asset counts by city",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "asset.read"
}
```

## getExploreData

`GET /api/search/explore`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L149).

Retrieve explore data

Permission: `asset.read`. Admin only: `false`.

Models: [SearchExploreResponseDto](models-29.md#searchexploreresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('explore')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve explore data',
    description: 'Retrieve data for the explore section, such as popular people and places.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve data for the explore section, such as popular people and places.",
  "operationId": "getExploreData",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SearchExploreResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Retrieve explore data",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchFacets

`POST /api/search/facets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L62).

Search facet counts

Permission: `asset.read`. Admin only: `false`.

Models: [SearchFacetsDto](models-30.md#searchfacetsdto), [SearchFacetsResponseDto](models-30.md#searchfacetsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('facets')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search facet counts',
    description:
      "Count the assets a metadata search body matches by people, media type, places, cameras, lenses, rating, favorites and tags. People and tags are the caller's own; places of partners who hide their locations are left out.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Count the assets a metadata search body matches by people, media type, places, cameras, lenses, rating, favorites and tags. People and tags are the caller's own; places of partners who hide their locations are left out.",
  "operationId": "searchFacets",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SearchFacetsDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SearchFacetsResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search facet counts",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## searchHistogram

`POST /api/search/histogram`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L75).

Search date histogram

Permission: `asset.read`. Admin only: `false`.

Models: [SearchHistogramDto](models-30.md#searchhistogramdto), [SearchHistogramResponseDto](models-30.md#searchhistogramresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('histogram')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search date histogram',
    description:
      'Count the assets a metadata search body matches per local capture day, month or year. The buckets add up to the POST /search/statistics total for the same body.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Count the assets a metadata search body matches per local capture day, month or year. The buckets add up to the POST /search/statistics total for the same body.",
  "operationId": "searchHistogram",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SearchHistogramDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SearchHistogramResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search date histogram",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```

## searchLargeAssets

`POST /api/search/large-assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L113).

Search large assets

Permission: `asset.read`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [ImageEnrichmentFilter](models-14.md#imageenrichmentfilter).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('large-assets')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search large assets',
    description: 'Search for assets that are considered large based on specified criteria.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Search for assets that are considered large based on specified criteria.",
  "operationId": "searchLargeAssets",
  "parameters": [
    {
      "name": "albumIds",
      "required": false,
      "in": "query",
      "description": "Filter by album IDs",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$"
        }
      }
    },
    {
      "name": "city",
      "required": false,
      "in": "query",
      "description": "Filter by city name",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "country",
      "required": false,
      "in": "query",
      "description": "Filter by country name",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "createdAfter",
      "required": false,
      "in": "query",
      "description": "Filter by creation date (after)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "createdBefore",
      "required": false,
      "in": "query",
      "description": "Filter by creation date (before)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "imageEnrichment",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/ImageEnrichmentFilter"
      }
    },
    {
      "name": "isEncoded",
      "required": false,
      "in": "query",
      "description": "Filter by encoded status",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isMotion",
      "required": false,
      "in": "query",
      "description": "Filter by motion photo status",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isNotInAlbum",
      "required": false,
      "in": "query",
      "description": "Filter assets not in any album",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isOffline",
      "required": false,
      "in": "query",
      "description": "Filter by offline status",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "lensModel",
      "required": false,
      "in": "query",
      "description": "Filter by lens model",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "libraryId",
      "required": false,
      "in": "query",
      "description": "Library ID to filter by",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "nullable": true
      }
    },
    {
      "name": "make",
      "required": false,
      "in": "query",
      "description": "Filter by camera make",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "minFileSize",
      "required": false,
      "in": "query",
      "description": "Minimum file size in bytes",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "model",
      "required": false,
      "in": "query",
      "description": "Filter by camera model",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "ocr",
      "required": false,
      "in": "query",
      "description": "Filter by OCR text content",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "personIds",
      "required": false,
      "in": "query",
      "description": "Filter by person IDs",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$"
        }
      }
    },
    {
      "name": "petIds",
      "required": false,
      "in": "query",
      "description": "Filter by the caller's own pet IDs (confirmed pet observations only)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$"
        }
      }
    },
    {
      "name": "rating",
      "required": false,
      "in": "query",
      "description": "Filter by rating [1-5], or null for unrated",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "integer",
        "minimum": 1,
        "maximum": 5,
        "nullable": true
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of results to return",
      "schema": {
        "minimum": 1,
        "maximum": 1000,
        "type": "integer"
      }
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "description": "Filter by state/province name",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "string",
        "nullable": true
      }
    },
    {
      "name": "suppressedOnly",
      "required": false,
      "in": "query",
      "description": "Return only suppressed content. Requires an elevated session.",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "tagIds",
      "required": false,
      "in": "query",
      "description": "Filter by tag IDs",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "array",
        "items": {
          "type": "string",
          "format": "uuid",
          "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$"
        },
        "nullable": true
      }
    },
    {
      "name": "takenAfter",
      "required": false,
      "in": "query",
      "description": "Filter by taken date (after)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "takenBefore",
      "required": false,
      "in": "query",
      "description": "Filter by taken date (before)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "trashedAfter",
      "required": false,
      "in": "query",
      "description": "Filter by trash date (after)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "trashedBefore",
      "required": false,
      "in": "query",
      "description": "Filter by trash date (before)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    },
    {
      "name": "updatedAfter",
      "required": false,
      "in": "query",
      "description": "Filter by update date (after)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "updatedBefore",
      "required": false,
      "in": "query",
      "description": "Filter by update date (before)",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    },
    {
      "name": "withDeleted",
      "required": false,
      "in": "query",
      "description": "Include deleted assets",
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
      "x-immich-state": "Deprecated",
      "deprecated": true,
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withExif",
      "required": false,
      "in": "query",
      "description": "Include EXIF data in response",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search large assets",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchAssets

`POST /api/search/metadata`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L38).

Search assets by metadata

Permission: `asset.read`. Admin only: `false`.

Models: [MetadataSearchDto](models-17.md#metadatasearchdto), [SearchResponseDto](models-30.md#searchresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('metadata')
@Authenticated({ permission: Permission.AssetRead, sharedLink: true })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search assets by metadata',
    description: 'Search for assets based on various metadata criteria.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Search for assets based on various metadata criteria.",
  "operationId": "searchAssets",
  "parameters": [
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "slug",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MetadataSearchDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SearchResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search assets by metadata",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchPerson

`GET /api/search/person`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L160).

Search people

Permission: `person.read`. Admin only: `false`.

Models: [PersonResponseDto](models-19.md#personresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('person')
@Authenticated({ permission: Permission.PersonRead })
@Endpoint({
    summary: 'Search people',
    description: 'Search for people by name.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Search for people by name.",
  "operationId": "searchPerson",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "query",
      "description": "Person name to search for",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "withHidden",
      "required": false,
      "in": "query",
      "description": "Include hidden people",
      "schema": {
        "type": "boolean"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PersonResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search people",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "person.read",
  "x-immich-state": "Stable"
}
```

## searchPlaces

`GET /api/search/places`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L171).

Search places

Permission: `asset.read`. Admin only: `false`.

Models: [PlacesResponseDto](models-26.md#placesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('places')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Search places',
    description: 'Search for places by name.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Search for places by name.",
  "operationId": "searchPlaces",
  "parameters": [
    {
      "name": "name",
      "required": true,
      "in": "query",
      "description": "Place name to search for",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PlacesResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search places",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchRandom

`POST /api/search/random`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L101).

Search random assets

Permission: `asset.read`. Admin only: `false`.

Models: [AssetResponseDto](models-06.md#assetresponsedto), [RandomSearchDto](models-28.md#randomsearchdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('random')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search random assets',
    description: 'Retrieve a random selection of assets based on the provided criteria.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a random selection of assets based on the provided criteria.",
  "operationId": "searchRandom",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RandomSearchDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/AssetResponseDto"
            },
            "type": "array"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Search random assets",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchSmart

`POST /api/search/smart`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L125).

Smart asset search

Permission: `asset.read`. Admin only: `false`.

Models: [SearchResponseDto](models-30.md#searchresponsedto), [SmartSearchDto](models-32.md#smartsearchdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('smart')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Smart asset search',
    description: 'Perform a smart search for assets by using machine learning vectors to determine relevance.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Perform a smart search for assets by using machine learning vectors to determine relevance.",
  "operationId": "searchSmart",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SmartSearchDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SearchResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Smart asset search",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    },
    {
      "version": "v2",
      "state": "Stable"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Stable"
}
```

## searchSmartStatistics

`POST /api/search/smart/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L88).

Smart search statistics

Permission: `asset.read`. Admin only: `false`.

Models: [SmartSearchDto](models-32.md#smartsearchdto), [SmartSearchStatisticsResponseDto](models-32.md#smartsearchstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('smart/statistics')
@Authenticated({ permission: Permission.AssetRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Smart search statistics',
    description:
      'How many assets a smart search body would rank, counted up to 1000 and flagged when capped. No text is encoded to answer it.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "How many assets a smart search body would rank, counted up to 1000 and flagged when capped. No text is encoded to answer it.",
  "operationId": "searchSmartStatistics",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SmartSearchDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SmartSearchStatisticsResponseDto"
          }
        }
      },
      "description": ""
    }
  },
  "security": [
    {
      "bearer": []
    },
    {
      "cookie": []
    },
    {
      "api_key": []
    }
  ],
  "summary": "Smart search statistics",
  "tags": [
    "Search"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    },
    {
      "version": "v3.2.0",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Alpha"
}
```
