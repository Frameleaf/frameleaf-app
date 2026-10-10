<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The shell every bulk dialog shares: a titled modal, one form, a live preview line and a
   * cancel/apply footer. Keeping it in one place is what lets each dialog below stay about its own
   * payload rather than about layout, and it keeps the Frameleaf tokens in a single stylesheet.
   */
  let {
    title,
    submitLabel,
    valid = true,
    danger = false,
    preview,
    open = $bindable(true),
    onSubmit,
    children,
  }: {
    title: string;
    submitLabel: string;
    valid?: boolean;
    danger?: boolean;
    preview?: string;
    open?: boolean;
    onSubmit: () => void;
    children: Snippet;
  } = $props();

  const formId = $props.id();

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    if (!valid) {
      return;
    }
    onSubmit();
    open = false;
  };
</script>

<Dialog bind:open {title} closeLabel={$t('cancel')}>
  <form id={formId} onsubmit={submit}>
    {@render children()}
    {#if preview}
      <p class="preview" aria-live="polite">{preview}</p>
    {/if}
  </form>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <!-- The prototype's footer sits outside the scrolling body, so the submit button joins the form by id. -->
    <button type="submit" form={formId} class="button" class:primary={!danger} class:danger disabled={!valid}
      >{submitLabel}</button
    >
  {/snippet}
</Dialog>

<style>
  form {
    display: grid;
    gap: 0.75rem;
    min-width: 0;
    font-size: 0.875rem;
  }
  /* The fields themselves live in the calling dialog, so they are styled globally within this form. */
  form :global(fieldset) {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.5rem 0.75rem;
  }
  form :global(legend) {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  form :global(label) {
    display: grid;
    gap: 0.25rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
    min-width: 0;
  }
  form :global(fieldset label) {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  form :global(.fl-grid) {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
  }
  form :global(input),
  form :global(select),
  form :global(textarea) {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0.35rem 0.5rem;
    font: inherit;
    min-width: 0;
  }
  form :global(input[type='radio']),
  form :global(input[type='checkbox']) {
    min-height: 0;
    min-width: 0;
  }
  .preview {
    color: var(--fl-muted);
    font-size: 0.75rem;
    margin: 0;
  }
  /* The prototype's `.dialog .button.danger`, with the token foreground that clears 4.5:1 on it. */
  .button.danger {
    background: var(--fl-danger);
    color: var(--fl-danger-text);
    border-color: transparent;
  }
  .button.danger:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-danger), white 10%);
  }
</style>
