<script lang="ts">
  /**
   * Storage & originals › Deleted items (FL-365, the approved prototype's
   * `settings-v2/library/deleted.jsx`): how long deleted photos and deleted accounts can be brought
   * back, for everyone on this server. One page in place of "Trash & retention" and "Deleted
   * accounts" (their old addresses open it).
   *
   * - "Keep deleted photos for" is a list with the last date said back. There is no "delete straight
   *   away" choice (owner call defaulted on FL-365): a saved 0, or a Trash that is off, still reads
   *   back honestly, and choosing any length turns the Trash on.
   * - A shorter time says, before saving, how many photos already in the Trash go tonight
   *   (`getTrashEveryone` with the proposed length).
   * - The Trash is emptied by the overnight tidy-up, and nothing is removed while that step is off.
   * - The administrator sees how much each person has waiting, never the photos.
   *
   * The lengths are ordinary settings (`trash.days`, `user.deleteDelay`), saved with the settings bar.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Coverage, { type CoverageRow } from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import {
    KEEP_ACCOUNT_DAYS,
    KEEP_PHOTO_DAYS,
    keepChoice,
    lastDay,
    RECOMMENDED_ACCOUNT_DAYS,
    RECOMMENDED_PHOTO_DAYS,
  } from '$lib/components/frameleaf/settings/storage/storage';
  import { formatBytes } from '$lib/frameleaf/physical-dedup';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getTrashEveryone,
    restoreUserAdmin,
    searchUsersAdmin,
    type TrashEveryoneResponseDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { mdiAccountOutline, mdiDeleteRestore, mdiImageMultipleOutline, mdiTrashCanOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const settingsDraft = getSystemConfigDraft();
  const draft = $derived(settingsDraft?.draft);
  const baseline = $derived(settingsDraft?.baseline);
  const disabled = $derived(featureFlagsManager.value.configFile || !draft);

  /** What is saved now: 0 while the Trash is off. */
  const savedDays = $derived(baseline ? (baseline.trash.enabled ? baseline.trash.days : 0) : RECOMMENDED_PHOTO_DAYS);
  const days = $derived(draft ? (draft.trash.enabled ? draft.trash.days : 0) : savedDays);
  const accountDays = $derived(draft?.user.deleteDelay ?? RECOMMENDED_ACCOUNT_DAYS);
  const savedAccountDays = $derived(baseline?.user.deleteDelay ?? RECOMMENDED_ACCOUNT_DAYS);
  const tidyOn = $derived(baseline?.nightlyTasks.databaseCleanup ?? true);

  let everyone = $state<TrashEveryoneResponseDto | null>(null);
  let proposed = $state<TrashEveryoneResponseDto | null>(null);
  let waitingAccounts = $state<UserAdminResponseDto[]>([]);
  let said = $state('');

  const loadAccounts = async () => {
    try {
      waitingAccounts = (await searchUsersAdmin({ withDeleted: true })).filter((user) => !!user.deletedAt);
    } catch {
      waitingAccounts = [];
    }
  };
  onMount(() => {
    void getTrashEveryone({})
      .then((value) => (everyone = value))
      .catch(() => (everyone = null));
    void loadAccounts();
  });

  // What a shorter length would remove tonight, read again whenever the length on the page changes.
  $effect(() => {
    const length = days;
    if (length <= 0 || length >= savedDays || savedDays === 0) {
      proposed = null;
      return;
    }
    let cancelled = false;
    void getTrashEveryone({ days: length })
      .then((value) => {
        if (!cancelled) {
          proposed = value;
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  });

  const date = (value: Date) => new Intl.DateTimeFormat($locale, { day: 'numeric', month: 'long' }).format(value);
  const size = (bytes: number) => formatBytes(bytes);
  const daysWords = (count: number) =>
    count >= 365 && count % 365 === 0
      ? $t('frameleaf_deleted_years', { values: { count: count / 365 } })
      : $t('frameleaf_deleted_days', { values: { count } });

  const photoOptions = $derived([
    ...KEEP_PHOTO_DAYS.map((value) => ({
      value: String(value),
      label:
        value === RECOMMENDED_PHOTO_DAYS
          ? $t('frameleaf_deleted_recommended', { values: { length: daysWords(value) } })
          : daysWords(value),
    })),
    { value: 'custom', label: $t('frameleaf_deleted_another_length') },
  ]);
  const accountOptions = $derived([
    ...KEEP_ACCOUNT_DAYS.map((value) => ({
      value: String(value),
      label:
        value === RECOMMENDED_ACCOUNT_DAYS
          ? $t('frameleaf_deleted_recommended', { values: { length: daysWords(value) } })
          : daysWords(value),
    })),
    { value: 'custom', label: $t('frameleaf_deleted_another_length') },
  ]);

  let photoCustom = $state(false);
  let accountCustom = $state(false);
  const photoChoice = $derived(photoCustom || days === 0 ? 'custom' : keepChoice(days, KEEP_PHOTO_DAYS));
  const accountChoice = $derived(accountCustom ? 'custom' : keepChoice(accountDays, KEEP_ACCOUNT_DAYS));

  const setPhotoDays = (value: number) => {
    if (draft && Number.isFinite(value) && value >= 1) {
      draft.trash.days = Math.min(36_500, Math.round(value));
      draft.trash.enabled = true;
    }
  };
  const setAccountDays = (value: number) => {
    if (draft && Number.isFinite(value) && value >= 1) {
      draft.user.deleteDelay = Math.min(3650, Math.round(value));
    }
  };

  const off = $derived(savedDays === 0);
  const heroTone = $derived(off ? 'bad' : tidyOn ? 'good' : 'warn');
  const heroTitle = $derived(
    off
      ? $t('frameleaf_deleted_hero_off')
      : tidyOn
        ? $t('frameleaf_deleted_hero', { values: { length: daysWords(savedDays) } })
        : $t('frameleaf_deleted_hero_tidy_off'),
  );
  const heroBody = $derived(
    off
      ? $t('frameleaf_deleted_hero_off_body')
      : !tidyOn
        ? $t('frameleaf_deleted_hero_tidy_off_body', { values: { length: daysWords(savedDays) } })
        : everyone
          ? $t('frameleaf_deleted_hero_body', { values: { count: everyone.count, size: size(everyone.bytes) } })
          : '',
  );
  const coverage = $derived<CoverageRow[]>([
    {
      icon: mdiImageMultipleOutline,
      name: $t('frameleaf_deleted_photos'),
      detail: off
        ? $t('frameleaf_deleted_removed_at_once')
        : $t('frameleaf_deleted_kept_for', { values: { length: daysWords(savedDays) } }),
      tone: off ? 'bad' : tidyOn ? 'good' : 'warn',
      value: everyone ? $t('frameleaf_deleted_waiting', { values: { count: everyone.count } }) : '—',
      note: everyone ? size(everyone.bytes) : undefined,
    },
    {
      icon: mdiAccountOutline,
      name: $t('frameleaf_deleted_accounts'),
      detail: $t('frameleaf_deleted_kept_for', { values: { length: daysWords(savedAccountDays) } }),
      tone: waitingAccounts.length > 0 ? 'warn' : 'off',
      value:
        waitingAccounts.length > 0
          ? $t('frameleaf_deleted_waiting', { values: { count: waitingAccounts.length } })
          : $t('frameleaf_deleted_none_waiting'),
    },
  ]);

  const nextGoes = (oldest: string | null) => {
    if (!oldest || savedDays === 0) {
      return '';
    }
    const goes = new Date(new Date(oldest).getTime() + savedDays * 86_400_000);
    return goes.getTime() <= Date.now()
      ? $t('frameleaf_deleted_goes_tonight')
      : $t('frameleaf_deleted_next_goes', { values: { date: date(goes) } });
  };

  const restore = async (user: UserAdminResponseDto) => {
    try {
      await restoreUserAdmin({ id: user.id });
      said = $t('frameleaf_deleted_restored', { values: { name: user.name } });
      await loadAccounts();
    } catch {
      said = $t('frameleaf_deleted_restore_failed', { values: { name: user.name } });
    }
  };
</script>

<KitPage>
  {#if said}
    <Said message={said} onDismiss={() => (said = '')} />
  {/if}

  <Hero
    tone={heroTone}
    icon={off ? mdiTrashCanOutline : mdiDeleteRestore}
    title={heroTitle}
    body={heroBody}
    label={$t('frameleaf_deleted_status')}
  >
    {#snippet actions()}
      {#if !tidyOn}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}
          >{$t('frameleaf_deleted_open_overnight')}</Button
        >
      {:else}
        <Button onclick={() => goto(commandCenterUrl('trash', 'contents'))}>{$t('frameleaf_deleted_open_trash')}</Button
        >
      {/if}
    {/snippet}
    <Coverage rows={coverage} />
  </Hero>

  <Section title={$t('frameleaf_deleted_photos_title')} description={$t('frameleaf_deleted_photos_description')}>
    <Row
      label={$t('frameleaf_deleted_keep_photos')}
      help={days > 0
        ? $t('frameleaf_deleted_keep_photos_help', { values: { date: date(lastDay(days)) } })
        : $t('frameleaf_deleted_keep_photos_off_help')}
    >
      <div class="inline">
        {#if photoChoice === 'custom'}
          <input
            type="number"
            min="1"
            max="36500"
            aria-label={$t('frameleaf_deleted_keep_photos_days')}
            value={days || ''}
            {disabled}
            oninput={(event) => setPhotoDays(Number(event.currentTarget.value))}
          />
          <span class="unit">{$t('frameleaf_deleted_days_unit')}</span>
        {/if}
        <select
          aria-label={$t('frameleaf_deleted_keep_photos')}
          value={photoChoice}
          {disabled}
          onchange={(event) => {
            const value = event.currentTarget.value;
            photoCustom = value === 'custom';
            if (value !== 'custom') {
              setPhotoDays(Number(value));
            }
          }}
        >
          {#each photoOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </div>
    </Row>
    {#if proposed && proposed.removedTonight > 0}
      <div class="pad">
        <Notice
          tone="warn"
          title={$t('frameleaf_deleted_shorter_title', {
            values: { count: proposed.removedTonight, length: daysWords(days) },
          })}
        >
          {$t('frameleaf_deleted_shorter_body')}
        </Notice>
      </div>
    {/if}
    <Row
      label={tidyOn ? $t('frameleaf_deleted_overnight') : $t('frameleaf_deleted_overnight_off')}
      help={tidyOn ? $t('frameleaf_deleted_overnight_help') : $t('frameleaf_deleted_overnight_off_help')}
    >
      <Button onclick={() => goto(commandCenterUrl('processing', 'nightly-tasks'))}
        >{$t('frameleaf_deleted_overnight_button')}</Button
      >
    </Row>
  </Section>

  <Section title={$t('frameleaf_deleted_waiting_title')} description={$t('frameleaf_deleted_waiting_description')}>
    {#if everyone && everyone.accounts.length > 0}
      <ItemList>
        {#each everyone.accounts as account (account.userId)}
          <Item
            icon={mdiAccountOutline}
            name={account.name}
            tone={nextGoes(account.oldestDeletedAt) === $t('frameleaf_deleted_goes_tonight') ? 'warn' : 'good'}
            status={nextGoes(account.oldestDeletedAt)}
            note={$t('frameleaf_deleted_account_waiting', {
              values: { count: account.count, size: size(account.bytes) },
            })}
          />
        {/each}
      </ItemList>
    {:else}
      <p class="hint pad">{everyone ? $t('frameleaf_deleted_nothing_waiting') : $t('frameleaf_deleted_unread')}</p>
    {/if}
  </Section>

  <Section title={$t('frameleaf_deleted_accounts_title')} description={$t('frameleaf_deleted_accounts_description')}>
    {#snippet action()}
      <Button onclick={() => goto(commandCenterUrl('users'))}>{$t('frameleaf_deleted_open_users')}</Button>
    {/snippet}
    <Row
      label={$t('frameleaf_deleted_keep_account')}
      help={$t('frameleaf_deleted_keep_account_help', { values: { date: date(lastDay(accountDays)) } })}
    >
      <div class="inline">
        {#if accountChoice === 'custom'}
          <input
            type="number"
            min="1"
            max="3650"
            aria-label={$t('frameleaf_deleted_keep_account_days')}
            value={accountDays}
            {disabled}
            oninput={(event) => setAccountDays(Number(event.currentTarget.value))}
          />
          <span class="unit">{$t('frameleaf_deleted_days_unit')}</span>
        {/if}
        <select
          aria-label={$t('frameleaf_deleted_keep_account')}
          value={accountChoice}
          {disabled}
          onchange={(event) => {
            const value = event.currentTarget.value;
            accountCustom = value === 'custom';
            if (value !== 'custom') {
              setAccountDays(Number(value));
            }
          }}
        >
          {#each accountOptions as option (option.value)}
            <option value={option.value}>{option.label}</option>
          {/each}
        </select>
      </div>
    </Row>
    {#if accountDays < savedAccountDays && waitingAccounts.length > 0}
      <div class="pad">
        <Notice tone="warn" title={$t('frameleaf_deleted_accounts_sooner')}
          >{$t('frameleaf_deleted_accounts_sooner_body')}</Notice
        >
      </div>
    {/if}
    <ItemList>
      {#each waitingAccounts as user (user.id)}
        <Item
          icon={mdiAccountOutline}
          quiet
          name={user.name}
          detail={user.email}
          tone="warn"
          status={user.deletedAt
            ? $t('frameleaf_deleted_removed_on', {
                values: { date: date(lastDay(savedAccountDays, new Date(user.deletedAt))) },
              })
            : undefined}
        >
          {#snippet action()}
            <Button onclick={() => restore(user)}>{$t('frameleaf_deleted_restore')}</Button>
          {/snippet}
        </Item>
      {:else}
        <Item
          icon={mdiAccountOutline}
          quiet
          off
          name={$t('frameleaf_deleted_no_accounts')}
          detail={$t('frameleaf_deleted_no_accounts_detail')}
        />
      {/each}
    </ItemList>
  </Section>
  <SettingActions keys={['trash', 'user']} {disabled} />
</KitPage>

<style>
  .inline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .unit {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  select,
  input[type='number'] {
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  input[type='number'] {
    width: 6rem;
  }
  .pad {
    padding-bottom: var(--fl-space-5);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
