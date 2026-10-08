<script lang="ts">
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { copyToClipboard } from '$lib/utils';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiContentCopy } from '@mdi/js';
  import { onDestroy } from 'svelte';

  /**
   * Copies an address and confirms it where the person pressed: the copy icon becomes a tick for a
   * moment (it pops in on the spring; no movement under Reduce Motion). `copyToClipboard` also says
   * "Copied" in a toast, which is what a screen reader hears, and reports a failure.
   */
  interface Props {
    value: string;
    /** The accessible name, for example "Copy link for Summer". */
    label: string;
    onCopied?: () => void;
  }

  let { value, label, onCopied }: Props = $props();

  /** How long the tick stays before the copy icon returns. */
  const COPIED_MS = 1500;
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;

  const copy = async () => {
    await copyToClipboard(value);
    onCopied?.();
    copied = true;
    clearTimeout(timer);
    timer = setTimeout(() => (copied = false), COPIED_MS);
  };

  onDestroy(() => clearTimeout(timer));
</script>

<IconButton {label} onclick={() => void copy()}>
  {#if copied}
    <span class="copied" data-testid="link-copied"><Icon icon={mdiCheck} size={ICON_SIZE.lg} /></span>
  {:else}
    <Icon icon={mdiContentCopy} size={ICON_SIZE.lg} />
  {/if}
</IconButton>

<style>
  .copied {
    display: inline-flex;
    color: var(--fl-accent);
    animation: fl-pop-in var(--fl-duration-pop) var(--fl-spring) both;
  }
</style>
