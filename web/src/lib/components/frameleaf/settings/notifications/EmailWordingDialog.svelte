<script lang="ts">
  /**
   * Changing the wording of one email (ADMIN-P3, the prototype's `Wording` dialog in
   * `settings-v2/server/notifications.jsx`): the words in a box, buttons that drop a name or a link
   * into them, and a preview with sample names. Empty means the standard wording. "Use this
   * wording" puts it into the page's changes, which the settings bar saves with everything else.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import { withSamples, type Wording } from '$lib/components/frameleaf/settings/notifications/email-wording';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlus } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    wording,
    words,
    onUse,
    onClose,
  }: {
    wording: Wording;
    /** The current wording in plain words; empty for the standard one. */
    words: string;
    onUse: (words: string) => void;
    onClose: () => void;
  } = $props();

  let open = $state(true);
  // The dialog edits its own copy until "Use this wording".
  // svelte-ignore state_referenced_locally
  let text = $state(words);
  const name = $derived($t(wording.name));
  const preview = $derived(withSamples(text || $t(wording.standard), wording, (key) => $t(key)));
</script>

<Dialog title={name} closeLabel={$t('close')} bind:open onClosed={onClose}>
  <div class="body">
    <p class="hint">
      {$t(wording.when)}
      {$t('frameleaf_notify_wording_empty_hint')}
    </p>
    <TextArea
      label={$t('frameleaf_notify_wording_box', { values: { name } })}
      rows={6}
      value={text}
      placeholder={$t(wording.standard)}
      onChange={(value) => (text = value)}
    />
    <div class="inserts" role="group" aria-label={$t('frameleaf_notify_wording_insert_label')}>
      <span class="hint">{$t('frameleaf_notify_wording_insert')}</span>
      {#each wording.inserts as insert (insert.code)}
        <button type="button" onclick={() => (text += `[${$t(insert.label)}]`)}>
          <Icon icon={mdiPlus} size="14" aria-hidden />
          {$t(insert.label)}
        </button>
      {/each}
    </div>
    <div class="letter" role="group" aria-label={$t('frameleaf_notify_wording_preview')}>
      <small>{$t('frameleaf_notify_wording_preview')}</small>
      <p>{preview}</p>
    </div>
  </div>
  {#snippet actions()}
    <Button disabled={!text} onclick={() => (text = '')}>{$t('frameleaf_notify_wording_standard_use')}</Button>
    <Button
      variant="primary"
      onclick={() => {
        onUse(text);
        open = false;
      }}
    >
      {$t('frameleaf_notify_wording_use')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: grid;
    gap: var(--fl-space-3);
    min-width: min(32rem, 100%);
  }
  .body :global(.kit-area) {
    margin-bottom: 0;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .inserts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
  }
  .inserts button {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    min-height: 32px;
    padding: 0 var(--fl-space-3);
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .inserts button:hover {
    border-color: var(--fl-accent);
  }
  .inserts button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .letter {
    display: grid;
    gap: var(--fl-space-2);
    padding: var(--fl-space-4);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .letter small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .letter p {
    margin: 0;
    font-size: var(--fl-font-callout);
    line-height: 1.5;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
