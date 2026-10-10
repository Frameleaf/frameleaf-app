# Server API — Authentication 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## linkOAuthAccount

`POST /api/oauth/link`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/oauth.controller.ts#L111).

Link OAuth account

Permission: `See authentication declaration`. Admin only: `false`.

Models: [OAuthCallbackDto](models-18.md#oauthcallbackdto), [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Post('link')
@Authenticated()
@RateLimited(RATE_LIMITS.oauthCallback)
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Link OAuth account',
    description: 'Link an OAuth account to the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Link an OAuth account to the authenticated user.",
  "operationId": "linkOAuthAccount",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/OAuthCallbackDto"
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
            "$ref": "#/components/schemas/UserAdminResponseDto"
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
  "summary": "Link OAuth account",
  "tags": [
    "Authentication"
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
  "x-immich-state": "Stable"
}
```

## redirectOAuthToMobile

`GET /api/oauth/mobile-redirect`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/oauth.controller.ts#L25).

Redirect OAuth to mobile

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Get('mobile-redirect')
@Authenticated({ public: true })
@Redirect()
@Endpoint({
    summary: 'Redirect OAuth to mobile',
    description:
      'Requests to this URL are automatically forwarded to the mobile app, and is used in some cases for OAuth redirecting.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Requests to this URL are automatically forwarded to the mobile app, and is used in some cases for OAuth redirecting.",
  "operationId": "redirectOAuthToMobile",
  "parameters": [],
  "responses": {
    "200": {
      "description": ""
    }
  },
  "summary": "Redirect OAuth to mobile",
  "tags": [
    "Authentication"
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
  "x-immich-state": "Stable"
}
```

## unlinkOAuthAccount

`POST /api/oauth/unlink`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/oauth.controller.ts#L128).

Unlink OAuth account

Permission: `See authentication declaration`. Admin only: `false`.

Models: [UserAdminResponseDto](models-37.md#useradminresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Authentication)
@Controller('oauth')
@Post('unlink')
@Authenticated()
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Unlink OAuth account',
    description: 'Unlink the OAuth account from the authenticated user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Unlink the OAuth account from the authenticated user.",
  "operationId": "unlinkOAuthAccount",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/UserAdminResponseDto"
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
  "summary": "Unlink OAuth account",
  "tags": [
    "Authentication"
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
  "x-immich-state": "Stable"
}
```
