# Server API — ICloud Sync

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## claimICloudItems

`POST /api/icloud-sync/claims`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L140).

Claim iCloud items for this device to fetch and upload

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudClaimDto](models-13.md#icloudclaimdto), [ICloudClaimResponseDto](models-13.md#icloudclaimresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('claims')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Claim iCloud items for this device to fetch and upload',
    description:
      "Up to 500 items. A claim covers the whole item (still, Live Photo motion, RAW and the current edit) for 10 minutes, renewable to 4 hours. An item a healthy sync connection covers is the sync's to fetch; one an unhealthy connection covers is the device's after 72 hours, or at once with takeOver. An upload naming an item someone else claimed is refused with 409 icloud_claimed. Send each item's filename and capture date: without them the server cannot confirm a sync covers it. The claim stays until it is released or runs out, so all of an item's roles come from one path. The device key must be one of the caller's backup devices.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to 500 items. A claim covers the whole item (still, Live Photo motion, RAW and the current edit) for 10 minutes, renewable to 4 hours. An item a healthy sync connection covers is the sync's to fetch; one an unhealthy connection covers is the device's after 72 hours, or at once with takeOver. An upload naming an item someone else claimed is refused with 409 icloud_claimed. Send each item's filename and capture date: without them the server cannot confirm a sync covers it. The claim stays until it is released or runs out, so all of an item's roles come from one path. The device key must be one of the caller's backup devices.",
  "operationId": "claimICloudItems",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudClaimDto"
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
            "$ref": "#/components/schemas/ICloudClaimResponseDto"
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
  "summary": "Claim iCloud items for this device to fetch and upload",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## releaseICloudClaims

`POST /api/icloud-sync/claims/release`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L166).

Release iCloud claims this device holds

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudClaimReleaseDto](models-13.md#icloudclaimreleasedto), [ICloudClaimReleaseResponseDto](models-13.md#icloudclaimreleaseresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('claims/release')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Release iCloud claims this device holds',
    description: 'Gives the items back, for example when the device stops before uploading them.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Gives the items back, for example when the device stops before uploading them.",
  "operationId": "releaseICloudClaims",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudClaimReleaseDto"
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
            "$ref": "#/components/schemas/ICloudClaimReleaseResponseDto"
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
  "summary": "Release iCloud claims this device holds",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## renewICloudClaims

`POST /api/icloud-sync/claims/renew`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L153).

