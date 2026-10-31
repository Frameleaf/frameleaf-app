<script lang="ts">
  import { eventManager, type Events } from '$lib/managers/event-manager.svelte';
  import type { EventMap } from '$lib/utils/base-event-manager.svelte';
  import { untrack } from 'svelte';

  type Props = {
    [K in keyof Events as `on${K}`]?: (...args: Events[K]) => void;
  };

  const props: Props = $props();

  $effect(() => {
    const events = Object.fromEntries(
      Object.entries(props).map(([name, listener]) => [name.slice(2), listener]),
    ) as EventMap<Events>;
    // Subscription writes must not make this effect depend on the manager's listener revision.
    return untrack(() => eventManager.on(events));
  });
</script>
