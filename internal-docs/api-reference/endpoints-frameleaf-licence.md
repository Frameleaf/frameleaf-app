# Server API — Frameleaf licence

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## removeLicenseKey

`DELETE /api/admin/license`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L68).

Remove the licence key

Permission: `serverLicense.delete`. Admin only: `true`.

Models: [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Delete()
@Authenticated({ permission: Permission.ServerLicenseDelete, admin: true })
@Endpoint({
    operationId: 'removeLicenseKey',
    summary: 'Remove the licence key',
    description:
      'Removes the supporter key from this server, deactivating it with Frameleaf Cloud when reachable. A Frameleaf Cloud plan is not affected.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the supporter key from this server, deactivating it with Frameleaf Cloud when reachable. A Frameleaf Cloud plan is not affected.",
  "operationId": "removeLicenseKey",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Remove the licence key",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.delete",
  "x-immich-state": "Alpha"
}
```

## getLicenseStatus

`GET /api/admin/license`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L27).

Get the licence status

Permission: `serverLicense.read`. Admin only: `true`.

Models: [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Get()
@Authenticated({ permission: Permission.ServerLicenseRead, admin: true })
@Endpoint({
    operationId: 'getLicenseStatus',
    summary: 'Get the licence status',
    description:
      'Whether this server holds a supporter key and a Frameleaf Cloud plan, their state (none, active, grace, expired, invalid), the entitlements cloud features read, and the refresh schedule.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Whether this server holds a supporter key and a Frameleaf Cloud plan, their state (none, active, grace, expired, invalid), the entitlements cloud features read, and the refresh schedule.",
  "operationId": "getLicenseStatus",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Get the licence status",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.read",
  "x-immich-state": "Alpha"
}
```

## activateLicense

`PUT /api/admin/license/activate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L40).

Activate a server licence key

Permission: `serverLicense.update`. Admin only: `true`.

Models: [LicenseActivateDto](models-15.md#licenseactivatedto), [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Put('activate')
@Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
@RateLimited(RATE_LIMITS.licenseActivation)
@Endpoint({
    operationId: 'activateLicense',
    summary: 'Activate a server licence key',
    description:
      'Checks the key format (FL-SXXX-XXXX-XXXX with its check symbol) and activates it with Frameleaf Cloud for this server. The key travels only in this request body and is never stored.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Checks the key format (FL-SXXX-XXXX-XXXX with its check symbol) and activates it with Frameleaf Cloud for this server. The key travels only in this request body and is never stored.",
  "operationId": "activateLicense",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LicenseActivateDto"
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
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Activate a server licence key",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.update",
  "x-immich-state": "Alpha"
}
```

## installLicenseCertificate

`PUT /api/admin/license/certificate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L54).

Install a licence file

Permission: `serverLicense.update`. Admin only: `true`.

Models: [LicenseCertificateDto](models-15.md#licensecertificatedto), [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Put('certificate')
@Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
@RateLimited(RATE_LIMITS.licenseActivation)
@Endpoint({
    operationId: 'installLicenseCertificate',
    summary: 'Install a licence file',
    description:
      'Installs a licence file downloaded for this server’s instance ID, for servers without internet access. It is verified with the pinned Frameleaf keys before it is kept.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Installs a licence file downloaded for this server’s instance ID, for servers without internet access. It is verified with the pinned Frameleaf keys before it is kept.",
  "operationId": "installLicenseCertificate",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LicenseCertificateDto"
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
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Install a licence file",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.update",
  "x-immich-state": "Alpha"
}
```

## removeLicensePlan

`DELETE /api/admin/license/plan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L81).

Remove the plan from this server

Permission: `serverLicense.delete`. Admin only: `true`.

Models: [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Delete('plan')
@Authenticated({ permission: Permission.ServerLicenseDelete, admin: true })
@Endpoint({
    operationId: 'removeLicensePlan',
    summary: 'Remove the plan from this server',
    description:
      'Removes the Frameleaf Cloud plan certificate from this server. The subscription itself is managed in the Frameleaf account and is not cancelled; the licence key is not affected.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Removes the Frameleaf Cloud plan certificate from this server. The subscription itself is managed in the Frameleaf account and is not cancelled; the licence key is not affected.",
  "operationId": "removeLicensePlan",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Remove the plan from this server",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.delete",
  "x-immich-state": "Alpha"
}
```

## refreshLicense

`POST /api/admin/license/refresh`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L94).

Refresh the licence now

Permission: `serverLicense.update`. Admin only: `true`.

Models: [LicenseStatusResponseDto](models-15.md#licensestatusresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('admin/license')
@Post('refresh')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.ServerLicenseUpdate, admin: true })
@Endpoint({
    operationId: 'refreshLicense',
    summary: 'Refresh the licence now',
    description: 'Asks Frameleaf Cloud for current certificates now instead of waiting for the daily refresh.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Asks Frameleaf Cloud for current certificates now instead of waiting for the daily refresh.",
  "operationId": "refreshLicense",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseStatusResponseDto"
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
  "summary": "Refresh the licence now",
  "tags": [
    "Frameleaf licence"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "serverLicense.update",
  "x-immich-state": "Alpha"
}
```

## redeemLicenseLinkCode

`POST /api/license/link-code`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L127).

Redeem a Frameleaf account link code

Permission: `userLicense.update`. Admin only: `false`.

Models: [LicenseLinkCodeDto](models-15.md#licenselinkcodedto), [LicenseLinkCodeResponseDto](models-15.md#licenselinkcoderesponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('license')
@Post('link-code')
@HttpCode(HttpStatus.OK)
@Authenticated({ permission: Permission.UserLicenseUpdate })
@RateLimited(RATE_LIMITS.licenseActivation)
@Endpoint({
    operationId: 'redeemLicenseLinkCode',
    summary: 'Redeem a Frameleaf account link code',
    description:
      'CLD-004: redeems a one-time link code from the Frameleaf account site. Frameleaf Cloud activates the licence for this server directly, so the key never reaches this server or a URL. An administrator can receive a server key; anyone else only a personal key. Needs a linked server; the code travels only in this request body.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "CLD-004: redeems a one-time link code from the Frameleaf account site. Frameleaf Cloud activates the licence for this server directly, so the key never reaches this server or a URL. An administrator can receive a server key; anyone else only a personal key. Needs a linked server; the code travels only in this request body.",
  "operationId": "redeemLicenseLinkCode",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/LicenseLinkCodeDto"
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
            "$ref": "#/components/schemas/LicenseLinkCodeResponseDto"
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
  "summary": "Redeem a Frameleaf account link code",
  "tags": [
    "Frameleaf licence"
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
  "x-immich-permission": "userLicense.update",
  "x-immich-state": "Alpha"
}
```

## getLicenseProducts

`GET /api/license/products`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/license-admin.controller.ts#L114).

Get Support Frameleaf prices

Permission: `See authentication declaration`. Admin only: `false`.

Models: [LicenseProductsResponseDto](models-15.md#licenseproductsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.FrameleafLicense)
@Controller('license')
@Get('products')
@Authenticated()
@Endpoint({
    operationId: 'getLicenseProducts',
    summary: 'Get Support Frameleaf prices',
    description:
      'Bundled plan and supporter prices in US dollars, the licensed-server discount, cloud backup pricing and the store this server was deployed with. Makes no outbound call.',
    history: new HistoryBuilder().added('v3.2.0').alpha('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Bundled plan and supporter prices in US dollars, the licensed-server discount, cloud backup pricing and the store this server was deployed with. Makes no outbound call.",
  "operationId": "getLicenseProducts",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/LicenseProductsResponseDto"
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
  "summary": "Get Support Frameleaf prices",
  "tags": [
    "Frameleaf licence"
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
