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
  .group {
    margin-top: 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .group.open {
    border-color: color-mix(in srgb, var(--fl-accent) 45%, var(--fl-border));
  }
  button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    width: 100%;
    padding: 0.75rem 1rem;
    text-align: start;
    color: var(--fl-text);
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-card);
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-raised), transparent 40%);
  }
  .heading {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    min-width: 0;
  }
  .title-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-weight: 550;
  }
  .subtitle {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .chevron {
    display: grid;
    place-items: center;
    flex-shrink: 0;
    color: var(--fl-muted);
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  .open .chevron {
    transform: rotate(180deg);
  }
  .panel {
    padding: 0 1rem 1rem;
  }
</style>
