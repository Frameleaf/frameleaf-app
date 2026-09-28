import { AdminAuditAction } from '@immich/sdk';
import { addMessages, t } from 'svelte-i18n';
import { get } from 'svelte/store';
import en from '$i18n/en.json';
import { describeAdminEvent, formatHistoryDate, managedUploadCount } from '$lib/frameleaf/account-history';

/** FL-76: the account detail's Activity sentences and managed uploads count. */

beforeAll(() => {
  addMessages('dev', en);
});

const bytes = (value: number) => `${value} B`;
const describe_ = (action: AdminAuditAction, detail: string | null = null) =>
  describeAdminEvent({ action, detail }, get(t), bytes);

describe(describeAdminEvent.name, () => {
  it("uses the template's wording", () => {
    expect(describe_(AdminAuditAction.AccountCreated)).toBe('Account created');
    expect(describe_(AdminAuditAction.PinReset)).toBe('PIN reset');
    expect(describe_(AdminAuditAction.PinSet)).toBe('Locked folder PIN updated');
    expect(describe_(AdminAuditAction.PreferencesUpdated, 'download,tags')).toBe('Account preferences updated');
    expect(describe_(AdminAuditAction.AccountRestored)).toBe('Account restored · sign-in required');
    expect(describe_(AdminAuditAction.LibraryCreated)).toBe('External library created');
    expect(describe_(AdminAuditAction.LibraryUpdated)).toBe('Library settings updated');
    expect(describe_(AdminAuditAction.LibraryScanQueued)).toBe('Library scan queued');
    expect(describe_(AdminAuditAction.LibraryDeleted)).toBe('Library removed · source files retained');
    expect(describe_(AdminAuditAction.AccountRemovalScheduled)).toBe('Account scheduled for permanent removal');
  });

  it('describes each step of an identity key recovery (FL-175)', () => {
    expect(describe_(AdminAuditAction.CloudKeyRecoveryRotation, 'rotated')).toBe(
      'Replaced this server’s identity key after a key could not be read',
    );
    expect(describe_(AdminAuditAction.CloudKeyRecoveryRotation, 'retrying')).toBe(
      'Could not replace this server’s identity key yet; retrying',
    );
    expect(describe_(AdminAuditAction.CloudKeyRecoveryRotation, 'window-closed')).toBe(
      'The previous identity key expired before it could be replaced; link this server again',
    );
    expect(describe_(AdminAuditAction.CloudKeyRecoveryRotation)).toBe(
      'Started a new identity key rotation after a key could not be read',
    );
  });

  it('carries the recorded specifics', () => {
    expect(describe_(AdminAuditAction.AccountDeleted, '7')).toBe('Account deleted · recovery available for 7 days');
    expect(describe_(AdminAuditAction.SessionRevoked, 'iOS · iPhone')).toBe('Device signed out: iOS · iPhone');
    expect(describe_(AdminAuditAction.PasswordReset, 'change-required')).toBe(
      'Password reset · change required at next sign-in',
    );
    expect(describe_(AdminAuditAction.PasswordReset)).toBe('Password reset');
    expect(describe_(AdminAuditAction.QuotaChanged, '1024')).toBe('Storage quota set to 1024 B');
    expect(describe_(AdminAuditAction.QuotaChanged)).toBe('Storage quota set to unlimited');
    expect(describe_(AdminAuditAction.StorageLabelChanged, 'grace')).toBe('Storage label set to grace');
    expect(describe_(AdminAuditAction.StorageLabelChanged)).toBe('Storage label set to automatic');
  });

  it('still reads when a detail is missing or an action is newer than this client', () => {
    expect(describe_(AdminAuditAction.AccountDeleted)).toBe('Account deleted');
    expect(describe_(AdminAuditAction.SessionRevoked)).toBe('Device signed out');
    expect(describe_('something-new' as AdminAuditAction)).toBe('Account changed');
  });
});

describe(managedUploadCount.name, () => {
  it("is the account's items less its external libraries' items", () => {
    expect(
      managedUploadCount({ images: 120, videos: 4 }, [
        { photos: 40, videos: 2 },
        { photos: 10, videos: 0 },
      ]),
    ).toBe(72);
  });

  it('is everything when the account has no external library', () => {
    expect(managedUploadCount({ images: 3, videos: 1 }, [])).toBe(4);
  });

  it('never goes below zero', () => {
    expect(managedUploadCount({ images: 1, videos: 0 }, [{ photos: 5, videos: 0 }])).toBe(0);
  });
});

describe(formatHistoryDate.name, () => {
  it("uses the template's short date", () => {
    expect(formatHistoryDate('2026-09-23T12:00:00.000Z', 'en-US')).toBe('Sep 23, 2026');
  });
});
