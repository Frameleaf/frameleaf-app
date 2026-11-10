/**
 * FL-792: the receipt in words, shared by Tools › Phones and the administrator's phone list. Each
 * takes the page's `$t` so the strings stay in i18n/en.json.
 */
import type { BackupDeviceDto } from '@frameleaf/sdk';
import type { Translations } from 'svelte-i18n';
import {
  daysSinceCheck,
  pendingUploads,
  serverVerified,
  waitingTotal,
  type ReasonKey,
  type ReceiptState,
} from '$lib/frameleaf/backup-receipt';

type T = (key: Translations, options?: { values?: Record<string, string | number> }) => string;

/** "12,348 on this phone · 12,340 safely on the server · 8 waiting", without guessing. */
export const receiptLine = (t: T, phone: BackupDeviceDto, state: ReceiptState) => {
  const verified = serverVerified(phone);
  const waiting = waitingTotal(phone, state !== 'locked');
  const parts = [
    phone.phoneItemCount === null
      ? t('frameleaf_phones_receipt_phone_unknown')
      : t('frameleaf_phones_receipt_on_phone', { values: { count: phone.phoneItemCount } }),
    state === 'locked'
      ? t('frameleaf_phones_receipt_server_locked')
      : verified === null
        ? t('frameleaf_phones_receipt_server_unknown')
        : t('frameleaf_phones_receipt_on_server', { values: { count: verified } }),
  ];
  if (waiting > 0) {
    parts.push(t('frameleaf_phones_receipt_waiting', { values: { count: waiting } }));
  }
  return parts.join(' · ');
};

export const receiptHeadline = (t: T, phone: BackupDeviceDto, state: ReceiptState) => {
  const values = { phone: phone.displayName, count: 0 };
  switch (state) {
    case 'locked': {
      return { title: t('frameleaf_phones_receipt_locked'), body: t('frameleaf_phones_receipt_locked_body') };
    }
    case 'never': {
      return { title: t('frameleaf_phones_receipt_never'), body: t('frameleaf_phones_receipt_never_body', { values }) };
    }
    case 'missing': {
      values.count = phone.lastCheck?.itemsMissing ?? 0;
      return {
        title: t('frameleaf_phones_receipt_missing', { values }),
        body: t('frameleaf_phones_receipt_missing_body', { values }),
      };
    }
    case 'waiting': {
      values.count = pendingUploads(phone);
      return {
        title: t('frameleaf_phones_receipt_waiting_title', { values }),
        body: t('frameleaf_phones_receipt_waiting_body', { values }),
      };
    }
    case 'stale': {
      values.count = daysSinceCheck(phone) ?? 0;
      return {
        title: t('frameleaf_phones_receipt_stale', { values }),
        body: t('frameleaf_phones_receipt_stale_body', { values }),
      };
    }
    default: {
      return { title: t('frameleaf_phones_receipt_safe'), body: t('frameleaf_phones_receipt_safe_body') };
    }
  }
};

/** The short status beside a phone in a list. */
export const receiptStatus = (t: T, phone: BackupDeviceDto, state: ReceiptState) => {
  switch (state) {
    case 'locked': {
      return t('frameleaf_phones_status_locked');
    }
    case 'never': {
      return t('frameleaf_phones_receipt_never');
    }
    case 'missing': {
      return t('frameleaf_phones_status_missing', { values: { count: phone.lastCheck?.itemsMissing ?? 0 } });
    }
    case 'waiting': {
      return t('frameleaf_phones_status_waiting', { values: { count: pendingUploads(phone) } });
    }
    case 'stale': {
      return t('frameleaf_phones_status_stale', { values: { count: daysSinceCheck(phone) ?? 0 } });
    }
    default: {
      return t('frameleaf_phones_status_safe');
    }
  }
};

export const receiptTone = (state: ReceiptState) =>
  state === 'safe' ? 'good' : state === 'missing' || state === 'stale' ? 'warn' : 'off';

/** "Checked 3 hours ago" or "No check yet"; nothing while the check is withheld. */
export const checkedWords = (t: T, phone: BackupDeviceDto, state: ReceiptState, ago: (iso: string) => string) =>
  state === 'locked'
    ? undefined
    : phone.lastCheck
      ? t('frameleaf_phones_checked', { values: { ago: ago(phone.lastCheck.completedAt) } })
      : t('frameleaf_phones_no_check');

export const reasonName = (t: T, key: ReasonKey) => t(`frameleaf_backup_reason_${key}` as Translations);
export const reasonBody = (t: T, key: ReasonKey) => t(`frameleaf_backup_reason_${key}_body` as Translations);
