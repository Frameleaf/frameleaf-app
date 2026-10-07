# Server API — Config (user)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getUserConfig

`GET /api/config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-user.controller.ts#L14).

Get the configuration with user visibility

Permission: `userConfig.read`. Admin only: `false`.

Models: [UserConfigDto](models-36.md#userconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigUser)
@Controller('config')
@Get()
@Authenticated({ permission: Permission.UserConfigRead })
@Endpoint({
    summary: 'Get the configuration with user visibility',
    description: 'Retrieve the system configuration properties that are visible to logged in users.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the system configuration properties that are visible to logged in users.",
  "operationId": "getUserConfig",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserConfigDto"
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
  "summary": "Get the configuration with user visibility",
  "tags": [
    "Config (user)"
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
  "x-immich-permission": "userConfig.read",
  "x-immich-state": "Alpha"
}
```

## getUserConfigDefaults

`GET /api/config/defaults`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/config-user.controller.ts#L25).

Get the default configuration with user visibility

Permission: `userConfig.read`. Admin only: `false`.

Models: [UserConfigDto](models-36.md#userconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ConfigUser)
@Controller('config')
@Get('defaults')
@Authenticated({ permission: Permission.UserConfigRead })
@Endpoint({
    summary: 'Get the default configuration with user visibility',
    description: 'Retrieve the default value of the configuration properties that are visible to logged in users.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the default value of the configuration properties that are visible to logged in users.",
  "operationId": "getUserConfigDefaults",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserConfigDto"
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
  "summary": "Get the default configuration with user visibility",
  "tags": [
    "Config (user)"
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
  "x-immich-permission": "userConfig.read",
  "x-immich-state": "Alpha"
}
```
