/**
 * FL-792: each phone's backup receipt, after the prototype's `backup-receipt.mjs` (FL-766). The
 * phone reports how many items it holds (`phoneItemCount`) and why items wait (`pendingReasons`,
 * free-string codes); the server adds its latest completed check (`lastCheck`). The check's counts
 * reach only a session that may see every item (FL-771), so a phone whose check is withheld is
 * `locked`, never "not checked".
 */
import { getAuthStatus, getBackupDeviceReceipt, isHttpError, type BackupDeviceDto } from '@frameleaf/sdk';

export type ReceiptState = 'locked' | 'never' | 'missing' | 'stale' | 'safe';

/** A last check older than this many days asks for the app to be opened. */
export const STALE_DAYS = 7;

/** The waiting reasons with their own words; any other code reads as plain "Waiting". */
export const REASONS = [
  'wifi',
  'charging',
  'low_power',
  'home_or_direct',
  'icloud_original',
  'too_large',
  'skipped_deleted',
  'error',
  'not_on_server',
] as const;
export type ReasonKey = (typeof REASONS)[number] | 'unknown';

/** Spellings the phones may send (`low-power`, `lowPower`, `low_power`) all reach one reason. */
const ALIASES: Record<string, ReasonKey> = {
  ...Object.fromEntries(REASONS.map((key) => [key.replaceAll('_', ''), key])),
  icloudoriginals: 'icloud_original',
  icloud: 'icloud_original',
  home: 'home_or_direct',
  lowpowermode: 'low_power',
  deleted: 'skipped_deleted',
};
export const reasonKey = (code: string): ReasonKey =>
  ALIASES[code.toLowerCase().replaceAll(/[^a-z0-9]/g, '')] ?? 'unknown';

export type ReceiptReason = { key: ReasonKey; count: number };

/**
 * The reasons as rows: one per reason (codes that spell the same reason are added together), and
 * "Not on the server" from the last check when the phone did not report it itself.
 */
export const receiptReasons = (phone: BackupDeviceDto): ReceiptReason[] => {
  const rows = new Map<ReasonKey, number>();
  for (const { code, count } of phone.pendingReasons ?? []) {
    if (count > 0) {
      const key = reasonKey(code);
      rows.set(key, (rows.get(key) ?? 0) + count);
    }
  }
  const missing = phone.lastCheck?.itemsMissing ?? 0;
  if (missing > 0 && !rows.has('not_on_server')) {
    rows.set('not_on_server', missing);
  }
  return [...rows].map(([key, count]) => ({ key, count }));
};

export const waitingTotal = (phone: BackupDeviceDto) =>
  receiptReasons(phone).reduce((total, reason) => total + reason.count, 0);

/** What the server proved is there: checked minus missing, or nothing before a check. */
export const serverVerified = (phone: BackupDeviceDto) =>
  phone.lastCheck ? Math.max(0, phone.lastCheck.itemsChecked - phone.lastCheck.itemsMissing) : null;

export const daysSinceCheck = (phone: BackupDeviceDto, now = Date.now()) =>
  phone.lastCheck ? Math.max(0, Math.floor((now - Date.parse(phone.lastCheck.completedAt)) / 86_400_000)) : null;

export const receiptState = (phone: BackupDeviceDto, scoped: boolean, now = Date.now()): ReceiptState => {
  if (!phone.lastCheck) {
    return scoped ? 'never' : 'locked';
  }
  if (phone.lastCheck.itemsMissing > 0) {
    return 'missing';
  }
  return (daysSinceCheck(phone, now) ?? 0) > STALE_DAYS ? 'stale' : 'safe';
};

/** Worst first: what the page's answer is about. */
const SEVERITY: ReceiptState[] = ['missing', 'stale', 'never', 'locked', 'safe'];
export const worstFirst = <T extends { state: ReceiptState }>(rows: T[]) =>
  [...rows].sort((a, b) => SEVERITY.indexOf(a.state) - SEVERITY.indexOf(b.state));

/**
 * Whether this session sees check counts: an unlocked (elevated) session without hidden-content
 * filters. Elevation comes from the session status; the filters only show as a refused receipt, so
 * one of the account's own phones without a check is asked for its receipt.
 */
export const receiptScope = async (probeId?: string): Promise<boolean> => {
  try {
    const { isElevated } = await getAuthStatus();
    if (!isElevated) {
      return false;
    }
  } catch {
    return false;
  }
  if (!probeId) {
    return true;
  }
  try {
    await getBackupDeviceReceipt({ id: probeId });
    return true;
  } catch (error) {
    return !(isHttpError(error) && error.status === 403);
  }
};
