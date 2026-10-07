# Server API — System config

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getConfig

`GET /api/system-config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L28).

Get system configuration

Permission: `systemConfig.read`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get()
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get system configuration',
    description: 'Retrieve the current system configuration.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getAdminConfig' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Retrieve the current system configuration.",
  "operationId": "getConfig",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Get system configuration",
  "tags": [
    "System config",
    "Deprecated"
  ],
  "x-immich-admin-only": true,
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
    },
    {
      "version": "v3.2.0",
      "state": "Deprecated",
      "replacementId": "getAdminConfig"
    }
  ],
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Deprecated"
}
```

## updateConfig

`PUT /api/system-config`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L72).

Update system configuration

Permission: `systemConfig.update`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Put()
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    summary: 'Update system configuration',
    description: 'Update the system configuration with a new system configuration.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'updateAdminConfig' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update the system configuration with a new system configuration.",
  "operationId": "updateConfig",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/AdminConfigDto"
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
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Update system configuration",
  "tags": [
    "System config",
    "Deprecated"
  ],
  "x-immich-admin-only": true,
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
    },
    {
      "version": "v3.2.0",
      "state": "Deprecated",
      "replacementId": "updateAdminConfig"
    }
  ],
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Deprecated"
}
```

## getConfigDefaults

`GET /api/system-config/defaults`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L43).

Get system configuration defaults

Permission: `systemConfig.read`. Admin only: `false`.

Models: [AdminConfigDto](models-01.md#adminconfigdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get('defaults')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get system configuration defaults',
    description: 'Retrieve the default values for the system configuration.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3.2.0', { replacementId: 'getAdminConfigDefaults' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Retrieve the default values for the system configuration.",
  "operationId": "getConfigDefaults",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/AdminConfigDto"
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
  "summary": "Get system configuration defaults",
  "tags": [
    "System config",
    "Deprecated"
  ],
  "x-immich-admin-only": true,
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
    },
    {
      "version": "v3.2.0",
      "state": "Deprecated",
      "replacementId": "getAdminConfigDefaults"
    }
  ],
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Deprecated"
}
```

## deferImageDescriptionRequeue

`POST /api/system-config/image-description/defer-requeue`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L123).

Defer image description re-queue

Permission: `systemConfig.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Post('image-description/defer-requeue')
@HttpCode(HttpStatus.NO_CONTENT)
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    summary: 'Defer image description re-queue',
    description:
      'Marks the image description config as having a pending re-queue. The persistent banner on the admin Image Description settings page will surface a reminder until the actual re-queue is triggered.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
@ApiResponse({ status: 400, description: 'Image description is not enabled.' })
```

Complete operation contract:

```json
{
  "description": "Marks the image description config as having a pending re-queue. The persistent banner on the admin Image Description settings page will surface a reminder until the actual re-queue is triggered.",
  "operationId": "deferImageDescriptionRequeue",
  "parameters": [],
  "responses": {
    "204": {
      "description": ""
    },
    "400": {
      "description": "Image description is not enabled."
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
  "summary": "Defer image description re-queue",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Beta"
}
```

## triggerImageDescriptionRequeue

`POST /api/system-config/image-description/requeue`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L110).

Trigger image description re-queue

Permission: `systemConfig.update`. Admin only: `false`.

Models: [ImageDescriptionRequeueResponseDto](models-13.md#imagedescriptionrequeueresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Post('image-description/requeue')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    summary: 'Trigger image description re-queue',
    description:
      'Enqueues a bulk re-queue of the image description pipeline for all eligible assets. Idempotent: if image-description work is already active or waiting, the call returns without re-enqueuing.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
@ApiResponse({ status: 400, description: 'Image description is not enabled.' })
```

Complete operation contract:

```json
{
  "description": "Enqueues a bulk re-queue of the image description pipeline for all eligible assets. Idempotent: if image-description work is already active or waiting, the call returns without re-enqueuing.",
  "operationId": "triggerImageDescriptionRequeue",
  "parameters": [],
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ImageDescriptionRequeueResponseDto"
          }
        }
      },
      "description": ""
    },
    "400": {
      "description": "Image description is not enabled."
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
  "summary": "Trigger image description re-queue",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Beta"
}
```

## getImageDescriptionRequeueEstimate

`GET /api/system-config/image-description/requeue-estimate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L98).

Estimate image description re-queue cost

Permission: `systemConfig.read`. Admin only: `false`.

