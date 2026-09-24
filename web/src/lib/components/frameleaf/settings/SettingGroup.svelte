<script lang="ts">
  /**
   * A collapsible group of related controls inside a settings section (FL-71). It replaces the
   * nested SettingAccordion with the same props, and keeps its open state in the `isOpen` query
   * parameter through the accordion manager so existing deep links still open the right group.
   */
  import { accordionManager } from '$lib/managers/accordion-manager.svelte';
  import { Icon } from '@immich/ui';
  import { mdiChevronDown } from '@mdi/js';
  import type { Snippet } from 'svelte';

  interface Props {
    title: string;
    subtitle?: string;
    key: string;
    isOpen?: boolean;
    autoScrollTo?: boolean;
    icon?: string;
    subtitleSnippet?: Snippet;
    children?: Snippet;
  }

  let {
    title,
    subtitle = '',
    key,
    isOpen = $bindable(false),
    autoScrollTo = false,
    icon = '',
    subtitleSnippet,
    children,
  }: Props = $props();

  const id = $props.id();
  let element: HTMLDivElement | undefined = $state();

  $effect(() => {
    isOpen = accordionManager.isOpen(key);
  });

  const toggle = () => {
    if (isOpen) {
      accordionManager.close(key);
      return;
    }
    accordionManager.open(key);
    if (autoScrollTo) {
      setTimeout(() => element?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 200);
    }
  };

  // Unmounting an area must not navigate: the router may still expose the source URL.
  // Open groups stay in the URL so Back restores the requested state.
</script>

<div class="group" class:open={isOpen} bind:this={element} id="setting-group-{key}">
  <button type="button" aria-expanded={isOpen} aria-controls="{id}-panel" onclick={toggle}>
    <span class="heading">
      <span class="title-line">
        {#if icon}
          <Icon {icon} size="1.25rem" aria-hidden={true} />
        {/if}
        <span class="title">{title}</span>
      </span>
      {#if subtitleSnippet}
        <span class="subtitle">{@render subtitleSnippet()}</span>
      {:else if subtitle}
        <span class="subtitle">{subtitle}</span>
      {/if}
    </span>
    <span class="chevron" aria-hidden="true"><Icon icon={mdiChevronDown} size="1.25rem" /></span>
  </button>
  {#if isOpen}
    <div class="panel" id="{id}-panel">
      {@render children?.()}
    </div>
  {/if}
</div>

<style>
  /*
   * Sept 24: a group is a disclosure row inside the page's grouped list rather than a card inside
   * a card (apple-style.css:1014-1045); its settings open underneath with a quiet inset.
   */
  .group {
    border-top: 1px solid var(--fl-border);
  }
  .group:first-child {
    border-top: 0;
  }
  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    width: 100%;
    min-height: 48px;
    padding: 12px 0;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: 0;
    font: inherit;
  }
  button:hover .title-line {
    color: var(--fl-accent);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
    border-radius: var(--fl-radius-control);
  }
  .heading {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
  }
  .title-line {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 550;
  }
  .title-line :global(svg) {
    color: var(--fl-muted);
  }
  .subtitle {
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.45;
  }
  .chevron {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: var(--fl-muted);
    transition: transform var(--fl-duration, 380ms) var(--fl-spring, ease);
  }
  .open .chevron {
    transform: rotate(180deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chevron {
      transition: none;
    }
  }
  .panel {
    margin: 0 0 12px;
    padding: 0 0 0 14px;
    border-inline-start: 2px solid var(--fl-border);
  }
</style>
