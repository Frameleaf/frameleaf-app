# Server API — Timeline

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getTimeBucket

`GET /api/timeline/bucket`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/timeline.controller.ts#L33).

Get time bucket

Permission: `asset.read`. Admin only: `false`.

Models: [AssetLockReason](models-05.md#assetlockreason), [AssetOrder](models-06.md#assetorder), [AssetOrderBy](models-06.md#assetorderby), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [TimeBucketAssetResponseDto](models-37.md#timebucketassetresponsedto), [TimeBucketDateType](models-37.md#timebucketdatetype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Timeline)
@Controller('timeline')
@Get('bucket')
@Authenticated({ permission: Permission.AssetRead, sharedLink: true })
@ApiOkResponse({ type: TimeBucketAssetResponseDto })
@Header('Content-Type', 'application/json')
@Endpoint({
    summary: 'Get time bucket',
    description: 'Retrieve a string of all asset ids in a given time bucket.',
    history: new HistoryBuilder().added('v1').internal('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a string of all asset ids in a given time bucket.",
  "operationId": "getTimeBucket",
  "parameters": [
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Filter assets belonging to a specific album",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetType",
      "required": false,
      "in": "query",
      "description": "Filter assets by media type",
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    },
    {
      "name": "bbox",
      "required": false,
      "in": "query",
      "description": "Bounding box coordinates as west,south,east,north (WGS84)",
      "schema": {
        "example": "11.075683,49.416711,11.117589,49.454875",
        "type": "string"
      }
    },
    {
      "name": "dateType",
      "required": false,
      "in": "query",
      "description": "Date source for timeline bucket grouping. Defaults to taken date.",
      "schema": {
        "$ref": "#/components/schemas/TimeBucketDateType"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status (true for favorites only, false for non-favorites only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status (true for trashed assets only, false for non-trashed only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "lockReason",
      "required": false,
      "in": "query",
      "description": "With visibility LOCKED only: return only assets locked for this reason. Requires an elevated session.",
      "schema": {
        "$ref": "#/components/schemas/AssetLockReason"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "description": "Sort order for assets within time buckets (ASC for oldest first, DESC for newest first)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrder"
      }
    },
    {
      "name": "orderBy",
      "required": false,
      "in": "query",
      "description": "Date to group and order assets by (takenAt for date taken, createdAt for date added to Frameleaf)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrderBy"
      }
    },
    {
      "name": "personId",
      "required": false,
      "in": "query",
      "description": "Filter assets containing a specific person (face recognition)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "petId",
      "required": false,
      "in": "query",
      "description": "Filter assets in which the caller confirmed one of their own pets",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
      "name": "tagId",
      "required": false,
      "in": "query",
      "description": "Filter assets with a specific tag",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "timeBucket",
      "required": true,
      "in": "query",
      "description": "Time bucket identifier in YYYY-MM-DDT00:00:00.000Z format",
      "schema": {
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": false,
      "in": "query",
      "description": "Filter assets by specific user ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "description": "Filter by asset visibility status (ARCHIVE, TIMELINE, HIDDEN, LOCKED)",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    },
    {
      "name": "withCoordinates",
      "required": false,
      "in": "query",
      "description": "Include location data in the response",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withStacked",
      "required": false,
      "in": "query",
      "description": "Include stacked assets in the response. When true, only primary assets from stacks are returned.",
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
            "$ref": "#/components/schemas/TimeBucketAssetResponseDto"
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
  "summary": "Get time bucket",
  "tags": [
    "Timeline"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Internal"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Internal"
}
```

## getTimeBuckets

`GET /api/timeline/buckets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/timeline.controller.ts#L22).

Get time buckets

Permission: `asset.read`. Admin only: `false`.

Models: [AssetLockReason](models-05.md#assetlockreason), [AssetOrder](models-06.md#assetorder), [AssetOrderBy](models-06.md#assetorderby), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [TimeBucketDateType](models-37.md#timebucketdatetype), [TimeBucketsResponseDto](models-37.md#timebucketsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Timeline)
@Controller('timeline')
@Get('buckets')
@Authenticated({ permission: Permission.AssetRead, sharedLink: true })
@Endpoint({
    summary: 'Get time buckets',
    description: 'Retrieve a list of all minimal time buckets.',
    history: new HistoryBuilder().added('v1').internal('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of all minimal time buckets.",
  "operationId": "getTimeBuckets",
  "parameters": [
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Filter assets belonging to a specific album",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetType",
      "required": false,
      "in": "query",
      "description": "Filter assets by media type",
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    },
    {
      "name": "bbox",
      "required": false,
      "in": "query",
      "description": "Bounding box coordinates as west,south,east,north (WGS84)",
      "schema": {
        "example": "11.075683,49.416711,11.117589,49.454875",
        "type": "string"
      }
    },
    {
      "name": "dateType",
      "required": false,
      "in": "query",
      "description": "Date source for timeline bucket grouping. Defaults to taken date.",
      "schema": {
        "$ref": "#/components/schemas/TimeBucketDateType"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status (true for favorites only, false for non-favorites only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status (true for trashed assets only, false for non-trashed only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "lockReason",
      "required": false,
      "in": "query",
      "description": "With visibility LOCKED only: return only assets locked for this reason. Requires an elevated session.",
      "schema": {
        "$ref": "#/components/schemas/AssetLockReason"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "description": "Sort order for assets within time buckets (ASC for oldest first, DESC for newest first)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrder"
      }
    },
    {
      "name": "orderBy",
      "required": false,
      "in": "query",
      "description": "Date to group and order assets by (takenAt for date taken, createdAt for date added to Frameleaf)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrderBy"
      }
    },
    {
      "name": "personId",
      "required": false,
      "in": "query",
      "description": "Filter assets containing a specific person (face recognition)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "petId",
      "required": false,
      "in": "query",
      "description": "Filter assets in which the caller confirmed one of their own pets",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
      "name": "tagId",
      "required": false,
      "in": "query",
      "description": "Filter assets with a specific tag",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": false,
      "in": "query",
      "description": "Filter assets by specific user ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "description": "Filter by asset visibility status (ARCHIVE, TIMELINE, HIDDEN, LOCKED)",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    },
    {
      "name": "withCoordinates",
      "required": false,
      "in": "query",
      "description": "Include location data in the response",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withStacked",
      "required": false,
      "in": "query",
      "description": "Include stacked assets in the response. When true, only primary assets from stacks are returned.",
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
              "$ref": "#/components/schemas/TimeBucketsResponseDto"
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
  "summary": "Get time buckets",
  "tags": [
    "Timeline"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Internal"
    }
  ],
  "x-immich-permission": "asset.read",
  "x-immich-state": "Internal"
}
```

## getTimelineHighlights

`GET /api/timeline/highlights`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/timeline.controller.ts#L62).

Get timeline highlights

Permission: `asset.read`. Admin only: `false`.

Models: [AssetLockReason](models-05.md#assetlockreason), [AssetOrder](models-06.md#assetorder), [AssetOrderBy](models-06.md#assetorderby), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [TimeBucketDateType](models-37.md#timebucketdatetype), [TimelineHighlightGrouping](models-37.md#timelinehighlightgrouping), [TimelineHighlightResponseDto](models-37.md#timelinehighlightresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Timeline)
@Controller('timeline')
@Get('highlights')
@Authenticated({ permission: Permission.AssetRead, sharedLink: true })
@ApiOkResponse({ type: TimelineHighlightResponseDto, isArray: true })
@Endpoint({
    summary: 'Get timeline highlights',
    description:
      'Curated Years and Months cards for the same filters as the time buckets: per year or month the count, a key photo (highest Best Photos score, then rating, then most recent), highlights for months and the top three places.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Curated Years and Months cards for the same filters as the time buckets: per year or month the count, a key photo (highest Best Photos score, then rating, then most recent), highlights for months and the top three places.",
  "operationId": "getTimelineHighlights",
  "parameters": [
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Filter assets belonging to a specific album",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetType",
      "required": false,
      "in": "query",
      "description": "Filter assets by media type",
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    },
    {
      "name": "bbox",
      "required": false,
      "in": "query",
      "description": "Bounding box coordinates as west,south,east,north (WGS84)",
      "schema": {
        "example": "11.075683,49.416711,11.117589,49.454875",
        "type": "string"
      }
    },
    {
      "name": "dateType",
      "required": false,
      "in": "query",
      "description": "Date source for timeline bucket grouping. Defaults to taken date.",
      "schema": {
        "$ref": "#/components/schemas/TimeBucketDateType"
      }
    },
    {
      "name": "grouping",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/TimelineHighlightGrouping"
      }
    },
    {
      "name": "highlightCount",
      "required": false,
      "in": "query",
      "description": "Highlights besides the key photo for each month card (default 4). Year cards carry none",
      "schema": {
        "minimum": 0,
        "maximum": 12,
        "type": "integer"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status (true for favorites only, false for non-favorites only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status (true for trashed assets only, false for non-trashed only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "lockReason",
      "required": false,
      "in": "query",
      "description": "With visibility LOCKED only: return only assets locked for this reason. Requires an elevated session.",
      "schema": {
        "$ref": "#/components/schemas/AssetLockReason"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "description": "Sort order for assets within time buckets (ASC for oldest first, DESC for newest first)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrder"
      }
    },
    {
      "name": "orderBy",
      "required": false,
      "in": "query",
      "description": "Date to group and order assets by (takenAt for date taken, createdAt for date added to Frameleaf)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrderBy"
      }
    },
    {
      "name": "personId",
      "required": false,
      "in": "query",
      "description": "Filter assets containing a specific person (face recognition)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "petId",
      "required": false,
      "in": "query",
      "description": "Filter assets in which the caller confirmed one of their own pets",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
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
      "name": "tagId",
      "required": false,
      "in": "query",
      "description": "Filter assets with a specific tag",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": false,
      "in": "query",
      "description": "Filter assets by specific user ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "description": "Filter by asset visibility status (ARCHIVE, TIMELINE, HIDDEN, LOCKED)",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    },
    {
      "name": "withCoordinates",
      "required": false,
      "in": "query",
      "description": "Include location data in the response",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withStacked",
      "required": false,
      "in": "query",
      "description": "Include stacked assets in the response. When true, only primary assets from stacks are returned.",
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
              "$ref": "#/components/schemas/TimelineHighlightResponseDto"
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
  "summary": "Get timeline highlights",
  "tags": [
    "Timeline"
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

## getTimelineOrdered

`GET /api/timeline/ordered`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/timeline.controller.ts#L48).

Get the timeline in a flat order

Permission: `asset.read`. Admin only: `false`.

Models: [AssetLockReason](models-05.md#assetlockreason), [AssetOrder](models-06.md#assetorder), [AssetOrderBy](models-06.md#assetorderby), [AssetTypeEnum](models-06.md#assettypeenum), [AssetVisibility](models-06.md#assetvisibility), [TimeBucketAssetResponseDto](models-37.md#timebucketassetresponsedto), [TimeBucketDateType](models-37.md#timebucketdatetype), [TimelineOrderedSort](models-37.md#timelineorderedsort).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Timeline)
@Controller('timeline')
@Get('ordered')
@Authenticated({ permission: Permission.AssetRead })
@ApiOkResponse({ type: TimeBucketAssetResponseDto })
@Header('Content-Type', 'application/json')
@Endpoint({
    summary: 'Get the timeline in a flat order',
    description:
      'One page of the assets the time buckets would show for the same filters, ordered by file name or by rating instead of by date, in the time bucket response shape.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "One page of the assets the time buckets would show for the same filters, ordered by file name or by rating instead of by date, in the time bucket response shape.",
  "operationId": "getTimelineOrdered",
  "parameters": [
    {
      "name": "after",
      "required": false,
      "in": "query",
      "description": "Continue after the previous ordered page cursor; overrides skip",
      "schema": {
        "maxLength": 8192,
        "type": "string"
      }
    },
    {
      "name": "albumId",
      "required": false,
      "in": "query",
      "description": "Filter assets belonging to a specific album",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "assetType",
      "required": false,
      "in": "query",
      "description": "Filter assets by media type",
      "schema": {
        "$ref": "#/components/schemas/AssetTypeEnum"
      }
    },
    {
      "name": "bbox",
      "required": false,
      "in": "query",
      "description": "Bounding box coordinates as west,south,east,north (WGS84)",
      "schema": {
        "example": "11.075683,49.416711,11.117589,49.454875",
        "type": "string"
      }
    },
    {
      "name": "before",
      "required": false,
      "in": "query",
      "description": "Read the page before this ordered cursor; overrides skip",
      "schema": {
        "maxLength": 8192,
        "type": "string"
      }
    },
    {
      "name": "dateType",
      "required": false,
      "in": "query",
      "description": "Date source for timeline bucket grouping. Defaults to taken date.",
      "schema": {
        "$ref": "#/components/schemas/TimeBucketDateType"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status (true for favorites only, false for non-favorites only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Filter by trash status (true for trashed assets only, false for non-trashed only)",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "key",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "lockReason",
      "required": false,
      "in": "query",
      "description": "With visibility LOCKED only: return only assets locked for this reason. Requires an elevated session.",
      "schema": {
        "$ref": "#/components/schemas/AssetLockReason"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "description": "Sort order for assets within time buckets (ASC for oldest first, DESC for newest first)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrder"
      }
    },
    {
      "name": "orderBy",
      "required": false,
      "in": "query",
      "description": "Date to group and order assets by (takenAt for date taken, createdAt for date added to Frameleaf)",
      "schema": {
        "$ref": "#/components/schemas/AssetOrderBy"
      }
    },
    {
      "name": "personId",
      "required": false,
      "in": "query",
      "description": "Filter assets containing a specific person (face recognition)",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "petId",
      "required": false,
      "in": "query",
      "description": "Filter assets in which the caller confirmed one of their own pets",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "skip",
      "required": false,
      "in": "query",
      "description": "Items to skip when no cursor is supplied",
      "schema": {
        "minimum": 0,
        "maximum": 9007199254740991,
        "default": 0,
        "type": "integer"
      }
    },
    {
      "name": "slug",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "sort",
      "required": true,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/TimelineOrderedSort"
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
      "name": "tagId",
      "required": false,
      "in": "query",
      "description": "Filter assets with a specific tag",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "description": "Items to return (at most 1000)",
      "schema": {
        "minimum": 1,
        "maximum": 1000,
        "default": 500,
        "type": "integer"
      }
    },
    {
      "name": "userId",
      "required": false,
      "in": "query",
      "description": "Filter assets by specific user ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "visibility",
      "required": false,
      "in": "query",
      "description": "Filter by asset visibility status (ARCHIVE, TIMELINE, HIDDEN, LOCKED)",
      "schema": {
        "$ref": "#/components/schemas/AssetVisibility"
      }
    },
    {
      "name": "withCoordinates",
      "required": false,
      "in": "query",
      "description": "Include location data in the response",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withStacked",
      "required": false,
      "in": "query",
      "description": "Include stacked assets in the response. When true, only primary assets from stacks are returned.",
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
            "$ref": "#/components/schemas/TimeBucketAssetResponseDto"
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
  "summary": "Get the timeline in a flat order",
  "tags": [
    "Timeline"
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
