<script lang="ts">
  // FL-1321 / FL-1323: the drive under a folder and its free space, shared by the setup Storage step and the Storage
  // page. Nothing is shown when Manager can't tell. `low` and `unmeasurable` come from FL-1324's storage report.
  import Icon from './Icon.svelte';
  import { driveHint, type Drive } from './drives';
  let { path, drives = [], low = false, unmeasurable = false } = $props<{
    path: string | null | undefined;
    drives?: Drive[] | null;
    /** The drive is nearly full. */
    low?: boolean;
    /** A folder only Docker reaches: Manager can't measure it from here. */
    unmeasurable?: boolean;
  }>();
  const hint = $derived(path ? driveHint(path, drives ?? []) : null);
</script>

{#if unmeasurable}<span class="st-drive">Manager can’t check free space on this folder from here. Frameleaf still uses it as normal.</span>
{:else if hint}<span class="st-drive" data-speed={low ? 'low' : hint.speed}><Icon name={hint.speed === 'fast' ? 'bolt' : hint.speed === 'network' ? 'lan' : 'harddisk'} />{hint.text}{#if low}{' · Nearly full'}{/if}</span>{/if}
