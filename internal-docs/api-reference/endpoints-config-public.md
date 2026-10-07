# Server API — Config (public)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getPublicConfig

`GET /api/public/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/config-public.controller.ts#L15).

Get the public configuration

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PublicConfigDto](models-26.md#publicconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigPublic)
@Controller('public/config')
@Get()
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get the public configuration',
    description: 'Retrieve the system configuration properties that are visible to everyone.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the system configuration properties that are visible to everyone.",
  "operationId": "getPublicConfig",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PublicConfigDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get the public configuration",
  "tags": [
    "Config (public)"
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
  "x-immich-state": "Alpha"
}
```

## getPublicConfigDefaults

`GET /api/public/config/defaults`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/config-public.controller.ts#L26).

Get the public configuration defaults

Permission: `See authentication declaration`. Admin only: `false`.

Models: [PublicConfigDto](models-26.md#publicconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigPublic)
@Controller('public/config')
@Get('defaults')
@Authenticated({ public: true })
@Endpoint({
    summary: 'Get the public configuration defaults',
    description: 'Retrieve the default value of the configuration properties that are visible to everyone.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the default value of the configuration properties that are visible to everyone.",
  "operationId": "getPublicConfigDefaults",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PublicConfigDto"
          }
        }
      },
      "description": ""
    }
  },
  "summary": "Get the public configuration defaults",
  "tags": [
    "Config (public)"
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
  "x-immich-state": "Alpha"
}
```
