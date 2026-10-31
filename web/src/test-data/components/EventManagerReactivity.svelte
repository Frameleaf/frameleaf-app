<script lang="ts">
  import type { BaseEventManager } from '$lib/utils/base-event-manager.svelte';

  let { manager, observations }: { manager: BaseEventManager<Record<string, []>>; observations: boolean[] } = $props();

  $effect(() => {
    observations.push(manager.hasListeners('first'));
  });

  $effect(() => {
    manager.emit('effect');
  });
</script>

<button type="button" disabled={!manager.hasListeners('first')}>Event action</button>
