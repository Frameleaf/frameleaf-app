<script lang="ts">
  /**
   * Library care › Nothing lost (FL-940, after the approved prototype `settings-v2/care/nothing-lost.jsx`):
   * every photo and video you added, where each one is now, and who removed what. Everyone has it for
   * their own library (`GET /users/me/ledger*`, FL-921). Administrators also get a "Whose photos" picker:
   * Everyone (the household's totals and who has anything missing) or one person (their totals). The
   * administrator's summary names no file, so those views never list one.
   *
   * Locked photos are always counted; the server lists them only while this session has Locked open.
   * It does not say which rows are Locked, so the prototype's Locked tag on a row is left out.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LockedUnlockDialog from '$lib/components/frameleaf/LockedUnlockDialog.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import {
    LEDGER_CHIPS,
    LEDGER_CHIP_STATE,
    LEDGER_STATES,
    LEDGER_STATE_ICONS,
    addedKey,
    inLibrary,
    ledgerMonth,
    ledgerRow,
    ledgerWhen,
    type LedgerChip,
    type LedgerState,
  } from '$lib/frameleaf/nothing-lost';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import {
    getLedger,
    getLedgerAdminSummary,
    getLedgerSummary,
    searchUsers,
    AssetLedgerState,
    searchUsersAdmin,
    type AssetLedgerAdminSummaryResponseDto,
    type AssetLedgerItemDto,
    type AssetLedgerSummaryResponseDto,
    type UserResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiChevronRight,
    mdiCloudAlertOutline,
    mdiEyeOffOutline,
    mdiImagePlusOutline,
    mdiLockOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiShieldSearch,
  } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  const YOU = 'you';
  const EVERYONE = 'everyone';
  /** Rows a page of the list holds. */
  const PAGE = 50;
  /** Months shown before "Show earlier months". */
  const MONTHS = 6;

  const me = $derived(authManager.user.id);
  const isAdmin = $derived(authManager.user.isAdmin);
  let whose = $state(YOU);
  const own = $derived(whose === YOU);
  const everyone = $derived(whose === EVERYONE);

  /** The people the reader can see, for names and pictures; anyone else is "Someone". */
  let people = $state(new Map<string, UserResponseDto>());
  const loadPeople = async () => {
    try {
      const users = isAdmin ? await searchUsersAdmin({ withDeleted: true }) : await searchUsers();
      people = new Map(users.map((user) => [user.id, user]));
    } catch {
      // the rows still show, saying "Someone"
    }
  };
  const names = $derived(new Map([...people].map(([id, user]) => [id, user.name])));
  const nameOf = (id: string) => names.get(id) || $t('frameleaf_ledger_someone');
  const person = $derived(own || everyone ? '' : nameOf(whose));

  type Summary = AssetLedgerSummaryResponseDto & Partial<AssetLedgerAdminSummaryResponseDto>;
  let summary = $state<Summary>();
  let failed = $state(false);
  let run = 0;
  const loadSummary = async () => {
    const current = ++run;
    summary = undefined;
    failed = false;
    try {
      const result = own ? await getLedgerSummary() : await getLedgerAdminSummary(everyone ? {} : { userId: whose });
      if (current === run) {
        summary = result;
      }
    } catch {
      if (current === run) {
        failed = true;
      }
    }
  };

  /** The originals that are gone with no record of a removal: the reader's own only. */
  let missing = $state<AssetLedgerItemDto[]>([]);
  let missingRun = 0;
  const loadMissing = async () => {
    // Rows read while Locked was open must not stay once it closes, nor arrive late over a newer read.
    const current = ++missingRun;
    missing = [];
    try {
      const page = await getLedger({ state: AssetLedgerState.Missing, size: PAGE });
      if (current === missingRun) {
        missing = page.items;
      }
    } catch {
      // the hero still says how many; the list stays empty
    }
  };

  let chip = $state<LedgerChip>('removed');
  let items = $state<AssetLedgerItemDto[]>();
  let cursor = $state<string | null>(null);
  let listFailed = $state(false);
  let listBusy = $state(false);
  let listRun = 0;
  const loadList = async (more = false) => {
    const current = ++listRun;
    if (!more) {
      items = undefined;
      cursor = null;
    }
    listFailed = false;
    listBusy = true;
    try {
      const page = await getLedger({
        state: LEDGER_CHIP_STATE[chip],
        size: PAGE,
        cursor: more ? (cursor ?? undefined) : undefined,
      });
      if (current === listRun) {
        items = more ? [...(items ?? []), ...page.items] : page.items;
        cursor = page.nextCursor;
      }
    } catch {
      if (current === listRun) {
        listFailed = true;
      }
    } finally {
      if (current === listRun) {
        listBusy = false;
      }
    }
  };

  $effect(() => {
    untrack(() => void loadPeople());
  });
  $effect(() => {
    void whose;
    untrack(() => {
      allMonths = false;
      void loadSummary();
    });
  });
  // The reader's own lists; they start again when another chip is chosen or Locked opens or closes.
  $effect(() => {
    void chip;
    void sessionAccess.isElevated;
    if (own) {
      untrack(() => void loadList());
    }
  });
  $effect(() => {
    void sessionAccess.isElevated;
    if (own && (summary?.states.missing ?? 0) > 0) {
      untrack(() => void loadMissing());
    }
  });

  const ready = $derived(!!summary && summary.total > 0);
  const number = (value: number) => value.toLocaleString($locale);
  const scope = $derived(own ? 'you' : everyone ? 'everyone' : 'person');

  type Answer = { tone: 'good' | 'warn' | 'quiet'; icon: string; title: string; body: string };
  const hero = $derived.by((): Answer => {
    if (failed) {
      return {
        tone: 'warn',
        icon: mdiCloudAlertOutline,
        title: $t('frameleaf_ledger_hero_error'),
        body: $t('frameleaf_ledger_hero_error_body'),
      };
    }
    if (!summary) {
      return {
        tone: 'quiet',
        icon: mdiShieldSearch,
        title: $t(everyone ? 'frameleaf_ledger_hero_loading_everyone' : 'frameleaf_ledger_hero_loading_you'),
        body: $t('frameleaf_ledger_hero_loading_body'),
      };
    }
    const { total, states } = summary;
    const values = { name: person };
    if (total === 0) {
      return {
        tone: 'quiet',
        icon: mdiImagePlusOutline,
        title: $t(`frameleaf_ledger_hero_empty_${scope}`, { values }),
        body: $t('frameleaf_ledger_hero_empty_body'),
      };
    }
    if (states.missing > 0) {
      const owners = everyone ? (summary.missingByOwner ?? []) : [];
      const where =
        owners.length === 1
          ? ' ' + $t('frameleaf_ledger_hero_missing_owner', { values: { name: nameOf(owners[0].ownerId) } })
          : owners.length > 1
            ? ' ' + $t('frameleaf_ledger_hero_missing_owners', { values: { people: owners.length } })
            : '';
      return {
        tone: 'warn',
        icon: mdiShieldAlertOutline,
        title: $t('frameleaf_ledger_hero_missing', { values: { count: states.missing } }),
        body:
          $t(`frameleaf_ledger_hero_missing_body_${scope}`, { values: { ...values, count: states.missing } }) +
          where +
          ' ' +
          $t('frameleaf_ledger_hero_missing_others', { values: { others: number(total - states.missing) } }),
      };
    }
    const parts = [
      $t(`frameleaf_ledger_part_library_${scope}`, { values: { ...values, count: number(inLibrary(states)) } }),
    ];
    if (states.trashed) {
      parts.push($t('frameleaf_ledger_part_trash', { values: { count: number(states.trashed) } }));
    }
    if (states.removed) {
      parts.push($t('frameleaf_ledger_part_removed', { values: { count: number(states.removed) } }));
    }
    const said = new Intl.ListFormat($locale, { type: 'conjunction' }).format(parts);
    return {
      tone: 'good',
      icon: mdiShieldCheckOutline,
      title: $t(`frameleaf_ledger_hero_ok_${scope}`, { values: { ...values, count: total } }),
      body: `${said}. ${$t(`frameleaf_ledger_hero_tail_${scope}`, { values })}`,
    };
  });

  const fileChecks = () => goto(commandCenterUrl('care', isAdmin ? 'integrity-checks' : 'files'));

  let allMonths = $state(false);
  const months = $derived(summary?.months ?? []);
  const shownMonths = $derived(allMonths ? months : months.slice(0, MONTHS));
  const monthCells = (states: Summary['states']) => [inLibrary(states), states.trashed, states.removed, states.missing];

  const options = $derived([
    { value: YOU, label: $t('frameleaf_ledger_whose_you') },
    { value: EVERYONE, label: $t('frameleaf_ledger_whose_everyone') },
    ...[...people.values()]
      .filter((user) => user.id !== me)
      .sort((a, b) => a.name.localeCompare(b.name, $locale))
      .map((user) => ({ value: user.id, label: user.name })),
  ]);

  const tileLabel = (state: LedgerState) =>
    $t(state === 'kept' && !own ? 'frameleaf_ledger_state_kept_others' : `frameleaf_ledger_state_${state}`);
  const tileNote = (state: LedgerState) =>
    $t(
      !own && state !== 'trashed' && state !== 'missing'
        ? `frameleaf_ledger_note_${state}_others`
        : `frameleaf_ledger_note_${state}`,
    );
  const sentence = (item: AssetLedgerItemDto) => {
    const row = ledgerRow(item, { me, names });
    return { ...row, text: $t(row.key, { values: { name: row.name || $t('frameleaf_ledger_someone') } }) };
  };
  const added = (item: AssetLedgerItemDto) =>
    $t(addedKey(item.addedVia), { values: { date: ledgerWhen(item.addedAt, $locale, { time: false }) } });

  let unlockOpen = $state(false);
