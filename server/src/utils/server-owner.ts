import { ForbiddenException } from '@nestjs/common';
import type { AuthDto } from 'src/dtos/auth.dto.js';

/** What the check needs from the user repository: every administrator that is not deleted, oldest first. */
export type ServerOwnerUsers = { getAdmins(): Promise<Array<{ id: string }>> };

/**
 * FL-416: the server owner is the first administrator, meaning the oldest administrator account that is not
 * deleted. Some things are the owner's alone (Unused files, which deletes files from the drive for good):
 * members and other administrators neither see them nor reach their API. A shared link never is the owner.
 */
export const isServerOwner = async (users: ServerOwnerUsers, auth: AuthDto): Promise<boolean> => {
  if (auth.sharedLink || !auth.user.isAdmin) {
    return false;
  }
  const [owner] = await users.getAdmins();
  return owner?.id === auth.user.id;
};

export const requireServerOwner = async (users: ServerOwnerUsers, auth: AuthDto): Promise<void> => {
  if (!(await isServerOwner(users, auth))) {
    throw new ForbiddenException('Only the server owner can do this');
  }
};
