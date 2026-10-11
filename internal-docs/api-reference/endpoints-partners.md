# Server API — Partners

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getPartners

`GET /api/partners`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L45).

Retrieve partners

Permission: `partner.read`. Admin only: `false`.

Models: [PartnerDirection](models-19.md#partnerdirection), [PartnerResponseDto](models-19.md#partnerresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Get()
@Authenticated({ permission: Permission.PartnerRead })
@Endpoint({
    summary: 'Retrieve partners',
    description: 'Retrieve a list of partners with whom assets are shared.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of partners with whom assets are shared.",
  "operationId": "getPartners",
  "parameters": [
    {
      "name": "direction",
      "required": true,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/PartnerDirection"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PartnerResponseDto"
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
  "summary": "Retrieve partners",
  "tags": [
    "Partners"
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
  "x-immich-permission": "partner.read",
  "x-immich-state": "Stable"
}
```

## createPartner

`POST /api/partners`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L56).

Create a partner

Permission: `partner.create`. Admin only: `false`.

Models: [PartnerCreateDto](models-19.md#partnercreatedto), [PartnerResponseDto](models-19.md#partnerresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Post()
@Authenticated({ permission: Permission.PartnerCreate })
@Endpoint({
    summary: 'Create a partner',
    description: 'Create a new partner to share assets with.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new partner to share assets with.",
  "operationId": "createPartner",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PartnerCreateDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PartnerResponseDto"
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
  "summary": "Create a partner",
  "tags": [
    "Partners"
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
  "x-immich-permission": "partner.create",
  "x-immich-state": "Stable"
}
```

## getPartnerLockedNotice

`GET /api/partners/locked-notice`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L22).

Get the Locked partner items notice

Permission: `partner.read`. Admin only: `false`.

Models: [PartnerLockedNoticeResponseDto](models-19.md#partnerlockednoticeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Get('locked-notice')
@Authenticated({ permission: Permission.PartnerRead })
@Endpoint({
    summary: 'Get the Locked partner items notice',
    description:
      'Whether to show the one-time notice that Locked items arrived from a partner and stay hidden until you set a PIN.',
    history: new HistoryBuilder().added('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether to show the one-time notice that Locked items arrived from a partner and stay hidden until you set a PIN.",
  "operationId": "getPartnerLockedNotice",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PartnerLockedNoticeResponseDto"
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
  "summary": "Get the Locked partner items notice",
  "tags": [
    "Partners"
  ],
  "x-immich-history": [
    {
      "version": "v2",
      "state": "Added"
    }
  ],
  "x-immich-permission": "partner.read"
}
```

## dismissPartnerLockedNotice

`PUT /api/partners/locked-notice`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L34).

Dismiss the Locked partner items notice

Permission: `partner.update`. Admin only: `false`.

Models: [PartnerLockedNoticeResponseDto](models-19.md#partnerlockednoticeresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Put('locked-notice')
@Authenticated({ permission: Permission.PartnerUpdate })
@Endpoint({
    summary: 'Dismiss the Locked partner items notice',
    description: 'Dismisses the one-time notice about Locked partner items for good. The items stay locked.',
    history: new HistoryBuilder().added('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Dismisses the one-time notice about Locked partner items for good. The items stay locked.",
  "operationId": "dismissPartnerLockedNotice",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PartnerLockedNoticeResponseDto"
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
  "summary": "Dismiss the Locked partner items notice",
  "tags": [
    "Partners"
  ],
  "x-immich-history": [
    {
      "version": "v2",
      "state": "Added"
    }
  ],
  "x-immich-permission": "partner.update"
}
```

## removePartner

`DELETE /api/partners/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L94).

Remove a partner

Permission: `partner.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Delete(':id')
@Authenticated({ permission: Permission.PartnerDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove a partner',
    description: 'Stop sharing assets with a partner.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Stop sharing assets with a partner.",
  "operationId": "removePartner",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "204": {
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
  "summary": "Remove a partner",
  "tags": [
    "Partners"
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
  "x-immich-permission": "partner.delete",
  "x-immich-state": "Stable"
}
```

## createPartnerDeprecated

`POST /api/partners/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L67).

Create a partner

Permission: `partner.create`. Admin only: `false`.

Models: [PartnerResponseDto](models-19.md#partnerresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Post(':id')
@Endpoint({
    summary: 'Create a partner',
    description: 'Create a new partner to share assets with.',
    history: new HistoryBuilder().added('v1').deprecated('v1', { replacementId: 'createPartner' }),
  })
@Authenticated({ permission: Permission.PartnerCreate })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Create a new partner to share assets with.",
  "operationId": "createPartnerDeprecated",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/PartnerResponseDto"
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
  "summary": "Create a partner",
  "tags": [
    "Partners",
    "Deprecated"
  ],
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Deprecated",
      "replacementId": "createPartner"
    }
  ],
  "x-immich-permission": "partner.create",
  "x-immich-state": "Deprecated"
}
```

## updatePartner

`PUT /api/partners/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/partner.controller.ts#L78).

Update a partner

Permission: `partner.update`. Admin only: `false`.

Models: [PartnerResponseDto](models-19.md#partnerresponsedto), [PartnerUpdateDto](models-19.md#partnerupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Partners)
@Controller('partners')
@Put(':id')
@Authenticated({ permission: Permission.PartnerUpdate })
@Endpoint({
    summary: 'Update a partner',
    description:
      'A partnership has no settings left (FL-326): partners receive their own copies and locations are always shared. Kept for older clients; returns the partner who shares with the user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "A partnership has no settings left (FL-326): partners receive their own copies and locations are always shared. Kept for older clients; returns the partner who shares with the user.",
  "operationId": "updatePartner",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    }
  ],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/PartnerUpdateDto"
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
            "$ref": "#/components/schemas/PartnerResponseDto"
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
  "summary": "Update a partner",
  "tags": [
    "Partners"
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
  "x-immich-permission": "partner.update",
  "x-immich-state": "Stable"
}
```
