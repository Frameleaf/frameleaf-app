# Server API — Shared spaces 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## unlinkSharedSpacePerson

`DELETE /api/shared-spaces/{id}/people/{linkId}`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/shared-space.controller.ts#L257).

Unlink a person from a shared space

Permission: `person.update`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Delete(':id/people/:linkId')
@Authenticated({ permission: Permission.PersonUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Unlink a person from a shared space',
    description:
      'Remove the link and only the link. The person, their name, their faces and every item that shows them are untouched, and so are the shared space’s items. The member who made the link, and the shared space owner, may remove it.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Remove the link and only the link. The person, their name, their faces and every item that shows them are untouched, and so are the shared space’s items. The member who made the link, and the shared space owner, may remove it.",
  "operationId": "unlinkSharedSpacePerson",
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
      "name": "linkId",
      "required": true,
      "in": "path",
      "description": "The person link to remove",
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
  "summary": "Unlink a person from a shared space",
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

## getSharedSpacePreview

`GET /api/shared-spaces/{id}/preview`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/shared-space.controller.ts#L111).

Preview a shared space

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpacePreviewResponseDto](models-31.md#sharedspacepreviewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Get(':id/preview')
@Authenticated({ permission: Permission.AlbumRead })
@Endpoint({
    summary: 'Preview a shared space',
    description:
      'What the shared space exposes, for someone holding an invitation to it or already in it. The preview carries no asset: no ids, no thumbnails, no file names, no people and no places. Counts and dates exclude media marked sensitive and Locked media. Anyone without an invitation or membership gets 404.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "What the shared space exposes, for someone holding an invitation to it or already in it. The preview carries no asset: no ids, no thumbnails, no file names, no people and no places. Counts and dates exclude media marked sensitive and Locked media. Anyone without an invitation or membership gets 404.",
  "operationId": "getSharedSpacePreview",
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
            "$ref": "#/components/schemas/SharedSpacePreviewResponseDto"
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
  "summary": "Preview a shared space",
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

## markSharedSpaceVisited

`POST /api/shared-spaces/{id}/visit`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/shared-space.controller.ts#L270).

Mark a shared space seen

Permission: `album.read`. Admin only: `false`.

Models: [SharedSpaceNewResponseDto](models-31.md#sharedspacenewresponsedto).

Controller access declarations:

```typescript
@ApiTags(ApiTag.SharedSpaces)
@Controller('shared-spaces')
@Post(':id/visit')
@Authenticated({ permission: Permission.AlbumRead })
@HttpCode(HttpStatus.OK)
@Endpoint({
    summary: 'Mark a shared space seen',
    description:
      'Move the caller’s own last-seen marker to now and return what is new after doing so. This is deliberately explicit rather than something opening the page does, so glancing at a space on a phone does not silently clear the list of what has not been looked at.',
    history: new HistoryBuilder().added('v3'),
  })
```

Complete operation contract:

```json
{
  "description": "Move the caller’s own last-seen marker to now and return what is new after doing so. This is deliberately explicit rather than something opening the page does, so glancing at a space on a phone does not silently clear the list of what has not been looked at.",
  "operationId": "markSharedSpaceVisited",
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
  "summary": "Mark a shared space seen",
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
