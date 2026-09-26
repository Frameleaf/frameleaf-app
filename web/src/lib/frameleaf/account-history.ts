import {
  AdminAuditAction,
  type AssetStatsResponseDto,
  type LibraryStatsResponseDto,
  type UserAdminHistoryEventResponseDto,
} from '@immich/sdk';
import type { MessageFormatter } from 'svelte-i18n';

/**
 * The account detail's Activity and Libraries tabs (FL-76), ported from the design template's
 * `Activity({ events })` and account `libraries` tab (`design/frameleaf/template/src/AccountsLibraries.jsx`).
 */

/** Events fetched per page of the Activity tab. */
export const HISTORY_PAGE_SIZE = 50;

/**
 * The sentence an Activity entry leads with, in the template's wording. `detail` carries the
 * specifics the server recorded (a quota in bytes, a storage label, a recovery period in days, a
 * device name); it never holds a password or PIN.
 */
export const describeAdminEvent = (
  { action, detail }: Pick<UserAdminHistoryEventResponseDto, 'action' | 'detail'>,
  $t: MessageFormatter,
  formatBytes: (bytes: number) => string,
): string => {
  switch (action) {
    case AdminAuditAction.AccountCreated: {
      return $t('frameleaf_account_history_account_created');
    }
    case AdminAuditAction.AccountUpdated: {
      return $t('frameleaf_account_history_account_updated');
    }
    case AdminAuditAction.AdminGranted: {
      return $t('frameleaf_account_history_admin_granted');
    }
    case AdminAuditAction.AdminRevoked: {
      return $t('frameleaf_account_history_admin_revoked');
    }
    case AdminAuditAction.QuotaChanged: {
      const bytes = detail === null ? NaN : Number(detail);
      return Number.isFinite(bytes)
        ? $t('frameleaf_account_history_quota_changed', { values: { size: formatBytes(bytes) } })
        : $t('frameleaf_account_history_quota_unlimited');
    }
    case AdminAuditAction.StorageLabelChanged: {
      return detail
        ? $t('frameleaf_account_history_storage_label_changed', { values: { label: detail } })
        : $t('frameleaf_account_history_storage_label_automatic');
    }
    case AdminAuditAction.PasswordReset: {
      return detail === 'change-required'
        ? $t('frameleaf_account_history_password_reset_change_required')
        : $t('frameleaf_account_history_password_reset');
    }
    case AdminAuditAction.PinSet: {
      return $t('frameleaf_account_history_pin_set');
    }
    case AdminAuditAction.PinReset: {
      return $t('frameleaf_account_history_pin_reset');
    }
    case AdminAuditAction.SessionRevoked: {
      return detail
        ? $t('frameleaf_account_history_session_revoked', { values: { device: detail } })
        : $t('frameleaf_account_history_session_revoked_unknown');
    }
    case AdminAuditAction.PreferencesUpdated: {
      return $t('frameleaf_account_history_preferences_updated');
    }
    case AdminAuditAction.CastingDisabled: {
      return $t('frameleaf_account_history_casting_disabled');
    }
    case AdminAuditAction.CastingAllowed: {
      return $t('frameleaf_account_history_casting_allowed');
    }
    case AdminAuditAction.AccountDeleted: {
      const days = Number(detail);
      return Number.isSafeInteger(days) && days > 0
        ? $t('frameleaf_account_history_account_deleted', { values: { days } })
        : $t('frameleaf_account_history_account_deleted_unknown');
    }
    case AdminAuditAction.AccountRemovalScheduled: {
      return $t('frameleaf_account_history_account_removal_scheduled');
    }
    case AdminAuditAction.AccountRestored: {
      return $t('frameleaf_account_history_account_restored');
    }
    case AdminAuditAction.LibraryCreated: {
      return $t('frameleaf_account_history_library_created');
    }
    case AdminAuditAction.LibraryUpdated: {
      return $t('frameleaf_account_history_library_updated');
    }
    case AdminAuditAction.LibraryScanQueued: {
      return $t('frameleaf_account_history_library_scan_queued');
    }
    case AdminAuditAction.LibraryScanCancelled: {
      return $t('frameleaf_account_history_library_scan_cancelled');
    }
    case AdminAuditAction.LibraryDeleted: {
      return $t('frameleaf_account_history_library_deleted');
    }
    // FL-155..FL-158: Frameleaf Cloud link, licence and Frameleaf account events.
    case AdminAuditAction.CloudLinked: {
      return detail
        ? $t('frameleaf_account_history_cloud_linked', { values: { account: detail } })
        : $t('frameleaf_account_history_cloud_linked_unknown');
    }
    case AdminAuditAction.CloudUnlinked: {
      return $t('frameleaf_account_history_cloud_unlinked');
    }
    case AdminAuditAction.CloudRevoked: {
      return $t('frameleaf_account_history_cloud_revoked');
    }
    case AdminAuditAction.CloudPermissionsChanged: {
      return $t('frameleaf_account_history_cloud_permissions_changed');
    }
    case AdminAuditAction.CloudKeyRecoveryRotation: {
      return $t('frameleaf_account_history_cloud_key_recovery_rotation');
    }
    case AdminAuditAction.LicenseActivated: {
      return detail === 'file' || !detail
        ? $t('frameleaf_account_history_license_file_installed')
        : $t('frameleaf_account_history_license_activated', { values: { hint: detail } });
    }
    case AdminAuditAction.LicenseRemoved: {
      return $t('frameleaf_account_history_license_removed');
    }
    case AdminAuditAction.FrameleafAccountLinked: {
      return $t('frameleaf_account_history_frameleaf_account_linked');
    }
    case AdminAuditAction.FrameleafAccountUnlinked: {
      return $t('frameleaf_account_history_frameleaf_account_unlinked');
    }
    default: {
      // an action from a newer server this client does not know yet
      return $t('frameleaf_account_history_other');
    }
  }
};

/** The template's short date (`Sep 23, 2026`), in the viewer's locale. */
export const formatHistoryDate = (value: string, locale?: string) =>
  new Date(value).toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });

/**
 * Photos and videos in the account's managed uploads: everything the account owns, less what its
 * external libraries hold. Both counts come from the existing admin statistics, which leave out
 * Locked, hidden and trashed items the same way, so the difference is the uploads alone.
 */
export const managedUploadCount = (
  statistics: Pick<AssetStatsResponseDto, 'images' | 'videos'>,
  externalLibraries: Array<Pick<LibraryStatsResponseDto, 'photos' | 'videos'>>,
) => {
  const external = externalLibraries.reduce((sum, library) => sum + library.photos + library.videos, 0);
  return Math.max(0, statistics.images + statistics.videos - external);
};
