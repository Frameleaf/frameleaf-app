<script lang="ts" module>
  export type RereadChoice = { label: string; run: () => Promise<void> | void };
</script>

<script lang="ts">
  /**
   * FL-521, after the prototype's `Reread` (`settings-v2/care/shared.jsx`): a change that only applies
   * from now on until the work is done again. It says what happens, roughly how long, and what keeps
   * working meanwhile, with "Save and start tonight / now" (or the page's own words) and Undo.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    body,
    choices,
    onUndo,
    disabled = false,
  }: {
    title: string;
    body: string;
    choices: RereadChoice[];
    onUndo: () => void;
    disabled?: boolean;
  } = $props();

  let busy = $state(false);
  const choose = async (choice: RereadChoice) => {
    busy = true;
    try {
      await choice.run();
    } finally {
      busy = false;
    }
  };
</script>

<Notice tone="warn" {title}>
  {body}
  {#snippet action()}
    {#each choices as choice (choice.label)}
      <Button disabled={busy || disabled} onclick={() => choose(choice)}>{choice.label}</Button>
    {/each}
    <Button disabled={busy} onclick={onUndo}>{$t('frameleaf_intel_undo')}</Button>
  {/snippet}
</Notice>
