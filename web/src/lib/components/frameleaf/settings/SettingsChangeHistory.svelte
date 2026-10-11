<script lang="ts">
  /**
   * Change history in plain words (FL-368, after the approved prototype
   * `settings-v2/server/history.jsx`; the record itself is FL-66 and FL-71 CC-10). Every change is
   * written in the words on the page it came from (`setting-words.ts`): one or two changes are the
   * entry's title, more are counted and open in place. Each entry says when, who, the device only
   * when it is known, whether it was for the whole server or just this account, and the page it
   * lives on with a way to open it.
   *
   * - For an administrator: the server's settings history. Credential entries name the credential
   *   and never a value; a change from the server command line or Frameleaf Cloud says so.
   * - For everyone: the account's own preference history. Locked-content rules appear only as changed.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { describeChange, settingLabel, type SettingKind, type SettingPage } from '$lib/frameleaf/setting-words';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import {
    SystemConfigHistoryCredentialChange,
    SystemConfigHistorySource,
    type SystemConfigHistoryChangeDto,
    type SystemConfigHistoryEntryDto,
    type UserPreferenceHistoryEntryDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountCircleOutline, mdiArrowRight, mdiHistory, mdiServerOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The server settings history; undefined for an account without administration. */
    entries?: SystemConfigHistoryEntryDto[] | null;
    /** The account's own preference history; null while it loads. */
    preferences: UserPreferenceHistoryEntryDto[] | null;
    /** The signed-in account's name, for its own entries. */
    ownName: string;
    error?: boolean;
    onRetry: () => void;
    onConfigure: () => void;
    configureLabel: string;
    /** The name of a settings page as the navigation says it: "Server & updates › Updates". */
    pageTitle?: (page: SettingPage) => string | undefined;
    /** The moment "today" is measured from (for tests). */
    now?: Date;
  };

  let {
    entries,
    preferences,
    ownName,
    error = false,
    onRetry,
    onConfigure,
    configureLabel,
    pageTitle,
    now = new Date(),
  }: Props = $props();

  type RawChange = { path: string; before: string | null; after: string | null; protected?: boolean } & Partial<
    Pick<SystemConfigHistoryChangeDto, 'credential'>
  >;
  type Change = { key: string; label: string; before: string; after: string; said: string; page?: SettingPage };
  type Item = {
    id: string;
    createdAt: string;
    title: string;
    changes: Change[];
    omitted: number;
    by: string;
    kind: SettingKind;
    pages: { page: SettingPage; title: string }[];
  };

  const decode = (text: string | null): unknown => {
    if (text === null) {
      return null;
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // A value the server shortened is no longer valid JSON; show it as text.
      return text;
    }
  };

  const words = (kind: SettingKind, change: RawChange): Change => {
    const label = settingLabel($t, kind, change.path);
    if (change.credential) {
      const after =
        change.credential === SystemConfigHistoryCredentialChange.Cleared
          ? $t('frameleaf_words_secret_removed')
          : $t('frameleaf_words_secret_saved');
      return { key: change.path, label, before: '', after, said: `${label}: ${after}` };
    }
    if (change.protected) {
      const after = $t('frameleaf_settings_history_protected');
      return { key: change.path, label, before: '', after, said: `${label}: ${after}` };
    }
    return {
      key: change.path,
      ...describeChange($t, kind, {
        path: change.path,
        before: decode(change.before),
        after: decode(change.after),
      }),
    };
  };

  /**
   * Who saved an entry. A change from the server command line or a Frameleaf Cloud action is labelled
   * with its source, after the administrator who started it when there was one (FL-146).
   */
  const settingsBy = (entry: SystemConfigHistoryEntryDto) => {
    const source =
      entry.source === SystemConfigHistorySource.ServerCli
        ? $t('frameleaf_settings_history_source_server_cli')
        : entry.source === SystemConfigHistorySource.FrameleafCloud
          ? $t('frameleaf_settings_history_source_frameleaf_cloud')
          : undefined;
    if (source) {
      return entry.actorName ? `${entry.actorName} · ${source}` : source;
    }
    return entry.actorName ?? $t('frameleaf_settings_history_unknown_actor');
  };

  const item = (
    kind: SettingKind,
    entry: { id: string; createdAt: string; changes: RawChange[]; omittedChanges: number },
    by: string,
    recorded?: string | null,
  ): Item => {
    const changes = entry.changes.map((change) => words(kind, change));
    const total = changes.length + entry.omittedChanges;
    const pages: Item['pages'] = [];
    for (const change of changes) {
      const title = change.page && pageTitle?.(change.page);
      if (change.page && title && pages.every((known) => known.title !== title)) {
        pages.push({ page: change.page, title });
      }
    }
    return {
      id: `${kind}:${entry.id}`,
      createdAt: entry.createdAt,
      // One or two changes are the title; more are counted. A title the server recorded for an
      // action (a review, a credential) is kept.
      title:
        recorded ||
        (total <= 2 && changes.length === total && total > 0
          ? changes.map((change) => change.said).join(' · ')
          : $t('frameleaf_words_history_count', { values: { count: total } })),
      changes,
      omitted: entry.omittedChanges,
      by,
      kind,
      pages,
    };
  };

  const items = $derived.by((): Item[] | null => {
    if (preferences === null || entries === null) {
      return null;
    }
    const settings = (entries ?? []).map((entry) => item('server', entry, settingsBy(entry), entry.title));
    const own = preferences.map((entry) =>
      // The device is named when it is known and left out when it is not.
      item('preference', entry, entry.deviceLabel ? `${ownName} · ${entry.deviceLabel}` : ownName),
    );
    return [...settings, ...own].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  });

  const DAYS = ['today', 'yesterday', 'week', 'earlier'] as const;
  type Day = (typeof DAYS)[number];
  const dayOf = (value: string): Day => {
    const days = DateTime.fromJSDate(now).startOf('day').diff(DateTime.fromISO(value).startOf('day'), 'days').days;
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 7 ? 'week' : 'earlier';
  };
  const groups = $derived(
    DAYS.map((day) => ({ day, items: (items ?? []).filter((entry) => dayOf(entry.createdAt) === day) })).filter(
      (group) => group.items.length > 0,
    ),
  );

  /** "Yesterday at 11:50 PM", "Tuesday at 8:02 PM", "28 September at 4:20 PM". */
  const whenOf = (value: string) => {
    const date = DateTime.fromISO(value).setLocale($locale ?? 'en');
    if (!date.isValid) {
      return value;
    }
    const time = date.toLocaleString(DateTime.TIME_SIMPLE);
    const day = dayOf(value);
    const dayWords =
      day === 'today'
        ? $t('frameleaf_words_history_today')
        : day === 'yesterday'
          ? $t('frameleaf_words_history_yesterday')
          : day === 'week'
            ? date.toFormat('cccc')
            : date.toLocaleString(
                date.year === now.getFullYear() ? { day: 'numeric', month: 'long' } : DateTime.DATE_FULL,
              );
    return $t('frameleaf_words_history_when', { values: { day: dayWords, time } });
  };

  const few = (entry: Item) => entry.changes.length <= 2 && entry.omitted === 0;
  /** Whether the entry's title already says its changes, so there is nothing more to open. */
  const titled = (entry: Item) => entry.title === entry.changes.map((change) => change.said).join(' · ');
