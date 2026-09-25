<script lang="ts">
  /**
   * The Change history area (FL-66, FL-71 CC-10), the design template's `ChangeHistory` in
   * `CommandCenter.jsx:2542-2583`: one timeline, newest first, each entry with its title, time,
   * "View changes" (every change before and after) and who saved it.
   *
   * - For an administrator: the server's settings history, where settings saves read "n settings
   *   changed", credential entries name the credential ("Updated OAuth client secret", never a value) and
   *   reviews read "Reviewed: …". Entries from before titles were recorded fall back to the count.
   * - For everyone: the account's own preference history, with the device that saved each change.
   *   Locked-content rules appear only as changed.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { historyValue, type HistoryValue } from '$lib/frameleaf/settings-history';
  import { configPathLabel } from '$lib/frameleaf/system-config-draft';
  import {
    SystemConfigHistoryCredentialChange,
    type SystemConfigHistoryChangeDto,
    type SystemConfigHistoryEntryDto,
    type UserPreferenceHistoryEntryDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiHistory } from '@mdi/js';
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
  };

  let { entries, preferences, ownName, error = false, onRetry, onConfigure, configureLabel }: Props = $props();

  type Change = { path: string; before: string | null; after: string | null; protected?: boolean } & Partial<
    Pick<SystemConfigHistoryChangeDto, 'credential'>
  >;
  type Item = {
    id: string;
    createdAt: string;
    title: string;
    changes: Change[];
    omittedChanges: number;
    by: string;
    preference: boolean;
  };

  const settingsTitle = (entry: SystemConfigHistoryEntryDto) =>
    entry.title ||
    $t('frameleaf_settings_history_title', { values: { count: entry.changes.length + entry.omittedChanges } });

  const items = $derived.by((): Item[] | null => {
    if (preferences === null || entries === null) {
      return null;
    }
    const settings = (entries ?? []).map((entry) => ({
      id: `settings:${entry.id}`,
      createdAt: entry.createdAt,
      title: settingsTitle(entry),
      changes: entry.changes,
      omittedChanges: entry.omittedChanges,
      by: entry.actorName ?? $t('frameleaf_settings_history_unknown_actor'),
      preference: false,
    }));
    const own = preferences.map((entry) => ({
      id: `preferences:${entry.id}`,
      createdAt: entry.createdAt,
      title: $t('frameleaf_settings_history_preferences_title', {
        values: { count: entry.changes.length + entry.omittedChanges },
      }),
      changes: entry.changes,
      omittedChanges: entry.omittedChanges,
      by: `${ownName} · ${entry.deviceLabel ?? $t('frameleaf_settings_history_unknown_device')}`,
      preference: true,
    }));
    return [...settings, ...own].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  });

  const describe = (value: HistoryValue) => {
    switch (value.kind) {
      case 'secret': {
        return $t('frameleaf_settings_draft_value_secret');
      }
      case 'credential': {
        return value.change === SystemConfigHistoryCredentialChange.Cleared
          ? $t('frameleaf_settings_history_credential_cleared')
          : $t('frameleaf_settings_history_credential_replaced');
      }
      case 'empty': {
        return $t('frameleaf_settings_draft_value_empty');
      }
      case 'on': {
        return $t('frameleaf_settings_draft_value_on');
      }
      case 'off': {
        return $t('frameleaf_settings_draft_value_off');
      }
      case 'text': {
        return value.text;
      }
    }
  };

  /** A preference path reads from its first segment (the section), a setting path without it. */
  const label = (item: Item, change: Change) =>
    item.preference ? configPathLabel(`preferences.${change.path}`) : configPathLabel(change.path);

  const formatTime = (value: string) => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
  };
</script>

{#if error}
  <div class="notice" role="alert">
    <span>{$t('frameleaf_settings_history_load_failed')}</span>
    <Button onclick={onRetry}>{$t('retry')}</Button>
  </div>
{:else if items && items.length === 0}
  <div class="empty">
    <Icon icon={mdiHistory} size="2.25rem" aria-hidden={true} />
    <h3>{$t('frameleaf_settings_history_empty_title')}</h3>
    <p>
      {entries === undefined
        ? $t('frameleaf_settings_history_empty_preferences')
        : $t('frameleaf_settings_history_empty')}
    </p>
    <Button onclick={onConfigure}>{configureLabel}</Button>
  </div>
{:else if items}
  <div class="history">
    {#each items as item (item.id)}
      <article>
        <div class="line">
          <Icon icon={mdiHistory} size="1.125rem" aria-hidden={true} />
          <strong>{item.title}</strong>
          <time datetime={item.createdAt}>{formatTime(item.createdAt)}</time>
        </div>
        {#if item.changes.length > 0}
          <details>
            <summary>{$t('frameleaf_settings_history_view')}</summary>
            <ul>
              {#each item.changes as change (change.path)}
                <li>
                  <strong>{label(item, change)}</strong>
                  {#if change.protected}
                    <span>{$t('frameleaf_settings_history_protected')}</span>
                  {:else}
                    <span>
                      <del>{describe(historyValue(change as SystemConfigHistoryChangeDto, 'before'))}</del>
                      <span aria-hidden="true">→</span>
                      <ins>{describe(historyValue(change as SystemConfigHistoryChangeDto, 'after'))}</ins>
                    </span>
                  {/if}
                </li>
              {/each}
            </ul>
            {#if item.omittedChanges > 0}
              <p class="omitted">
                {$t('frameleaf_settings_history_omitted', { values: { count: item.omittedChanges } })}
              </p>
            {/if}
          </details>
        {/if}
        <small>{item.by}</small>
      </article>
    {/each}
  </div>
{:else}
  <p role="status">{$t('loading')}</p>
{/if}

<style>
  .empty {
    padding: 4.375rem 1.25rem;
    text-align: center;
    color: var(--fl-text);
  }
  .empty :global(svg) {
    display: block;
    margin: 0 auto 1.125rem;
    color: var(--fl-muted);
  }
  .empty h3 {
    margin: 0;
    font-size: 1.125rem;
    font-weight: 550;
  }
  .empty p {
    max-width: 32.5rem;
    margin: 0.75rem auto 1.25rem;
    color: var(--fl-muted);
    line-height: 1.7;
  }
  .notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 0.75rem 1rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .history article {
    padding: 1.25rem 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .line {
    display: flex;
    gap: 0.625rem;
    align-items: center;
  }
  .line :global(svg) {
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  .history strong {
    font-size: var(--fl-font-small);
    font-weight: 500;
  }
  time {
    margin-inline-start: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  small {
    display: block;
    margin-top: 0.625rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  details {
    margin-top: 0.9375rem;
  }
  summary {
    cursor: pointer;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  ul {
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 1.25rem;
    padding: 0.25rem 0;
    font-size: var(--fl-font-micro);
  }
  li > span {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 0.375rem;
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  del {
    text-decoration: line-through;
  }
  ins {
    color: var(--fl-text);
    text-decoration: none;
  }
  .omitted {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  @media (max-width: 56rem) {
    .line {
      flex-wrap: wrap;
    }
    time {
      width: 100%;
      margin-inline-start: 1.75rem;
    }
  }
</style>
