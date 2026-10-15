<script lang="ts">
  /**
   * People & sharing in plain words (FL-368), after the approved prototype
   * (`settings-v2/server/sharing.jsx`): who you share with as one answer, partner libraries with a
   * sentence each way, sharing face recognition with family, the account's sharing groups, and, for
   * an administrator, whether people can find each other when sharing.
   *
   * Everything the page did before is kept: partners and how far the first copy has come (FL-326),
   * recognition group members, leaving, invitations sent and received (review with the group's
   * members, accept, decline, cancel) and starting face recognition again. That last action erases
   * every name, so it sits behind "Advanced", says so where it sits, and needs a tick before it runs.
   *
   * Left out because the app cannot do it yet: the partner timeline switch (gone since FL-326),
   * removing someone else from a recognition group, and "suggest matching people in shared Spaces".
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import RecipientGroupsDialog from '$lib/components/frameleaf/RecipientGroupsDialog.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Links from '$lib/components/frameleaf/settings/kit/Links.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { backfillProgress } from '$lib/frameleaf/partner-sharing';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Route } from '$lib/route';
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
    getRecipientGroups,
    leaveClusterGroup,
    PartnerDirection,
    removePartner,
    searchUsers,
    type ClusterGroupRequestResponseDto,
    type PartnerResponseDto,
    type RecipientGroupResponseDto,
    type UserResponseDto,
  } from '@frameleaf/sdk';
  import {
    mdiAccountGroupOutline,
    mdiAccountHeartOutline,
    mdiAccountMultipleOutline,
    mdiImageMultipleOutline,
    mdiLinkVariant,
  } from '@mdi/js';
  import { onDestroy, onMount } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  type PartnerSharing = {
    user: UserResponseDto;
    sharedByMe: boolean;
    sharedWithMe: boolean;
    /** The first copy of my library into theirs (FL-326). */
    backfill?: PartnerResponseDto['backfill'];
  };

  let alive = true;
  const isCurrentSession = authManager.captureSession();
  const isCurrentView = () => alive && isCurrentSession();
  onDestroy(() => {
    alive = false;
    dialogGeneration++;
  });
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
    | { kind: 'erase'; sure: boolean }
    | { kind: 'review'; request: ClusterGroupRequestResponseDto; members?: UserResponseDto[] };
  let dialog = $state<DialogState | null>(null);
  let dialogOpen = $state(false);
  let working = $state(false);
  let dialogGeneration = 0;
  $effect(() => {
    if (!dialogOpen) {
      dialog = null;
      dialogGeneration++;
    }
  });
  const openDialog = (next: DialogState) => {
    if (!isCurrentView()) {
      return;
    }
    dialogGeneration++;
    dialog = next;
    dialogOpen = true;
  };
  const name = (user?: UserResponseDto, fallback = '') => user?.name ?? fallback;

  onMount(async () => {
    await Promise.all([refresh(), refreshPartners(), loadAccounts(), loadGroups()]);
  });

  // The account's sharing groups: a shortcut for picking people, managed in their own dialog.
  let groups = $state<RecipientGroupResponseDto[] | null>(null);
  let groupsOpen = $state(false);
  let groupsRequest = 0;
  const loadGroups = async () => {
    if (!isCurrentView()) {
      return;
    }
    const request = ++groupsRequest;
    const current = () => isCurrentView() && request === groupsRequest;
    try {
      const result = await getRecipientGroups();
      if (current()) {
        groups = result;
      }
    } catch (error) {
      if (current()) {
        handleError(error, $t('frameleaf_sharing_groups_error'));
      }
    }
  };

  // Whether people can find each other is a server setting: an administrator changes it here (it is
  // saved with the settings bar); everyone else only meets its effect.
  const settingsDraft = getSystemConfigDraft();
  const findable = $derived(settingsDraft?.draft.server.publicUsers ?? serverConfigManager.value.publicUsers);
  /** A member on a server where people cannot find each other has nobody to choose. */
  const blocked = $derived(!authManager.user.isAdmin && !serverConfigManager.value.publicUsers);

  const listFormat = $derived(new Intl.ListFormat($locale ?? 'en', { style: 'long', type: 'conjunction' }));
  const list = (names: string[]) => listFormat.format(names);
  const mine = $derived(partners.filter((partner) => partner.sharedByMe).map((partner) => partner.user.name));
  const theirs = $derived(partners.filter((partner) => partner.sharedWithMe).map((partner) => partner.user.name));
  const family = $derived(members.filter((user) => user.id !== me));
  const invitation = $derived(receivedRequests[0]);

  const hero = $derived.by(() => {
    if (invitation) {
      return {
        tone: 'warn' as const,
        icon: mdiAccountHeartOutline,
        title: $t('frameleaf_sharing_hero_invited'),
        body: $t('frameleaf_sharing_hero_invited_body'),
      };
    }
    if (mine.length + theirs.length + family.length === 0) {
      return {
        tone: 'quiet' as const,
        icon: mdiAccountMultipleOutline,
        title: $t('frameleaf_sharing_hero_none'),
        body: $t('frameleaf_sharing_hero_none_body'),
      };
    }
    const parts = [
      mine.length > 0 && theirs.length > 0
        ? $t('frameleaf_sharing_hero_theirs_too', { values: { count: theirs.length, names: list(theirs) } })
        : '',
      mine.length === 0 && theirs.length > 0 ? $t('frameleaf_sharing_hero_not_mine') : '',
      family.length > 0
        ? $t('frameleaf_sharing_hero_family', { values: { names: list(family.map((user) => user.name)) } })
        : '',
    ];
    return {
      tone: 'good' as const,
      icon: mdiAccountMultipleOutline,
      title:
        mine.length > 0
          ? $t('frameleaf_sharing_hero_mine', { values: { names: list(mine) } })
          : theirs.length > 0
            ? $t('frameleaf_sharing_hero_theirs', { values: { count: theirs.length, names: list(theirs) } })
            : $t('frameleaf_sharing_hero_family_only', { values: { names: list(family.map((user) => user.name)) } }),
      body: parts.filter(Boolean).join(' '),
    };
  });

  let accountsRequest = 0;
  const loadAccounts = async () => {
    if (!isCurrentView()) {
      return;
    }
    const request = ++accountsRequest;
    const current = () => isCurrentView() && request === accountsRequest;
    accountsStatus = 'loading';
    try {
      const result = await searchUsers();
      if (current()) {
        accounts = result;
        accountsStatus = 'loaded';
      }
    } catch (error) {
      if (current()) {
        accountsStatus = 'error';
        handleError(error, $t('frameleaf_people_sharing.accounts_error'));
      }
    }
  };

  let groupRefreshRequest = 0;
  const refresh = async () => {
    if (!isCurrentView()) {
      return;
    }
    const request = ++groupRefreshRequest;
    const current = () => isCurrentView() && request === groupRefreshRequest;
    try {
      const { clusterGroupId: id } = await getMyUser();
      if (!current()) {
        return;
      }

      const [groupUsers, sent, received] = await Promise.all([
        getClusterGroupUsers({ id }),
        getClusterGroupRequestsForGroup({ id }),
        getClusterGroupRequests(),
      ]);

      if (current()) {
        clusterGroupId = id;
        members = groupUsers;
        sentRequests = sent;
        receivedRequests = received;
      }
    } catch (error) {
      if (current()) {
        handleError(error, $t('errors.unable_to_load_cluster_group'));
      }
    }
  };

  let partnerRefreshRequest = 0;
  const refreshPartners = async () => {
    if (!isCurrentView()) {
      return;
    }
    const request = ++partnerRefreshRequest;
    const current = () => isCurrentView() && request === partnerRefreshRequest;
    let sharedBy: PartnerResponseDto[];
    let sharedWith: PartnerResponseDto[];
    try {
      [sharedBy, sharedWith] = await Promise.all([
        getPartners({ direction: PartnerDirection.SharedBy }),
        getPartners({ direction: PartnerDirection.SharedWith }),
      ]);
    } catch (error) {
      if (current()) {
        handleError(error, $t('frameleaf_people_sharing.partners_error'));
      }
      return;
    }
    if (!current()) {
      return;
    }

    const next: PartnerSharing[] = sharedBy.map((candidate) => ({
      user: candidate,
      sharedByMe: true,
      sharedWithMe: false,
      backfill: candidate.backfill,
    }));
    for (const candidate of sharedWith) {
      const existing = next.find((p) => p.user.id === candidate.id);
      if (existing) {
        existing.sharedWithMe = true;
      } else {
        next.push({ user: candidate, sharedByMe: false, sharedWithMe: true });
      }
    }
    partners = next;
  };

  const run = async (action: () => Promise<unknown>, done: string, errorKey: Translations) => {
    if (!isCurrentView() || working) {
      return false;
    }
    working = true;
    try {
      await action();
      if (!isCurrentSession()) {
        return false;
      }
      if (alive) {
        notice = done;
      }
      return true;
    } catch (error) {
      if (isCurrentView()) {
        handleError(error, $t(errorKey));
      }
      return false;
    } finally {
      if (isCurrentView()) {
        working = false;
      }
    }
  };

  const confirmDialog = async () => {
    if (!dialog || !isCurrentView() || working) {
      return;
    }
    const current = dialog;
    const generation = dialogGeneration;
    const groupId = clusterGroupId;
    let ok: boolean;
    switch (current.kind) {
      case 'invite': {
        ok = await run(
          () =>
            createClusterGroupRequest({
              id: groupId,
              clusterGroupRequestCreateDto: { userId: current.userId },
            }),
          $t('frameleaf_people_sharing.invitation_sent'),
          'errors.something_went_wrong',
        );
        await refresh();
        break;
      }
      case 'partner-add': {
        ok = await run(
          () => createPartner({ partnerCreateDto: { sharedWithId: current.userId } }),
          $t('frameleaf_people_sharing.partner_added'),
          'errors.unable_to_add_partners',
        );
        await refreshPartners();
        break;
      }
      case 'erase': {
        ok = await run(
          () => clusterGroupRegeneratePeople({ id: groupId }),
          $t('frameleaf_sharing_erase_started'),
          'errors.something_went_wrong',
        );
        break;
      }
      default: {
        ok = await run(
          () => acceptClusterGroupRequest({ id: current.request.id }),
          $t('frameleaf_people_sharing.invitation_accepted'),
          'errors.something_went_wrong',
        );
        await refresh();
      }
    }
    if (ok && isCurrentView() && generation === dialogGeneration) {
      dialogOpen = false;
    }
  };

  const reviewInvitation = async (request: ClusterGroupRequestResponseDto) => {
    openDialog({ kind: 'review', request });
    const generation = dialogGeneration;
    if (!isCurrentView()) {
      return;
    }
    try {
      const groupMembers = await getClusterGroupUsers({ id: request.clusterGroupId });
      if (
        isCurrentView() &&
        generation === dialogGeneration &&
        dialog?.kind === 'review' &&
        dialog.request.id === request.id
      ) {
        dialog = { ...dialog, members: groupMembers };
      }
    } catch (error) {
      if (isCurrentView() && generation === dialogGeneration) {
        handleError(error, $t('errors.unable_to_load_cluster_group'));
      }
    }
  };

  const deleteRequest = async (request: ClusterGroupRequestResponseDto, done: string) => {
    await run(() => deleteClusterGroupRequest({ id: request.id }), done, 'errors.something_went_wrong');
    await refresh();
  };

  const leave = async () => {
    const groupId = clusterGroupId;
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_sharing_leave_title'),
      prompt: $t('frameleaf_sharing_leave_prompt'),
      confirmText: $t('frameleaf_people_sharing.leave_action'),
      danger: true,
    });
    if (confirmed && isCurrentView() && groupId === clusterGroupId) {
      await run(
        () => leaveClusterGroup({ id: groupId }),
        $t('frameleaf_people_sharing.left'),
        'errors.unable_to_leave_cluster_group',
      );
      await refresh();
    }
  };

  const stopSharing = async (partner: PartnerSharing) => {
    const userId = me;
    const partnerId = partner.user.id;
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_sharing_stop_title', { values: { name: partner.user.name } }),
      prompt: $t('frameleaf_people_sharing.stop_prompt', { values: { name: partner.user.name } }),
      confirmText: $t('frameleaf_people_sharing.stop_action'),
      danger: true,
    });
    if (confirmed && isCurrentView()) {
      const stopped = await run(
        () => removePartner({ id: partnerId }),
        $t('frameleaf_people_sharing.stopped'),
        'errors.unable_to_remove_partner',
      );
      if (stopped) {
        // FL-54: this tab's open pages drop the partner at once, as the server tells other tabs.
        eventManager.emit('PartnerRevoke', { sharedById: userId, sharedWithId: partnerId });
      }
      await refreshPartners();
    }
  };

  const dialogTitle = $derived(
    dialog?.kind === 'invite'
      ? $t('frameleaf_sharing_invite_title')
      : dialog?.kind === 'partner-add'
        ? $t('frameleaf_sharing_partner_add_title')
        : dialog?.kind === 'erase'
          ? $t('frameleaf_sharing_erase_title')
          : $t('frameleaf_sharing_review_title'),
  );
  /** Whose named people starting again erases: everyone in the recognition group. */
  const eraseWho = $derived(
    family.length > 0
      ? $t('frameleaf_sharing_erase_who_group', {
          values: { names: list([$t('frameleaf_sharing_you'), ...family.map((user) => user.name)]) },
        })
      : $t('frameleaf_sharing_erase_who_alone'),
  );
  const selectId = $props.id();
  const count = (value: number) => value.toLocaleString($locale ?? 'en-US');
  const progressLabel = (progress: NonNullable<ReturnType<typeof backfillProgress>>) =>
    progress.state === 'running'
      ? $t('frameleaf_partner_sharing.progress_running', {
          values: { done: count(Math.min(progress.done, progress.total)), total: count(progress.total) },
        })
      : progress.state === 'done'
        ? $t('frameleaf_partner_sharing.progress_done', { values: { total: count(progress.total) } })
        : progress.state === 'stopped'
          ? $t('frameleaf_partner_sharing.progress_stopped', { values: { done: count(progress.done) } })
          : $t('frameleaf_partner_sharing.progress_queued');
