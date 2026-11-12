<script lang="ts">
  /**
   * Users › Activity log, for administrators (FL-824, the approved prototype's `HouseholdActivity`
   * in `settings-v2/cloud/AccountActivity.jsx`): what happened on everyone's accounts, read from
   * `GET /admin/activity` (FL-808), which merges each account's own activity with what
   * administrators did to it (FL-76). Each row names who it is about and shows the picture of
   * whoever did it; "Whose" narrows the list to one person (the server's `userId` filter). A sign-in
   * that did not work, or an app cut off for safety, offers "Open <person>".
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import ActivityList from '$lib/components/frameleaf/settings/security/ActivityList.svelte';
  import {
    ACTIVITY_PAGE_SIZE,
    activityDevice,
    activityPlace,
    activityTime,
    recentFailures,
    type ActivityEvent,
    type ActivityRow,
  } from '$lib/frameleaf/account-activity';
  import { ActivityFeed } from '$lib/frameleaf/account-activity-feed.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getAccountActivityAdmin, searchUsersAdmin, type UserAdminResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAccountGroupOutline,
    mdiChevronRight,
    mdiCloudAlertOutline,
    mdiHistory,
    mdiShieldAlertOutline,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The one account the list is narrowed to; everyone when left out. */
    who?: string;
    onWho: (id: string | undefined) => void;
    /** The moment "today" is measured from (for tests). */
    now?: Date;
  };
  let { who, onWho, now = new Date() }: Props = $props();

  const EVERYONE = 'everyone';

  /** Everyone with an account, removed ones too, so an older row still has its name and picture. */
  let people = $state<Map<string, UserAdminResponseDto> | null>(null);
  let peopleFailed = $state(false);
  const loadPeople = async () => {
    peopleFailed = false;
    try {
      const users = await searchUsersAdmin({ withDeleted: true });
      people = new Map(users.map((user) => [user.id, user]));
    } catch {
      peopleFailed = true;
    }
  };

  const feed = new ActivityFeed((before) => getAccountActivityAdmin({ before, take: ACTIVITY_PAGE_SIZE, userId: who }));
  // The list starts again whenever another person is chosen.
  $effect(() => {
    void who;
    untrack(() => void feed.load());
  });
  $effect(() => {
    untrack(() => void loadPeople());
  });
  const retry = () => {
    if (peopleFailed) {
      void loadPeople();
    }
    void feed.load();
  };

  const failed = $derived(feed.failed || peopleFailed);
  // Rows wait for the names, so a sentence never says "Someone" for a person who has an account.
  const events = $derived(people ? feed.events : null);
  const failures = $derived(events ? recentFailures(events, now) : undefined);
  const suspect = $derived(failures ? people?.get(failures.events[0].userId) : undefined);

  const options = $derived([
    { value: EVERYONE, label: $t('frameleaf_account_activity_log_everyone') },
    ...[...(people?.values() ?? [])]
      .sort((a, b) => a.name.localeCompare(b.name, $locale))
      .map((user) => ({ value: user.id, label: user.name })),
  ]);
  const household = $derived([...(people?.values() ?? [])].filter((user) => !user.deletedAt).length);

  type Answer = { tone: 'good' | 'warn' | 'quiet'; icon: string; title: string; body: string };
  const hero = $derived.by((): Answer => {
    if (failed) {
      return {
        tone: 'warn',
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_account_activity_log_hero_error_title'),
        body: $t('frameleaf_account_activity_log_hero_error_body'),
      };
    }
    if (events === null) {
      return {
        tone: 'quiet',
        icon: mdiHistory,
        title: $t('frameleaf_account_activity_log_hero_loading_title'),
        body: $t('frameleaf_account_activity_hero_loading_body'),
      };
    }
    if (events.length === 0 && !who) {
      return {
        tone: 'quiet',
        icon: mdiHistory,
        title: $t('frameleaf_account_activity_hero_empty_title'),
        body: $t('frameleaf_account_activity_log_hero_empty_body'),
      };
    }
    if (failures && suspect) {
      const [latest] = failures.events;
      const device = activityDevice($t, latest);
      const values = { name: suspect.name, count: failures.events.length };
      return {
        tone: 'warn',
        icon: mdiShieldAlertOutline,
        title: failures.passwordOnly
          ? $t('frameleaf_account_activity_log_hero_warn_password', { values })
          : $t('frameleaf_account_activity_log_hero_warn_sign_in', { values }),
        body: $t('frameleaf_account_activity_log_hero_warn_body', {
          values: {
            name: suspect.name,
            device,
            hasDevice: device ? 'yes' : 'no',
            place: activityPlace(latest.via),
            time: activityTime(latest.createdAt, $locale),
          },
        }),
      };
    }
    return {
      tone: 'good',
      icon: mdiAccountGroupOutline,
      title: $t('frameleaf_account_activity_log_hero_title'),
      body: $t('frameleaf_account_activity_log_hero_body', { values: { count: household } }),
    };
  });

  const openPerson = (id: string) => void goto(Route.viewUser({ id }));
  const rowAction = (event: ActivityEvent, row: ActivityRow) => {
    const person = row.warn ? people?.get(event.userId) : undefined;
    return person
      ? {
          text: $t('frameleaf_account_activity_log_open_person', { values: { name: person.name } }),
          label: $t('frameleaf_account_activity_log_open_person_label', { values: { name: person.name } }),
          chevron: true,
          onclick: () => openPerson(person.id),
        }
      : undefined;
  };
</script>

{#snippet heroActions()}
  {#if failed}
    <Button onclick={retry}>{$t('frameleaf_account_activity_try_again')}</Button>
  {:else if suspect}
    {@const person = suspect}
    <Button
      variant="primary"
      label={$t('frameleaf_account_activity_log_open_person_label', { values: { name: person.name } })}
      onclick={() => openPerson(person.id)}
    >
      {$t('frameleaf_account_activity_log_open_person', { values: { name: person.name } })}
      <Icon icon={mdiChevronRight} size="1em" aria-hidden />
    </Button>
  {/if}
{/snippet}

{#snippet whose()}
  <div class="who">
    <span aria-hidden="true">{$t('frameleaf_account_activity_log_whose')}</span>
    <Select
      label={$t('frameleaf_account_activity_log_whose_label')}
      value={who ?? EVERYONE}
      {options}
      onChange={(value) => onWho(value === EVERYONE ? undefined : value)}
    />
  </div>
{/snippet}

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_account_activity_log_title')}
    actions={failed || (hero.tone === 'warn' && suspect) ? heroActions : undefined}
  />

  {#if !failed && (events === null || events.length > 0 || feed.hasMore || who)}
    <ActivityList
      title={$t('frameleaf_account_activity_what_happened')}
      description={$t('frameleaf_account_activity_log_who_sees')}
      {events}
      people={people ?? new Map()}
      hasMore={feed.hasMore}
      loadingMore={feed.loadingMore}
      moreFailed={feed.moreFailed}
      onMore={() => void feed.more()}
      filter={whose}
      {rowAction}
      {now}
    />
  {/if}
</KitPage>

<style>
  .who {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .who :global(.kit-select) {
    min-width: 148px;
  }
  @container kit (max-width: 620px) {
    .who {
      justify-content: space-between;
      width: 100%;
    }
    .who :global(.kit-select) {
      width: auto;
    }
  }
</style>