</script>

<KitPage>
  {#if error}
    <InlineError message={$t('frameleaf_settings_history_load_failed')} {onRetry} />
  {:else if items && items.length === 0}
    <Hero
      tone="quiet"
      icon={mdiHistory}
      title={$t('frameleaf_words_history_empty')}
      body={entries === undefined ? $t('frameleaf_words_history_empty_own') : $t('frameleaf_words_history_empty_body')}
      label={$t('frameleaf_settings_area_history')}
    >
      {#snippet actions()}
        <Button onclick={onConfigure}>{configureLabel}</Button>
      {/snippet}
    </Hero>
  {:else if items}
    {#each groups as group (group.day)}
      <Section title={$t(`frameleaf_words_history_group_${group.day}`)}>
        <ul class="log">
          {#each group.items as entry (entry.id)}
            <li>
              <span class="tile" aria-hidden="true">
                <Icon icon={entry.kind === 'server' ? mdiServerOutline : mdiAccountCircleOutline} size="22" />
              </span>
              <div class="main">
                <strong>{entry.title}</strong>
                <span><time datetime={entry.createdAt}>{whenOf(entry.createdAt)}</time> · {entry.by}</span>
                {#if entry.pages.length > 0 && few(entry)}
                  <span>{entry.pages.map((page) => page.title).join(' · ')}</span>
                {/if}
                {#if entry.changes.length > 0 && (!few(entry) || !titled(entry))}
                  <details>
                    <summary>
                      {$t('frameleaf_words_history_show', {
                        values: { count: entry.changes.length + entry.omitted },
                      })}
                    </summary>
                    <ul class="changes">
                      {#each entry.changes as change (change.key)}
                        <li>
                          <strong>{change.label}</strong>
                          <span>
                            {#if change.before}
                              {change.before}
                              <Icon icon={mdiArrowRight} size="14" aria-label={$t('frameleaf_words_history_to')} />
                            {/if}
                            <b>{change.after}</b>
                          </span>
                        </li>
                      {/each}
                    </ul>
                    {#if entry.omitted > 0}
                      <p class="omitted">
                        {$t('frameleaf_settings_history_omitted', { values: { count: entry.omitted } })}
                      </p>
                    {/if}
                  </details>
                {/if}
                {#if entry.pages.length > 1}
                  <span class="links">
                    {#each entry.pages as page (page.title)}
                      <TextLink href={commandCenterUrl(page.page.area, page.page.section)}>
                        {$t('frameleaf_words_history_open_page', { values: { page: page.title } })}
                      </TextLink>
                    {/each}
                  </span>
                {/if}
              </div>
              <Pill tone="off">
                {entry.kind === 'server' ? $t('frameleaf_words_history_server') : $t('frameleaf_words_history_you')}
              </Pill>
              <span class="open">
                {#if entry.pages.length === 1}
                  <TextLink href={commandCenterUrl(entry.pages[0].page.area, entry.pages[0].page.section)}>
                    {$t('frameleaf_words_history_open')}
                  </TextLink>
                {/if}
              </span>
            </li>
          {/each}
        </ul>
      </Section>
    {/each}
  {:else}
    <div class="loading" role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="4.5rem" />
      <Skeleton variant="block" height="4.5rem" />
      <Skeleton variant="block" height="4.5rem" />
    </div>
  {/if}
</KitPage>

<style>
  .log,
  .changes {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .log {
    padding-bottom: var(--fl-space-2);
  }
  .log > li {
    display: grid;
    grid-template-columns: 44px minmax(0, 1fr) auto minmax(120px, auto);
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .tile {
    display: grid;
    align-self: start;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
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
  .main > .links {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2) var(--fl-space-4);
    margin-top: var(--fl-space-2);
  }
  details {
    margin-top: var(--fl-space-2);
  }
  summary {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
    cursor: pointer;
  }
  summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
  details[open] summary {
    margin-bottom: var(--fl-space-2);
  }
  .changes li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-3) 0;
    font-size: var(--fl-font-callout);
    border-top: 1px solid var(--fl-border);
  }
  .changes strong {
    font-weight: 600;
  }
  .changes li > span {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
    max-width: 420px;
    color: var(--fl-muted);
    text-align: end;
    overflow-wrap: anywhere;
  }
  .changes b {
    color: var(--fl-text);
    font-weight: 600;
  }
  .omitted {
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .open {
    font-size: var(--fl-font-callout);
    text-align: end;
  }
  .loading {
    display: grid;
    gap: var(--fl-space-3);
  }
  @container kit (max-width: 620px) {
    .log > li {
      grid-template-columns: 44px minmax(0, 1fr);
      gap: var(--fl-space-3) var(--fl-space-4);
    }
    .log > li > :global(.kit-pill),
    .open {
      grid-column: 2;
      justify-self: start;
      text-align: start;
    }
    .open:empty {
      display: none;
    }
    .changes li {
      grid-template-columns: 1fr;
      gap: var(--fl-space-2);
    }
    .changes li > span {
      justify-content: flex-start;
      text-align: start;
    }
  }
</style>
