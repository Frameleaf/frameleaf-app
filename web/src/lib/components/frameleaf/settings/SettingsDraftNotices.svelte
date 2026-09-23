<script lang="ts">
  /**
   * The settings draft's messages at the top of the settings page (FL-66), the template's
   * `.cc-notice` lines in `CommandCenter.jsx`: the conflict banner when saved settings changed
   * under the draft, errors, and the notice after an action. A conflict lists each setting the
   * draft changes that was also changed elsewhere, with the saved value and the draft's value, and
   * offers to keep the draft's values on the latest settings or to discard the draft.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { configPathLabel, reviewValue, type ReviewValue } from '$lib/frameleaf/system-config-draft';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import { Icon } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let { store }: { store: SystemConfigDraftStore } = $props();

  const describe = (value: ReviewValue) => {
    switch (value.kind) {
      case 'secret': {
        return $t('frameleaf_settings_draft_value_secret');
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

  const errorText = $derived.by(() => {
    const error = store.error;
    if (!error) {
      return '';
    }
    const message = {
      save_failed: $t('frameleaf_settings_draft_error_save'),
      partial_save_failed: $t('frameleaf_settings_draft_error_partial_save'),
      load_failed: $t('frameleaf_settings_draft_error_load'),
      invalid_file: $t('frameleaf_settings_draft_error_file'),
    }[error.code];
    return [message, error.detail].filter(Boolean).join(' ');
  });

  const noticeLines = $derived.by((): string[] => {
    const notice = store.notice;
    if (!notice) {
      return [];
    }
    switch (notice.code) {
      case 'saved': {
        return [$t('frameleaf_settings_draft_notice_saved')];
      }
      case 'partial_saved': {
        return [$t('frameleaf_settings_draft_notice_partial_saved')];
      }
      case 'discarded': {
        return [$t('frameleaf_settings_draft_notice_discarded')];
      }
      case 'defaults_restored': {
        return [$t('frameleaf_settings_draft_notice_defaults')];
      }
      case 'latest_loaded': {
        return [$t('frameleaf_settings_draft_notice_latest')];
      }
      case 'rebased': {
        return [$t('frameleaf_settings_draft_notice_rebased')];
      }
      case 'kept_mine': {
        return [$t('frameleaf_settings_draft_notice_kept_mine')];
      }
      case 'recovered': {
        const lines = [$t('frameleaf_settings_draft_notice_recovered', { values: { count: notice.count } })];
        if (notice.dropped > 0) {
          lines.push($t('frameleaf_settings_draft_notice_recovered_dropped', { values: { count: notice.dropped } }));
        }
        return lines;
      }
      case 'imported': {
        const lines = [$t('frameleaf_settings_draft_notice_imported', { values: { count: notice.applied } })];
        if (notice.unsupported.length > 0) {
          lines.push(
            $t('frameleaf_settings_draft_notice_imported_unsupported', {
              values: { count: notice.unsupported.length, paths: notice.unsupported.join(', ') },
            }),
          );
        }
        if (notice.keptSecrets > 0) {
          lines.push($t('frameleaf_settings_draft_notice_imported_secrets'));
        }
        if (notice.skippedSecrets > 0) {
          lines.push($t('frameleaf_credentials_import_skipped'));
        }
        return lines;
      }
    }
  });
</script>

{#if store.stale}
  <div class="notice error conflict" role="alert">
    <div class="copy">
      <p>{$t('frameleaf_settings_draft_conflict')}</p>
      {#if store.conflicts.length > 0}
        <p>{$t('frameleaf_settings_draft_conflict_count', { values: { count: store.conflicts.length } })}</p>
        <ul>
          {#each store.conflicts as conflict (conflict.path)}
            {@const saved = describe(reviewValue(conflict.path, conflict.theirs))}
            {@const yours = describe(reviewValue(conflict.path, conflict.mine))}
            <li>
              <strong>{configPathLabel(conflict.path)}</strong>
              <span>{$t('frameleaf_settings_draft_conflict_saved_now', { values: { value: saved } })}</span>
              <span>{$t('frameleaf_settings_draft_conflict_yours', { values: { value: yours } })}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="actions">
      <Button disabled={store.loading || store.saving} onclick={() => store.keepMine()}>
        {$t('frameleaf_settings_draft_conflict_keep_mine')}
      </Button>
      <Button disabled={store.loading || store.saving} onclick={() => void store.loadLatest()}>
        {$t('frameleaf_settings_draft_load_latest')}
      </Button>
    </div>
  </div>
{/if}

{#if errorText}
  <p class="notice error" role="alert">{errorText}</p>
{/if}

{#if noticeLines.length > 0}
  <div class="notice" role="status">
    <div class="copy">
      {#each noticeLines as line, index (index)}
        <p>{line}</p>
      {/each}
    </div>
    <button
      type="button"
      class="dismiss"
      aria-label={$t('frameleaf_settings_draft_dismiss')}
      onclick={() => store.dismissNotice()}
    >
      <Icon icon={mdiClose} size="1rem" aria-hidden={true} />
    </button>
  </div>
{/if}

<style>
  .notice {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    margin: 0;
    padding: 0.75rem 0.875rem;
    background: var(--fl-raised);
    border-inline-start: 2px solid var(--fl-accent);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  .notice.error {
    border-color: var(--fl-warning);
  }
  .copy {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .copy p {
    margin: 0;
  }
  .conflict {
    flex-wrap: wrap;
  }
  .conflict ul {
    margin: 0.25rem 0 0;
    padding: 0;
    list-style: none;
  }
  .conflict li {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.75rem;
    padding: 0.375rem 0;
    border-top: 1px solid var(--fl-border);
    word-break: break-word;
  }
  .conflict li span {
    color: var(--fl-muted);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-inline-start: auto;
  }
  .dismiss {
    margin-inline-start: auto;
    display: inline-flex;
    padding: 0.25rem;
    color: var(--fl-muted);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius);
  }
  .dismiss:hover {
    color: var(--fl-text);
    background: var(--fl-panel);
  }
</style>
