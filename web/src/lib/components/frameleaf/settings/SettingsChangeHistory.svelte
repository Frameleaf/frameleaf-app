<script lang="ts">
  /**
   * The settings change history (FL-66), the design template's `ChangeHistory` in
   * `CommandCenter.jsx`: each saved change with its time, "View changes" with every changed
   * setting before and after, and who saved it. The server keeps the history, so it is the same
   * for every administrator; values are redacted there and credentials only say replaced or
   * cleared.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { historyValue, type HistoryValue } from '$lib/frameleaf/settings-history';
  import { configPathLabel } from '$lib/frameleaf/system-config-draft';
  import { SystemConfigHistoryCredentialChange, type SystemConfigHistoryEntryDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiHistory } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    entries: SystemConfigHistoryEntryDto[] | null;
    error?: boolean;
    onRetry: () => void;
    onConfigure: () => void;
  };

  let { entries, error = false, onRetry, onConfigure }: Props = $props();

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
{:else if entries && entries.length === 0}
  <div class="empty">
    <Icon icon={mdiHistory} size="2.25rem" aria-hidden={true} />
    <h3>{$t('frameleaf_settings_history_empty_title')}</h3>
    <p>{$t('frameleaf_settings_history_empty')}</p>
    <Button onclick={onConfigure}>{$t('frameleaf_settings_history_empty_action')}</Button>
  </div>
{:else if entries}
  <div class="history">
    {#each entries as entry (entry.id)}
      <article>
        <div class="line">
          <Icon icon={mdiHistory} size="1.125rem" aria-hidden={true} />
          <strong>
            {$t('frameleaf_settings_history_title', {
              values: { count: entry.changes.length + entry.omittedChanges },
            })}
          </strong>
          <time datetime={entry.createdAt}>{formatTime(entry.createdAt)}</time>
        </div>
        {#if entry.changes.length > 0}
          <details>
            <summary>{$t('frameleaf_settings_history_view')}</summary>
            <ul>
              {#each entry.changes as change (change.path)}
                <li>
                  <strong>{configPathLabel(change.path)}</strong>
                  <span>
                    <del>{describe(historyValue(change, 'before'))}</del>
                    <span aria-hidden="true">→</span>
                    <ins>{describe(historyValue(change, 'after'))}</ins>
                  </span>
                </li>
              {/each}
            </ul>
            {#if entry.omittedChanges > 0}
              <p class="omitted">
                {$t('frameleaf_settings_history_omitted', { values: { count: entry.omittedChanges } })}
              </p>
            {/if}
          </details>
        {/if}
        <small>{entry.actorName ?? $t('frameleaf_settings_history_unknown_actor')}</small>
      </article>
    {/each}
  </div>
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
