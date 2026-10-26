/**
 * Frameleaf Cloud landing (FL-367): "What you need for each feature", worked out from what this
 * server has. Kept apart from the drawing so it can be tested on its own.
 *
 * The Cloud Backup and Buddy Backup rows do not say a licence turns them on: that depends on what
 * Frameleaf Cloud puts in the licence (FC-147/FC-148), so they point to Backup until it does.
 */
import { LicenseKind } from '@frameleaf/sdk';

export type NeedState = 'have' | 'not' | 'always' | 'partly';
export type NeedId = 'apps' | 'remote' | 'cloud_backup' | 'buddy_backup' | 'processing' | 'everything';

export const cloudNeeds = ({
  off,
  linked,
  hasPlan,
  licence,
}: {
  off: boolean;
  linked: boolean;
  hasPlan: boolean;
  licence: LicenseKind | null;
}): { id: NeedId; state: NeedState }[] => {
  const on = (have: boolean): NeedState => (!off && have ? 'have' : 'not');
  return [
    { id: 'apps', state: on(linked) },
    { id: 'remote', state: on(linked && hasPlan) },
    {
      id: 'cloud_backup',
      state: off || !linked || !hasPlan ? 'not' : licence === LicenseKind.Individual ? 'partly' : 'have',
    },
    { id: 'buddy_backup', state: on(linked && licence === LicenseKind.Server) },
    { id: 'processing', state: on(linked) },
    { id: 'everything', state: 'always' },
  ];
};
