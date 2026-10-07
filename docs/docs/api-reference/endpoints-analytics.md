# Server API — Analytics

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getAnalyticsReport

`GET /api/analytics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/analytics.controller.ts#L34).

Retrieve library analytics

Permission: `See authentication declaration`. Admin only: `false`.

Models: [AnalyticsRange](models-03.md#analyticsrange), [AnalyticsReportResponseDto](models-03.md#analyticsreportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Analytics)
@Controller('analytics')
@Get()
@Authenticated()
@Endpoint({
    summary: 'Retrieve library analytics',
    description:
      'Counts, sizes, dated history and processing outcomes for one selection and date range. Series that are not recorded for the selection are omitted or null, never filled in; estimated processing cost is an estimate, not a charge.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Counts, sizes, dated history and processing outcomes for one selection and date range. Series that are not recorded for the selection are omitted or null, never filled in; estimated processing cost is an estimate, not a charge.",
  "operationId": "getAnalyticsReport",
  "parameters": [
    {
      "name": "range",
      "required": false,
      "in": "query",
      "schema": {
        "default": "year",
        "$ref": "#/components/schemas/AnalyticsRange"
      }
    },
    {
      "name": "scope",
      "required": false,
      "in": "query",
      "description": "`all` (the whole server, administrators only), `account:<id>` or `library:<id>`",
      "schema": {
        "default": "all",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AnalyticsReportResponseDto"
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
  "summary": "Retrieve library analytics",
  "tags": [
    "Analytics"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```

## getAnalyticsScopes

`GET /api/analytics/scopes`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/analytics.controller.ts#L22).

List analytics scopes

Permission: `See authentication declaration`. Admin only: `false`.

Models: [AnalyticsScopesResponseDto](models-03.md#analyticsscopesresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Analytics)
@Controller('analytics')
@Get('scopes')
@Authenticated()
@Endpoint({
    summary: 'List analytics scopes',
    description:
      'The selections the signed-in account may read analytics for: the whole server for administrators, then accounts and external libraries.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "The selections the signed-in account may read analytics for: the whole server for administrators, then accounts and external libraries.",
  "operationId": "getAnalyticsScopes",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AnalyticsScopesResponseDto"
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
  "summary": "List analytics scopes",
  "tags": [
    "Analytics"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    },
    {
      "version": "v3.0.0",
      "state": "Alpha"
    }
  ],
  "x-immich-state": "Alpha"
}
```
