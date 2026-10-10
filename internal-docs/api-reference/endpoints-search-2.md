# Server API — Search 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchSmartStatistics

`POST /api/search/smart/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L89).

Smart search statistics

Permission: `asset.read`. Admin only: `false`.

Models: [SmartSearchDto](models-33.md#smartsearchdto), [SmartSearchStatisticsResponseDto](models-33.md#smartsearchstatisticsresponsedto).

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

## searchAssetStatistics

`POST /api/search/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L51).

Search asset statistics

Permission: `asset.statistics`. Admin only: `false`.

Models: [SearchStatisticsResponseDto](models-31.md#searchstatisticsresponsedto), [StatisticsSearchDto](models-33.md#statisticssearchdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Post('statistics')
@Authenticated({ permission: Permission.AssetStatistics })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Search asset statistics',
    description: 'Retrieve statistical data about assets based on search criteria, such as the total matching count.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve statistical data about assets based on search criteria, such as the total matching count.",
  "operationId": "searchAssetStatistics",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/StatisticsSearchDto"
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
            "$ref": "#/components/schemas/SearchStatisticsResponseDto"
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
  "summary": "Search asset statistics",
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
  "x-immich-permission": "asset.statistics",
  "x-immich-state": "Stable"
}
```

## getSearchSuggestions

`GET /api/search/suggestions`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/search.controller.ts#L219).

Retrieve search suggestions

Permission: `asset.read`. Admin only: `false`.

Models: [SearchSuggestionType](models-32.md#searchsuggestiontype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Search)
@Controller('search')
@Get('suggestions')
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Retrieve search suggestions',
    description:
      'Retrieve search suggestions based on partial input. This endpoint is used for typeahead search features.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve search suggestions based on partial input. This endpoint is used for typeahead search features.",
  "operationId": "getSearchSuggestions",
  "parameters": [
    {
      "name": "country",
      "required": false,
      "in": "query",
      "description": "Filter by country",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "includeNull",
      "required": false,
      "in": "query",
      "description": "Include null values in suggestions",
      "x-immich-history": [
        {
          "version": "v1.111.0",
          "state": "Added"
        },
        {
          "version": "v2",
          "state": "Stable"
        }
      ],
      "x-immich-state": "Stable",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "lensModel",
      "required": false,
      "in": "query",
      "description": "Filter by lens model",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "make",
      "required": false,
      "in": "query",
      "description": "Filter by camera make",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "model",
      "required": false,
      "in": "query",
      "description": "Filter by camera model",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "state",
      "required": false,
      "in": "query",
      "description": "Filter by state/province",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "type",
      "required": true,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/SearchSuggestionType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "type": "string"
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
  "summary": "Retrieve search suggestions",
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
