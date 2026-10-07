# Server API — Shared spaces 1

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getSharedSpaceInvitations

`GET /api/shared-spaces/invitations`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L99).

List shared space invitations

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpacePreviewResponseDto](models-30.md#sharedspacepreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get('invitations')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List shared space invitations',
    description:
      'Shared spaces the authenticated user has been invited to and has not answered. Each entry is the same safe preview as GET /shared-spaces/{id}/preview: no assets, and counts that exclude media marked sensitive and Locked media.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Shared spaces the authenticated user has been invited to and has not answered. Each entry is the same safe preview as GET /shared-spaces/{id}/preview: no assets, and counts that exclude media marked sensitive and Locked media.",
  "operationId": "getSharedSpaceInvitations",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/SharedSpacePreviewResponseDto"
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
  "summary": "List shared space invitations",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## getRecipientGroups

`GET /api/shared-spaces/recipient-groups`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L44).

List recipient groups

Permission: `album.read`. Admin only: `false`.

Models: [RecipientGroupResponseDto](models-27.md#recipientgroupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get('recipient-groups')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List recipient groups',
    description:
      "The authenticated user's own named groups of people to invite to a shared space together. A group is a shortcut only: it grants nothing, and its name is never shown to anyone but its owner.",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "The authenticated user's own named groups of people to invite to a shared space together. A group is a shortcut only: it grants nothing, and its name is never shown to anyone but its owner.",
  "operationId": "getRecipientGroups",
  "parameters": [],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "items": {
              "$ref": "#/components/schemas/RecipientGroupResponseDto"
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
  "summary": "List recipient groups",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "album.read",
  "x-immich-state": "Alpha"
}
```

## createRecipientGroup

`POST /api/shared-spaces/recipient-groups`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L56).

Create a recipient group

Permission: `album.share`. Admin only: `false`.

Models: [RecipientGroupCreateDto](models-27.md#recipientgroupcreatedto), [RecipientGroupResponseDto](models-27.md#recipientgroupresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Post('recipient-groups')
@Authenticated({ permission: Permission.AlbumShare })
@Endpoint({
    summary: 'Create a recipient group',
    description:
      'Save a named group of people to invite together. Nobody is invited or given access until the group is applied to a shared space and its invitations are sent.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Save a named group of people to invite together. Nobody is invited or given access until the group is applied to a shared space and its invitations are sent.",
  "operationId": "createRecipientGroup",
  "parameters": [],
  "requestBody": {
    "content": {
      "application/json": {
        "schema": {
          "$ref": "#/components/schemas/RecipientGroupCreateDto"
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
            "$ref": "#/components/schemas/RecipientGroupResponseDto"
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
  "summary": "Create a recipient group",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "album.share",
  "x-immich-state": "Alpha"
}
```

## deleteRecipientGroup

`DELETE /api/shared-spaces/recipient-groups/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L87).

Delete a recipient group

Permission: `album.share`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete('recipient-groups/:id')
@Authenticated({ permission: Permission.AlbumShare })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Delete a recipient group',
    description: 'Delete one of your recipient groups. Nobody loses access to anything.',
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Delete one of your recipient groups. Nobody loses access to anything.",
  "operationId": "deleteRecipientGroup",
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
  "summary": "Delete a recipient group",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "album.share",
  "x-immich-state": "Alpha"
}
```

## updateRecipientGroup

`PUT /api/shared-spaces/recipient-groups/{id}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L71).

Update a recipient group

Permission: `album.share`. Admin only: `false`.

Models: [RecipientGroupResponseDto](models-27.md#recipientgroupresponsedto), [RecipientGroupUpdateDto](models-27.md#recipientgroupupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Put('recipient-groups/:id')
@Authenticated({ permission: Permission.AlbumShare })
@Endpoint({
    summary: 'Update a recipient group',
    description:
      "Rename a group or change who is in it. Existing invitations and memberships are never changed; only the owner's own groups can be updated (anyone else's reads as not found).",
    history: new HistoryBuilder().added('v3.2.1').alpha('v3.2.1'),
  })
```

Complete operation contract:

```json
{
  "description": "Rename a group or change who is in it. Existing invitations and memberships are never changed; only the owner's own groups can be updated (anyone else's reads as not found).",
  "operationId": "updateRecipientGroup",
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
          "$ref": "#/components/schemas/RecipientGroupUpdateDto"
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
            "$ref": "#/components/schemas/RecipientGroupResponseDto"
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
  "summary": "Update a recipient group",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3.2.1",
      "state": "Added"
    },
    {
      "version": "v3.2.1",
      "state": "Alpha"
    }
  ],
  "x-immich-permission": "album.share",
  "x-immich-state": "Alpha"
}
```

## acceptSharedSpaceInvitation

`POST /api/shared-spaces/{id}/accept`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L135).

