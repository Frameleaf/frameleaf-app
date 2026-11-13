<script lang="ts">
  /**
   * Personal › Your sign-in & privacy › Account activity (FL-824, the approved prototype's
   * `AccountActivity` in `settings-v2/cloud/AccountActivity.jsx`): your own sign-ins and changes to
   * your account, sharing and connected apps, newest first, read from `GET /users/me/activity`
   * (FL-808). It opens on the answer: when you last signed in, or that sign-ins did not work in the
   * last day. Sign-ins and security changes you made offer "This wasn't me".
   *
   * The answer is only as good as the rows loaded, so it says no more than they support: until they
   * reach back a full day and hold a sign-in (a few earlier pages load by themselves to get there),
   * it says "in what's shown so far".
   *
   * States: something to look at, nothing yet, nothing of this kind, loading, couldn't load (the
   * rest of settings stays usable), getting more and all shown.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import ActivityList from '$lib/components/frameleaf/settings/security/ActivityList.svelte';
  import WasntMeDialog from '$lib/components/frameleaf/settings/security/WasntMeDialog.svelte';
  import {
    ACTIVITY_AUTO_PAGES,
    ACTIVITY_PAGE_SIZE,
    activityDay,
    activityDevice,
    activityPlace,
    activityTime,
    coversLastDay,
    daysAgo,
    describeActivity,
    lastSignIn,
    recentFailures,
    type ActivityEvent,
    type ActivityRow,
  } from '$lib/frameleaf/account-activity';
  import { ActivityFeed } from '$lib/frameleaf/account-activity-feed.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getMyActivity } from '@frameleaf/sdk';
  import { mdiCloudAlertOutline, mdiHistory, mdiShieldAlertOutline, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  /** The moment "today" is measured from (for tests). */
  let { now = new Date() }: { now?: Date } = $props();

  const feed = new ActivityFeed((before) => getMyActivity({ before, take: ACTIVITY_PAGE_SIZE }));
  onMount(() => void feed.load());

  const events = $derived(feed.events);
  const failures = $derived(events ? recentFailures(events, now) : undefined);
  const last = $derived(events ? lastSignIn(events) : undefined);
  /** Whether the rows loaded hold the whole last day, so a count of it is complete. */
  const covered = $derived(events ? coversLastDay(events, feed.hasMore, now) : false);
  /** Whether the rows loaded can answer "is anything wrong, and when did I last sign in". */
  const answered = $derived(covered && (last !== undefined || !feed.hasMore));
  // The answer needs the last day's rows and the last sign-in: a few earlier pages load by themselves.
  $effect(() => {
    if (
      events &&
      !answered &&
      feed.hasMore &&
      !feed.loadingMore &&
      !feed.moreFailed &&
      feed.pages < ACTIVITY_AUTO_PAGES
    ) {
      untrack(() => void feed.more());
    }
  });

  const whenOf = (createdAt: string) =>
    $t('frameleaf_account_activity_day_time', {
      values: { day: activityDay($t, createdAt, now, $locale), time: activityTime(createdAt, $locale) },
    });

  type Answer = { tone: 'good' | 'warn' | 'quiet'; icon: string; title: string; body: string };
  const hero = $derived.by((): Answer => {
    if (feed.failed) {
      return {
        tone: 'warn',
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_account_activity_hero_error_title'),
        body: $t('frameleaf_account_activity_hero_error_body'),
      };
    }
    if (events === null) {
      return {
        tone: 'quiet',
        icon: mdiHistory,
        title: $t('frameleaf_account_activity_hero_loading_title'),
        body: $t('frameleaf_account_activity_hero_loading_body'),
      };
    }
    if (events.length === 0) {
      return {
        tone: 'quiet',
        icon: mdiHistory,
        title: $t('frameleaf_account_activity_hero_empty_title'),
        body: $t('frameleaf_account_activity_hero_empty_body'),
      };
    }
    if (failures) {
      const [latest] = failures.events;
      const device = activityDevice($t, latest);
      return {
        tone: 'warn',
        icon: mdiShieldAlertOutline,
        title: $t(
          failures.passwordOnly
            ? 'frameleaf_account_activity_hero_warn_password'
            : 'frameleaf_account_activity_hero_warn_sign_in',
          { values: { count: failures.events.length } },
        ),
        body:
          $t('frameleaf_account_activity_hero_warn_body', {
            values: {
              device,
              hasDevice: device ? 'yes' : 'no',
              place: activityPlace(latest.via),
              time: activityTime(latest.createdAt, $locale),
            },
          }) + (covered ? '' : ` ${$t('frameleaf_account_activity_hero_warn_more')}`),
      };
    }
    if (!answered) {
      // Earlier rows are still on the server: nothing is concluded about them.
      return {
        tone: 'quiet',
        icon: mdiHistory,
        title: $t('frameleaf_account_activity_hero_so_far_title'),
        body: $t('frameleaf_account_activity_hero_so_far_body'),
      };
    }
    const body = $t('frameleaf_account_activity_hero_last_body');
    if (!last) {
      return {
        tone: 'good',
        icon: mdiShieldCheckOutline,
        title: $t('frameleaf_account_activity_hero_last_none'),
        body,
      };
    }
    const time = activityTime(last.createdAt, $locale);
    const days = daysAgo(last.createdAt, now);
    const device = activityDevice($t, last);
    return {
      tone: 'good',
      icon: mdiShieldCheckOutline,
      title:
        days <= 0
          ? $t('frameleaf_account_activity_hero_last_today', { values: { time } })
          : days === 1
            ? $t('frameleaf_account_activity_hero_last_yesterday', { values: { time } })
            : $t('frameleaf_account_activity_hero_last_on', {
                values: { day: activityDay($t, last.createdAt, now, $locale), time },
              }),
      body: device
        ? $t('frameleaf_account_activity_hero_last_body_device', {
            values: { device, place: activityPlace(last.via) },
          })
        : body,
    };
  });

  // The row "This wasn't me" was pressed on.
  let target = $state<ActivityEvent>();
  const rowAction = (event: ActivityEvent, row: ActivityRow) =>
    row.wasntMe
      ? {
          text: $t('frameleaf_account_activity_wasnt_me'),
          label: $t('frameleaf_account_activity_wasnt_me_row', { values: { what: row.text } }),
          onclick: () => (target = event),
        }
      : undefined;
</script>

{#snippet heroActions()}
  {#if feed.failed}
    <Button onclick={() => void feed.load()}>{$t('frameleaf_account_activity_try_again')}</Button>
  {:else if failures}
    <Button variant="primary" onclick={() => (target = failures?.events[0])}>
      {$t('frameleaf_account_activity_wasnt_me')}
    </Button>
  {/if}
{/snippet}

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_account_activity_title')}
    actions={feed.failed || (events && events.length > 0 && failures) ? heroActions : undefined}
  />

  {#if !feed.failed && (events === null || events.length > 0 || feed.hasMore)}
    <ActivityList
      title={$t('frameleaf_account_activity_what_happened')}
      description={$t('frameleaf_account_activity_who_sees')}
      {events}
      hasMore={feed.hasMore}
      loadingMore={feed.loadingMore}
      moreFailed={feed.moreFailed}
      onMore={() => void feed.more()}
      {rowAction}
      {now}
    />
  {/if}
</KitPage>

{#if target}
  <WasntMeDialog
    what={describeActivity($t, target).text}
    when={whenOf(target.createdAt)}
    member={!authManager.user.isAdmin}
    onClose={() => (target = undefined)}
  />
{/if}
