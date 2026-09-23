/**
 * The settings change history (FL-66), the design template's "Change history" area of
 * `CommandCenter.jsx`. The server keeps the history (every administrator sees the same record);
 * this module only turns a recorded change into what the history shows. Values arrive JSON
 * encoded and already redacted by the server; credentials never have a value, only whether they
 * were replaced or cleared.
 */
import type { SystemConfigHistoryChangeDto, SystemConfigHistoryCredentialChange } from '@immich/sdk';
import { reviewValue, type ReviewValue } from '$lib/frameleaf/system-config-draft';

export type HistoryValue = ReviewValue | { kind: 'credential'; change: SystemConfigHistoryCredentialChange };

const decode = (text: string | null): unknown => {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // A value the server shortened is no longer valid JSON; show it as text.
    return text;
  }
};

/** How one side of a recorded change is shown. */
export const historyValue = (change: SystemConfigHistoryChangeDto, side: 'before' | 'after'): HistoryValue => {
  if (change.credential) {
    return side === 'before' ? { kind: 'secret' } : { kind: 'credential', change: change.credential };
  }
  return reviewValue(change.path, decode(side === 'before' ? change.before : change.after));
};
