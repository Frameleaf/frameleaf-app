import {
  getSharedSpaceHouseholds,
  inviteSharedSpaceHouseholdMember,
  removeSharedSpaceHouseholdMember,
  updateSharedSpaceHouseholdMember,
  type HouseholdDirectoryEntryDto,
  type HouseholdShareLinkDto,
  type HouseholdShareMemberDto,
} from '@frameleaf/sdk';

export type HouseholdCandidate = HouseholdDirectoryEntryDto & { linkId: string; householdName: string };
export type HouseholdMember = HouseholdShareMemberDto & { linkId: string; householdName: string; reachable: boolean };

/**
 * A space's people from linked households, shared by the two places the Share sheet shows them
 * (the "Other households" picker and the rows under "Who has access"). Only a space's owner can
 * read this; for anyone else the load fails quietly and neither place appears.
 *
 * Names and pictures only: the API has no address for these people and none is ever stored here.
 */
export class HouseholdShareState {
  links = $state<HouseholdShareLinkDto[]>([]);
  loaded = $state(false);
  busy = $state(false);
  said = $state('');

  private readonly spaceId: string;
  private readonly onChanged?: () => Promise<void> | void;

  /** `onChanged` runs after a change, so the page around the sheet can re-read who the space is shared with. */
  constructor(spaceId: string, onChanged?: () => Promise<void> | void) {
    this.spaceId = spaceId;
    this.onChanged = onChanged;
  }

  members = $derived<HouseholdMember[]>(
    this.links.flatMap(({ linkId, householdName, members, reachable }) =>
      members.map((member) => ({ ...member, linkId, householdName, reachable })),
    ),
  );

  /** Everyone not already in the space. Someone who left can be invited again. */
  candidates = $derived<HouseholdCandidate[]>(
    this.links.flatMap(({ linkId, householdName, directory, members }) =>
      directory
        .filter(({ id }) => members.every((member) => member.remoteUserId !== id || member.state === 'left'))
        .map((entry) => ({ ...entry, linkId, householdName })),
    ),
  );

  async load() {
    try {
      this.links = (await getSharedSpaceHouseholds({ id: this.spaceId })) ?? [];
      this.loaded = true;
    } catch {
      this.links = [];
      this.loaded = false;
    }
  }

  private async run(work: () => Promise<unknown>) {
    this.busy = true;
    try {
      await work();
      await this.load();
      await this.onChanged?.();
    } finally {
      this.busy = false;
    }
  }

  invite(candidate: HouseholdCandidate, role: string) {
    return this.run(() =>
      inviteSharedSpaceHouseholdMember({
        id: this.spaceId,
        householdShareInviteDto: { linkId: candidate.linkId, remoteUserId: candidate.id, role },
      }),
    );
  }

  setRole(member: HouseholdMember, role: string) {
    return this.run(() =>
      updateSharedSpaceHouseholdMember({
        id: this.spaceId,
        shareId: member.shareId,
        remoteUserId: member.remoteUserId,
        householdShareRoleDto: { role },
      }),
    );
  }

  remove(member: HouseholdMember) {
    return this.run(() =>
      removeSharedSpaceHouseholdMember({
        id: this.spaceId,
        shareId: member.shareId,
        remoteUserId: member.remoteUserId,
      }),
    );
  }
}
