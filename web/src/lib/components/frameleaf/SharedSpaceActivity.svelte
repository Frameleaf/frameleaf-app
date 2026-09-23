<script lang="ts">
  import ActivityPanel from '$lib/components/frameleaf/ActivityPanel.svelte';
  import { activityManager } from '$lib/managers/activity-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import type { AlbumResponseDto } from '@immich/sdk';
  import { onDestroy } from 'svelte';

  /**
   * Likes and comments for a shared space, on the space's own page (FL-55).
   *
   * A space is an album, so its activity is the album's activity: the same `ActivityPanel` the album
   * view opens beside its photos, through the same `activityManager` and the same endpoints. This
   * only mounts it as a panel of its own and owns the manager's lifetime while it is open, so the
   * album view and this page never disagree about what was said.
   */
  interface Props {
    space: AlbumResponseDto;
    onClose: () => void;
  }

  let { space, onClose }: Props = $props();

  $effect(() => {
    handlePromiseError(activityManager.init(space.id));
  });

  onDestroy(() => activityManager.reset());
</script>

<div class="space-activity">
  <ActivityPanel album={space} {onClose} />
</div>

<style>
  .space-activity {
    display: flex;
    justify-content: center;
    block-size: min(70vh, 40rem);
    min-block-size: 20rem;
  }
  .space-activity :global(aside.activity) {
    inline-size: min(40rem, 100%);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
</style>
