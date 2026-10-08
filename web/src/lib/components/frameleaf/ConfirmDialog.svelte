<script lang="ts">
  /**
   * The Frameleaf confirmation (FL-67, FL-71, FL-76, FL-81): the prototype's titled `Dialog` with a
   * sentence of consequence and a Cancel / action footer (for example "Delete this report?" in
   * `design/frameleaf/template/src/Maintenance.jsx:673-699`, or the device revoke confirm in
   * `AccountsLibraries.jsx`). It replaces `modalManager.showDialog`'s generic upstream modal on the
   * Frameleaf surfaces; open it through `confirmFrameleaf` in `$lib/frameleaf/confirm`, which
   * resolves `true` only when the action button is pressed.
   *
   * It is the one confirmation in the app: `$lib/frameleaf/kit-bridge` also routes the legacy
   * `modalManager.showDialog` here, which is why the title, prompt and action text have the
   * generic defaults that call had, and why `prompt` may be a snippet.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    prompt,
    confirmText,
    cancelText,
    danger = false,
    disabled = false,
    onClose,
  }: {
    title?: string;
    prompt?: string | Snippet;
    confirmText?: string;
    cancelText?: string;
    danger?: boolean;
    /** Keeps the action unavailable, for a confirmation that depends on something still loading. */
    disabled?: boolean;
    onClose: (confirmed?: boolean) => void;
  } = $props();

  let open = $state(true);
  let confirmed = false;

  const confirm = () => {
    confirmed = true;
    open = false;
  };
</script>

<!-- The answer is reported once the sheet has finished leaving, so the exit is not cut short. -->
<Dialog bind:open title={title ?? $t('confirm')} closeLabel={$t('close')} onClosed={() => onClose(confirmed)}>
  {#if typeof prompt === 'string'}
    <p>{prompt}</p>
  {:else if prompt}
    {@render prompt()}
  {/if}
  {#snippet actions()}
    <!-- A destructive action never takes the first focus: Enter on open must not delete. -->
    <button type="button" class="button" data-initial-focus={danger ? '' : undefined} onclick={() => (open = false)}
      >{cancelText ?? $t('cancel')}</button
    >
    <button
      type="button"
      class="button"
      class:primary={!danger}
      class:fl-danger={danger}
      data-initial-focus={danger ? undefined : ''}
      {disabled}
      onclick={confirm}>{confirmText ?? $t('confirm')}</button
    >
  {/snippet}
</Dialog>

<style>
  p {
    margin: 0;
    color: var(--fl-text);
    line-height: 1.5;
  }
</style>
