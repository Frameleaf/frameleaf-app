<script lang="ts">
  // Stand-in for FixMatchPanel in PersonHero specs: reports one face moved to Grace when asked.
  import type { Snippet } from 'svelte';

  interface Props {
    onChanged?: (personIds: string[]) => void;
    close: () => void;
    title?: string;
    tabs?: Snippet;
    footerLink?: Snippet;
  }

  let { onChanged, close, title, tabs, footerLink }: Props = $props();
</script>

<h2>{title}</h2>
{@render tabs?.()}
{@render footerLink?.()}
<button
  type="button"
  onclick={() => {
    onChanged?.(['grace']);
    close();
  }}>Moved a face</button
>
