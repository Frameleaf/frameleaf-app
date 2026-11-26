<script lang="ts">
  /**
   * Settings, People & sharing, Linked households (FL-998), after the approved prototype
   * (`settings-v2/server/households.jsx`). Administrators only: the route and the API both say so.
   *
   * An invitation lives only as long as this page: the server has no list of open invitations and
   * no way to withdraw one, so the waiting row offers Show and not the mock's Cancel.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import HouseholdAcceptDialog from '$lib/components/frameleaf/households/HouseholdAcceptDialog.svelte';
  import HouseholdInviteDialog from '$lib/components/frameleaf/households/HouseholdInviteDialog.svelte';
  import HouseholdRenameDialog from '$lib/components/frameleaf/households/HouseholdRenameDialog.svelte';
  import HouseholdUnlinkDialog from '$lib/components/frameleaf/households/HouseholdUnlinkDialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import {
    HOUSEHOLD_LINK_LIMIT,
    householdRow,
    householdsPause,
    type HouseholdRow,
  } from '$lib/frameleaf/linked-households';
  import { cloudGlance } from '$lib/frameleaf/overview-readiness';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createHouseholdInvitation,
    getHouseholdLinks,
    type HouseholdInvitationDto,
    type HouseholdLinkDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAccountMultiplePlusOutline,
    mdiContentCopy,
    mdiEmailFastOutline,
    mdiHomeGroup,
    mdiHomeOutline,
    mdiLinkOff,
    mdiLinkVariant,
    mdiLockOutline,
    mdiPauseCircleOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let links = $state<HouseholdLinkDto[]>([]);
  let loadState = $state<'loading' | 'ready' | 'failed'>('loading');
  let said = $state('');
  let invitation = $state<HouseholdInvitationDto>();
  let inviteOpen = $state(false);
  let acceptOpen = $state(false);
  let acceptRun = $state(0);
  let creating = $state(false);
  let renaming = $state<{ open: boolean; link?: HouseholdLinkDto }>({ open: false });
  let unlinking = $state<{ open: boolean; link?: HouseholdLinkDto }>({ open: false });

  const live = $derived(links.filter((link) => !link.ended));
  const waiting = $derived(
    invitation && new Date(invitation.expiresAt).getTime() > Date.now() ? invitation : undefined,
  );

  const status = $derived(cloudManager.status);
  const license = $derived(cloudManager.license);
  /** Undefined until Cloud has answered, so nothing is claimed about this server's licence early. */
  const licensed = $derived.by(() => {
    if (!license) {
      return;
    }
    const key = license.key;
    return !!key && (key.state === 'active' || key.state === 'grace') && key.kind !== 'individual';
  });
  const glance = $derived(status ? cloudGlance(status, license) : null);
  const noPlan = $derived(
    !!glance?.configured && glance.link === 'linked' && !['active', 'grace'].includes(glance.plan),
  );
  const pause = $derived(householdsPause(live, licensed));

  const load = async () => {
    loadState = 'loading';
    try {
      links = await getHouseholdLinks();
      loadState = 'ready';
    } catch {
      loadState = 'failed';
    }
  };

  onMount(() => {
    void load();
    return cloudManager.listen();
  });

  const invite = async () => {
    // One open invitation at a time: the server cannot withdraw one, so another would only add a live code.
    if (waiting) {
      inviteOpen = true;
      return;
    }
    creating = true;
    try {
      invitation = await createHouseholdInvitation();
      inviteOpen = true;
    } catch (error) {
      handleError(error, $t('frameleaf_households_error'));
    } finally {
      creating = false;
    }
  };

  const onLinked = (link: HouseholdLinkDto) => {
    links = [link, ...links.filter(({ id }) => id !== link.id)];
    said = $t('frameleaf_households_just_linked', { values: { name: link.householdName } });
  };
  const onRenamed = (link: HouseholdLinkDto) => {
    links = links.map((entry) => (entry.id === link.id ? link : entry));
    said = $t('frameleaf_households_renamed', { values: { name: link.householdName } });
  };
  const onUnlinked = (link: HouseholdLinkDto) => {
    links = links.filter(({ id }) => id !== link.id);
    said = $t('frameleaf_households_unlinked', { values: { name: link.householdName } });
  };

  const longDate = (iso: string) =>
    new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'long' }).format(new Date(iso));
  const inviteDate = (iso: string) =>
    new Intl.DateTimeFormat($locale ?? undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(
      new Date(iso),
    );
  const ago = (iso: string) =>
    DateTime.fromISO(iso)
      .setLocale($locale ?? 'en')
      .toRelative() ?? '';

  const noteOf = (row: HouseholdRow, link: HouseholdLinkDto) => {
    switch (row.note) {
      case undefined: {
        return;
      }
      case 'seen': {
        return link.lastSeenAt
          ? $t('frameleaf_households_seen', { values: { when: ago(link.lastSeenAt) } })
          : undefined;
      }
      case 'offline': {
        return link.lastSeenAt
          ? $t('frameleaf_households_note_offline', { values: { when: ago(link.lastSeenAt) } })
          : $t('frameleaf_households_note_offline_unseen');
      }
      default: {
        return $t(`frameleaf_households_row_${row.note}` as Translations);
      }
    }
  };

  const facts = [
    { icon: mdiAccountMultipleOutline, id: 'people' },
    { icon: mdiContentCopy, id: 'copies' },
    { icon: mdiLockOutline, id: 'locked' },
    { icon: mdiLinkOff, id: 'unlink' },
  ];
</script>

{#snippet inviteButton(variant: 'primary' | 'default')}
  <Button {variant} disabled={!!pause || creating} onclick={() => void invite()}>
    <Icon icon={mdiAccountMultiplePlusOutline} size="18" aria-hidden />
    {$t('frameleaf_households_invite_action')}
  </Button>
{/snippet}
{#snippet acceptButton()}
  <Button
    disabled={!!pause}
    onclick={() => {
      acceptRun += 1;
      acceptOpen = true;
    }}
  >
    <Icon icon={mdiLinkVariant} size="18" aria-hidden />
    {$t('frameleaf_households_accept_action')}
  </Button>
{/snippet}

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

  {#if loadState === 'loading'}
    <div aria-busy="true" aria-label={$t('loading')}>
      <Skeleton variant="block" height="106px" />
    </div>
  {:else if loadState === 'failed'}
    <InlineError message={$t('frameleaf_households_load_failed')} onRetry={() => void load()} />
  {:else}
    {#if pause}
      <Hero
        tone="warn"
        icon={mdiPauseCircleOutline}
        title={$t('frameleaf_households_paused_title')}
        body={pause === 'licence'
          ? $t('frameleaf_households_paused_licence_body')
          : $t('frameleaf_households_paused_cloud_body')}
        label={$t('frameleaf_households_title')}
      >
        {#snippet actions()}
          <a
            class="fl-control primary-link"
            href={commandCenterUrl('cloud', pause === 'licence' ? 'cloud-license' : undefined)}
          >
            {pause === 'licence' ? $t('frameleaf_households_see_licences') : $t('frameleaf_households_link_cloud')}
          </a>
        {/snippet}
      </Hero>
    {:else if live.length === 0}
      <Hero
        tone="quiet"
        icon={mdiHomeGroup}
        title={$t('frameleaf_households_empty_title')}
        body={$t('frameleaf_households_empty_body')}
        label={$t('frameleaf_households_title')}
      >
        {#snippet actions()}
          {@render inviteButton('primary')}
          {@render acceptButton()}
        {/snippet}
      </Hero>
    {:else}
      <Hero
        icon={mdiHomeGroup}
        title={$t('frameleaf_households_linked_title', { values: { count: live.length } })}
        body={$t('frameleaf_households_linked_body')}
        label={$t('frameleaf_households_title')}
      />
    {/if}

    {#if noPlan && live.length > 0 && !pause}
      <Notice tone="info" icon={mdiHomeOutline} title={$t('frameleaf_households_plan_title')}>
        {$t('frameleaf_households_plan_body')}
        {#snippet action()}
          <a class="fl-control plain-link" href={commandCenterUrl('cloud')}>{$t('frameleaf_households_plan_action')}</a>
        {/snippet}
      </Notice>
    {/if}

    {#if live.length > 0 || waiting}
      <Section
        title={$t('frameleaf_households_list_title')}
        description={$t('frameleaf_households_list_help', { values: { count: HOUSEHOLD_LINK_LIMIT } })}
      >
        {#snippet action()}
          {#if live.length > 0}
            {@render acceptButton()}
            {@render inviteButton('primary')}
          {/if}
        {/snippet}
        <ItemList noMeasure>
          {#each live as link (link.id)}
            {@const row = householdRow(link, licensed)}
            <Item
              icon={mdiHomeGroup}
              quiet={row.tone !== 'good'}
              name={$t('frameleaf_households_household_name', { values: { name: link.householdName } })}
              detail={$t('frameleaf_households_linked_on', {
                values: { server: link.peerName, date: longDate(link.createdAt) },
              })}
              tone={row.tone}
              status={$t(`frameleaf_households_status_${row.status}` as Translations)}
              note={noteOf(row, link)}
            >
              {#snippet action()}
                <div class="row-buttons">
                  <Button
                    label={$t('frameleaf_households_rename_title', { values: { name: link.householdName } })}
                    onclick={() => (renaming = { open: true, link })}
                  >
                    {$t('frameleaf_households_rename_action')}
                  </Button>
                  <Button
                    label={$t('frameleaf_households_unlink_aria', { values: { name: link.householdName } })}
                    onclick={() => (unlinking = { open: true, link })}
                  >
                    {$t('frameleaf_households_unlink_action')}
                  </Button>
                </div>
              {/snippet}
            </Item>
          {/each}
          {#if waiting}
            <Item
              icon={mdiEmailFastOutline}
              quiet
              name={$t('frameleaf_households_waiting_name')}
              detail={$t('frameleaf_households_waiting_code', { values: { code: waiting.code } })}
              tone="off"
              status={$t('frameleaf_households_waiting')}
              note={$t('frameleaf_households_waiting_expires', { values: { date: inviteDate(waiting.expiresAt) } })}
            >
              {#snippet action()}
                <Button onclick={() => (inviteOpen = true)}>{$t('frameleaf_households_show')}</Button>
              {/snippet}
            </Item>
          {/if}
        </ItemList>
      </Section>
    {/if}

    <Section title={$t('frameleaf_households_facts_title')}>
      <ul class="points">
        {#each facts as fact (fact.id)}
          <li>
            <span aria-hidden="true"><Icon icon={fact.icon} size="20" /></span>
            <div>
              <strong>{$t(`frameleaf_households_fact_${fact.id}_title` as Translations)}</strong>
              <p>{$t(`frameleaf_households_fact_${fact.id}_body` as Translations)}</p>
            </div>
          </li>
        {/each}
      </ul>
      <p class="needs">{$t('frameleaf_households_needs')}</p>
    </Section>
  {/if}
</KitPage>

<!-- Each opening starts clean; the dialogs stay mounted while closing so their exit can play. -->
{#if invitation}
  <HouseholdInviteDialog {invitation} bind:open={inviteOpen} />
{/if}
{#key acceptRun}
  <HouseholdAcceptDialog bind:open={acceptOpen} {onLinked} />
{/key}
{#key renaming}
  {#if renaming.link}
    <HouseholdRenameDialog link={renaming.link} bind:open={renaming.open} {onRenamed} />
  {/if}
{/key}
{#key unlinking}
  {#if unlinking.link}
    <HouseholdUnlinkDialog link={unlinking.link} bind:open={unlinking.open} {onUnlinked} />
  {/if}
{/key}

<style>
  .row-buttons {
    display: flex;
    gap: var(--fl-space-2);
  }
  .points {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-6) var(--fl-space-8);
    margin: 0;
    padding: 0 0 var(--fl-space-6);
    list-style: none;
  }
  .points li {
    display: flex;
    gap: var(--fl-space-4);
  }
  .points li > span {
    flex-shrink: 0;
    margin-top: 2px;
    color: var(--fl-accent);
  }
  .points strong {
    font-weight: 600;
  }
  .points p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .needs {
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .primary-link,
  .plain-link {
    display: inline-flex;
    align-items: center;
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
  }
  .primary-link {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  @container kit (max-width: 720px) {
    .points {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