</script>

{#snippet row(item: AssetLedgerItemDto, since: boolean)}
  {@const said = sentence(item)}
  <li class="row" class:has-badge={since}>
    <span class="tile" class:is-warn={said.warn} aria-hidden="true"><Icon icon={said.icon} size="22" /></span>
    <div class="main">
      <strong>{item.originalFileName}</strong>
      <span>
        {item.state === 'missing' ? said.text : `${said.text} · ${ledgerWhen(item.stateAt, $locale)}`}
      </span>
    </div>
    <span class="added">{added(item)}</span>
    {#if since}
      <Pill tone="warn">
        {$t('frameleaf_ledger_missing_since', {
          values: { date: ledgerWhen(item.stateAt, $locale, { time: false }) },
        })}
      </Pill>
    {/if}
  </li>
{/snippet}

<KitPage>
  {#if isAdmin}
    <div class="whose">
      <label>
        <span>{$t('frameleaf_ledger_whose_label')}</span>
        <Select
          label={$t('frameleaf_ledger_whose_label')}
          value={whose}
          {options}
          onChange={(value) => (whose = value)}
        />
      </label>
      <p>{$t(own ? 'frameleaf_ledger_whose_own' : 'frameleaf_ledger_whose_others')}</p>
    </div>
  {/if}

  <Hero tone={hero.tone} icon={hero.icon} title={hero.title} body={hero.body} label={$t('frameleaf_ledger_title')}>
    {#snippet actions()}
      {#if failed}
        <Button onclick={loadSummary}>{$t('frameleaf_ledger_try_again')}</Button>
      {:else if summary && summary.states.missing > 0}
        <Button variant="primary" onclick={fileChecks}>
          {$t(isAdmin ? 'frameleaf_ledger_open_file_checks' : 'frameleaf_ledger_see_missing_files')}
          <Icon icon={mdiChevronRight} size="1em" aria-hidden />
        </Button>
      {/if}
    {/snippet}
    {#if !failed && (!summary || ready)}
      <dl class="tiles" aria-busy={summary ? undefined : true}>
        {#each LEDGER_STATES as state (state)}
          {@const value = summary?.states[state] ?? 0}
          {@const warn = state === 'missing' && value > 0}
          <div class:is-warn={warn} class:is-calm={state === 'missing' && !warn}>
            <dt>
              <Icon icon={warn ? mdiAlertCircleOutline : LEDGER_STATE_ICONS[state]} size="18" aria-hidden />
              {tileLabel(state)}
            </dt>
            <dd>
              {#if summary}{number(value)}{:else}<span class="bone"></span>{/if}
              <small>{tileNote(state)}</small>
            </dd>
          </div>
        {/each}
      </dl>
    {/if}
  </Hero>

  {#if ready && summary && own && summary.states.missing > 0 && missing.length > 0}
    <Section title={$t('frameleaf_ledger_missing_title')} description={$t('frameleaf_ledger_missing_description')}>
      <ul class="list">
        {#each missing as item (item.assetId + item.stateAt)}
          {@render row(item, true)}
        {/each}
      </ul>
    </Section>
  {/if}

  {#if ready && summary && own}
    <Section title={$t('frameleaf_ledger_happened_title')} description={$t('frameleaf_ledger_happened_description')}>
      <div class="chips" role="group" aria-label={$t('frameleaf_ledger_show_label')}>
        {#each LEDGER_CHIPS as id (id)}
          <button type="button" aria-pressed={chip === id} onclick={() => (chip = id)}>
            {$t(`frameleaf_ledger_state_${id}`)}
            <span>{number(summary.states[id])}</span>
          </button>
        {/each}
      </div>
      {#if listFailed}
        <div class="none" role="alert">
          <strong>{$t('frameleaf_ledger_list_failed')}</strong>
          <Button onclick={() => loadList(!!items)}>{$t('frameleaf_ledger_try_again')}</Button>
        </div>
      {:else if !items}
        <ul class="list is-loading" aria-busy="true" aria-label={$t('frameleaf_ledger_happened_loading')}>
          {#each [0, 1, 2, 3] as index (index)}
            <li class="row">
              <span class="tile bone-tile"></span>
              <div class="main"><span class="bone"></span><span class="bone is-short"></span></div>
            </li>
          {/each}
        </ul>
      {:else if items.length === 0}
        <div class="none">
          <strong>{$t(`frameleaf_ledger_none_${chip}`)}</strong>
          <p>{$t('frameleaf_ledger_none_body')}</p>
        </div>
      {:else}
        <ul class="list">
          {#each items as item (item.assetId + item.stateAt)}
            {@render row(item, false)}
          {/each}
        </ul>
        <div class="more">
          {#if chip === 'trashed'}
            <Button onclick={() => goto(Route.trash())}>
              {$t('frameleaf_ledger_open_trash')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          {/if}
          {#if chip === 'merged' && unusedFilesAccess.isOwner}
            <Button onclick={() => goto(commandCenterUrl('care', 'unused-files'))}>
              {$t('frameleaf_ledger_open_unused')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          {/if}
          {#if cursor}
            <Button disabled={listBusy} onclick={() => loadList(true)}>{$t('frameleaf_ledger_show_more')}</Button>
          {:else}
            <p>{$t('frameleaf_ledger_all_shown')}</p>
          {/if}
        </div>
      {/if}
      {#if !sessionAccess.isElevated}
        <div class="locked">
          <Icon icon={mdiLockOutline} size="18" aria-hidden />
          <p>
            {$t('frameleaf_ledger_locked_line')}
            <button type="button" class="link" onclick={() => (unlockOpen = true)}>
              {$t('frameleaf_ledger_open_locked')}
            </button>
          </p>
        </div>
      {/if}
    </Section>
  {/if}

  {#if ready && summary && everyone}
    <Section title={$t('frameleaf_ledger_people_title')} description={$t('frameleaf_ledger_people_description')}>
      <ul class="people">
        {#each summary.byOwner ?? [] as theirs (theirs.ownerId)}
          {@const user = people.get(theirs.ownerId)}
          {@const gone = summary.missingByOwner?.find((entry) => entry.ownerId === theirs.ownerId)}
          <li>
            <span class="face"
              >{#if user}<UserAvatar {user} noTitle />{/if}</span
            >
            <div>
              <strong>{nameOf(theirs.ownerId)}</strong>
              <span>
                {$t('frameleaf_ledger_person_totals', {
                  values: { added: number(theirs.total), library: number(inLibrary(theirs.states)) },
                })}
              </span>
            </div>
            <div class="people-status">
              {#if gone}
                <Pill tone="warn"
                  >{$t('frameleaf_ledger_count_missing', { values: { count: number(gone.count) } })}</Pill
                >
                <small>
                  {$t('frameleaf_ledger_person_since', {
                    values: { date: ledgerWhen(gone.since, $locale, { time: false }) },
                  })}
                </small>
              {:else}
                <Pill tone="good">{$t('frameleaf_ledger_person_ok')}</Pill>
              {/if}
            </div>
            <Button
              label={theirs.ownerId === me
                ? $t('frameleaf_ledger_show_yours')
                : $t('frameleaf_ledger_show_theirs', { values: { name: nameOf(theirs.ownerId) } })}
              onclick={() => (whose = theirs.ownerId === me ? YOU : theirs.ownerId)}
            >
              {$t('frameleaf_ledger_show')}<Icon icon={mdiChevronRight} size="1em" aria-hidden />
            </Button>
          </li>
        {/each}
      </ul>
    </Section>
  {/if}

  {#if ready && summary && !own && !everyone}
    <Notice tone="info" icon={mdiEyeOffOutline} title={$t('frameleaf_ledger_only_title', { values: { name: person } })}>
      {$t('frameleaf_ledger_only_body', { values: { name: person } })}
      {#if summary.states.missing > 0}{$t('frameleaf_ledger_only_body_missing')}{/if}
    </Notice>
  {/if}

  {#if ready && summary && !everyone && months.length > 0}
    <Section
      title={$t('frameleaf_ledger_months_title')}
      description={own
        ? $t('frameleaf_ledger_months_description_you')
        : $t('frameleaf_ledger_months_description_person', { values: { name: person } })}
    >
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">{$t('frameleaf_ledger_col_month')}</th>
              <th scope="col">{$t('frameleaf_ledger_col_added')}</th>
              <th scope="col">{$t('frameleaf_ledger_state_kept_others')}</th>
              <th scope="col">{$t('frameleaf_ledger_state_trashed')}</th>
              <th scope="col">{$t('frameleaf_ledger_state_removed')}</th>
              <th scope="col">{$t('frameleaf_ledger_state_missing')}</th>
            </tr>
          </thead>
          <tbody>
            {#each shownMonths as month (month.month)}
              <tr>
                <th scope="row">{ledgerMonth(month.month, $locale)}</th>
                <td class:is-zero={month.total === 0}>{number(month.total)}</td>
                {#each monthCells(month.states) as value, index (index)}
                  <td class:is-zero={value === 0} class:is-warn={index === 3 && value > 0}>{number(value)}</td>
                {/each}
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <ul class="months" aria-label={$t('frameleaf_ledger_months_title')}>
        {#each shownMonths as month (month.month)}
          {@const [library, trashed, removed, gone] = monthCells(month.states)}
          <li>
            <strong>
              {ledgerMonth(month.month, $locale)}
              <span>{$t('frameleaf_ledger_month_added', { values: { count: number(month.total) } })}</span>
            </strong>
            <span>
              {[
                $t('frameleaf_ledger_month_library', { values: { count: number(library) } }),
                trashed > 0 && $t('frameleaf_ledger_part_trash', { values: { count: number(trashed) } }),
                removed > 0 && $t('frameleaf_ledger_month_removed', { values: { count: number(removed) } }),
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
            {#if gone > 0}
              <Pill tone="warn">{$t('frameleaf_ledger_count_missing', { values: { count: number(gone) } })}</Pill>
            {/if}
          </li>
        {/each}
      </ul>
      <div class="more">
        {#if !allMonths && months.length > MONTHS}
          <Button onclick={() => (allMonths = true)}>{$t('frameleaf_ledger_months_more')}</Button>
        {:else}
          <p>
            {own
              ? $t('frameleaf_ledger_months_all_you', {
                  values: { month: ledgerMonth(months.at(-1)!.month, $locale) },
                })
              : $t('frameleaf_ledger_months_all_person', {
                  values: { name: person, month: ledgerMonth(months.at(-1)!.month, $locale) },
                })}
          </p>
        {/if}
      </div>
    </Section>
  {/if}
</KitPage>

<LockedUnlockDialog bind:open={unlockOpen} onUnlocked={() => (unlockOpen = false)} />

<style>
  /* The prototype's settings-v2/care/nothing-lost.css, drawn with the app's tokens. */
  .whose {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-5);
  }
  .whose label {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    margin: 0;
    gap: var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    white-space: nowrap;
  }
  .whose p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }

  /* The five places an original can be, under the hero's rule. */
  .tiles {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    margin: 0;
    border-top: 1px solid var(--fl-border);
  }
  .tiles > div {
    display: grid;
    align-content: start;
    gap: 10px;
    padding: var(--fl-space-6);
    border-inline-start: 1px solid var(--fl-border);
  }
  .tiles > div:first-child {
    border-inline-start: 0;
  }
  .tiles dt {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .tiles dt :global(svg) {
    flex-shrink: 0;
  }
  .tiles dd {
    margin: 0;
    font-size: var(--fl-font-title);
    font-weight: 600;
    letter-spacing: -0.3px;
    font-variant-numeric: tabular-nums;
  }
  .tiles dd small {
    display: block;
    margin-top: 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
    letter-spacing: 0;
    line-height: 1.45;
  }
  .tiles > .is-warn dt,
  .tiles > .is-warn dd {
    color: var(--fl-warning);
  }
  .tiles > .is-calm dd {
    color: var(--fl-muted);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    padding-bottom: var(--fl-space-4);
  }
  .chips button {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 36px;
    padding: 0 var(--fl-space-4);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .chips button span {
    font-variant-numeric: tabular-nums;
  }
  .chips button:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .chips button[aria-pressed='true'] {
    border-color: color-mix(in srgb, var(--fl-accent) 45%, var(--fl-border));
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    color: var(--fl-text);
    font-weight: 600;
  }

  .list,
  .people,
  .months {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 76px;
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .row.has-badge {
    grid-template-columns: 44px minmax(0, 1fr) auto auto;
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .tile.is-warn {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 14%, transparent);
  }
  .main > strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .main > span {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .added {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-align: end;
  }

  /* The foot of a list: more to show, or a way on. */
  .more {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-3) var(--fl-space-4);
    padding: var(--fl-space-6) 0;
    border-top: 1px solid var(--fl-border);
  }
  .more > p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
    text-align: center;
  }
  .none {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-10) var(--fl-space-4) var(--fl-space-12);
    border-top: 1px solid var(--fl-border);
    text-align: center;
  }
  .none strong {
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .none p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }

  .locked {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-3);
    padding: var(--fl-space-5) 0 var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .locked p {
    margin: 0;
  }
  .link {
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    font-weight: 600;
  }
  .link:hover {
    text-decoration: underline;
  }

  /* Everyone: one row a person. */
  .people li {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) minmax(0, auto) auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 76px;
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .face {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }
  .people li > div > strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .people li > div > span,
  .people-status small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .people-status {
    display: grid;
    justify-items: end;
  }

  /* By month: a table, and on a narrow page one line a month. */
  .table-wrap {
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--fl-font-callout);
    font-variant-numeric: tabular-nums;
  }
  th,
  td {
    height: 52px;
    padding: 0 var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
    text-align: end;
    white-space: nowrap;
  }
  th:first-child {
    padding-inline-start: 0;
    text-align: start;
  }
  th:last-child,
  td:last-child {
    padding-inline-end: 0;
  }
  thead th {
    height: 44px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  tbody th {
    font-weight: 600;
  }
  td.is-zero {
    color: var(--fl-muted);
  }
  td.is-warn {
    color: var(--fl-warning);
    font-weight: 600;
  }
  .months {
    display: none;
  }
  .months li {
    display: grid;
    gap: 6px;
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .months strong {
    display: flex;
    justify-content: space-between;
    gap: var(--fl-space-3);
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .months strong span {
    font-variant-numeric: tabular-nums;
  }
  .months li > span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }

  /* Loading: tiles and rows the size of the real ones. */
  .bone,
  .bone-tile {
    display: block;
    background: var(--fl-raised);
    animation: pulse 1.4s ease-in-out infinite;
  }
  .bone {
    width: min(120px, 70%);
    height: 24px;
    border-radius: var(--fl-radius-control);
  }
  .main > .bone {
    width: min(320px, 80%);
    height: 14px;
    margin-top: 0;
  }
  .main > .bone.is-short {
    width: min(180px, 45%);
    margin-top: 10px;
  }
  .list.is-loading .row {
    grid-template-columns: 44px minmax(0, 1fr);
  }
  @keyframes pulse {
    50% {
      opacity: 0.45;
    }
  }

  @container kit (max-width: 980px) {
    .tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
    .tiles > div {
      border-top: 1px solid var(--fl-border);
    }
    .tiles > div:nth-child(-n + 3) {
      border-top: 0;
    }
    .tiles > div:nth-child(3n + 1) {
      border-inline-start: 0;
    }
  }
  @container kit (max-width: 620px) {
    .tiles {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .tiles > div {
      padding: var(--fl-space-5);
      border-inline-start: 0;
    }
    .tiles > div:nth-child(-n + 3) {
      border-top: 1px solid var(--fl-border);
    }
    .tiles > div:nth-child(-n + 2) {
      border-top: 0;
    }
    .tiles > div:nth-child(2n) {
      border-inline-start: 1px solid var(--fl-border);
    }
    /* The last tile on its own row spans it, so nothing looks missing. */
    .tiles > div:last-child:nth-child(odd) {
      grid-column: 1 / -1;
    }
    .tiles dd {
      font-size: var(--fl-font-headline);
    }
    .row,
    .row.has-badge,
    .people li {
      grid-template-columns: 44px minmax(0, 1fr);
      align-items: start;
      gap: var(--fl-space-2) var(--fl-space-4);
    }
    .added,
    .row > :global(.kit-pill),
    .people-status,
    .people li > :global(button) {
      grid-column: 2;
      justify-self: start;
      text-align: start;
    }
    .people-status {
      justify-items: start;
    }
    .chips button {
      min-height: 40px;
    }
    .table-wrap {
      display: none;
    }
    .months {
      display: block;
    }
    .whose label {
      width: 100%;
      justify-content: space-between;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .bone,
    .bone-tile {
      animation: none;
    }
  }
</style>
