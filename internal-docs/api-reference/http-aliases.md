# Server HTTP aliases and discovery

These 24 controller routes are intentionally excluded from OpenAPI. Paths below are controller-relative; see the protocol guide for root discovery mounting. They remain inventoried so exclusion does not silently hide an API.

## updateApiKeyV3

`PATCH /api-keys/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/api-key.controller.ts#L79).

```typescript
@ApiTags(ApiTag.ApiKeys)
@Controller('api-keys')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.ApiKeyUpdate })
```

## getImmichWellKnown

`GET /.well-known/immich` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/app.controller.ts#L10).

```typescript
@Controller()
@ApiExcludeEndpoint()
@Get('.well-known/immich')
@Authenticated({ public: true })
```

## getCustomCss

`GET /custom.css` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/app.controller.ts#L17).

```typescript
@Controller()
@ApiExcludeEndpoint()
@Get('custom.css')
@Authenticated({ public: true })
@Header('Content-Type', 'text/css')
```

## updateAssetsV3

`PATCH /assets` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L86).

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Patch()
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.AssetUpdate })
@HttpCode(HttpStatus.NO_CONTENT)
```

## updateAssetV3

`PATCH /assets/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/asset.controller.ts#L229).

```typescript
@ApiTags(ApiTag.Assets)
@Controller(RouteKey.Asset)
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.AssetUpdate })
```

## handshake

`GET /buddy/v1/vaults/{vaultId}/handshake` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L60).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Get('handshake')
@Authenticated({ public: true })
```

## inventory

`POST /buddy/v1/vaults/{vaultId}/inventory` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L71).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Post('inventory')
@Authenticated({ public: true })
```

## reserve

`POST /buddy/v1/vaults/{vaultId}/reservations` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L85).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Post('reservations')
@Authenticated({ public: true })
```

## put

`PUT /buddy/v1/vaults/{vaultId}/objects/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L98).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Put('objects/:id')
@Authenticated({ public: true })
```

## get

`GET /buddy/v1/vaults/{vaultId}/objects/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L112).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Get('objects/:id')
@Authenticated({ public: true })
```

## snapshots

`GET /buddy/v1/vaults/{vaultId}/snapshots` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L125).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Get('snapshots')
@Authenticated({ public: true })
```

## snapshot

`GET /buddy/v1/vaults/{vaultId}/snapshots/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L140).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Get('snapshots/:id')
@Authenticated({ public: true })
```

## commit

`POST /buddy/v1/vaults/{vaultId}/snapshots` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/buddy-backup-peer.controller.ts#L155).

```typescript
@ApiExcludeController()
@Controller('buddy/v1/vaults/:vaultId')
@Post('snapshots')
@Authenticated({ public: true })
```

## updateLibraryV3

`PATCH /libraries/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/library.controller.ts#L100).

```typescript
@ApiTags(ApiTag.Libraries)
@Controller('libraries')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.LibraryUpdate, admin: true })
```

## updateMemoryV3

`PATCH /memories/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/memory.controller.ts#L250).

```typescript
@ApiTags(ApiTag.Memories)
@Controller('memories')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.MemoryUpdate })
```

## updatePersonV3

`PATCH /people/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/person.controller.ts#L189).

```typescript
@ApiTags(ApiTag.People)
@Controller('people')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.PersonUpdate })
```

## updateSessionV3

`PATCH /sessions/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/session.controller.ts#L74).

```typescript
@ApiTags(ApiTag.Sessions)
@Controller('sessions')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.SessionUpdate })
```

## updateStackV3

`PATCH /stacks/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/stack.controller.ts#L82).

```typescript
@ApiTags(ApiTag.Stacks)
@Controller('stacks')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.StackUpdate })
```

## updateTagV3

`PATCH /tags/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/tag.controller.ts#L103).

```typescript
@ApiTags(ApiTag.Tags)
@Controller('tags')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.TagUpdate })
```

## updateUserAdminV3

`PATCH /admin/users/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/user-admin.controller.ts#L82).

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.AdminUserUpdate, admin: true })
```

## updateUserPreferencesAdminV3

`PATCH /admin/users/{id}/preferences` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/user-admin.controller.ts#L230).

```typescript
@ApiTags(ApiTag.UsersAdmin)
@Controller('admin/users')
@Patch(':id/preferences')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.AdminUserUpdate, admin: true })
```

## updateMyUserV3

`PATCH /users/me` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/user.controller.ts#L134).

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Patch('me')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.UserUpdate })
```

## updateMyPreferencesV3

`PATCH /users/me/preferences` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/user.controller.ts#L182).

```typescript
@ApiTags(ApiTag.Users)
@Controller(RouteKey.User)
@Patch('me/preferences')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.UserPreferenceUpdate })
```

## updateWorkflowV3

`PATCH /workflows/{id}` — [source](https://github.com/Frameleaf/frameleaf-app/blob/84601cc0814d82ddfcf113a25e4046c930dd64b8/server/src/controllers/workflow.controller.ts#L97).

```typescript
@ApiTags('Workflows')
@Controller('workflows')
@Patch(':id')
@ApiExcludeEndpoint()
@Authenticated({ permission: Permission.WorkflowUpdate })
```
