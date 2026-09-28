<script lang="ts">
  /**
   * People & sharing (FL-71 CC-52/53/54): the prototype's sharing workspace
   * (`design/frameleaf/template/src/SharingAccess.jsx:180-403`) — "Recognition groups" and "Partner
   * libraries", each with its intro and primary action, a list of accounts, invitations, and titled
   * Frameleaf dialogs — in place of the upstream Card/Button page, `PartnerSelectionModal`,
   * `ClusterGroup*Modal` and generic `showDialog` confirms.
   *
   * Everything it did is kept: recognition group members, leaving, invitations sent and received
   * (review with the group's members, accept, decline, cancel), re-running face recognition, and
   * per-partner "Show in timeline" and the fork's location sharing.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    acceptClusterGroupRequest,
    clusterGroupRegeneratePeople,
    createClusterGroupRequest,
    createPartner,
    deleteClusterGroupRequest,
    getClusterGroupRequests,
    getClusterGroupRequestsForGroup,
    getClusterGroupUsers,
    getMyUser,
    getPartners,
    leaveClusterGroup,
    PartnerDirection,
    removePartner,
    searchUsers,
    updatePartner,
    type ClusterGroupRequestResponseDto,
    type PartnerResponseDto,
    type UserResponseDto,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type PartnerSharing = {
    user: UserResponseDto;
    sharedByMe: boolean;
    sharedWithMe: boolean;
    inTimeline: boolean;
    /** my setting towards this partner; meaningful only when `sharedByMe` */
    shareLocation: boolean;
  };

  let clusterGroupId: string = $state('');
  let members: UserResponseDto[] = $state([]);
  let sentRequests: ClusterGroupRequestResponseDto[] = $state([]);
  let receivedRequests: ClusterGroupRequestResponseDto[] = $state([]);
  let accounts: UserResponseDto[] = $state([]);
  // The accounts to add or invite load on their own, so a recognition group that fails to load
  // never blocks adding a partner.
  let accountsStatus = $state<'loading' | 'loaded' | 'error'>('loading');
  const byId = $derived(Object.fromEntries(accounts.map((user) => [user.id, user])));
  let partners: PartnerSharing[] = $state([]);
  let notice = $state('');

  const me = $derived(authManager.user.id);
  const canLeave = $derived(members.length > 1);

  const inviteChoices = $derived(
    accounts.filter(
      (user) =>
        user.id !== me &&
        members.every(({ id }) => id !== user.id) &&
        sentRequests.every(({ userId }) => userId !== user.id),
    ),
  );
  const partnerChoices = $derived(
    accounts.filter((user) => user.id !== me && partners.every((p) => !(p.user.id === user.id && p.sharedByMe))),
  );

  type DialogState =
    | { kind: 'invite'; userId: string }
    | { kind: 'partner-add'; userId: string }
    | { kind: 'review'; request: ClusterGroupRequestResponseDto; members?: UserResponseDto[] };
  let dialog = $state<DialogState | null>(null);
  let dialogOpen = $state(false);
  let working = $state(false);
  $effect(() => {
    if (!dialogOpen) {
      dialog = null;
    }
  });
  const openDialog = (next: DialogState) => {
    dialog = next;
    dialogOpen = true;
  };
  const name = (user?: UserResponseDto, fallback = '') => user?.name ?? fallback;

  onMount(async () => {
    await Promise.all([refresh(), refreshPartners(), loadAccounts()]);
  });

  const loadAccounts = async () => {
    accountsStatus = 'loading';
    try {
      accounts = await searchUsers();
      accountsStatus = 'loaded';
    } catch (error) {
      accountsStatus = 'error';
      handleError(error, $t('frameleaf_people_sharing.accounts_error'));
    }
  };

  const refresh = async () => {
    try {
      const { clusterGroupId: id } = await getMyUser();
      clusterGroupId = id;

      const [groupUsers, sent, received] = await Promise.all([
        getClusterGroupUsers({ id }),
        getClusterGroupRequestsForGroup({ id }),
        getClusterGroupRequests(),
      ]);

      members = groupUsers;
      sentRequests = sent;
      receivedRequests = received;
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_cluster_group'));
    }
  };

  const refreshPartners = async () => {
    let sharedBy: PartnerResponseDto[];
    let sharedWith: PartnerResponseDto[];
    try {
      [sharedBy, sharedWith] = await Promise.all([
        getPartners({ direction: PartnerDirection.SharedBy }),
        getPartners({ direction: PartnerDirection.SharedWith }),
      ]);
    } catch (error) {
      handleError(error, $t('frameleaf_people_sharing.partners_error'));
      return;
    }

    const next: PartnerSharing[] = sharedBy.map((candidate) => ({
      user: candidate,
      sharedByMe: true,
      sharedWithMe: false,
      inTimeline: candidate.inTimeline ?? false,
      shareLocation: candidate.shareLocation ?? true,
    }));
    for (const candidate of sharedWith) {
      const existing = next.find((p) => p.user.id === candidate.id);
      if (existing) {
        existing.sharedWithMe = true;
        existing.inTimeline = candidate.inTimeline ?? false;
      } else {
        next.push({
          user: candidate,
          sharedByMe: false,
          sharedWithMe: true,
          inTimeline: candidate.inTimeline ?? false,
          shareLocation: true,
        });
      }
    }
    partners = next;
  };

  const run = async (action: () => Promise<unknown>, done: string, errorKey: Translations) => {
    working = true;
    try {
      await action();
      notice = done;
      return true;
    } catch (error) {
      handleError(error, $t(errorKey));
      return false;
    } finally {
      working = false;
    }
  };

  const confirmDialog = async () => {
    if (!dialog) {
      return;
    }
    const current = dialog;
    let ok: boolean;
    if (current.kind === 'invite') {
      ok = await run(
        () =>
          createClusterGroupRequest({ id: clusterGroupId, clusterGroupRequestCreateDto: { userId: current.userId } }),
        $t('frameleaf_people_sharing.invitation_sent'),
        'errors.something_went_wrong',
      );
      await refresh();
    } else if (current.kind === 'partner-add') {
      ok = await run(
        () => createPartner({ partnerCreateDto: { sharedWithId: current.userId } }),
        $t('frameleaf_people_sharing.partner_added'),
        'errors.unable_to_add_partners',
      );
      await refreshPartners();
    } else {
      ok = await run(
        () => acceptClusterGroupRequest({ id: current.request.id }),
        $t('frameleaf_people_sharing.invitation_accepted'),
        'errors.something_went_wrong',
      );
      await refresh();
    }
    if (ok) {
      dialogOpen = false;
    }
  };

  const reviewInvitation = async (request: ClusterGroupRequestResponseDto) => {
    openDialog({ kind: 'review', request });
    try {
      const groupMembers = await getClusterGroupUsers({ id: request.clusterGroupId });
      if (dialog?.kind === 'review' && dialog.request.id === request.id) {
        dialog = { ...dialog, members: groupMembers };
      }
    } catch (error) {
      handleError(error, $t('errors.unable_to_load_cluster_group'));
    }
  };

  const deleteRequest = async (request: ClusterGroupRequestResponseDto, done: string) => {
    await run(() => deleteClusterGroupRequest({ id: request.id }), done, 'errors.something_went_wrong');
    await refresh();
  };

  const leave = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_people_sharing.leave_title'),
      prompt: $t('leave_group_description'),
      confirmText: $t('frameleaf_people_sharing.leave_action'),
      danger: true,
    });
    if (confirmed) {
      await run(
        () => leaveClusterGroup({ id: clusterGroupId }),
        $t('frameleaf_people_sharing.left'),
        'errors.unable_to_leave_cluster_group',
      );
      await refresh();
    }
  };

  const rerunRecognition = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_people_sharing.rerun_title'),
      prompt: $t('cluster_group_facial_recognition_prompt'),
      confirmText: $t('frameleaf_people_sharing.rerun_action'),
      danger: true,
    });
    if (confirmed) {
      await run(
        () => clusterGroupRegeneratePeople({ id: clusterGroupId }),
        $t('frameleaf_people_sharing.rerun_started'),
        'errors.something_went_wrong',
      );
    }
  };

  const stopSharing = async (partner: PartnerSharing) => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_people_sharing.stop_title'),
      prompt: $t('frameleaf_people_sharing.stop_prompt', { values: { name: partner.user.name } }),
      confirmText: $t('frameleaf_people_sharing.stop_action'),
      danger: true,
    });
    if (confirmed) {
      const stopped = await run(
        () => removePartner({ id: partner.user.id }),
        $t('frameleaf_people_sharing.stopped'),
        'errors.unable_to_remove_partner',
      );
      if (stopped) {
        // FL-54: this tab's open pages drop the partner at once, as the server tells other tabs.
        eventManager.emit('PartnerRevoke', { sharedById: authManager.user.id, sharedWithId: partner.user.id });
      }
      await refreshPartners();
    }
  };

  const setInTimeline = async (partner: PartnerSharing, inTimeline: boolean) => {
    try {
      await updatePartner({ id: partner.user.id, partnerUpdateDto: { inTimeline } });
      partner.inTimeline = inTimeline;
      notice = $t('frameleaf_people_sharing.timeline_updated');
    } catch (error) {
      partner.inTimeline = !inTimeline;
      handleError(error, $t('errors.unable_to_update_timeline_display_status'));
    }
  };

  const setShareLocation = async (partner: PartnerSharing, shareLocation: boolean) => {
    try {
      await updatePartner({ id: partner.user.id, partnerUpdateDto: { shareLocation } });
      partner.shareLocation = shareLocation;
    } catch (error) {
      partner.shareLocation = !shareLocation;
      handleError(error, $t('errors.unable_to_change_partner_permission'));
    }
  };

  const dialogTitle = $derived(
    dialog?.kind === 'invite'
      ? $t('frameleaf_people_sharing.invite_title')
      : dialog?.kind === 'partner-add'
        ? $t('frameleaf_people_sharing.partner_add_title')
        : $t('frameleaf_people_sharing.review_title'),
  );
  const selectId = $props.id();