Renew iCloud claims this device holds

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudClaimRenewDto](models-13.md#icloudclaimrenewdto), [ICloudClaimRenewResponseDto](models-13.md#icloudclaimrenewresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('claims/renew')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Renew iCloud claims this device holds',
    description:
      'Extends live claims, never past 4 hours from when each was taken; a claim missing from the answer is lost.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Extends live claims, never past 4 hours from when each was taken; a claim missing from the answer is lost.",
  "operationId": "renewICloudClaims",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudClaimRenewDto"
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
            "$ref": "#/components/schemas/ICloudClaimRenewResponseDto"
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
  "summary": "Renew iCloud claims this device holds",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## listICloudConnections

`GET /api/icloud-sync/connections`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L37).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudConnectionsResponseDto](models-13.md#icloudconnectionsresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Get()
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "listICloudConnections",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ICloudConnectionsResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## createICloudConnection

`POST /api/icloud-sync/connections`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L44).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudConnectionCreateDto](models-13.md#icloudconnectioncreatedto), [ICloudConnectionResponseDto](models-13.md#icloudconnectionresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Post()
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "createICloudConnection",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudConnectionCreateDto"
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
            "$ref": "#/components/schemas/ICloudConnectionResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## disconnectICloudConnection

`DELETE /api/icloud-sync/connections/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L95).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Delete(':id')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "disconnectICloudConnection",
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
  "tags": [
    "ICloud Sync"
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

## updateICloudConnection

`PATCH /api/icloud-sync/connections/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L54).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudConnectionResponseDto](models-13.md#icloudconnectionresponsedto), [ICloudConnectionUpdateDto](models-13.md#icloudconnectionupdatedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Patch(':id')
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "updateICloudConnection",
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
          "$ref": "#/components/schemas/ICloudConnectionUpdateDto"
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
            "$ref": "#/components/schemas/ICloudConnectionResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## authenticateICloudConnection

`POST /api/icloud-sync/connections/{id}/auth`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L65).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudAuthDto](models-13.md#icloudauthdto), [ICloudConnectionResponseDto](models-13.md#icloudconnectionresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Post(':id/auth')
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "authenticateICloudConnection",
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
          "$ref": "#/components/schemas/ICloudAuthDto"
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
            "$ref": "#/components/schemas/ICloudConnectionResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## controlICloudConnection

`POST /api/icloud-sync/connections/{id}/control`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L77).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudConnectionResponseDto](models-13.md#icloudconnectionresponsedto), [ICloudControlDto](models-13.md#icloudcontroldto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Post(':id/control')
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "controlICloudConnection",
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
          "$ref": "#/components/schemas/ICloudControlDto"
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
            "$ref": "#/components/schemas/ICloudConnectionResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## updateICloudIdentityReuseAuthority

`PATCH /api/icloud-sync/connections/{id}/identity-reuse-authority`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L26).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudIdentityReuseAuthorityDto](models-14.md#icloudidentityreuseauthoritydto), [ICloudIdentityReuseAuthorityStatusDto](models-14.md#icloudidentityreuseauthoritystatusdto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Patch(':id/identity-reuse-authority')
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "updateICloudIdentityReuseAuthority",
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
          "$ref": "#/components/schemas/ICloudIdentityReuseAuthorityDto"
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
            "$ref": "#/components/schemas/ICloudIdentityReuseAuthorityStatusDto"
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
  "tags": [
    "ICloud Sync"
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

## getICloudInventory

`GET /api/icloud-sync/connections/{id}/inventory`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L88).

Permission: `See authentication declaration`. Admin only: `false`.

Models: [ICloudInventoryResponseDto](models-14.md#icloudinventoryresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Get(':id/inventory')
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "getICloudInventory",
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
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ICloudInventoryResponseDto"
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
  "tags": [
    "ICloud Sync"
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

## removeICloudConnection

`POST /api/icloud-sync/connections/{id}/remove`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-sync.controller.ts#L105).

Permission: `See authentication declaration`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync/connections')
@Post(':id/remove')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({ history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0') })
```

Complete operation contract:

```json
{
  "operationId": "removeICloudConnection",
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
  "tags": [
    "ICloud Sync"
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

## probeICloudCoverage

`POST /api/icloud-sync/coverage`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L101).

Does a sync connection cover this device library?

Permission: `asset.read`. Admin only: `false`.

Models: [ICloudCoverageDto](models-13.md#icloudcoveragedto), [ICloudCoverageResponseDto](models-13.md#icloudcoverageresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('coverage')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Does a sync connection cover this device library?',
    description:
      "Up to 200 sampled items from the device. For each of the caller's own connections: its state, scope and how many of the samples that existed before its last complete inventory it holds. A connection covers the library with at least 20 such samples and 95 % matched (corroborated or better). PhotoKit cannot tell which Apple Account is signed in, so overlap is the only proof.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to 200 sampled items from the device. For each of the caller's own connections: its state, scope and how many of the samples that existed before its last complete inventory it holds. A connection covers the library with at least 20 such samples and 95 % matched (corroborated or better). PhotoKit cannot tell which Apple Account is signed in, so overlap is the only proof.",
  "operationId": "probeICloudCoverage",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudCoverageDto"
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
            "$ref": "#/components/schemas/ICloudCoverageResponseDto"
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
  "summary": "Does a sync connection cover this device library?",
  "tags": [
    "ICloud Sync"
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

## acceptICloudEditBaseline

`POST /api/icloud-sync/edits/baseline`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L56).

Accept an administrative edit-owner baseline

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudEditBaselineDto](models-13.md#icloudeditbaselinedto), [ICloudEditDecisionResponseDto](models-13.md#icloudeditdecisionresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('edits/baseline')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Accept an administrative edit-owner baseline',
    description:
      'Owner session only. Explicitly accepts a stored owned digest receipt as a handover watermark. This is an administrative decision, not Apple revision ordering or byte-equivalence proof. Healthy sync authority and live competing item claims remain protected; takeOver only bypasses the wait for an unhealthy source. Locked and hidden evidence requires current access. Optional original-revert intent explicitly changes local primary against the current immutable publication with the selected retention policy; without intent this remains administrative and cannot reinterpret an existing publication.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner session only. Explicitly accepts a stored owned digest receipt as a handover watermark. This is an administrative decision, not Apple revision ordering or byte-equivalence proof. Healthy sync authority and live competing item claims remain protected; takeOver only bypasses the wait for an unhealthy source. Locked and hidden evidence requires current access. Optional original-revert intent explicitly changes local primary against the current immutable publication with the selected retention policy; without intent this remains administrative and cannot reinterpret an existing publication.",
  "operationId": "acceptICloudEditBaseline",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudEditBaselineDto"
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
            "$ref": "#/components/schemas/ICloudEditDecisionResponseDto"
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
  "summary": "Accept an administrative edit-owner baseline",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## discoverICloudEditEvidence

`GET /api/icloud-sync/edits/evidence`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L40).

Discover owned edit evidence and administrative authority

Permission: `asset.read`. Admin only: `false`.

Models: [ICloudEditEvidenceResponseDto](models-14.md#icloudeditevidenceresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Get('edits/evidence')
@Header('Cache-Control', 'private, no-store')
@Authenticated({ permission: Permission.AssetRead, refreshElevation: false })
@Endpoint({
    summary: 'Discover owned edit evidence and administrative authority',
    description:
      'Complete bounded owner-session snapshot. Receipts are current owned bytes; administrative authority is not provider chronology. Incoming eligibility is a snapshot, never admission permission. Oversized or inaccessible evidence requires review.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Complete bounded owner-session snapshot. Receipts are current owned bytes; administrative authority is not provider chronology. Incoming eligibility is a snapshot, never admission permission. Oversized or inaccessible evidence requires review.",
  "operationId": "discoverICloudEditEvidence",
  "parameters": [
    {
      "name": "assetId",
      "required": true,
      "in": "query",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$",
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ICloudEditEvidenceResponseDto"
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
  "summary": "Discover owned edit evidence and administrative authority",
  "tags": [
    "ICloud Sync"
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

## acceptICloudEditSuccessor

`POST /api/icloud-sync/edits/successor`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L72).

Accept verified bytes as an administrative edit successor

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudEditDecisionResponseDto](models-13.md#icloudeditdecisionresponsedto), [ICloudEditSuccessorDto](models-14.md#icloudeditsuccessordto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('edits/successor')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Accept verified bytes as an administrative edit successor',
    description:
      'Owner session only. Accepts one existing verified device or sync resource at the current owner generation and canonical version. No timestamp/hash ordering is inferred. First publication rechecks the decision, digest, live holder claim, item capacity and access; an already committed result remains eligible for settlement after takeover. Keep is the default. Supersede explicitly binds the current local publication, verified eligible render set, effective config and owner-local policy sequence; first publication refuses changed policy, privacy or authority. Accepted decisions, committed bytes, queued effects and delivered effects are distinct.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner session only. Accepts one existing verified device or sync resource at the current owner generation and canonical version. No timestamp/hash ordering is inferred. First publication rechecks the decision, digest, live holder claim, item capacity and access; an already committed result remains eligible for settlement after takeover. Keep is the default. Supersede explicitly binds the current local publication, verified eligible render set, effective config and owner-local policy sequence; first publication refuses changed policy, privacy or authority. Accepted decisions, committed bytes, queued effects and delivered effects are distinct.",
  "operationId": "acceptICloudEditSuccessor",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudEditSuccessorDto"
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
            "$ref": "#/components/schemas/ICloudEditDecisionResponseDto"
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
  "summary": "Accept verified bytes as an administrative edit successor",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## attachICloudIdentities

`POST /api/icloud-sync/identities/attach`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L127).

Attach iCloud identities to originals already uploaded by this device

Permission: `asset.upload`. Admin only: `false`.

Models: [ICloudAttachDto](models-13.md#icloudattachdto), [ICloudAttachResponseDto](models-13.md#icloudattachresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('identities/attach')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetUpload })
@Endpoint({
    summary: 'Attach iCloud identities to originals already uploaded by this device',
    description:
      "Up to 500 resources from one of the caller's registered backup devices. Each attachment requires the device SHA-256 to equal the current original of an active asset the caller owns, with the safety lookup's Locked and hidden rules. Unknown, inaccessible and mismatched assets all answer unavailable. Identifiers remain hints until corroborated; attachment never marks an audit verified or changes media.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to 500 resources from one of the caller's registered backup devices. Each attachment requires the device SHA-256 to equal the current original of an active asset the caller owns, with the safety lookup's Locked and hidden rules. Unknown, inaccessible and mismatched assets all answer unavailable. Identifiers remain hints until corroborated; attachment never marks an audit verified or changes media.",
  "operationId": "attachICloudIdentities",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudAttachDto"
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
            "$ref": "#/components/schemas/ICloudAttachResponseDto"
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
  "summary": "Attach iCloud identities to originals already uploaded by this device",
  "tags": [
    "ICloud Sync"
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
  "x-immich-permission": "asset.upload",
  "x-immich-state": "Alpha"
}
```

## lookupICloudIdentities

`POST /api/icloud-sync/identities/lookup`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L114).

Is this iCloud item on the server, or coming from the sync?

Permission: `asset.read`. Admin only: `false`.

Models: [ICloudLookupDto](models-14.md#icloudlookupdto), [ICloudLookupResponseDto](models-14.md#icloudlookupresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('identities/lookup')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Is this iCloud item on the server, or coming from the sync?',
    description:
      "Up to 1000 items. For each item and role: on-server (with who delivered it and how it was verified), sync-pending, out-of-scope, unknown or review; and who delivers its edit renders. Only the caller's own assets and connections, with the safety lookup's Locked and hidden rules. A hint is reported but never counts as on-server.",
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Up to 1000 items. For each item and role: on-server (with who delivered it and how it was verified), sync-pending, out-of-scope, unknown or review; and who delivers its edit renders. Only the caller's own assets and connections, with the safety lookup's Locked and hidden rules. A hint is reported but never counts as on-server.",
  "operationId": "lookupICloudIdentities",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudLookupDto"
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
            "$ref": "#/components/schemas/ICloudLookupResponseDto"
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
  "summary": "Is this iCloud item on the server, or coming from the sync?",
  "tags": [
    "ICloud Sync"
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

## verifyICloudIdentities

`POST /api/icloud-sync/identities/verify`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/icloud-identity.controller.ts#L88).

Download and verify named iCloud originals

Permission: `asset.read`. Admin only: `false`.

Models: [ICloudVerifyDto](models-14.md#icloudverifydto), [ICloudVerifyResponseDto](models-14.md#icloudverifyresponsedto).

Controller access declarations:

```typescript
@ApiTags('ICloud Sync')
@Controller('icloud-sync')
@Post('identities/verify')
@HttpCode(HttpStatus.ACCEPTED)
@Authenticated({ permission: Permission.AssetRead })
@Endpoint({
    summary: 'Download and verify named iCloud originals',
    description:
      'Owner sessions only. Queues fresh source-byte SHA-256 verification of current in-scope identities. Queued is not verified; results appear in identity lookup. Mismatches preserve the original and import a separate managed copy for review. Request keys replay the original complete batch outcomes.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Owner sessions only. Queues fresh source-byte SHA-256 verification of current in-scope identities. Queued is not verified; results appear in identity lookup. Mismatches preserve the original and import a separate managed copy for review. Request keys replay the original complete batch outcomes.",
  "operationId": "verifyICloudIdentities",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/ICloudVerifyDto"
        }
      }
    },
    "required": true
  },
  "responses": {
    "202": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ICloudVerifyResponseDto"
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
  "summary": "Download and verify named iCloud originals",
  "tags": [
    "ICloud Sync"
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