Accept a shared space invitation

Permission: `albumUser.update`. Admin only: `false`.

Models: [AlbumResponseDto](models-02.md#albumresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Post(':id/accept')
@Authenticated({ permission: Permission.AlbumUserUpdate })
@Endpoint({
    summary: 'Accept a shared space invitation',
    description:
      'Join the shared space with the role its owner offered. The role comes from the stored invitation, never from the request. This is the only way to become a member of a space.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Join the shared space with the role its owner offered. The role comes from the stored invitation, never from the request. This is the only way to become a member of a space.",
  "operationId": "acceptSharedSpaceInvitation",
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
            "$ref": "#/components/schemas/AlbumResponseDto"
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
  "summary": "Accept a shared space invitation",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "albumUser.update"
}
```

## getSharedSpaceActivity

`GET /api/shared-spaces/{id}/activity`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L283).

What happened in a shared space

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpaceActivityResponseDto](models-30.md#sharedspaceactivityresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/activity')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'What happened in a shared space',
    description:
      'The shared space’s activity feed, newest first: items added and removed, albums and people linked and unlinked, members joining, leaving, being removed or changing role, comments and likes — by every member. Only current members may read it. Every event is narrowed to the caller before it is sent: an item the caller cannot see (Locked, marked sensitive, hidden by their own settings, or no longer in the space) is never named, and an event with nothing visible left is not sent at all, so nothing can be inferred from a count. `unreadCount` is the events by other members since the caller last marked the space seen, computed the same way. Page with `before` and `take`.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The shared space’s activity feed, newest first: items added and removed, albums and people linked and unlinked, members joining, leaving, being removed or changing role, comments and likes — by every member. Only current members may read it. Every event is narrowed to the caller before it is sent: an item the caller cannot see (Locked, marked sensitive, hidden by their own settings, or no longer in the space) is never named, and an event with nothing visible left is not sent at all, so nothing can be inferred from a count. `unreadCount` is the events by other members since the caller last marked the space seen, computed the same way. Page with `before` and `take`.",
  "operationId": "getSharedSpaceActivity",
  "parameters": [
    {
      "name": "before",
      "required": false,
      "in": "query",
      "description": "Only events before this moment, for paging",
      "schema": {
        "format": "date-time",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "take",
      "required": false,
      "in": "query",
      "description": "Page size, 50 by default",
      "schema": {
        "minimum": 1,
        "maximum": 200,
        "type": "integer"
      }
    }
  ],
  "responses": {
    "200": {
      "content": {
        "application/json": {
          "schema": {
            "$ref": "#/components/schemas/SharedSpaceActivityResponseDto"
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
  "summary": "What happened in a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## getSharedSpaceAlbums

`GET /api/shared-spaces/{id}/albums`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L176).

List albums linked into a shared space

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpaceAlbumsResponseDto](models-30.md#sharedspacealbumsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/albums')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List albums linked into a shared space',
    description:
      'The albums members have linked into the shared space, one level: a space links albums, never another space and never a collection. A link is a reference, not a move and not a share — the album keeps its owner, its members, its access rules and its place in its owner’s tree, and this response grants no access to it. The count and the tile picture come only from items that are in both the album and the space, with media marked sensitive and Locked media excluded.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The albums members have linked into the shared space, one level: a space links albums, never another space and never a collection. A link is a reference, not a move and not a share — the album keeps its owner, its members, its access rules and its place in its owner’s tree, and this response grants no access to it. The count and the tile picture come only from items that are in both the album and the space, with media marked sensitive and Locked media excluded.",
  "operationId": "getSharedSpaceAlbums",
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
            "$ref": "#/components/schemas/SharedSpaceAlbumsResponseDto"
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
  "summary": "List albums linked into a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## unlinkSharedSpaceAlbum

`DELETE /api/shared-spaces/{id}/albums/{albumId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L203).

Unlink an album from a shared space

Permission: `album.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete(':id/albums/:albumId')
@Authenticated({ permission: Permission.AlbumUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Unlink an album from a shared space',
    description:
      'Remove the reference and only the reference. The album, its items, its members and the shared space’s own items are untouched. The member who made the link, and the shared space owner, may remove it.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the reference and only the reference. The album, its items, its members and the shared space’s own items are untouched. The member who made the link, and the shared space owner, may remove it.",
  "operationId": "unlinkSharedSpaceAlbum",
  "parameters": [
    {
      "name": "albumId",
      "required": true,
      "in": "path",
      "description": "The album to link or unlink",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Shared space ID",
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
  "summary": "Unlink an album from a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.update"
}
```

## linkSharedSpaceAlbum

`PUT /api/shared-spaces/{id}/albums/{albumId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L188).

Link an album into a shared space

Permission: `album.update`. Admin only: `false`.

Models: [SharedSpaceAlbumsResponseDto](models-30.md#sharedspacealbumsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Put(':id/albums/:albumId')
@Authenticated({ permission: Permission.AlbumUpdate })
@Endpoint({
    summary: 'Link an album into a shared space',
    description:
      'Point the shared space at an album the caller can already read. Nothing else happens: no item moves or is copied, no album membership changes, and the album stays where its owner put it. Linking the same album twice is the same single link. An owner or editor of the space may link; a viewer may not.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Point the shared space at an album the caller can already read. Nothing else happens: no item moves or is copied, no album membership changes, and the album stays where its owner put it. Linking the same album twice is the same single link. An owner or editor of the space may link; a viewer may not.",
  "operationId": "linkSharedSpaceAlbum",
  "parameters": [
    {
      "name": "albumId",
      "required": true,
      "in": "path",
      "description": "The album to link or unlink",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Shared space ID",
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
            "$ref": "#/components/schemas/SharedSpaceAlbumsResponseDto"
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
  "summary": "Link an album into a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.update"
}
```

## getSharedSpaceComments

`GET /api/shared-spaces/{id}/comments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L299).

List comments in a shared space

Permission: `activity.read`. Admin only: `false`.

Models: [SharedSpaceCommentsResponseDto](models-30.md#sharedspacecommentsresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/comments')
@Authenticated({ permission: Permission.ActivityRead })
@Endpoint({
    summary: 'List comments in a shared space',
    description:
      'The comments on one item in the shared space (`assetId`), or on the space itself when `assetId` is left out. Oldest first. Only current members may read them, and an item the caller cannot see is not in the space as far as they are concerned (404). Mentions stay as `@{userId}` tokens in the text and are resolved in `mentions`. Threads are one level deep: a reply names its top-level comment in `parentId`, and a top-level comment carries its `replyCount`.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "The comments on one item in the shared space (`assetId`), or on the space itself when `assetId` is left out. Oldest first. Only current members may read them, and an item the caller cannot see is not in the space as far as they are concerned (404). Mentions stay as `@{userId}` tokens in the text and are resolved in `mentions`. Threads are one level deep: a reply names its top-level comment in `parentId`, and a top-level comment carries its `replyCount`.",
  "operationId": "getSharedSpaceComments",
  "parameters": [
    {
      "name": "assetId",
      "required": false,
      "in": "query",
      "description": "Comments on this item. Left out, the comments on the space itself.",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
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
            "$ref": "#/components/schemas/SharedSpaceCommentsResponseDto"
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
  "summary": "List comments in a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "activity.read"
}
```

## createSharedSpaceComment

`POST /api/shared-spaces/{id}/comments`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L315).

Comment in a shared space

Permission: `activity.create`. Admin only: `false`.

Models: [SharedSpaceCommentCreateDto](models-30.md#sharedspacecommentcreatedto), [SharedSpaceCommentResponseDto](models-30.md#sharedspacecommentresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Post(':id/comments')
@Authenticated({ permission: Permission.ActivityCreate })
@Endpoint({
    summary: 'Comment in a shared space',
    description:
      'Write a comment on one item in the shared space, or on the space itself when `assetId` is left out. Commenting must be enabled on the space, and the item must be one the caller can see. Mention a member with `@{userId}`: mentions are by id, never by name, every mention must name a current member (400 otherwise), and each mentioned member other than the author is notified. Reply with `parentId`: a reply to a reply joins the same thread under its top-level comment, is on the same item, and notifies the top-level comment’s author in the app.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Write a comment on one item in the shared space, or on the space itself when `assetId` is left out. Commenting must be enabled on the space, and the item must be one the caller can see. Mention a member with `@{userId}`: mentions are by id, never by name, every mention must name a current member (400 otherwise), and each mentioned member other than the author is notified. Reply with `parentId`: a reply to a reply joins the same thread under its top-level comment, is on the same item, and notifies the top-level comment’s author in the app.",
  "operationId": "createSharedSpaceComment",
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
          "$ref": "#/components/schemas/SharedSpaceCommentCreateDto"
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
            "$ref": "#/components/schemas/SharedSpaceCommentResponseDto"
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
  "summary": "Comment in a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "activity.create"
}
```

## deleteSharedSpaceComment

`DELETE /api/shared-spaces/{id}/comments/{commentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L347).

Remove a shared space comment

Permission: `activity.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete(':id/comments/:commentId')
@Authenticated({ permission: Permission.ActivityDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Remove a shared space comment',
    description:
      'Remove a comment. Its author may, and so may a shared space owner or editor — that is how a space is moderated. A viewer removes only their own. The comment’s mentions and its entry in the activity feed go with it, and removing a top-level comment removes its replies.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove a comment. Its author may, and so may a shared space owner or editor — that is how a space is moderated. A viewer removes only their own. The comment’s mentions and its entry in the activity feed go with it, and removing a top-level comment removes its replies.",
  "operationId": "deleteSharedSpaceComment",
  "parameters": [
    {
      "name": "commentId",
      "required": true,
      "in": "path",
      "description": "The comment",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Shared space ID",
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
  "summary": "Remove a shared space comment",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "activity.delete"
}
```

## updateSharedSpaceComment

`PUT /api/shared-spaces/{id}/comments/{commentId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L331).

Edit a shared space comment

Permission: `activity.update`. Admin only: `false`.

Models: [SharedSpaceCommentResponseDto](models-30.md#sharedspacecommentresponsedto), [SharedSpaceCommentUpdateDto](models-30.md#sharedspacecommentupdatedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Put(':id/comments/:commentId')
@Authenticated({ permission: Permission.ActivityUpdate })
@Endpoint({
    summary: 'Edit a shared space comment',
    description:
      'Change what a comment says. Only its author may. Mentions are re-read from the new text under the same rules, and members newly mentioned are notified.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Change what a comment says. Only its author may. Mentions are re-read from the new text under the same rules, and members newly mentioned are notified.",
  "operationId": "updateSharedSpaceComment",
  "parameters": [
    {
      "name": "commentId",
      "required": true,
      "in": "path",
      "description": "The comment",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Shared space ID",
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
          "$ref": "#/components/schemas/SharedSpaceCommentUpdateDto"
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
            "$ref": "#/components/schemas/SharedSpaceCommentResponseDto"
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
  "summary": "Edit a shared space comment",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "activity.update"
}
```

## declineSharedSpaceInvitation

`DELETE /api/shared-spaces/{id}/invitation`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L147).

Decline a shared space invitation

Permission: `albumUser.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete(':id/invitation')
@Authenticated({ permission: Permission.AlbumUserDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Decline a shared space invitation',
    description:
      'Decline the invitation. Nothing else changes: the shared space and its photos are untouched, and the owner may invite again later.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Decline the invitation. Nothing else changes: the shared space and its photos are untouched, and the owner may invite again later.",
  "operationId": "declineSharedSpaceInvitation",
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
  "summary": "Decline a shared space invitation",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "albumUser.delete"
}
```

## removeSharedSpaceInvitation

`DELETE /api/shared-spaces/{id}/invitations/{userId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L160).

Withdraw a shared space invitation

Permission: `albumUser.delete`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete(':id/invitations/:userId')
@Authenticated({ permission: Permission.AlbumUserDelete })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Withdraw a shared space invitation',
    description:
      'Withdraw a pending invitation. Only the shared space owner can do this, and it only reaches people who have not joined; removing a member is DELETE /albums/{id}/user/{userId}.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Withdraw a pending invitation. Only the shared space owner can do this, and it only reaches people who have not joined; removing a member is DELETE /albums/{id}/user/{userId}.",
  "operationId": "removeSharedSpaceInvitation",
  "parameters": [
    {
      "name": "id",
      "required": true,
      "in": "path",
      "description": "Shared space ID",
      "schema": {
        "format": "uuid",
        "pattern": "^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$",
        "type": "string"
      }
    },
    {
      "name": "userId",
      "required": true,
      "in": "path",
      "description": "The invited user",
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
  "summary": "Withdraw a shared space invitation",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "albumUser.delete"
}
```

## getSharedSpaceMembers

`GET /api/shared-spaces/{id}/members`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L123).

List shared space members

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpaceMembersResponseDto](models-30.md#sharedspacemembersresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/members')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'List shared space members',
    description:
      'Everyone in the shared space and everyone invited to it who has not answered. Any member may read the roster; only the owner may change it.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Everyone in the shared space and everyone invited to it who has not answered. Any member may read the roster; only the owner may change it.",
  "operationId": "getSharedSpaceMembers",
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
            "$ref": "#/components/schemas/SharedSpaceMembersResponseDto"
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
  "summary": "List shared space members",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## getSharedSpaceNew

`GET /api/shared-spaces/{id}/new`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L216).

