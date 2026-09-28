<script lang="ts">
  /**
   * The Frameleaf confirmation (FL-67, FL-71, FL-76, FL-81): the prototype's titled `Dialog` with a
   * sentence of consequence and a Cancel / action footer (for example "Delete this report?" in
   * `design/frameleaf/template/src/Maintenance.jsx:673-699`, or the device revoke confirm in
   * `AccountsLibraries.jsx`). It replaces `modalManager.showDialog`'s generic upstream modal on the
   * Frameleaf surfaces; open it through `confirmFrameleaf` in `$lib/frameleaf/confirm`, which
   * resolves `true` only when the action button is pressed.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    prompt,
    confirmText,
    cancelText,
    danger = false,
    onClose,
  }: {
    title: string;
    prompt?: string;
    confirmText: string;
    cancelText?: string;
    danger?: boolean;
    onClose: (confirmed?: boolean) => void;
  } = $props();

  let open = $state(true);
  let confirmed = false;

  $effect(() => {
    if (open) {
      return;
    }
    onClose(confirmed);
  });

  const confirm = () => {
    confirmed = true;
    open = false;
  };
</script>

<Dialog bind:open {title} closeLabel={$t('close')}>
  {#if prompt}
    <p>{prompt}</p>
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
      class:danger
      data-initial-focus={danger ? undefined : ''}
      onclick={confirm}>{confirmText}</button
    >
  {/snippet}
</Dialog>

<style>
  p {
    margin: 0;
    color: var(--fl-text);
    line-height: 1.5;
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