</script>

<KitPage>
  <Said message={notice} onDismiss={() => (notice = '')} />

  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_sharing_hero_label')}
  >
    {#snippet actions()}
      {#if invitation}
        <Button variant="primary" onclick={() => reviewInvitation(invitation)}>
          {$t('frameleaf_sharing_review_action')}
        </Button>
        <Button
          disabled={working}
          onclick={() => deleteRequest(invitation, $t('frameleaf_people_sharing.invitation_declined'))}
        >
          {$t('frameleaf_people_sharing.decline')}
        </Button>
      {/if}
    {/snippet}
  </Hero>

  {#if blocked}
    <Notice tone="warn" title={$t('frameleaf_sharing_blocked_title')}>{$t('frameleaf_sharing_blocked_body')}</Notice>
  {/if}

  <Section
    title={$t('frameleaf_people_sharing.partners_title')}
    description={$t('frameleaf_sharing_partners_description')}
  >
    {#snippet action()}
      <Button
        disabled={blocked || partnerChoices.length === 0}
        onclick={() => openDialog({ kind: 'partner-add', userId: partnerChoices[0]?.id ?? '' })}
      >
        {$t('frameleaf_sharing_partner_add')}
      </Button>
    {/snippet}
    {#if accountsStatus === 'error'}
      <div class="pad">
        <InlineError compact message={$t('frameleaf_people_sharing.accounts_error')} onRetry={loadAccounts} />
      </div>
    {/if}
    {#if partners.length > 0}
      <ItemList>
        {#each partners as partner (partner.user.id)}
          {@const name = partner.user.name}
          {@const progress = partner.sharedByMe ? backfillProgress(partner.backfill) : undefined}
          <Item
            {name}
            detail={partner.user.email}
            tone={partner.sharedByMe ? 'good' : 'off'}
            status={partner.sharedByMe
              ? $t('frameleaf_sharing_partner_mine', { values: { name } })
              : $t('frameleaf_sharing_partner_not_mine', { values: { name } })}
            note={partner.sharedWithMe
              ? $t('frameleaf_sharing_partner_theirs', { values: { name } })
              : $t('frameleaf_sharing_partner_not_theirs', { values: { name } })}
          >
            {#snippet media()}<UserAvatar user={partner.user} size="md" noTitle />{/snippet}
            {#snippet measure()}
              {#if progress}
                <div class="progress" data-state={progress.state}>
                  <div
                    role="progressbar"
                    aria-label={$t('frameleaf_partner_sharing.progress_label')}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress.percent}
                  >
                    <span style:width="{progress.percent}%"></span>
                  </div>
                  <small>{progressLabel(progress)}</small>
                </div>
              {/if}
            {/snippet}
            {#snippet action()}
              {#if partner.sharedByMe}
                <Button
                  disabled={working}
                  label={$t('frameleaf_sharing_partner_stop_label', { values: { name } })}
                  onclick={() => stopSharing(partner)}
                >
                  {$t('frameleaf_people_sharing.stop_action')}
                </Button>
              {:else}
                <Button
                  variant="primary"
                  disabled={working || blocked}
                  label={$t('frameleaf_sharing_partner_share_label', { values: { name } })}
                  onclick={() => openDialog({ kind: 'partner-add', userId: partner.user.id })}
                >
                  {$t('frameleaf_sharing_partner_share')}
                </Button>
              {/if}
            {/snippet}
          </Item>
        {/each}
      </ItemList>
    {:else}
      <p class="hint">{$t('frameleaf_sharing_partners_empty')}</p>
    {/if}
  </Section>

  <Section title={$t('frameleaf_sharing_family_title')} description={$t('frameleaf_sharing_family_description')}>
    {#snippet action()}
      <Button
        disabled={blocked || inviteChoices.length === 0}
        onclick={() => openDialog({ kind: 'invite', userId: inviteChoices[0]?.id ?? '' })}
      >
        {$t('frameleaf_sharing_invite')}
      </Button>
    {/snippet}
    <ItemList>
      {#each members as user (user.id)}
        {#if user.id === me}
          <Item
            name={$t('frameleaf_sharing_member_you', { values: { name: user.name } })}
            detail={user.email}
            tone={family.length > 0 ? 'good' : 'off'}
            status={family.length > 0 ? $t('frameleaf_sharing_member_sharing') : $t('frameleaf_sharing_member_alone')}
            note={family.length > 0
              ? $t('frameleaf_sharing_member_with', { values: { names: list(family.map((item) => item.name)) } })
              : $t('frameleaf_sharing_member_alone_note')}
          >
            {#snippet media()}<UserAvatar {user} size="md" noTitle />{/snippet}
            {#snippet action()}
              {#if canLeave}
                <Button disabled={working} onclick={leave}>{$t('frameleaf_sharing_leave')}</Button>
              {/if}
            {/snippet}
          </Item>
        {:else}
          <Item
            name={user.name}
            detail={user.email}
            tone="good"
            status={$t('frameleaf_sharing_member_same')}
            note={$t('frameleaf_sharing_member_no_photos')}
          >
            {#snippet media()}<UserAvatar {user} size="md" noTitle />{/snippet}
          </Item>
        {/if}
      {/each}
      {#each sentRequests as request (request.id)}
        {@const invited = byId[request.userId]}
        <Item
          icon={mdiAccountHeartOutline}
          quiet
          name={name(invited, $t('frameleaf_sharing_invited_someone'))}
          detail={invited?.email}
          status={$t('frameleaf_sharing_invited_waiting')}
          note={$t('frameleaf_sharing_invited_note')}
        >
          {#snippet action()}
            <Button
              disabled={working}
              onclick={() => deleteRequest(request, $t('frameleaf_people_sharing.invitation_cancelled'))}
            >
              {$t('frameleaf_people_sharing.cancel_invitation')}
            </Button>
          {/snippet}
        </Item>
      {/each}
    </ItemList>
    <Advanced>
      <Row
        label={$t('frameleaf_sharing_erase_label')}
        help={$t('frameleaf_sharing_erase_help', { values: { who: eraseWho } })}
      >
        <Button
          variant="danger"
          disabled={working || !clusterGroupId}
          onclick={() => openDialog({ kind: 'erase', sure: false })}
        >
          {$t('frameleaf_sharing_erase_open')}
        </Button>
      </Row>
    </Advanced>
  </Section>

  <Section title={$t('frameleaf_sharing_groups_title')} description={$t('frameleaf_sharing_groups_description')}>
    {#snippet action()}
      <Button disabled={blocked || groups === null} onclick={() => (groupsOpen = true)}>
        {$t('frameleaf_sharing_groups_manage')}
      </Button>
    {/snippet}
    {#if groups && groups.length > 0}
      <ItemList>
        {#each groups as group (group.id)}
          <Item
            icon={mdiAccountGroupOutline}
            quiet
            name={group.name}
            detail={list(group.users.map((user) => user.name))}
            status={$t('frameleaf_sharing_groups_count', { values: { count: group.users.length } })}
          />
        {/each}
      </ItemList>
    {:else if groups}
      <p class="hint">{$t('frameleaf_sharing_groups_empty')}</p>
    {/if}
  </Section>

  <Section title={$t('frameleaf_sharing_also_title')}>
    <Links
      stacked
      rows={[
        {
          icon: mdiImageMultipleOutline,
          title: $t('frameleaf_sharing_also_spaces'),
          body: $t('frameleaf_sharing_also_spaces_body'),
          href: Route.sharing(),
        },
        {
          icon: mdiLinkVariant,
          title: $t('frameleaf_sharing_also_links'),
          body: $t('frameleaf_sharing_also_links_body'),
          href: Route.sharedLinks(),
        },
      ]}
    />
  </Section>

  {#if settingsDraft}
    <Section title={$t('frameleaf_sharing_server_title')} description={$t('frameleaf_sharing_server_description')}>
      <Row
        label={$t('frameleaf_sharing_find_label')}
        help={findable ? $t('frameleaf_sharing_find_on') : $t('frameleaf_sharing_find_off')}
        helpId="{selectId}-find"
      >
        <Switch
          label={$t('frameleaf_sharing_find_label')}
          checked={findable}
          held={featureFlagsManager.value.configFile}
          describedBy="{selectId}-find"
          onChange={(value) => (settingsDraft.draft.server.publicUsers = value)}
        />
      </Row>
    </Section>
  {/if}
</KitPage>

{#if groups}
  <RecipientGroupsDialog
    bind:open={groupsOpen}
    {groups}
    people={accounts.filter((user) => user.id !== me)}
    onChanged={loadGroups}
  />
{/if}

{#if dialog}
  <Dialog title={dialogTitle} closeLabel={$t('close')} bind:open={dialogOpen}>
    {#if dialog.kind === 'invite' || dialog.kind === 'partner-add'}
      {@const choices =
        dialog.kind === 'invite'
          ? inviteChoices
          : accounts.filter(
              (user) => user.id !== me && partners.every((p) => !(p.user.id === user.id && p.sharedByMe)),
            )}
      <label class="field" for={selectId}>
        {$t('frameleaf_sharing_choose')}
        <select id={selectId} bind:value={dialog.userId} data-initial-focus>
          {#each choices as user (user.id)}
            <option value={user.id}>{user.name} · {user.email}</option>
          {/each}
        </select>
      </label>
      <p class="hint">
        {dialog.kind === 'partner-add'
          ? $t('frameleaf_sharing_partner_add_body', { values: { name: name(byId[dialog.userId]) } })
          : $t('frameleaf_sharing_invite_body')}
      </p>
    {:else if dialog.kind === 'erase'}
      <Notice tone="warn" title={$t('frameleaf_sharing_erase_warning_title', { values: { who: eraseWho } })}>
        {$t('frameleaf_sharing_erase_warning_body')}
      </Notice>
      <label class="pick">
        <input type="checkbox" bind:checked={dialog.sure} />
        <span>
          <strong>{$t('frameleaf_sharing_erase_sure')}</strong>
          <small>{$t('frameleaf_sharing_erase_sure_note')}</small>
        </span>
      </label>
    {:else if dialog.kind === 'review'}
      {#if dialog.members}
        <p class="hint">
          {$t('frameleaf_sharing_review_body', {
            values: { members: list(dialog.members.map((user) => user.name)) },
          })}
        </p>
      {:else}
        <div role="status" aria-busy="true">
          <span class="sr-only">{$t('loading')}</span>
          <Skeleton lines={2} />
        </div>
      {/if}
    {/if}
    {#snippet actions()}
      {#if dialog?.kind === 'erase'}
        <Button initialFocus onclick={() => (dialogOpen = false)}>{$t('frameleaf_sharing_erase_keep')}</Button>
        <Button variant="danger" disabled={working || !dialog.sure} onclick={confirmDialog}>
          {$t('frameleaf_sharing_erase_confirm')}
        </Button>
      {:else}
        <Button onclick={() => (dialogOpen = false)}>{$t('cancel')}</Button>
        <Button
          variant="primary"
          disabled={working || (dialog?.kind !== 'review' && !dialog?.userId)}
          onclick={confirmDialog}
        >
          {dialog?.kind === 'review'
            ? $t('frameleaf_people_sharing.accept')
            : dialog?.kind === 'partner-add'
              ? $t('frameleaf_sharing_partner_add_confirm', { values: { name: name(byId[dialog.userId]) } })
              : $t('frameleaf_sharing_invite_confirm')}
        </Button>
      {/if}
    {/snippet}
  </Dialog>
{/if}

<style>
  .hint {
    max-width: 640px;
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .pad {
    padding-bottom: var(--fl-space-4);
  }
  /* How far the first copy into a partner's library has come (FL-326). */
  .progress {
    display: grid;
    gap: var(--fl-space-1);
    max-width: 360px;
  }
  .progress [role='progressbar'] {
    height: 6px;
    overflow: hidden;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
  }
  .progress [role='progressbar'] span {
    display: block;
    height: 100%;
    background: var(--fl-accent);
  }
  .progress[data-state='stopped'] [role='progressbar'] span {
    background: var(--fl-muted);
  }
  .progress small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .field {
    display: grid;
    gap: var(--fl-space-2);
    margin-bottom: var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .field select {
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .pick {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-4);
    cursor: pointer;
  }
  .pick input {
    width: 18px;
    height: 18px;
    margin-top: 2px;
    accent-color: var(--fl-accent);
  }
  .pick strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  .pick small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
</style>