What is new in a shared space since your last visit

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpaceNewResponseDto](models-30.md#sharedspacenewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/new')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'What is new in a shared space since your last visit',
    description:
      'Items other members added since the caller last marked this shared space seen. The marker is per member. If the caller has never marked it seen, everything in the space counts as new to them. The caller’s own additions are left out, and media marked sensitive and Locked media are excluded.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Items other members added since the caller last marked this shared space seen. The marker is per member. If the caller has never marked it seen, everything in the space counts as new to them. The caller’s own additions are left out, and media marked sensitive and Locked media are excluded.",
  "operationId": "getSharedSpaceNew",
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
            "$ref": "#/components/schemas/SharedSpaceNewResponseDto"
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
  "summary": "What is new in a shared space since your last visit",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## getSharedSpacePeople

`GET /api/shared-spaces/{id}/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L228).

People in a shared space

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpacePeopleResponseDto](models-30.md#sharedspacepeopleresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/people')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'People in a shared space',
    description:
      'Two lists. `linked` is who members have published into the space, carrying the space’s own name for each one and a picture that is already in the space — never the owner’s private name, thumbnail, birth date or person ID. `candidates` is the caller’s own people seen on the space’s items, so they can publish one; no other member’s people are ever listed. Counts exclude media marked sensitive and Locked media.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Two lists. `linked` is who members have published into the space, carrying the space’s own name for each one and a picture that is already in the space — never the owner’s private name, thumbnail, birth date or person ID. `candidates` is the caller’s own people seen on the space’s items, so they can publish one; no other member’s people are ever listed. Counts exclude media marked sensitive and Locked media.",
  "operationId": "getSharedSpacePeople",
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
            "$ref": "#/components/schemas/SharedSpacePeopleResponseDto"
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
  "summary": "People in a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "album.read"
}
```

## linkSharedSpacePerson

`POST /api/shared-spaces/{id}/people`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/shared-space.controller.ts#L240).

Link a person into a shared space

Permission: `person.update`. Admin only: `false`.

Models: [SharedSpacePeopleResponseDto](models-30.md#sharedspacepeopleresponsedto), [SharedSpacePersonLinkDto](models-30.md#sharedspacepersonlinkdto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Post(':id/people')
@Authenticated({ permission: Permission.PersonUpdate })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Link a person into a shared space',
    description:
      'Publish one of the caller’s own people into the shared space under a name the space uses. The name is independent: it never renames the caller’s own person, and renaming that person does not rename it here. The caller’s person record is not disclosed to anybody. Linking the same person again rewrites the link rather than adding a second one.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Publish one of the caller’s own people into the shared space under a name the space uses. The name is independent: it never renames the caller’s own person, and renaming that person does not rename it here. The caller’s person record is not disclosed to anybody. Linking the same person again rewrites the link rather than adding a second one.",
  "operationId": "linkSharedSpacePerson",
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
          "$ref": "#/components/schemas/SharedSpacePersonLinkDto"
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
            "$ref": "#/components/schemas/SharedSpacePeopleResponseDto"
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
  "summary": "Link a person into a shared space",
  "tags": [
    "Shared spaces"
  ],
  "x-immich-history": [
    {
      "version": "v3",
      "state": "Added"
    }
  ],
  "x-immich-permission": "person.update"
}
```
