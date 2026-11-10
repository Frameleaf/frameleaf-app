/**
 * Frameleaf Cloud landing (FL-367): "What you need for each feature", worked out from what this
 * server has. Kept apart from the drawing so it can be tested on its own.
 *
 * Cloud Backup uses the live grant's account scope; unknown never becomes "have" from a key kind.
 */
import { LicenseKind } from '@frameleaf/sdk';

export type NeedState = 'have' | 'not' | 'always' | 'partly' | 'unknown';
export type NeedId = 'apps' | 'remote' | 'cloud_backup' | 'buddy_backup' | 'processing' | 'everything';

export const cloudNeeds = ({
  off,
  linked,
  hasPlan,
  licence,
  backupScope,
}: {
  off: boolean;
  linked: boolean;
  hasPlan: boolean;
  licence: LicenseKind | null;
  backupScope?: 'unknown' | 'none' | 'all' | 'users';
}): { id: NeedId; state: NeedState }[] => {
  const on = (have: boolean): NeedState => (!off && have ? 'have' : 'not');
  return [
    { id: 'apps', state: on(linked) },
    { id: 'remote', state: on(linked && hasPlan) },
    {
      id: 'cloud_backup',
      state:
        off || !linked || !hasPlan
          ? 'not'
          : backupScope === 'all'
            ? 'have'
            : backupScope === 'users'
              ? 'partly'
              : backupScope === 'none'
                ? 'not'
                : 'unknown',
    },
    { id: 'buddy_backup', state: on(linked && licence === LicenseKind.Server) },
    { id: 'processing', state: on(linked) },
    { id: 'everything', state: 'always' },
  ];
};
