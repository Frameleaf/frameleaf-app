<script lang="ts">
  /**
   * The settings bar and change review of the Frameleaf settings page (FL-66), the template's
   * `.cc-savebar` and "Review settings changes" dialog in `CommandCenter.jsx`. It appears while
   * the one settings draft has changes on any page: Discard returns every page to the saved
   * settings, Review changes lists each change with its page, the saved value and the new value
   * (passwords and keys only as "changed"), and Save changes saves them together against the
   * revision the draft was made against.
   *
   * Leaving the settings page with changes holds the navigation until the draft is kept or
   * discarded; switching areas keeps the draft. Closing or reloading the tab gets the browser's
   * own warning; a reload recovers the draft from this tab's session storage.
   */
  import { beforeNavigate, goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SaveBarFrame from '$lib/components/frameleaf/settings/SaveBarFrame.svelte';
  import { presentedAreaForSection, type SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import {
    configPathLabel,
    reviewValue,
    sectionForConfigPath,
    type ConfigChange,
    type ReviewValue,
  } from '$lib/frameleaf/system-config-draft';
  import type { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    store: SystemConfigDraftStore;
    sections: SettingsHostSection[];
    /** Area titles by area id, for the review's "page · area" line. */
    areaTitles: Record<string, string>;
    /** True while a configuration file manages the settings; nothing can be saved. */
    disabled?: boolean;
  };

  let { store, sections, areaTitles, disabled = false }: Props = $props();

  let reviewing = $state(false);
  // A page can ask for the review (the Job manager's "Review n pending settings").
  $effect(() => {
    if (store.reviewRequests > 0) {
      untrack(() => (reviewing = store.changes.length > 0));
    }
  });
  let pendingNavigation = $state<URL | null>(null);

  const count = $derived(store.changes.length);

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

  /** Where a change lives: its settings page and area. */
  const placeOf = (change: ConfigChange) => {
    const key = sectionForConfigPath(change.path);
    const section = sections.find((item) => item.key === key);
    // The area the page is shown in (a backup page is shown under Backup).
    const area = key === undefined ? undefined : presentedAreaForSection(key);
    if (!section) {
      return $t('frameleaf_settings_draft_other');
    }
    return area ? `${areaTitles[area] ?? ''} · ${section.title}` : section.title;
  };

  const subtitle = $derived.by(() => {
    if (store.saving) {
      return $t('frameleaf_settings_draft_saving');
    }
    if (store.stale) {
      return $t('frameleaf_settings_draft_stale_help');
    }
    if (store.error?.code === 'save_failed') {
      return $t('frameleaf_settings_draft_error_save');
    }
    if (!store.journalAvailable) {
      return $t('frameleaf_settings_draft_journal_unavailable');
    }
    if (store.unjournaled > 0) {
      return $t('frameleaf_settings_draft_journal_secrets', { values: { count: store.unjournaled } });
    }
    return $t('frameleaf_settings_draft_unsaved_help');
  });

  const saveChanges = async () => {
    // Close the review first: a confirmation a page asks for before saving opens its own dialog.
    reviewing = false;
    await store.save();
  };

  beforeNavigate(({ cancel, from, to, type }) => {
    if (type === 'leave' || !to || !untrack(() => store.dirty)) {
      return;
    }
    // Moving between settings areas keeps the one draft.
    if (from && to.url.pathname === from.url.pathname) {
      return;
    }
    cancel();
    pendingNavigation = to.url;
  });

  const keepEditing = () => {
    pendingNavigation = null;
  };

  const discardAndLeave = async () => {
    const destination = pendingNavigation;
    pendingNavigation = null;
    // With the draft discarded the guard above lets this navigation through.
    store.discard();
    if (destination) {
      await goto(destination);
    }
  };

  const warnBeforeUnload = (event: BeforeUnloadEvent) => {
    event.preventDefault();
  };

  $effect(() => {
    if (count === 0) {
      return;
    }
    addEventListener('beforeunload', warnBeforeUnload);
    return () => removeEventListener('beforeunload', warnBeforeUnload);
  });
</script>

{#if count > 0}
  <SaveBarFrame
    alert={!!pendingNavigation}
    label={$t('frameleaf_settings_draft_bar_label')}
    title={pendingNavigation
      ? $t('frameleaf_settings_draft_leave', { values: { count } })
      : $t('frameleaf_settings_draft_unsaved', { values: { count } })}
    subtitle={pendingNavigation ? $t('frameleaf_settings_draft_leave_help') : subtitle}
    tick={count}
  >
    {#if pendingNavigation}
      <Button onclick={keepEditing}>{$t('frameleaf_settings_draft_keep_editing')}</Button>
      <Button variant="primary" onclick={discardAndLeave}>{$t('frameleaf_settings_draft_discard_leave')}</Button>
    {:else}
      <Button disabled={store.saving} onclick={() => store.discard()}>{$t('frameleaf_settings_draft_discard')}</Button>
      <Button variant="primary" disabled={disabled || store.saving || store.stale} onclick={() => (reviewing = true)}>
        {$t('frameleaf_settings_draft_review')}
        <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
      </Button>
    {/if}
  </SaveBarFrame>
{/if}

<Dialog
  title={$t('frameleaf_settings_draft_review_title')}
  closeLabel={$t('frameleaf_settings_draft_keep_editing')}
  bind:open={reviewing}
>
  <p class="intro">{$t('frameleaf_settings_draft_review_intro')}</p>
  <div class="diff">
    {#each store.changes as change (change.path)}
      <article>
        <strong>{configPathLabel(change.path)}</strong>
        <small>{placeOf(change)}</small>
        <div>
          <del>{describe(reviewValue(change.path, change.before))}</del>
          <Icon icon={mdiChevronRight} size="1rem" aria-hidden={true} />
          <ins>{describe(reviewValue(change.path, change.after))}</ins>
        </div>
      </article>
    {/each}
  </div>
  <footer>
    <Button onclick={() => (reviewing = false)}>{$t('frameleaf_settings_draft_keep_editing')}</Button>
    <Button variant="primary" disabled={disabled || store.saving || store.stale || count === 0} onclick={saveChanges}>
      {$t('frameleaf_settings_draft_save')}
    </Button>
  </footer>
</Dialog>

<style>
  .intro {
    margin-top: 0;
    color: var(--fl-muted);
  }
  .diff {
    max-height: min(60dvh, 32rem);
    overflow-y: auto;
  }
  .diff article {
    padding: 0.9375rem 0;
    border-top: 1px solid var(--fl-border);
  }
  .diff article > strong {
    font-size: var(--fl-font-small);
  }
  .diff small {
    display: block;
    margin-top: 0.3125rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .diff article > div {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin-top: 0.875rem;
    word-break: break-word;
  }
  .diff del {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .diff ins {
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .diff :global(svg) {
    color: var(--fl-accent);
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }
</style>
