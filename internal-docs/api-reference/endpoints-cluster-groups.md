# Server API — Cluster groups

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getClusterGroupRequests

`GET /api/cluster-groups/requests`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L18).

Retrieve cluster group requests

Permission: `clusterGroupRequest.read`. Admin only: `false`.

Models: [ClusterGroupRequestResponseDto](models-09.md#clustergrouprequestresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Get('requests')
@Authenticated({ permission: Permission.ClusterGroupRequestRead })
@Endpoint({
    summary: 'Retrieve cluster group requests',
    description: 'Retrieve the pending requests for the current user to join a cluster group.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the pending requests for the current user to join a cluster group.",
  "operationId": "getClusterGroupRequests",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/ClusterGroupRequestResponseDto"
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
  "summary": "Retrieve cluster group requests",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroupRequest.read"
}
```

## deleteClusterGroupRequest

`DELETE /api/cluster-groups/requests/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L41).

Decline a cluster group request

Permission: `clusterGroupRequest.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Delete('requests/:id')
@Authenticated({ permission: Permission.ClusterGroupRequestDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Decline a cluster group request',
    description: 'Delete a pending request to join a cluster group.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete a pending request to join a cluster group.",
  "operationId": "deleteClusterGroupRequest",
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
  "summary": "Decline a cluster group request",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroupRequest.delete"
}
```

## acceptClusterGroupRequest

`POST /api/cluster-groups/requests/{id}/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L29).

Accept a cluster group request

Permission: `clusterGroupRequest.create`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Post('requests/:id/accept')
@Authenticated({ permission: Permission.ClusterGroupRequestCreate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Accept a cluster group request',
    description: 'Join the cluster group the request was created for.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Join the cluster group the request was created for.",
  "operationId": "acceptClusterGroupRequest",
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
  "summary": "Accept a cluster group request",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroupRequest.create"
}
```

## leaveClusterGroup

`POST /api/cluster-groups/{id}/leave`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L108).

Leave a cluster group

Permission: `clusterGroup.leave`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Post(':id/leave')
@Authenticated({ permission: Permission.ClusterGroupLeave })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Leave a cluster group',
    description: 'Move the current user into a new cluster group of their own.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Move the current user into a new cluster group of their own.",
  "operationId": "leaveClusterGroup",
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
  "summary": "Leave a cluster group",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroup.leave"
}
```

## clusterGroupRegeneratePeople

`POST /api/cluster-groups/{id}/regenerate-people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L96).

Regenerate people of users in cluster group

Permission: `clusterGroup.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Post(':id/regenerate-people')
@Authenticated({ permission: Permission.ClusterGroupRead })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Regenerate people of users in cluster group',
    description: 'Forcefully re-run facial recognition for all faces of users in this group.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Forcefully re-run facial recognition for all faces of users in this group.",
  "operationId": "clusterGroupRegeneratePeople",
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
  "summary": "Regenerate people of users in cluster group",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroup.read"
}
```

## getClusterGroupRequestsForGroup

`GET /api/cluster-groups/{id}/requests`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L53).

Retrieve the requests sent by a cluster group

Permission: `clusterGroupRequest.read`. Admin only: `false`.

Models: [ClusterGroupRequestResponseDto](models-09.md#clustergrouprequestresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Get(':id/requests')
@Authenticated({ permission: Permission.ClusterGroupRequestRead })
@Endpoint({
    summary: 'Retrieve the requests sent by a cluster group',
    description: 'Retrieve the pending requests for other users to join the cluster group.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the pending requests for other users to join the cluster group.",
  "operationId": "getClusterGroupRequestsForGroup",
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
            "items": {
              "$ref": "#/components/schemas/ClusterGroupRequestResponseDto"
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
  "summary": "Retrieve the requests sent by a cluster group",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroupRequest.read"
}
```

## createClusterGroupRequest

`PUT /api/cluster-groups/{id}/requests`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L78).

Create a cluster group request

Permission: `clusterGroupRequest.create`. Admin only: `false`.

Models: [ClusterGroupRequestCreateDto](models-09.md#clustergrouprequestcreatedto), [ClusterGroupRequestResponseDto](models-09.md#clustergrouprequestresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Put(':id/requests')
@Authenticated({ permission: Permission.ClusterGroupRequestCreate })
@Endpoint({
    summary: 'Create a cluster group request',
    description: 'Ask another user to join the cluster group of the current user.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Ask another user to join the cluster group of the current user.",
  "operationId": "createClusterGroupRequest",
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
          "$ref": "#/components/schemas/ClusterGroupRequestCreateDto"
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
            "$ref": "#/components/schemas/ClusterGroupRequestResponseDto"
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
  "summary": "Create a cluster group request",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroupRequest.create"
}
```

## getClusterGroupUsers

`GET /api/cluster-groups/{id}/users`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/cluster-group.controller.ts#L67).

Retrieve the users of a cluster group

Permission: `clusterGroup.read`. Admin only: `false`.

Models: [UserResponseDto](models-38.md#userresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.ClusterGroups)
@Controller('cluster-groups')
@Get(':id/users')
@Authenticated({ permission: Permission.ClusterGroupRead })
@Endpoint({
    summary: 'Retrieve the users of a cluster group',
    description: 'Retrieve the users that are a member of the cluster group.',
    history: new HistoryBuilder().added('v3.2.0'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the users that are a member of the cluster group.",
  "operationId": "getClusterGroupUsers",
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
            "items": {
              "$ref": "#/components/schemas/UserResponseDto"
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
  "summary": "Retrieve the users of a cluster group",
  "tags": [
    "Cluster groups"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.0",
      "state": "Added"
    }
  ],
  "x-immich-permission": "clusterGroup.read"
}
```
