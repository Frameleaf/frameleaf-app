/**
 * Account list rules for the Frameleaf admin Users area (FL-76).
 *
 * The design template's `AccountsLibraries.jsx` filters, sorts and guards its rows against a
 * simulated `account-library-data.mjs` store whose users carry `status: "active" | "deleted" |
 * "removing"` and a `pinEnabled` flag. Production has `UserAdminResponseDto`, where the same
 * lifecycle lives in `status` plus `deletedAt`, and where no PIN state is exposed to an
 * administrator at all. This module ports the template's rules onto the real shape so the
 * components stay about presentation and the rules stay testable without a DOM.
 *
 * The guards here mirror, and never replace, the server's own: `UserAdminService.delete`
 * refuses self-deletion and `UserAdminService.update` refuses a self admin-status change.
 * Hiding a control is a courtesy; the endpoint is the boundary.
 */
import { UserStatus, type UserAdminResponseDto } from '@immich/sdk';
import { DateTime } from 'luxon';

/** Bounds a pasted block of text so every keystroke cannot re-filter against a huge string. */
export const ACCOUNT_QUERY_MAX_LENGTH = 200;

export type AccountFilter = 'active' | 'all' | 'deleted' | 'admin';
export type AccountSort = 'name' | 'storage' | 'created';

/** The template's three row states, derived from the production status/deletedAt pair. */
export type AccountLifecycle = 'active' | 'deleted' | 'removing';

/** The fields the list rules need; every caller passes whole `UserAdminResponseDto` values. */
export type AccountRow = Pick<
  UserAdminResponseDto,
  'id' | 'name' | 'email' | 'isAdmin' | 'status' | 'deletedAt' | 'createdAt' | 'quotaSizeInBytes' | 'quotaUsageInBytes'
>;

export const normalizeAccountQuery = (query: string | undefined | null): string =>
  (query ?? '').trim().slice(0, ACCOUNT_QUERY_MAX_LENGTH).toLowerCase();

/**
 * `UserStatus.Removing` is the forced, unrecoverable delete; `UserStatus.Deleted` is the
 * soft delete that the configured recovery window can still undo. A row is only treated as
 * active when the server reports neither, so a stale `deletedAt` never reads as active.
 */
export const accountLifecycle = (user: Pick<AccountRow, 'status' | 'deletedAt'>): AccountLifecycle => {
  if (user.status === UserStatus.Removing) {
    return 'removing';
  }
  if (user.status === UserStatus.Deleted || user.deletedAt) {
    return 'deleted';
  }
  return 'active';
};

export const filterAccounts = <T extends AccountRow>(
  users: readonly T[],
  { query, filter }: { query?: string | null; filter: AccountFilter },
): T[] => {
  const normalized = normalizeAccountQuery(query);

  return users.filter((user) => {
    const lifecycle = accountLifecycle(user);

    switch (filter) {
      case 'active': {
        if (lifecycle !== 'active') {
          return false;
        }
        break;
      }
      case 'deleted': {
        if (lifecycle === 'active') {
          return false;
        }
        break;
      }
      case 'admin': {
        if (!user.isAdmin) {
          return false;
        }
        break;
      }
      case 'all': {
        break;
      }
    }

    if (!normalized) {
      return true;
    }

    return user.name.toLowerCase().includes(normalized) || user.email.toLowerCase().includes(normalized);
  });
};

/** Sorts a copy; the caller's array is never reordered in place. */
export const sortAccounts = <T extends AccountRow>(users: readonly T[], sort: AccountSort): T[] => {
  const rows = [...users];

  switch (sort) {
    case 'storage': {
      // Largest first, matching the template's "Storage used" sort.
      return rows.sort((a, b) => (b.quotaUsageInBytes ?? 0) - (a.quotaUsageInBytes ?? 0));
    }
    case 'created': {
      return rows.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    }
    case 'name': {
      return rows.sort((a, b) => a.name.localeCompare(b.name));
    }
  }
};

/**
 * Quota readout for a row. `null` means no quota is configured, which is unlimited storage.
 * A configured quota of 0 bytes is a real setting — it blocks new uploads while keeping the
 * existing photos — so it reports a full meter rather than dividing by zero.
 */
export const accountQuotaUsage = (
  user: Pick<AccountRow, 'quotaSizeInBytes' | 'quotaUsageInBytes'>,
): { used: number; total: number; fraction: number } | null => {
  const total = user.quotaSizeInBytes;
  if (total === null || total === undefined || total < 0) {
    return null;
  }

  const used = user.quotaUsageInBytes ?? 0;
  return { used, total, fraction: total === 0 ? 1 : Math.min(used / total, 1) };
};

/** The server refuses to delete the calling administrator's own account, and so does this. */
export const canDeleteAccount = (user: AccountRow, actorId: string): boolean =>
  user.id !== actorId && accountLifecycle(user) === 'active';

/** Only a soft-deleted account can be restored; a forced removal is already in progress. */
export const canRestoreAccount = (user: AccountRow): boolean => accountLifecycle(user) === 'deleted';

/** `UserAdminService.update` rejects an administrator changing their own admin status. */
export const canChangeRole = (user: AccountRow, actorId: string): boolean => user.id !== actorId;

/** Security actions only apply to a live account; a deleted one has nothing to sign in with. */
export const canChangeSecrets = (user: AccountRow): boolean => accountLifecycle(user) === 'active';

/**
 * The end of the configured recovery window, from the server's own `deletedAt` and the
 * server config's `userDeleteDelay` in days. Returns null when the account is not deleted.
 */
export const accountRecoveryDeadline = (user: AccountRow, deleteDelayDays: number): Date | null => {
  if (!user.deletedAt || accountLifecycle(user) !== 'deleted') {
    return null;
  }

  return DateTime.fromISO(user.deletedAt).plus({ days: deleteDelayDays }).toJSDate();
};
