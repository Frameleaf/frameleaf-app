import type { FrameleafAccess } from 'src/utils/frameleaf-sign-in.js';
import { Permission, ServerRole } from 'src/enum.js';
import { isGranted } from 'src/utils/access.js';

/**
 * FL-235 (NAPI-011): a person's role on this server, for an app to label it. The server owner is the
 * administrator whose Frameleaf account owns the server's Frameleaf Cloud link: the link's
 * `accountId` (the account's OpenID `sub`) when the server knows it, else the `frameleaf_access`
 * `owner` recorded at their last sign-in. `frameleaf_access` grants nothing else (an invited person
 * is an ordinary user with their own library).
 */
export const getServerRole = (
  isAdmin: boolean,
  link: { sub: string; access: FrameleafAccess | null } | undefined,
  ownerAccountId: string | undefined,
): ServerRole => {
  if (!isAdmin) {
    return ServerRole.User;
  }
  const isOwner = link ? (ownerAccountId ? link.sub === ownerAccountId : link.access === 'owner') : false;
  return isOwner ? ServerRole.Owner : ServerRole.Admin;
};

/**
 * Whether this session may upload here, so an app shows backup only where it is true: every account
 * has its own library, so only an API key without `asset.upload` may not.
 */
export const canUploadWith = (apiKeyPermissions?: string[]) =>
  !apiKeyPermissions || isGranted({ requested: [Permission.AssetUpload], current: apiKeyPermissions as Permission[] });
