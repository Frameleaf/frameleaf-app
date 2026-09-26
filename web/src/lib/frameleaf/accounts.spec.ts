import { UserStatus } from '@immich/sdk';
import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_QUERY_MAX_LENGTH,
  accountLifecycle,
  accountQuotaUsage,
  accountRecoveryDeadline,
  canChangeRole,
  canChangeSecrets,
  canDeleteAccount,
  canRestoreAccount,
  filterAccounts,
  normalizeAccountQuery,
  sortAccounts,
  type AccountRow,
} from '$lib/frameleaf/accounts';

const account = (overrides: Partial<AccountRow> & Pick<AccountRow, 'id' | 'name' | 'email'>): AccountRow => ({
  isAdmin: false,
  status: UserStatus.Active,
  deletedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  quotaSizeInBytes: null,
  quotaUsageInBytes: 0,
  ...overrides,
});

const owner = account({
  id: 'owner',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  isAdmin: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  quotaUsageInBytes: 30,
});
const member = account({
  id: 'member',
  name: 'Grace Hopper',
  email: 'grace@example.com',
  createdAt: '2026-03-01T00:00:00.000Z',
  quotaUsageInBytes: 90,
  quotaSizeInBytes: 100,
});
const deleted = account({
  id: 'deleted',
  name: 'Zoe Removed',
  email: 'zoe@example.com',
  status: UserStatus.Deleted,
  deletedAt: '2026-09-10T00:00:00.000Z',
  createdAt: '2026-02-01T00:00:00.000Z',
  quotaUsageInBytes: 10,
});
const removing = account({
  id: 'removing',
  name: 'Ida Purged',
  email: 'ida@example.com',
  status: UserStatus.Removing,
  deletedAt: '2026-09-20T00:00:00.000Z',
  createdAt: '2026-04-01T00:00:00.000Z',
});

const rows = [owner, member, deleted, removing];

describe('Frameleaf account lifecycle', () => {
  it('separates a soft delete from a forced removal', () => {
    expect(accountLifecycle(owner)).toBe('active');
    expect(accountLifecycle(deleted)).toBe('deleted');
    expect(accountLifecycle(removing)).toBe('removing');
  });

  it('treats a stale deletedAt as deleted even when the status has not caught up', () => {
    expect(accountLifecycle({ status: UserStatus.Active, deletedAt: '2026-09-10T00:00:00.000Z' })).toBe('deleted');
  });
});

describe('Frameleaf account filtering', () => {
  it('shows only live accounts by default', () => {
    expect(filterAccounts(rows, { filter: 'active' })).toEqual([owner, member]);
  });

  it('shows both deleted and removing accounts under the deleted filter', () => {
    expect(filterAccounts(rows, { filter: 'deleted' })).toEqual([deleted, removing]);
  });

  it('shows administrators regardless of their lifecycle', () => {
    expect(filterAccounts(rows, { filter: 'admin' })).toEqual([owner]);
  });

  it('matches names and email addresses case-insensitively', () => {
    expect(filterAccounts(rows, { filter: 'all', query: 'HOPPER' })).toEqual([member]);
    expect(filterAccounts(rows, { filter: 'all', query: 'ada@' })).toEqual([owner]);
  });

  it('combines the search with the selected filter', () => {
    expect(filterAccounts(rows, { filter: 'active', query: 'zoe' })).toEqual([]);
  });

  it('ignores an empty or whitespace-only search', () => {
    expect(filterAccounts(rows, { filter: 'all', query: ' '.repeat(3) })).toEqual(rows);
    expect(filterAccounts(rows, { filter: 'all', query: null })).toEqual(rows);
  });

  it('caps the query so a huge paste cannot blow up matching', () => {
    expect(normalizeAccountQuery('x'.repeat(ACCOUNT_QUERY_MAX_LENGTH + 50))).toHaveLength(ACCOUNT_QUERY_MAX_LENGTH);
  });
});

describe('Frameleaf account sorting', () => {
  it('sorts by name, largest storage first, and newest first', () => {
    expect(sortAccounts(rows, 'name').map((row) => row.id)).toEqual(['owner', 'member', 'removing', 'deleted']);
    expect(sortAccounts(rows, 'storage').map((row) => row.id)).toEqual(['member', 'owner', 'deleted', 'removing']);
    expect(sortAccounts(rows, 'created').map((row) => row.id)).toEqual(['removing', 'member', 'deleted', 'owner']);
  });

  it('does not reorder the array it was given', () => {
    const input = [member, owner];
    sortAccounts(input, 'name');
    expect(input).toEqual([member, owner]);
  });
});

describe('Frameleaf account quota', () => {
  it('reports no quota as unlimited', () => {
    expect(accountQuotaUsage({ quotaSizeInBytes: null, quotaUsageInBytes: 10 })).toBeNull();
  });

  it('reports a configured quota as a bounded fraction', () => {
    expect(accountQuotaUsage({ quotaSizeInBytes: 100, quotaUsageInBytes: 90 })).toEqual({
      used: 90,
      total: 100,
      fraction: 0.9,
    });
    expect(accountQuotaUsage({ quotaSizeInBytes: 100, quotaUsageInBytes: 250 })?.fraction).toBe(1);
  });

  it('treats a zero quota as full rather than dividing by zero', () => {
    expect(accountQuotaUsage({ quotaSizeInBytes: 0, quotaUsageInBytes: 0 })).toEqual({
      used: 0,
      total: 0,
      fraction: 1,
    });
  });
});

describe('Frameleaf account guards', () => {
  it('mirrors the server refusal to delete or demote your own account', () => {
    expect(canDeleteAccount(owner, 'owner')).toBe(false);
    expect(canDeleteAccount(member, 'owner')).toBe(true);
    expect(canChangeRole(owner, 'owner')).toBe(false);
    expect(canChangeRole(member, 'owner')).toBe(true);
  });

  it('never offers delete for an account that is already gone', () => {
    expect(canDeleteAccount(deleted, 'owner')).toBe(false);
    expect(canDeleteAccount(removing, 'owner')).toBe(false);
  });

  it('offers restore only within the recovery window, never for a forced removal', () => {
    expect(canRestoreAccount(deleted)).toBe(true);
    expect(canRestoreAccount(removing)).toBe(false);
    expect(canRestoreAccount(member)).toBe(false);
  });

  it('offers password and PIN actions only for a live account', () => {
    expect(canChangeSecrets(member)).toBe(true);
    expect(canChangeSecrets(deleted)).toBe(false);
    expect(canChangeSecrets(removing)).toBe(false);
  });
});

describe('Frameleaf account recovery deadline', () => {
  it('adds the configured delay to the server deletion date', () => {
    expect(accountRecoveryDeadline(deleted, 7)?.toISOString()).toBe('2026-09-17T00:00:00.000Z');
  });

  it('has no deadline for a live account or a forced removal', () => {
    expect(accountRecoveryDeadline(member, 7)).toBeNull();
    expect(accountRecoveryDeadline(removing, 7)).toBeNull();
  });
});
