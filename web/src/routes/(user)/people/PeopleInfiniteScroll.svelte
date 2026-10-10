<script lang="ts" generics="T extends PersonResponseDto">
  import { onDestroy } from 'svelte';
  import { listEnter, listFlip, listLeave } from '$lib/components/frameleaf/people/list-motion';
  import type { PersonResponseDto } from '@frameleaf/sdk';

  interface Props {
    people: T[];
    managed?: boolean;
    hasNextPage?: boolean | undefined;
    loadNextPage: () => void;
    children?: import('svelte').Snippet<[{ person: T; index: number }]>;
  }

  let { people, managed = false, hasNextPage = undefined, loadNextPage, children }: Props = $props();

  let grid: HTMLElement | undefined = $state();
  // The last card is what the next page loads behind; it is read from the grid, so every card
  // keeps the same wrapper and can slide when the list is sorted or filtered.
  const lastPersonContainer = $derived(people.length > 0 ? (grid?.lastElementChild ?? undefined) : undefined);
  const motion = $derived({ count: people.length });

  let retired = false;
  const intersectionObserver = new IntersectionObserver((entries) => {
    const entry = entries.find((entry) => entry.target === lastPersonContainer);
    if (!retired && hasNextPage && entry?.isIntersecting) {
      loadNextPage();
    }
  });

  onDestroy(() => {
    retired = true;
    intersectionObserver.disconnect();
  });

  $effect(() => {
    intersectionObserver.disconnect();
    if (!lastPersonContainer || !hasNextPage) {
      return;
    }

    intersectionObserver.observe(lastPersonContainer);
  });
</script>

<div class={managed ? 'managed-grid' : 'library-grid'} bind:this={grid}>
  {#each people as person, index (person.id)}
    <div class="cell" animate:listFlip={motion} in:listEnter={motion} out:listLeave={motion}>
      {@render children?.({ person, index })}
    </div>
  {/each}
</div>

<style>
  /* template/src/people.css `.pl-grid`. */
  .library-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
    gap: 20px;
  }
  .managed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 14px;
  }
  .cell {
    min-width: 0;
  }
  @media (max-width: 700px) {
    /* Two faces on a small phone, three once there is room for them. */
    .library-grid {
      grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
      gap: 8px;
    }
    .managed-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  }
</style>
