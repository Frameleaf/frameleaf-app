# Server API — Memories

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## searchMemories

`GET /api/memories`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L42).

Retrieve memories

Permission: `memory.read`. Admin only: `false`.

Models: [MemoryResponseDto](models-16.md#memoryresponsedto), [MemorySearchOrder](models-16.md#memorysearchorder), [MemoryType](models-16.md#memorytype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get()
@Authenticated({ permission: Permission.MemoryRead })
@Endpoint({
    summary: 'Retrieve memories',
    description:
      'Retrieve a list of memories. Memories are sorted descending by creation date by default, although they can also be sorted in ascending order, or randomly.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a list of memories. Memories are sorted descending by creation date by default, although they can also be sorted in ascending order, or randomly.",
  "operationId": "searchMemories",
  "parameters": [
    {
      "name": "for",
      "required": false,
      "in": "query",
      "description": "Filter by date",
      "schema": {
        "format": "date",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
        "example": "2024-01-01",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Memory ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "isHidden",
      "required": false,
      "in": "query",
      "description": "Only the memories the owner hid (true); hidden memories are left out otherwise",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ],
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isSaved",
      "required": false,
      "in": "query",
      "description": "Filter by saved status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Include trashed memories",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isUpcoming",
      "required": false,
      "in": "query",
      "description": "Filter by memories that have not been shown yet",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MemorySearchOrder"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of memories to return",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MemoryType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/MemoryResponseDto"
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
  "summary": "Retrieve memories",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memory.read",
  "x-immich-state": "Stable"
}
```

## createMemory

`POST /api/memories`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L54).

Create a memory

Permission: `memory.create`. Admin only: `false`.

Models: [MemoryCreateDto](models-16.md#memorycreatedto), [MemoryResponseDto](models-16.md#memoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Post()
@Authenticated({ permission: Permission.MemoryCreate })
@Endpoint({
    summary: 'Create a memory',
    description:
      'Create a new memory by providing a name, description, and a list of asset IDs to include in the memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Create a new memory by providing a name, description, and a list of asset IDs to include in the memory.",
  "operationId": "createMemory",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MemoryCreateDto"
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
            "$ref": "#/components/schemas/MemoryResponseDto"
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
  "summary": "Create a memory",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memory.create",
  "x-immich-state": "Stable"
}
```

## getMemoryExports

`GET /api/memories/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L124).

Retrieve memory exports

Permission: `memory.read`. Admin only: `false`.

Models: [MemoryExportResponseDto](models-16.md#memoryexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get('exports')
@Authenticated({ permission: Permission.MemoryRead })
@Endpoint({
    summary: 'Retrieve memory exports',
    description:
      "Retrieve the caller's own private highlight exports, newest first, optionally limited to a single memory. This is the durable job state the Activity page reads.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the caller's own private highlight exports, newest first, optionally limited to a single memory. This is the durable job state the Activity page reads.",
  "operationId": "getMemoryExports",
  "parameters": [
    {
      "name": "memoryId",
      "required": false,
      "in": "query",
      "description": "Only return exports of this memory",
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
            "items": {
              "$ref": "#/components/schemas/MemoryExportResponseDto"
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
  "summary": "Retrieve memory exports",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.read"
}
```

## deleteMemoryExport

`DELETE /api/memories/exports/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L160).

Delete a memory export

Permission: `memory.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Delete('exports/:id')
@Authenticated({ permission: Permission.MemoryDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a memory export',
    description: 'Cancel the export if it is still running, then delete the run and its archive.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Cancel the export if it is still running, then delete the run and its archive.",
  "operationId": "deleteMemoryExport",
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
  "summary": "Delete a memory export",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.delete"
}
```

## getMemoryExport

`GET /api/memories/exports/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L136).

Retrieve a memory export

Permission: `memory.read`. Admin only: `false`.

Models: [MemoryExportResponseDto](models-16.md#memoryexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get('exports/:id')
@Authenticated({ permission: Permission.MemoryRead })
@Endpoint({
    summary: 'Retrieve a memory export',
    description: "Retrieve the current state of one of the caller's own private highlight exports.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the current state of one of the caller's own private highlight exports.",
  "operationId": "getMemoryExport",
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
            "$ref": "#/components/schemas/MemoryExportResponseDto"
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
  "summary": "Retrieve a memory export",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.read"
}
```

## cancelMemoryExport

`POST /api/memories/exports/{id}/cancel`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L147).

Cancel a memory export

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryExportResponseDto](models-16.md#memoryexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Post('exports/:id/cancel')
@Authenticated({ permission: Permission.MemoryUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Cancel a memory export',
    description:
      'Ask for a running export to stop. A queued export is cancelled immediately; a running one stops at its next asset. Cancelling a finished export returns its final state unchanged.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Ask for a running export to stop. A queued export is cancelled immediately; a running one stops at its next asset. Cancelling a finished export returns its final state unchanged.",
  "operationId": "cancelMemoryExport",
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
            "$ref": "#/components/schemas/MemoryExportResponseDto"
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
  "summary": "Cancel a memory export",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.update"
}
```

## downloadMemoryExport

`GET /api/memories/exports/{id}/download`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L185).

Download a memory export

Permission: `memory.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get('exports/:id/download')
@Authenticated({ permission: Permission.MemoryRead })
@OriginalTransfer()
@FileResponse()
@Endpoint({
    summary: 'Download a memory export',
    description:
      "Download the finished archive for one of the caller's own exports. The archive is not reachable by any other route and is deleted when it expires.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Download the finished archive for one of the caller's own exports. The archive is not reachable by any other route and is deleted when it expires.",
  "operationId": "downloadMemoryExport",
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
        "application/octet-stream": {
          "schema": {
            "format": "binary",
            "type": "string"
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
  "summary": "Download a memory export",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.read"
}
```

## saveMemoryExportToLibrary

`POST /api/memories/exports/{id}/library`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L172).

Save a memory highlight to the library

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryExportResponseDto](models-16.md#memoryexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Post('exports/:id/library')
@Authenticated({ permission: Permission.MemoryUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Save a memory highlight to the library',
    description:
      "Save a finished highlight video of one of the caller's own memories to their library. Until then it is kept with the memory, out of the library, and removed with it.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Save a finished highlight video of one of the caller's own memories to their library. Until then it is kept with the memory, out of the library, and removed with it.",
  "operationId": "saveMemoryExportToLibrary",
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
            "$ref": "#/components/schemas/MemoryExportResponseDto"
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
  "summary": "Save a memory highlight to the library",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.update"
}
```

## removeMemoryShowLess

`DELETE /api/memories/show-less`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L104).

Remove a memories show-less rule

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryShowLessDto](models-16.md#memoryshowlessdto), [MemoryShowLessResponseDto](models-16.md#memoryshowlessresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Delete('show-less')
@Authenticated({ permission: Permission.MemoryUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Remove a memories show-less rule',
    description:
      "Remove one of the caller's show-less rules, so its memories are generated and shown again, and return every rule.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove one of the caller's show-less rules, so its memories are generated and shown again, and return every rule.",
  "operationId": "removeMemoryShowLess",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MemoryShowLessDto"
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
            "items": {
              "$ref": "#/components/schemas/MemoryShowLessResponseDto"
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
  "summary": "Remove a memories show-less rule",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.update"
}
```

## getMemoryShowLess

`GET /api/memories/show-less`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L79).

Retrieve memories show-less rules

Permission: `memory.read`. Admin only: `false`.

Models: [MemoryShowLessResponseDto](models-16.md#memoryshowlessresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get('show-less')
@Authenticated({ permission: Permission.MemoryRead })
@Endpoint({
    summary: 'Retrieve memories show-less rules',
    description:
      "Retrieve the caller's own rules: people, pets, dates and kinds of memory they asked to see less of. Memories of them are neither generated nor shown.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the caller's own rules: people, pets, dates and kinds of memory they asked to see less of. Memories of them are neither generated nor shown.",
  "operationId": "getMemoryShowLess",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/MemoryShowLessResponseDto"
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
  "summary": "Retrieve memories show-less rules",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.read"
}
```

## addMemoryShowLess

`POST /api/memories/show-less`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L91).

Show less of a person, pet, date or kind of memory

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryShowLessDto](models-16.md#memoryshowlessdto), [MemoryShowLessResponseDto](models-16.md#memoryshowlessresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Post('show-less')
@Authenticated({ permission: Permission.MemoryUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Show less of a person, pet, date or kind of memory',
    description:
      "Add a show-less rule for one of the caller's own people or pets, a date written as 'MM-dd', or a memory type, and return every rule.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Add a show-less rule for one of the caller's own people or pets, a date written as 'MM-dd', or a memory type, and return every rule.",
  "operationId": "addMemoryShowLess",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/MemoryShowLessDto"
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
            "items": {
              "$ref": "#/components/schemas/MemoryShowLessResponseDto"
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
  "summary": "Show less of a person, pet, date or kind of memory",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.update"
}
```

## memoriesStatistics

`GET /api/memories/statistics`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L66).

Retrieve memories statistics

Permission: `memory.statistics`. Admin only: `false`.

Models: [MemorySearchOrder](models-16.md#memorysearchorder), [MemoryStatisticsResponseDto](models-16.md#memorystatisticsresponsedto), [MemoryType](models-16.md#memorytype).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get('statistics')
@Authenticated({ permission: Permission.MemoryStatistics })
@Endpoint({
    summary: 'Retrieve memories statistics',
    description: 'Retrieve statistics about memories, such as total count and other relevant metrics.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve statistics about memories, such as total count and other relevant metrics.",
  "operationId": "memoriesStatistics",
  "parameters": [
    {
      "name": "for",
      "required": false,
      "in": "query",
      "description": "Filter by date",
      "schema": {
        "format": "date",
        "pattern": "^(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))$",
        "example": "2024-01-01",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": false,
      "in": "query",
      "description": "Memory ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "isHidden",
      "required": false,
      "in": "query",
      "description": "Only the memories the owner hid (true); hidden memories are left out otherwise",
      "x-immich-history": [
        {
          "version": "v3",
          "state": "Added"
        }
      ],
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isSaved",
      "required": false,
      "in": "query",
      "description": "Filter by saved status",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isTrashed",
      "required": false,
      "in": "query",
      "description": "Include trashed memories",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "isUpcoming",
      "required": false,
      "in": "query",
      "description": "Filter by memories that have not been shown yet",
      "schema": {
        "type": "boolean"
      }
    },
    {
      "name": "order",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MemorySearchOrder"
      }
    },
    {
      "name": "page",
      "required": false,
      "in": "query",
      "description": "Page number",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "size",
      "required": false,
      "in": "query",
      "description": "Number of memories to return",
      "schema": {
        "minimum": 1,
        "maximum": 9007199254740991,
        "type": "integer"
      }
    },
    {
      "name": "type",
      "required": false,
      "in": "query",
      "schema": {
        "$ref": "#/components/schemas/MemoryType"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/MemoryStatisticsResponseDto"
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
  "summary": "Retrieve memories statistics",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memory.statistics",
  "x-immich-state": "Stable"
}
```

## deleteMemory

`DELETE /api/memories/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L261).

Delete a memory

Permission: `memory.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Delete(':id')
@Authenticated({ permission: Permission.MemoryDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a memory',
    description: 'Delete a specific memory by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a specific memory by its ID.",
  "operationId": "deleteMemory",
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
  "summary": "Delete a memory",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memory.delete",
  "x-immich-state": "Stable"
}
```

## getMemory

`GET /api/memories/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L220).

Retrieve a memory

Permission: `memory.read`. Admin only: `false`.

Models: [MemoryResponseDto](models-16.md#memoryresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Get(':id')
@Authenticated({ permission: Permission.MemoryRead })
@Endpoint({
    summary: 'Retrieve a memory',
    description: 'Retrieve a specific memory by its ID.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve a specific memory by its ID.",
  "operationId": "getMemory",
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
            "$ref": "#/components/schemas/MemoryResponseDto"
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
  "summary": "Retrieve a memory",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memory.read",
  "x-immich-state": "Stable"
}
```

## updateMemory

`PUT /api/memories/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L231).

Update a memory

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryResponseDto](models-16.md#memoryresponsedto), [MemoryUpdateDto](models-16.md#memoryupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Put(':id')
@Authenticated({ permission: Permission.MemoryUpdate })
@Endpoint({
    summary: 'Update a memory',
    description: 'Update an existing memory by its ID.',
    history: new HistoryBuilder()
      .added('v1')
      .beta('v1')
      .stable('v2')
      .deprecated('v3', { replacementId: 'updateMemory' }),
  })
```

Complete operation contract:

```json
{
  "deprecated": true,
  "description": "Update an existing memory by its ID.",
  "operationId": "updateMemory",
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
          "$ref": "#/components/schemas/MemoryUpdateDto"
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
            "$ref": "#/components/schemas/MemoryResponseDto"
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
  "summary": "Update a memory",
  "tags": [
    "Memories",
    "Deprecated"
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
    },
    {
      "version": "v3",
      "state": "Deprecated",
      "replacementId": "updateMemory"
    }
  ],
  "x-immich-permission": "memory.update",
  "x-immich-state": "Deprecated"
}
```

## removeMemoryAssets

`DELETE /api/memories/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L288).

Remove assets from a memory

Permission: `memoryAsset.delete`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Delete(':id/assets')
@Authenticated({ permission: Permission.MemoryAssetDelete })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Remove assets from a memory',
    description: 'Remove a list of asset IDs from a specific memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove a list of asset IDs from a specific memory.",
  "operationId": "removeMemoryAssets",
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
          "$ref": "#/components/schemas/BulkIdsDto"
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
            "items": {
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Remove assets from a memory",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memoryAsset.delete",
  "x-immich-state": "Stable"
}
```

## addMemoryAssets

`PUT /api/memories/{id}/assets`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L273).

Add assets to a memory

Permission: `memoryAsset.create`. Admin only: `false`.

Models: [BulkIdResponseDto](models-07.md#bulkidresponsedto), [BulkIdsDto](models-07.md#bulkidsdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Put(':id/assets')
@Authenticated({ permission: Permission.MemoryAssetCreate })
@Endpoint({
    summary: 'Add assets to a memory',
    description: 'Add a list of asset IDs to a specific memory.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Add a list of asset IDs to a specific memory.",
  "operationId": "addMemoryAssets",
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
          "$ref": "#/components/schemas/BulkIdsDto"
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
            "items": {
              "$ref": "#/components/schemas/BulkIdResponseDto"
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
  "summary": "Add assets to a memory",
  "tags": [
    "Memories"
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
  "x-immich-permission": "memoryAsset.create",
  "x-immich-state": "Stable"
}
```

## createMemoryExport

`POST /api/memories/{id}/exports`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/memory.controller.ts#L203).

Export a memory

Permission: `memory.update`. Admin only: `false`.

Models: [MemoryExportCreateDto](models-16.md#memoryexportcreatedto), [MemoryExportResponseDto](models-16.md#memoryexportresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Post(':id/exports')
@Authenticated({ permission: Permission.MemoryUpdate })
@HttpCode(HttpStatus.CREATED)
@Endpoint({
    summary: 'Export a memory',
    description:
      "Start a private highlight export of a memory's assets as a durable, cancellable background job. The asset list is snapshotted when the export starts, and a second request while one is already running returns the export in flight.",
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Start a private highlight export of a memory's assets as a durable, cancellable background job. The asset list is snapshotted when the export starts, and a second request while one is already running returns the export in flight.",
  "operationId": "createMemoryExport",
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
          "$ref": "#/components/schemas/MemoryExportCreateDto"
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
            "$ref": "#/components/schemas/MemoryExportResponseDto"
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
  "summary": "Export a memory",
  "tags": [
    "Memories"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "memory.update"
}
```