</script>

<div class="cc-sharing-workspace">
  {#if notice}
    <p role="status" class="cc-notice">{notice}</p>
  {/if}

  <section aria-labelledby="{selectId}-groups">
    <div class="cc-sharing-intro">
      <div>
        <h3 id="{selectId}-groups">{$t('frameleaf_people_sharing.groups_title')}</h3>
        <p>{$t('frameleaf_people_sharing.groups_description')}</p>
      </div>
      <button
        type="button"
        class="button primary"
        disabled={inviteChoices.length === 0}
        onclick={() => openDialog({ kind: 'invite', userId: inviteChoices[0]?.id ?? '' })}
      >
        {$t('frameleaf_people_sharing.invite')}
      </button>
    </div>
    <div class="cc-sharing-list">
      {#each members as user (user.id)}
        <article>
          <UserAvatar {user} size="md" noTitle />
          <div>
            <strong>{user.name}</strong>
            <p>
              {user.id === me ? $t('frameleaf_people_sharing.your_account') : $t('frameleaf_people_sharing.member')}
              · {user.email}
            </p>
          </div>
        </article>
      {/each}
    </div>
    <div class="cc-section-action">
      <button type="button" class="button" disabled={working} onclick={rerunRecognition}>
        {$t('frameleaf_people_sharing.rerun_action')}
      </button>
      <button type="button" class="button" disabled={!canLeave || working} onclick={leave}>
        {$t('frameleaf_people_sharing.leave_action')}
      </button>
    </div>

    <h3>{$t('frameleaf_people_sharing.invitations')}</h3>
    {#each receivedRequests as request (request.id)}
      <div class="cc-sharing-request">
        <span>
          <strong>{$t('frameleaf_people_sharing.invitation_received')}</strong>
          <small>{$t('request_received_description')}</small>
        </span>
        <button type="button" class="button" onclick={() => reviewInvitation(request)}>
          {$t('frameleaf_people_sharing.review_action')}
        </button>
        <button
          type="button"
          class="button"
          disabled={working}
          onclick={() => deleteRequest(request, $t('frameleaf_people_sharing.invitation_declined'))}
        >
          {$t('frameleaf_people_sharing.decline')}
        </button>
      </div>
    {/each}
    {#each sentRequests as request (request.id)}
      <div class="cc-sharing-request">
        <span>
          <strong>{name(byId[request.userId], request.userId)}</strong>
          <small>{$t('frameleaf_people_sharing.awaiting')}</small>
        </span>
        <button
          type="button"
          class="button"
          disabled={working}
          onclick={() => deleteRequest(request, $t('frameleaf_people_sharing.invitation_cancelled'))}
        >
          {$t('frameleaf_people_sharing.cancel_invitation')}
        </button>
      </div>
    {/each}
    {#if receivedRequests.length === 0 && sentRequests.length === 0}
      <p class="cc-subtle">{$t('frameleaf_people_sharing.no_invitations')}</p>
    {/if}
  </section>

  <section aria-labelledby="{selectId}-partners">
    <div class="cc-sharing-intro">
      <div>
        <h3 id="{selectId}-partners">{$t('frameleaf_people_sharing.partners_title')}</h3>
        <p>{$t('frameleaf_people_sharing.partners_description')}</p>
      </div>
      <button
        type="button"
        class="button primary"
        disabled={partnerChoices.length === 0}
        onclick={() => openDialog({ kind: 'partner-add', userId: partnerChoices[0]?.id ?? '' })}
      >
        {$t('add_partner')}
      </button>
    </div>
    {#if accountsStatus === 'error'}
      <p class="cc-error" role="alert">
        {$t('frameleaf_people_sharing.accounts_error')}
        <button type="button" class="button" onclick={loadAccounts}>{$t('retry')}</button>
      </p>
    {/if}
    <div class="cc-sharing-list">
      {#each partners as partner (partner.user.id)}
        <article>
          <UserAvatar user={partner.user} size="md" noTitle />
          <div>
            <strong>{partner.user.name}</strong>
            <p>
              {partner.sharedByMe
                ? $t('frameleaf_people_sharing.can_see_yours')
                : $t('frameleaf_people_sharing.not_sharing_with')}
              ·
              {partner.sharedWithMe
                ? $t('frameleaf_people_sharing.shares_with_you')
                : $t('frameleaf_people_sharing.does_not_share')}
            </p>
            {#if partner.sharedWithMe}
              <SettingToggle
                title={$t('frameleaf_people_sharing.in_timeline')}
                bind:checked={partner.inTimeline}
                onToggle={(checked) => setInTimeline(partner, checked)}
              />
            {/if}
            {#if partner.sharedByMe}
              <SettingToggle
                title={$t('frameleaf_sharing.share_location_title')}
                subtitle={$t('frameleaf_sharing.share_location_description', { values: { name: partner.user.name } })}
                bind:checked={partner.shareLocation}
                onToggle={(checked) => setShareLocation(partner, checked)}
              />
              {#if !partner.shareLocation}
                <p>{$t('frameleaf_sharing.location_already_seen', { values: { name: partner.user.name } })}</p>
              {/if}
            {/if}
          </div>
          {#if partner.sharedByMe}
            <button type="button" class="button" disabled={working} onclick={() => stopSharing(partner)}>
              {$t('frameleaf_people_sharing.stop_action')}
            </button>
          {/if}
        </article>
      {:else}
        <p class="cc-subtle">{$t('frameleaf_people_sharing.no_partners')}</p>
      {/each}
    </div>
  </section>
</div>

{#if dialog}
  <Dialog title={dialogTitle} closeLabel={$t('close')} bind:open={dialogOpen}>
    {#if dialog.kind === 'invite' || dialog.kind === 'partner-add'}
      {@const choices = dialog.kind === 'invite' ? inviteChoices : partnerChoices}
      <label class="field" for={selectId}>
        {$t('frameleaf_people_sharing.account')}
        <select id={selectId} bind:value={dialog.userId} data-initial-focus>
          {#each choices as user (user.id)}
            <option value={user.id}>{user.name} · {user.email}</option>
          {/each}
        </select>
      </label>
      <p>
        {dialog.kind === 'partner-add'
          ? $t('frameleaf_people_sharing.partner_add_body', { values: { name: name(byId[dialog.userId]) } })
          : $t('frameleaf_people_sharing.invite_body')}
      </p>
    {:else if dialog.kind === 'review'}
      <p>
        {dialog.members
          ? $t('frameleaf_people_sharing.review_body', {
              values: { members: dialog.members.map((user) => user.name).join(', ') },
            })
          : $t('loading')}
      </p>
    {/if}
    {#snippet actions()}
      <button type="button" class="button" onclick={() => (dialogOpen = false)}>{$t('cancel')}</button>
      <button
        type="button"
        class="button primary"
        disabled={working || (dialog?.kind !== 'review' && !dialog?.userId)}
        onclick={confirmDialog}
      >
        {dialog?.kind === 'review' ? $t('frameleaf_people_sharing.accept') : $t('confirm')}
      </button>
    {/snippet}
  </Dialog>
{/if}

<style>
  /* design/frameleaf/template/src/command-center.css `.cc-sharing-*`. */
  .cc-sharing-workspace {
    padding-bottom: 20px;
  }
  h3 {
    font-size: 14px;
    margin: 12px 0;
  }
  .cc-sharing-intro,
  .cc-sharing-list article,
  .cc-sharing-request {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 0;
  }
  .cc-sharing-intro p,
  .cc-sharing-list p {
    margin: 0;
    font-size: 12px;
    color: var(--fl-muted);
    line-height: 1.6;
  }
  .cc-sharing-intro > div,
  .cc-sharing-list article > div,
  .cc-sharing-request > span {
    flex: 1;
    min-width: 0;
  }
  .cc-sharing-list article,
  .cc-sharing-request {
    border-top: 1px solid var(--fl-border);
  }
  .cc-sharing-list strong {
    font-size: 13px;
  }
  .cc-sharing-request small {
    display: block;
    color: var(--fl-muted);
    margin-top: 6px;
  }
  .cc-section-action {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    padding: 8px 0;
  }
  .cc-subtle {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cc-error {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 0 8px;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .cc-notice {
    margin: 0 0 8px;
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
  }
  .field {
    display: grid;
    gap: 6px;
    margin-bottom: 12px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field select {
    min-height: 34px;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 6px 9px;
    font: inherit;
  }
  @media (max-width: 700px) {
    .cc-sharing-intro,
    .cc-sharing-request,
    .cc-sharing-list article {
      flex-wrap: wrap;
    }
    .cc-sharing-list article > div {
      min-width: 70%;
    }
  }
</style>
