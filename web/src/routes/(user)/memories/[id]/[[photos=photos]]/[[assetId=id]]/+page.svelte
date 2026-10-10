<script lang="ts">
  /**
   * Frameleaf memory player (FL-62). The Frameleaf UI is the only UI here now: see
   * `$lib/components/frameleaf/MemoryPlayerPanel.svelte` for the Ken Burns player, gallery,
   * remove/share/make-a-movie actions, built on the existing `memoryManager`.
   */
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import MemoryPlayerPanel from '$lib/components/frameleaf/MemoryPlayerPanel.svelte';
  import { HERO_PAGE_ATTRIBUTE, HERO_SHARED_ATTRIBUTE } from '$lib/frameleaf/motion';

  /**
   * A memory's card (Memories, Explore) travels into the player's stage, and back (BRAND.md
   * "Hero", `data-fl-shared`). The stage carries the mark only around a navigation between this
   * page and one of those two: the player also navigates from item to item, and a stage that
   * stayed marked would pair with itself on every one of them.
   */
  const CARD_ROUTES = new Set(['/(user)/memories', '/(user)/explore']);
  const isCardRoute = (id: string | null | undefined) => !!id && CARD_ROUTES.has(id);
  const markStage = () => {
    const stage = document.querySelector<HTMLElement>('[data-fl-memory-stage]');
    const id = stage?.dataset.flMemoryStage;
    if (!stage || !id) {
      return null;
    }
    stage.setAttribute(HERO_SHARED_ATTRIBUTE, `memory:${id}`);
    stage.setAttribute(HERO_PAGE_ATTRIBUTE, '');
    return stage;
  };
  const unmarkStage = (stage: HTMLElement | null) => {
    stage?.removeAttribute(HERO_SHARED_ATTRIBUTE);
    stage?.removeAttribute(HERO_PAGE_ATTRIBUTE);
  };
  beforeNavigate(({ to }) => {
    if (isCardRoute(to?.route.id)) {
      markStage();
    }
  });
  afterNavigate(({ from }) => {
    if (!isCardRoute(from?.route.id)) {
      return;
    }
    const stage = markStage();
    // The root layout reads the mark in the same turn; after that the stage is the player's own.
    setTimeout(() => unmarkStage(stage), 0);
  });
</script>

<MemoryPlayerPanel />
