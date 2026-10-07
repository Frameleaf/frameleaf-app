# Server API — Map

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getMapMarkers

`GET /api/map/markers`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/map.controller.ts#L21).

Retrieve map markers

Permission: `map.read`. Admin only: `false`.

Models: [MapMarkerResponseDto](models-15.md#mapmarkerresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Map)
@Controller('map')
@Get('markers')
@Authenticated({ permission: Permission.MapRead })
@Endpoint({
    summary: 'Retrieve map markers',
    description: 'Retrieve a list of latitude and longitude coordinates for every asset with location data.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of latitude and longitude coordinates for every asset with location data.",
  "operationId": "getMapMarkers",
  "parameters": [
    {
      "name": "fileCreatedAfter",
      "required": false,
      "in": "query",
      "description": "Filter assets created after this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "fileCreatedBefore",
      "required": false,
      "in": "query",
      "description": "Filter assets created before this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "isArchived",
      "required": false,
      "in": "query",
      "description": "Filter by archived status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withSharedAlbums",
      "required": false,
      "in": "query",
      "description": "Include shared album assets",
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
              "$ref": "#/components/schemas/MapMarkerResponseDto"
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
  "summary": "Retrieve map markers",
  "tags": [
    "Map"
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
  "x-immich-permission": "map.read",
  "x-immich-state": "Stable"
}
```

## reverseGeocode

`GET /api/map/reverse-geocode`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/map.controller.ts#L44).

Reverse geocode coordinates

Permission: `map.search`. Admin only: `false`.

Models: [MapReverseGeocodeResponseDto](models-15.md#mapreversegeocoderesponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Map)
@Controller('map')
@Get('reverse-geocode')
@Authenticated({ permission: Permission.MapSearch })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Reverse geocode coordinates',
    description: 'Retrieve location information (e.g., city, country) for given latitude and longitude coordinates.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve location information (e.g., city, country) for given latitude and longitude coordinates.",
  "operationId": "reverseGeocode",
  "parameters": [
    {
      "name": "lat",
      "required": true,
      "in": "query",
      "description": "Latitude (-90 to 90)",
      "schema": {
        "format": "double",
        "type": "number"
      }
    },
    {
      "name": "lon",
      "required": true,
      "in": "query",
      "description": "Longitude (-180 to 180)",
      "schema": {
        "format": "double",
        "type": "number"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/MapReverseGeocodeResponseDto"
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
  "summary": "Reverse geocode coordinates",
  "tags": [
    "Map"
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
  "x-immich-permission": "map.search",
  "x-immich-state": "Stable"
}
```

## getMapStatistics

`GET /api/map/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/map.controller.ts#L32).

Retrieve map statistics

Permission: `map.read`. Admin only: `false`.

Models: [MapStatisticsResponseDto](models-15.md#mapstatisticsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Map)
@Controller('map')
@Get('statistics')
@Authenticated({ permission: Permission.MapRead })
@Endpoint({
    summary: 'Retrieve map statistics',
    description:
      "Count what the map settings would add: the viewer's own located archived items and the located items of partners who share their locations, under the same date and favorite filters, and the viewer's own items without a location.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Count what the map settings would add: the viewer's own located archived items and the located items of partners who share their locations, under the same date and favorite filters, and the viewer's own items without a location.",
  "operationId": "getMapStatistics",
  "parameters": [
    {
      "name": "fileCreatedAfter",
      "required": false,
      "in": "query",
      "description": "Filter assets created after this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "fileCreatedBefore",
      "required": false,
      "in": "query",
      "description": "Filter assets created before this date",
      "schema": {
        "format": "date-time",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))T(?:(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d+)?)?(?:Z|([+-](?:[01]\\d|2[0-3]):[0-5]\\d)))$",
        "example": "2024-01-01T00:00:00.000Z",
        "type": "string"
      }
    },
    {
      "name": "isArchived",
      "required": false,
      "in": "query",
      "description": "Filter by archived status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isFavorite",
      "required": false,
      "in": "query",
      "description": "Filter by favorite status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "withSharedAlbums",
      "required": false,
      "in": "query",
      "description": "Include shared album assets",
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
            "$ref": "#/components/schemas/MapStatisticsResponseDto"
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
  "summary": "Retrieve map statistics",
  "tags": [
    "Map"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "map.read"
}
```
