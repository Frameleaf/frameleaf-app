<script lang="ts">
  import { onDestroy } from 'svelte';
  import type { PersonResponseDto } from '@immich/sdk';

  interface Props {
    people: PersonResponseDto[];
    managed?: boolean;
    hasNextPage?: boolean | undefined;
    loadNextPage: () => void;
    children?: import('svelte').Snippet<[{ person: PersonResponseDto; index: number }]>;
  }

  let { people, managed = false, hasNextPage = undefined, loadNextPage, children }: Props = $props();

  let lastPersonContainer: HTMLElement | undefined = $state();

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

<div
  class={managed
    ? 'managed-grid'
    : 'grid w-full grid-cols-2 gap-1 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-7 2xl:grid-cols-10'}
>
  {#each people as person, index (person.id)}
    {#if hasNextPage && index === people.length - 1}
      <div bind:this={lastPersonContainer}>
        {@render children?.({ person, index })}
      </div>
    {:else}
      {@render children?.({ person, index })}
    {/if}
  {/each}
</div>

<style>
  .managed-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 14px;
  }
  @media (max-width: 700px) {
    .managed-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 8px;
    }
  }
</style>
