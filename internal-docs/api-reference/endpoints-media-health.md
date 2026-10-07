# Server API — Media Health

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## list

`GET /api/media-health`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L28).

List media health findings

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthCategory](models-15.md#mediahealthcategory), [MediaHealthListResponseDto](models-15.md#mediahealthlistresponsedto), [MediaHealthStatus](models-15.md#mediahealthstatus).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Get()
@Authenticated()
@Endpoint({
    summary: 'List media health findings',
    description: 'List missing and corrupt media health findings in timeline buckets.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "List missing and corrupt media health findings in timeline buckets.",
  "operationId": "list",
  "parameters": [
    {
      "name": "allAccounts",
      "required": false,
      "in": "query",
      "description": "Review every account; administrators only",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "category",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MediaHealthCategory"
      }
    },
    {
      "name": "needsAttention",
      "required": false,
      "in": "query",
      "description": "Only findings that still need a decision",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "ownerId",
      "required": false,
      "in": "query",
      "description": "Account to review; administrators only for another account",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "default": 1,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "default": 100,
        "type": "integer"
      }
    },
    {
      "name": "status",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MediaHealthStatus"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaHealthListResponseDto"
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
  "summary": "List media health findings",
  "tags": [
    "Media Health"
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

## chooseCandidates

`POST /api/media-health/candidates/choose`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L62).

Choose media health candidates

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkResponseDto](models-15.md#mediahealthbulkresponsedto), [MediaHealthChooseCandidatesDto](models-15.md#mediahealthchoosecandidatesdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('candidates/choose')
@Authenticated()
@Endpoint({
    summary: 'Choose media health candidates',
    description: 'Record which verified exact copy each missing original should be relinked to.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Record which verified exact copy each missing original should be relinked to.",
  "operationId": "chooseCandidates",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthChooseCandidatesDto"
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
            "$ref": "#/components/schemas/MediaHealthBulkResponseDto"
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
  "summary": "Choose media health candidates",
  "tags": [
    "Media Health"
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

## deleteCorrupt

`DELETE /api/media-health/corrupt`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L157).

Move confirmed corrupt media to trash

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkResponseDto](models-15.md#mediahealthbulkresponsedto), [MediaHealthDeleteCorruptDto](models-15.md#mediahealthdeletecorruptdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Delete('corrupt')
@Authenticated()
@Endpoint({
    summary: 'Move confirmed corrupt media to trash',
    description: 'Move recently confirmed corrupt media findings to trash after revalidation.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Move recently confirmed corrupt media findings to trash after revalidation.",
  "operationId": "deleteCorrupt",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthDeleteCorruptDto"
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
            "$ref": "#/components/schemas/MediaHealthBulkResponseDto"
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
  "summary": "Move confirmed corrupt media to trash",
  "tags": [
    "Media Health"
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

## recoverDamaged

`POST /api/media-health/corrupt/recover`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L121).

Recover damaged media from a verified copy

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkResponseDto](models-15.md#mediahealthbulkresponsedto), [MediaHealthRecoverDto](models-15.md#mediahealthrecoverdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('corrupt/recover')
@Authenticated()
@Endpoint({
    summary: 'Recover damaged media from a verified copy',
    description:
      'Queue a durable job replacing confirmed damage with an exact, decoded copy while keeping the damaged file.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue a durable job replacing confirmed damage with an exact, decoded copy while keeping the damaged file.",
  "operationId": "recoverDamaged",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthRecoverDto"
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
            "$ref": "#/components/schemas/MediaHealthBulkResponseDto"
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
  "summary": "Recover damaged media from a verified copy",
  "tags": [
    "Media Health"
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

## startCorruptScan

`POST /api/media-health/corrupt/scan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L110).

Start corrupt media scan

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthScanResponseDto](models-15.md#mediahealthscanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('corrupt/scan')
@Authenticated()
@Endpoint({
    summary: 'Start corrupt media scan',
    description: 'Queue an explicit scan that validates source media integrity.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue an explicit scan that validates source media integrity.",
  "operationId": "startCorruptScan",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaHealthScanResponseDto"
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
  "summary": "Start corrupt media scan",
  "tags": [
    "Media Health"
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

## dismiss

`POST /api/media-health/dismiss`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L133).

Dismiss media health findings

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkActionDto](models-15.md#mediahealthbulkactiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('dismiss')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated()
@Endpoint({
    summary: 'Dismiss media health findings',
    description: 'Dismiss selected media health findings without modifying assets.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Dismiss selected media health findings without modifying assets.",
  "operationId": "dismiss",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthBulkActionDto"
        }
      }
    },
    "required": true
  },
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
  "summary": "Dismiss media health findings",
  "tags": [
    "Media Health"
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

## locateMissing

`POST /api/media-health/missing/locate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L87).

Locate missing media

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthLocateDto](models-15.md#mediahealthlocatedto), [MediaHealthScanResponseDto](models-15.md#mediahealthscanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('missing/locate')
@Authenticated()
@Endpoint({
    summary: 'Locate missing media',
    description:
      'Queue a durable exact-checksum search of the chosen locations for missing originals or copies of confirmed damage.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue a durable exact-checksum search of the chosen locations for missing originals or copies of confirmed damage.",
  "operationId": "locateMissing",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthLocateDto"
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
            "$ref": "#/components/schemas/MediaHealthScanResponseDto"
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
  "summary": "Locate missing media",
  "tags": [
    "Media Health"
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

## relinkMissing

`POST /api/media-health/missing/relink`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L99).

Relink missing media

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkActionDto](models-15.md#mediahealthbulkactiondto), [MediaHealthBulkResponseDto](models-15.md#mediahealthbulkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('missing/relink')
@Authenticated()
@Endpoint({
    summary: 'Relink missing media',
    description: 'Queue a durable job relinking missing originals to their verified exact copies.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue a durable job relinking missing originals to their verified exact copies.",
  "operationId": "relinkMissing",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthBulkActionDto"
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
            "$ref": "#/components/schemas/MediaHealthBulkResponseDto"
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
  "summary": "Relink missing media",
  "tags": [
    "Media Health"
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

## startMissingScan

`POST /api/media-health/missing/scan`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L76).

Start missing media scan

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthScanResponseDto](models-15.md#mediahealthscanresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('missing/scan')
@Authenticated()
@Endpoint({
    summary: 'Start missing media scan',
    description: 'Queue an owner-scoped scan that identifies missing files and restores supported untracked media.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue an owner-scoped scan that identifies missing files and restores supported untracked media.",
  "operationId": "startMissingScan",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaHealthScanResponseDto"
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
  "summary": "Start missing media scan",
  "tags": [
    "Media Health"
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

## reopen

`POST /api/media-health/reopen`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L145).

Reopen media health findings

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthBulkActionDto](models-15.md#mediahealthbulkactiondto), [MediaHealthBulkResponseDto](models-15.md#mediahealthbulkresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Post('reopen')
@Authenticated()
@Endpoint({
    summary: 'Reopen media health findings',
    description:
      'Undo a dismissal, or reopen confirmed damage whose item was restored from the trash, putting the findings back in review.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Undo a dismissal, or reopen confirmed damage whose item was restored from the trash, putting the findings back in review.",
  "operationId": "reopen",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MediaHealthBulkActionDto"
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
            "$ref": "#/components/schemas/MediaHealthBulkResponseDto"
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
  "summary": "Reopen media health findings",
  "tags": [
    "Media Health"
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

## getRoots

`GET /api/media-health/roots`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L51).

List Library Care search locations

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthRootsResponseDto](models-15.md#mediahealthrootsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Get('roots')
@Authenticated()
@Endpoint({
    summary: 'List Library Care search locations',
    description: 'Locations the caller may search for exact copies of missing or damaged originals.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Locations the caller may search for exact copies of missing or damaged originals.",
  "operationId": "getRoots",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MediaHealthRootsResponseDto"
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
  "summary": "List Library Care search locations",
  "tags": [
    "Media Health"
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

## getSummary

`GET /api/media-health/summary`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/media-health.controller.ts#L39).

Get Library Care summary

Permission: `See authentication declaration`. Admin only: `false`.

Models: [MediaHealthSummaryResponseDto](models-15.md#mediahealthsummaryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.MediaHealth)
@Controller('media-health')
@Get('summary')
@Authenticated()
@Endpoint({
    summary: 'Get Library Care summary',
    description:
      'Queue sizes for missing, damaged, duplicate, import and enrichment work, the latest scan or search, and recent Library Care jobs.',
    history: new HistoryBuilder().added('v3.0.0').alpha('v3.0.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Queue sizes for missing, damaged, duplicate, import and enrichment work, the latest scan or search, and recent Library Care jobs.",
  "operationId": "getSummary",
  "parameters": [
    {
      "name": "allAccounts",
      "required": false,
      "in": "query",
      "description": "Review every account; administrators only",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "ownerId",
      "required": false,
      "in": "query",
      "description": "Account to review; administrators only for another account",
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
            "$ref": "#/components/schemas/MediaHealthSummaryResponseDto"
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
  "summary": "Get Library Care summary",
  "tags": [
    "Media Health"
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
