# Server API — Plugins

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchPlugins

`GET /api/plugins`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/plugin.controller.ts#L21).

List all plugins

Permission: `plugin.read`. Admin only: `false`.

Models: [PluginResponseDto](models-26.md#pluginresponsedto).

Controller access declarations:

```typescript
@ApiTags('Plugins')
@Controller('plugins')
@Get()
@Authenticated({ permission: Permission.PluginRead })
@Endpoint({
    summary: 'List all plugins',
    description: 'Retrieve a list of plugins available to the authenticated user.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of plugins available to the authenticated user.",
  "operationId": "searchPlugins",
  "parameters": [
    {
      "name": "description",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "enabled",
      "required": false,
      "in": "query",
      "description": "Whether the plugin is enabled",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Plugin ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "name",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "title",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "version",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PluginResponseDto"
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
  "summary": "List all plugins",
  "tags": [
    "Plugins"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "plugin.read"
}
```

## searchPluginMethods

`GET /api/plugins/methods`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/plugin.controller.ts#L32).

Retrieve plugin methods

Permission: `plugin.read`. Admin only: `false`.

Models: [PluginMethodResponseDto](models-26.md#pluginmethodresponsedto), [WorkflowTrigger](models-39.md#workflowtrigger), [WorkflowType](models-39.md#workflowtype).

Controller access declarations:

```typescript
@ApiTags('Plugins')
@Controller('plugins')
@Get('methods')
@Authenticated({ permission: Permission.PluginRead })
@Endpoint({
    summary: 'Retrieve plugin methods',
    description: 'Retrieve a list of plugin methods',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of plugin methods",
  "operationId": "searchPluginMethods",
  "parameters": [
    {
      "name": "description",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "enabled",
      "required": false,
      "in": "query",
      "description": "Whether the plugin method is enabled",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Plugin method ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "name",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "pluginName",
      "required": false,
      "in": "query",
      "description": "Plugin name",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "pluginVersion",
      "required": false,
      "in": "query",
      "description": "Plugin version",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "title",
      "required": false,
      "in": "query",
      "schema": {
        "type": "string"
      }
    },
    {
      "name": "trigger",
      "required": false,
      "in": "query",
      "description": "Workflow trigger",
      "schema": {
        "$ref": "#/components/schemas/WorkflowTrigger"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "description": "Workflow types",
      "schema": {
        "$ref": "#/components/schemas/WorkflowType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PluginMethodResponseDto"
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
  "summary": "Retrieve plugin methods",
  "tags": [
    "Plugins"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "plugin.read"
}
```

## searchPluginTemplates

`GET /api/plugins/templates`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/plugin.controller.ts#L43).

Retrieve workflow templates

Permission: `plugin.read`. Admin only: `false`.

Models: [PluginTemplateResponseDto](models-26.md#plugintemplateresponsedto).

Controller access declarations:

```typescript
@ApiTags('Plugins')
@Controller('plugins')
@Get('templates')
@Authenticated({ permission: Permission.PluginRead })
@Endpoint({
    summary: 'Retrieve workflow templates',
    description: 'Retrieve workflow templates provided by installed plugins',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve workflow templates provided by installed plugins",
  "operationId": "searchPluginTemplates",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/PluginTemplateResponseDto"
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
  "summary": "Retrieve workflow templates",
  "tags": [
    "Plugins"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "plugin.read"
}
```

## getPlugin

`GET /api/plugins/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/plugin.controller.ts#L54).

Retrieve a plugin

Permission: `plugin.read`. Admin only: `false`.

Models: [PluginResponseDto](models-26.md#pluginresponsedto).

Controller access declarations:

```typescript
@ApiTags('Plugins')
@Controller('plugins')
@Get(':id')
@Authenticated({ permission: Permission.PluginRead })
@Endpoint({
    summary: 'Retrieve a plugin',
    description: 'Retrieve information about a specific plugin by its ID.',
    history: HistoryBuilder.v3(),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve information about a specific plugin by its ID.",
  "operationId": "getPlugin",
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
            "$ref": "#/components/schemas/PluginResponseDto"
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
  "summary": "Retrieve a plugin",
  "tags": [
    "Plugins"
  ],
  "x-immich-history": [
    {
      "version": "v3.0.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "plugin.read"
}
```
