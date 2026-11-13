# Frameleaf Connect protocol 1

Connect integrations use the Library's OAuth authorization code flow with PKCE S256. Direct connections to a Library on the local network or customer HTTPS do not require a Cloud plan. Existing remote-access and original-transfer policies still apply when the connection uses Frameleaf relay.

Discover the protected resource at `/.well-known/oauth-protected-resource/api/connect` and use its exact `resource` in authorization and token requests. Authorization-server discovery is at `/.well-known/oauth-authorization-server`. Public clients register exact HTTPS callbacks, HTTP loopback callbacks, or the exact native Lightroom callback `lightroom://net.frameleaf.connect/oauth/callback`. Loopback listeners may choose their port. A client ID is public and specific to the Library. Administrators can register clients when dynamic registration is disabled; clients must never work around that setting.

The signed-in consent page binds a policy to the authorization code and grant:

```json
{
  "version": 1,
  "readAlbumIds": [],
  "allLibraryRead": false,
  "writableAlbumIds": [],
  "writeWorkspaces": []
}
```

Select owned albums explicitly. A selected album grants no access to its children or to assets owned by someone else. Whole-library reads require an explicit choice. Writable albums and permission to create destinations in the `photo` or `design` workspace are separate choices. Shared spaces, Locked albums, mixed-workspace albums and Trash cannot be destinations. Album metadata reports mixed workspaces as `both` with `canWrite: false`; those albums can still be selected for reading. Hidden, Locked and trashed assets are excluded from every read, count and page.

Supported scopes are `library:read`, `library:download`, `albums:write`, `tags:write`, `photos:upload`, `boards:upload` and `events:read`. People, sharing, administration, removal and deletion are outside Connect. Upload and event scopes are valid only for the Connect resource. Restricted tokens cannot call the general REST API or MCP; general API and MCP grants cannot call Connect.

Send access tokens only in the Authorization bearer header. Refresh tokens rotate on every refresh: serialize refresh operations and replace both tokens together. Reuse of a spent refresh token revokes the grant. Refresh does not expand policy, scope or resource. A person can narrow a grant through Settings; the next request uses the new policy. Expanded access requires new consent.

Disconnect through `POST /api/oauth/apps/revoke` with `client_id` and the last stored refresh token. Revocation accepts a consumed refresh token for the same grant, including when a rotation response was lost. This does not permit using that token for another refresh. Unknown tokens still receive the standard success response without revealing grant information.

## Read and additive-write endpoints

All routes below are relative to `/api/connect`.

| Method and route         | Behavior                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET capabilities`       | Protocol version, stable server ID, display name, granted scopes and policy, policy revision, current album targets, effective transfer limits and MIME types by workspace.                             |
| `GET albums`             | Readable and writable owned targets, with `id`, `name`, `workspace`, `canRead` and `canWrite`.                                                                                                          |
| `GET assets`             | Search authorized image/video assets using `q`, `albumId`, `type`, `page` and `size`. Pages start at 1; size defaults to 50 and cannot exceed 100. Counts use the same authorization filter as results. |
| `GET assets/:id`         | Narrow asset metadata or 404.                                                                                                                                                                           |
| `POST albums/:id/assets` | Add `assetIds` (1–100) to a currently writable target. Every source asset must also be readable. Returns per-asset results.                                                                             |
| `POST assets/:id/tags`   | Add `tags` (1–20). The asset must be readable and belong to a currently writable destination. Returns `tagIds`.                                                                                         |

Asset metadata contains `id`, `type`, `title`, `description`, `width`, `height`, `duration`, `createdAt` and `updatedAt`. Duration is milliseconds. This Connect protocol version returns `title` as null; `description` is the caption. Responses omit EXIF, location, people, owner details, storage paths and original filenames. Asset ordering is capture time descending, then ID descending.

`connection.grantId` and `connection.libraryUserId` identify only the currently authenticated grant and its Library owner. Managed connectors use these IDs to bind downstream consent; they do not expose another account or permit selecting an owner.

Capabilities expose a stable `server.id` for identity pinning and `policyRevision` for detecting consent changes. `limits` contains `maxPageSize`, `maxUploadBytes`, `maxAppendBytes`, `uploadExpiresAfterSeconds`, `receiptWindowSeconds`, `renditionTicketSeconds` and `originalsAllowed`. `supportedTypes.upload` lists accepted MIME types separately for `photo` and `design`. Treat these as current limits; a later upload or download can still be denied if quota, consent or connection policy changes.

Album creation, resumable uploads, renditions, transfer tickets and the event feed use the same live grant and privacy boundary. Asset creation must retain the original file and publish a new asset rather than overwrite an existing original. Request identifiers and transfer receipts belong to the creating grant. Additive writes serialize with policy narrowing and revocation.

Additive writes and uploads may return `409` while album hierarchy or access changes are in progress. Retry the same operation after a short delay; retain the request ID and payload for album creation and upload retries.

Do not log authorization headers, OAuth codes, tokens, transfer URLs, filenames or media. Keep a failed consent, revoked grant, expired cursor and unavailable rendition distinguishable in client recovery flows.
