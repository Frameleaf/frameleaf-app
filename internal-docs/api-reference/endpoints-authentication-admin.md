# Server API — Authentication (admin)

Generated from the checked-in [server contract](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/open-api/immich-openapi-specs.json). Base path: `/api`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.

## unlinkAllOAuthAccountsAdmin

`POST /api/admin/auth/unlink-all`

[Controller implementation](https://github.com/Frameleaf/frameleaf-app/blob/0a503215fa351aafbeea57c6d19899a9e943fa88/server/src/controllers/auth-admin.controller.ts#L13).

Unlink all OAuth accounts

Permission: `adminAuth.unlinkAll`. Admin only: `true`.

Controller access declarations:

```typescript
@ApiTags(ApiTag.AuthenticationAdmin)
@Controller('admin/auth')
@Post('unlink-all')
@Authenticated({ permission: Permission.AdminAuthUnlinkAll, admin: true })
@HttpCode(HttpStatus.NO_CONTENT)
@Endpoint({
    summary: 'Unlink all OAuth accounts',
    description: 'Unlinks all OAuth accounts associated with user accounts in the system.',
    history: new HistoryBuilder().added('v1').beta('v1').stable('v2'),
  })
```

Complete operation contract:

```json
{
  "description": "Unlinks all OAuth accounts associated with user accounts in the system.",
  "operationId": "unlinkAllOAuthAccountsAdmin",
  "parameters": [],
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
  "summary": "Unlink all OAuth accounts",
  "tags": [
    "Authentication (admin)"
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
  "x-immich-permission": "adminAuth.unlinkAll",
  "x-immich-state": "Stable"
}
```
