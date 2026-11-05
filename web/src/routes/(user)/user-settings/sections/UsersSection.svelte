<script lang="ts">
  /**
   * Users (FL-71, FL-76; rebuilt to the approved prototype `settings-v2/cloud/People.jsx`): the answer
   * first (how many people have an account, or who is almost out of space, or that you are the only
   * one) with the space everyone uses and the space each new person starts with; then everyone with
   * an account as one list (avatar, email and role, state and when they joined, the space they use,
   * Open ›) with "Add a person" on the list; then "Space for new people".
   *
   * One person (`?user=<id>`) opens in place of the list with "‹ Users" (`UserDetail`); "Add a person"
   * (`?new=1`) is a page of its own (`AddPerson`, FL-516). The old `/admin/users` addresses only
   * redirect here. Accounts being removed stay in the list, so they can still be opened and restored.
   *
   * "Space for new people" (FL-516) is one space every new account starts with, however it is made
   * (added here, invited through Frameleaf, or created by a sign-in provider). It writes
   * `user.newUserStorageQuota` and, so the older per-path settings never disagree with it,
   * `oauth.defaultStorageQuota` and `frameleafCloud.signIn.invitedStorageQuota` too.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import SupporterTag from '$lib/components/frameleaf/SupporterTag.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import PageHeading from '$lib/components/frameleaf/settings/kit/PageHeading.svelte';
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import AddPerson from '$lib/components/frameleaf/settings/people/AddPerson.svelte';
  import SpacePicker from '$lib/components/frameleaf/settings/people/SpacePicker.svelte';
  import { gibWords, spaceWords } from '$lib/components/frameleaf/settings/people/space';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { UUID_REGEX } from '$lib/constants';
  import { accountLifecycle, accountQuotaUsage } from '$lib/frameleaf/accounts';
  import { motionScrollBehavior } from '$lib/frameleaf/motion';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserAdminsActions } from '$lib/services/user-admin.service';
  import { locale } from '$lib/stores/preferences.store';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { requestServerInfo } from '$lib/utils/auth';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    getServerStatistics,
    searchUsersAdmin,
    type UsageByUserDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { CommandPaletteDefaultProvider, Icon } from '@frameleaf/ui';
  import { mdiAccountGroupOutline, mdiAccountPlusOutline, mdiChevronRight, mdiHarddisk } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserDetail from './UserDetail.svelte';

  const selectedId = $derived(page.url.searchParams.get('user'));
  const selected = $derived(selectedId && UUID_REGEX.test(selectedId) ? selectedId : undefined);
  const creating = $derived(page.url.searchParams.get('new') === '1');

  let users: UserAdminResponseDto[] = $state([]);
  /** Everyone's photos and videos together, for "Space used"; the list works without it. */
  let usedByEveryone = $state<number>();
  /** When each account last used a signed-in device (servers since 2026-11 say so); the list works without it. */
  let lastActive = $state<Map<string, string>>(new Map());
  let loaded = $state(false);
  let failed = $state(false);

  let load = 0;
  const loadUsers = () => {
    failed = false;
    const current = ++load;
    // Both reads are independent: the account list does not wait for the disk check, and is shown as
    // soon as it arrives. A disk check that fails leaves the list as it is.
    // A load that failed, or that a retry replaced, shows nothing it receives afterwards.
    void searchUsersAdmin({ withDeleted: true })
      .then((result) => {
        if (current === load) {
          users = result;
          loaded = true;
        }
      })
      .catch(() => {
        if (current === load) {
          failed = true;
          load++;
        }
      });
    void requestServerInfo().catch(() => {});
  };
  onMount(() => {
    loadUsers();
    void getServerStatistics()
      .then((statistics) => {
        usedByEveryone = statistics.usage;
        lastActive = new Map(
          // `lastActiveAt` is new on the server (2026-11); typed here until the SDK is regenerated
          (statistics.usageByUser as Array<UsageByUserDto & { lastActiveAt?: string | null }>).flatMap((row) =>
            row.lastActiveAt ? [[row.userId, row.lastActiveAt] as const] : [],
          ),
        );
      })
      .catch(() => {
        // "Space used" is left out rather than failing the account list.
      });
  });

  const onUpdate = async (user: UserAdminResponseDto) => {
    const index = users.findIndex(({ id }) => id === user.id);
    if (index === -1) {
      users = await searchUsersAdmin({ withDeleted: true });
    } else {
      users[index] = user;
    }
  };

  const onUserAdminDeleted = ({ id: userId }: { id: string }) => {
    users = users.filter(({ id }) => id !== userId);
  };

  const onCreateClose = async (created?: UserAdminResponseDto) => {
    await (created ? goto(Route.viewUser(created), { replaceState: true }) : goto(Route.users()));
  };

  // FL-516: "Space for new people", through the settings page's draft and its Save.
  const settingsDraft = getSystemConfigDraft();
  const held = $derived(featureFlagsManager.value.configFile);
  const newSpace = $derived(settingsDraft?.draft.user.newUserStorageQuota ?? null);
  const setNewSpace = (value: number | null) => {
    const draft = settingsDraft?.draft;
    if (!draft) {
      return;
    }
    draft.user.newUserStorageQuota = value;
    draft.oauth.defaultStorageQuota = value;
    if (draft.frameleafCloud?.signIn) {
      draft.frameleafCloud.signIn.invitedStorageQuota = value;
    }
  };

  const { Create } = $derived(getUserAdminsActions($t));

  // ---- The list ----
  const bytes = (value: number) => getByteUnitString(value, $locale);
  const selfId = $derived(authManager.authenticated ? authManager.user.id : undefined);
  /**
   * Supporter option (b): the "Supporter" tag beside a person. Everyone while this server holds a
   * Server licence (the server feature), otherwise whoever holds their own Individual licence.
   */
  const isSupporter = (user: UserAdminResponseDto) => featureFlagsManager.value.supporter || !!user.license;
  const almostFull = (user: UserAdminResponseDto) => {
    const quota = accountQuotaUsage(user);
    return accountLifecycle(user) === 'active' && !!quota && quota.fraction > 0.9;
  };
  /** People who can sign in first, by name; accounts being removed after them. */
  const rows = $derived(
    [...users].sort(
      (a, b) =>
        Number(accountLifecycle(a) !== 'active') - Number(accountLifecycle(b) !== 'active') ||
        a.name.localeCompare(b.name, $locale),
    ),
  );
  const active = $derived(users.filter((user) => accountLifecycle(user) === 'active'));
  const admins = $derived(active.filter((user) => user.isAdmin).length);
  const full = $derived(active.filter((user) => almostFull(user)));

  const statusOf = (user: UserAdminResponseDto): { tone: KitTone; text: string } => {
    switch (accountLifecycle(user)) {
      case 'removing': {
        return { tone: 'off', text: $t('frameleaf_users_status_removing') };
      }
      case 'deleted': {
        return { tone: 'warn', text: $t('frameleaf_users_status_deleted') };
      }
      case 'active': {
        if (user.uploadsPaused) {
          return { tone: 'off', text: $t('frameleaf_users_status_paused') };
        }
        return almostFull(user)
          ? { tone: 'warn', text: $t('frameleaf_users_status_almost_full') }
          : { tone: 'good', text: $t('frameleaf_users_status_active') };
      }
    }
  };
  const joined = (user: UserAdminResponseDto) => {
    const date = new Date(user.createdAt).toLocaleDateString($locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const active = lastActive.get(user.id);
    // "today", "yesterday", "3 days ago": a session records its use about once an hour
    const when = active ? DateTime.fromISO(active, { locale: $locale }).toRelativeCalendar() : null;
    return when
      ? $t('frameleaf_users_joined_active', { values: { date, when } })
      : $t('frameleaf_users_joined', { values: { date } });
  };
  const quotaWords = (total: number) => gibWords(total) ?? bytes(total);

  // ---- The answer at the top ----
  type Answer = {
    tone: 'good' | 'warn' | 'quiet';
    title: string;
    body: string;
    /** The one person almost out of space, whom the answer's button opens. */
    person?: UserAdminResponseDto;
  };
  const hero = $derived.by((): Answer => {
    if (active.length <= 1) {
      return {
        tone: 'quiet',
        title: $t('frameleaf_users_hero_alone_title'),
        body: $t('frameleaf_users_hero_alone_body'),
      };
    }
    if (full.length === 1) {
      const [person] = full;
      const quota = accountQuotaUsage(person);
      return {
        tone: 'warn',
        title: $t('frameleaf_users_hero_full_title', { values: { name: person.name } }),
        body: $t('frameleaf_users_hero_full_body', {
          values: { used: bytes(quota?.used ?? 0), total: quotaWords(quota?.total ?? 0) },
        }),
        person,
      };
    }
    if (full.length > 1) {
      return {
        tone: 'warn',
        title: $t('frameleaf_users_hero_full_many_title', { values: { count: full.length } }),
        body: $t('frameleaf_users_hero_full_many_body'),
      };
    }
    return {
      tone: 'good',
      title: $t('frameleaf_users_hero_title', { values: { count: active.length } }),
      body: $t('frameleaf_users_hero_body', { values: { admins, members: active.length - admins } }),
    };
  });
  const alone = $derived(active.length <= 1);
  const coverage = $derived.by((): CoverageRow[] => {
    const disk = userInteraction.serverInfo;
    const result: CoverageRow[] = [];
    if (usedByEveryone !== undefined) {
      result.push({
        icon: mdiHarddisk,
        name: $t('frameleaf_users_space_used'),
        detail: $t('frameleaf_users_space_used_detail'),
        tone: disk && disk.diskUsagePercentage >= 90 ? 'warn' : 'good',
        value: disk
          ? $t('frameleaf_users_space_used_value', {
              values: { used: bytes(usedByEveryone), total: bytes(disk.diskSizeRaw) },
            })
          : bytes(usedByEveryone),
      });
    }
    if (settingsDraft) {
      result.push({
        icon: mdiAccountPlusOutline,
        name: $t('frameleaf_userpage_new_space_title'),
        detail: $t('frameleaf_users_space_new_detail'),
        tone: 'good',
        value:
          newSpace === null
            ? $t('frameleaf_userpage_space_none')
            : $t('frameleaf_users_space_new_each', { values: { space: spaceWords(newSpace) } }),
      });
    }
    return result;
  });

  // Opening a person or the Add page shows it from its top, wherever the list was scrolled to.
  let pageElement: HTMLElement | undefined = $state();
  $effect(() => {
    if ((selected || creating) && pageElement) {
      pageElement.scrollIntoView?.({ block: 'start', behavior: motionScrollBehavior() });
    }
  });
</script>

<OnEvents
  onUserAdminCreate={onUpdate}
  onUserAdminUpdate={onUpdate}
  onUserAdminDelete={onUpdate}
  onUserAdminRestore={onUpdate}
  {onUserAdminDeleted}
/>

<CommandPaletteDefaultProvider name={$t('users')} actions={[Create]} />

{#snippet addPerson(primary: boolean)}
  <Button variant={primary ? 'primary' : 'default'} onclick={() => void goto(Route.newUser())}>
    <Icon icon={mdiAccountPlusOutline} size="1.125rem" aria-hidden />
    {$t('frameleaf_users_create')}
  </Button>
{/snippet}

{#snippet heroActions()}
  {#if alone}
    {@render addPerson(true)}
  {:else if hero.person}
    {@const person = hero.person}
    <Button variant="primary" onclick={() => void goto(Route.viewUser(person))}>
      {$t('frameleaf_users_hero_full_action', { values: { name: person.name } })}
    </Button>
  {/if}
{/snippet}

{#snippet listAction()}
  {@render addPerson(false)}
{/snippet}

{#snippet person(user: UserAdminResponseDto)}
  {@const status = statusOf(user)}
  {@const quota = accountQuotaUsage(user)}
  {@const used = user.quotaUsageInBytes ?? 0}
  <Item
    name={user.id === selfId ? $t('frameleaf_users_you', { values: { name: user.name } }) : user.name}
    tag={isSupporter(user) ? supporter : undefined}
    detail="{user.email} · {user.isAdmin ? $t('frameleaf_users_role_admin') : $t('frameleaf_userpage_role_member')}"
    tone={status.tone}
    status={status.text}
    note={joined(user)}
  >
    {#snippet media()}
      <span class="avatar"><UserAvatar {user} noTitle /></span>
    {/snippet}
    {#snippet measure()}
      {#if quota}
        <Meter
          label={$t('frameleaf_users_quota_usage', { values: { name: user.name } })}
          value={bytes(used)}
          max={$t('frameleaf_users_space_of', { values: { total: quotaWords(quota.total) } })}
          fraction={quota.fraction}
        />
      {:else}
        <Meter
          label={$t('frameleaf_users_quota_usage', { values: { name: user.name } })}
          value={bytes(used)}
          max="· {$t('frameleaf_users_quota_unlimited')}"
        />
      {/if}
    {/snippet}
    {#snippet action()}
      <Button
        label={$t('frameleaf_users_open_person', { values: { name: user.name } })}
        onclick={() => void goto(Route.viewUser(user))}
        >{$t('frameleaf_security_who_open')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
      >
    {/snippet}
  </Item>
{/snippet}

{#snippet supporter()}
  <SupporterTag />
{/snippet}

{#if selected}
  {#key selected}
    <div class="person" bind:this={pageElement}>
      <UserDetail id={selected} />
    </div>
  {/key}
{:else if creating}
  <div class="person" bind:this={pageElement}>
    <PageHeading
      overline={$t('frameleaf_settings_area_users')}
      title={$t('frameleaf_userpage_add_title')}
      description={$t('frameleaf_userpage_add_description')}
      back={{ href: Route.users(), label: $t('frameleaf_settings_area_users') }}
    />
    <AddPerson onDone={onCreateClose} />
  </div>
{:else}
  <PageHeading
    overline={$t('frameleaf_users_eyebrow')}
    title={$t('frameleaf_settings_area_users')}
    description={$t('frameleaf_users_subtitle')}
  />
  {#if loaded}
    <KitPage>
      <Hero
        tone={hero.tone}
        icon={mdiAccountGroupOutline}
        title={hero.title}
        body={hero.body}
        label={$t('frameleaf_users_hero_label')}
        actions={alone || hero.person ? heroActions : undefined}
      >
        {#if !alone && coverage.length > 0}
          <Coverage rows={coverage} />
        {/if}
      </Hero>

      <Section title={$t('frameleaf_settings_area_users')} action={alone ? undefined : listAction}>
        <ItemList>
          {#each rows as user (user.id)}
            {@render person(user)}
          {/each}
        </ItemList>
      </Section>

      {#if settingsDraft}
        <Section title={$t('frameleaf_userpage_new_space_title')}>
          <Row
            label={$t('frameleaf_userpage_new_space')}
            help={$t('frameleaf_userpage_new_space_help', {
              values: { space: newSpace === null ? $t('frameleaf_userpage_space_none') : spaceWords(newSpace) },
            })}
          >
            <SpacePicker
              label={$t('frameleaf_userpage_space_for_new')}
              value={newSpace}
              disabled={held}
              onChange={setNewSpace}
            />
          </Row>
          <p class="hint">{$t('frameleaf_userpage_new_space_shared')}</p>
        </Section>
      {/if}
    </KitPage>
  {:else if failed}
    <InlineError message={$t('frameleaf_cc_section_load_failed')} onRetry={loadUsers} />
  {:else}
    <div class="users-loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="8rem" />
      <Skeleton variant="block" height="12rem" />
    </div>
  {/if}
{/if}

<style>
  /* Opened from further down the list, a page is shown from its top with the page's own air above it. */
  .person {
    scroll-margin-top: var(--fl-space-8);
  }
  .avatar {
    display: block;
    width: 44px;
    height: 44px;
    overflow: hidden;
    border-radius: 50%;
  }
  .hint {
    margin: 0;
    padding: 0 0 var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .users-loading {
    display: grid;
    gap: var(--fl-space-3);
    max-width: 1120px;
  }
</style>
