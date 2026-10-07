# Server API — Users 2

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## getProfileImage

`GET /api/users/{id}/profile-image`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/24d509f1346e344bb356f92cd0fbed2a59b74ca8/server/src/controllers/user.controller.ts#L304).

Retrieve user profile image

Permission: `userProfileImage.read`. Admin only: `false`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Get(':id/profile-image')
@FileResponse()
@Authenticated({ permission: Permission.UserProfileImageRead })
@Endpoint({
    summary: 'Retrieve user profile image',
    description: 'Retrieve the profile image file for a user.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Retrieve the profile image file for a user.",
  "operationId": "getProfileImage",
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
  "summary": "Retrieve user profile image",
  "tags": [
    "Users"
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
  "x-immich-permission": "userProfileImage.read",
  "x-immich-state": "Stable"
}
```