Models: [ImageDescriptionRequeueEstimateDto](models-13.md#imagedescriptionrequeueestimatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get('image-description/requeue-estimate')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Estimate image description re-queue cost',
    description:
      'Returns asset counts and a rough time estimate for re-running the image description pipeline over all eligible assets.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns asset counts and a rough time estimate for re-running the image description pipeline over all eligible assets.",
  "operationId": "getImageDescriptionRequeueEstimate",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/ImageDescriptionRequeueEstimateDto"
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
  "summary": "Estimate image description re-queue cost",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Beta"
}
```

## getMachineLearningHardware

`GET /api/system-config/machine-learning/hardware`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L58).

Get machine learning hardware

Permission: `systemConfig.read`. Admin only: `false`.

Models: [MachineLearningHardwareResponseDto](models-14.md#machinelearninghardwareresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get('machine-learning/hardware')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get machine learning hardware',
    description:
      'Retrieve available hardware acceleration providers from one machine learning destination. Without `destinationId` the first enabled local destination is probed; a cloud destination is never chosen implicitly.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve available hardware acceleration providers from one machine learning destination. Without `destinationId` the first enabled local destination is probed; a cloud destination is never chosen implicitly.",
  "operationId": "getMachineLearningHardware",
  "parameters": [
    {
      "name": "destinationId",
      "required": false,
      "in": "query",
      "description": "Destination to probe. When omitted, the first enabled local destination is probed; a cloud destination is never chosen implicitly.",
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
            "$ref": "#/components/schemas/MachineLearningHardwareResponseDto"
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
  "summary": "Get machine learning hardware",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Stable"
}
```

## triggerSmartAlbumReevaluate

`POST /api/system-config/smart-albums/reevaluate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L149).

Trigger smart-album re-evaluate

Permission: `systemConfig.update`. Admin only: `false`.

Models: [SmartAlbumReevaluateRequestDto](models-30.md#smartalbumreevaluaterequestdto), [SmartAlbumReevaluateResponseDto](models-30.md#smartalbumreevaluateresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Post('smart-albums/reevaluate')
@Authenticated({ permission: Permission.SystemConfigUpdate, admin: true })
@Endpoint({
    summary: 'Trigger smart-album re-evaluate',
    description:
      'Enqueues a bulk re-evaluation of all described image assets against the smart-album tag rules. Pass an optional `kind` body field to scope the re-evaluation to a single built-in kind. Idempotent via durable job deduplication (kind-scoped dispatches use their own dedup namespace).',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
@ApiResponse({ status: 400, description: 'Smart albums are not enabled, or invalid kind.' })
@ApiBody({ required: false, type: SmartAlbumReevaluateRequestDto })
```

Complete operation contract:

```json
{
  "description": "Enqueues a bulk re-evaluation of all described image assets against the smart-album tag rules. Pass an optional `kind` body field to scope the re-evaluation to a single built-in kind. Idempotent via durable job deduplication (kind-scoped dispatches use their own dedup namespace).",
  "operationId": "triggerSmartAlbumReevaluate",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/SmartAlbumReevaluateRequestDto"
        }
      }
    },
    "required": false
  },
  "responses": {
    "201": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SmartAlbumReevaluateResponseDto"
          }
        }
      },
      "description": ""
    },
    "400": {
      "description": "Smart albums are not enabled, or invalid kind."
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
  "summary": "Trigger smart-album re-evaluate",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "systemConfig.update",
  "x-immich-state": "Beta"
}
```

## getSmartAlbumReevaluateEstimate

`GET /api/system-config/smart-albums/reevaluate-estimate`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L137).

Estimate smart-album re-evaluate cost

Permission: `systemConfig.read`. Admin only: `false`.

Models: [SmartAlbumReevaluateEstimateDto](models-30.md#smartalbumreevaluateestimatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get('smart-albums/reevaluate-estimate')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Estimate smart-album re-evaluate cost',
    description:
      'Returns the number of image assets that have a completed description and will be re-evaluated by the re-evaluate job.',
    history: new HistoryBuilder().added('v1').beta('v1'),
  })
```

Complete operation contract:

```json
{
  "description": "Returns the number of image assets that have a completed description and will be re-evaluated by the re-evaluate job.",
  "operationId": "getSmartAlbumReevaluateEstimate",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SmartAlbumReevaluateEstimateDto"
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
  "summary": "Estimate smart-album re-evaluate cost",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
  "x-immich-history": [
    {
      "version": "v1",
      "state": "Added"
    },
    {
      "version": "v1",
      "state": "Beta"
    }
  ],
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Beta"
}
```

## getStorageTemplateOptions

`GET /api/system-config/storage-template-options`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/d78bb71b1bd4a5aed4735dddea02c8aa271cdcd9/server/src/controllers/system-config.controller.ts#L87).

Get storage template options

Permission: `systemConfig.read`. Admin only: `false`.

Models: [SystemConfigTemplateStorageOptionDto](models-35.md#systemconfigtemplatestorageoptiondto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SystemConfig)
@Controller('system-config')
@Get('storage-template-options')
@Authenticated({ permission: Permission.SystemConfigRead, admin: true })
@Endpoint({
    summary: 'Get storage template options',
    description: 'Retrieve exemplary storage template options.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve exemplary storage template options.",
  "operationId": "getStorageTemplateOptions",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SystemConfigTemplateStorageOptionDto"
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
  "summary": "Get storage template options",
  "tags": [
    "System config"
  ],
  "x-immich-admin-only": true,
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
  "x-immich-permission": "systemConfig.read",
  "x-immich-state": "Stable"
}
```
