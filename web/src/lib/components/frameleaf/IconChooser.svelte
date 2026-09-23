<script lang="ts">
  import Status from '$lib/components/frameleaf/Status.svelte';
  import {
    buildCatalogueEntries,
    iconPathFor,
    loadIconCatalogue,
    loadIconPaths,
    searchCatalogue,
    type CatalogueEntry,
    type IconPaths,
  } from '$lib/frameleaf/icon-catalogue';
  import type { AlbumIconCatalogueResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiMagnify } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * Searchable icon chooser over the whole Material Design Icons catalogue: the
   * categorised suggested set first, then every icon, filtered as you type.
   * The names and suggestions come from `GET /albums/icons`; the geometry chunk
   * loads lazily. By default it is a popover under its anchor; `inline` renders
   * it as a static panel inside a form. Every icon picker in the product reuses
   * this component.
   */
  interface Props {
    value: string | null;
    onChange: (name: string) => void;
    onClose?: () => void;
    label?: string;
    inline?: boolean;
  }

  let { value, onChange, onClose, label, inline = false }: Props = $props();

  const PAGE = 240;

  let catalogue = $state<AlbumIconCatalogueResponseDto | undefined>();
  let paths = $state<IconPaths | undefined>();
  let failed = $state(false);
  let query = $state('');
  let limit = $state(PAGE);
  let root = $state<HTMLDivElement>();
  let search = $state<HTMLInputElement>();

  const entries = $derived<CatalogueEntry[]>(catalogue ? buildCatalogueEntries(catalogue) : []);
  const terms = $derived(query.trim().length > 0);
  const results = $derived(searchCatalogue(entries, query));
  const shown = $derived(results.slice(0, limit));
  const remaining = $derived(results.length - shown.length);
  const title = $derived(label ?? $t('frameleaf_icons_choose'));

  $effect(() => {
    // A new search starts from the first page again.
    void query;
    limit = PAGE;
  });

  const load = async () => {
    failed = false;
    try {
      const [loadedCatalogue, loadedPaths] = await Promise.all([loadIconCatalogue(), loadIconPaths()]);
      catalogue = loadedCatalogue;
      paths = loadedPaths;
    } catch {
      failed = true;
    }
  };

  onMount(() => {
    void load();
    if (!inline) {
      search?.focus();
      const outside = (event: PointerEvent) => {
        if (root && !root.contains(event.target as Node)) {
          onClose?.();
        }
      };
      document.addEventListener('pointerdown', outside);
      return () => document.removeEventListener('pointerdown', outside);
    }
  });

  const choose = (name: string) => {
    onChange(name);
    if (!inline) {
      onClose?.();
    }
  };

  /** Options per row for the grid that holds `active`, measured so arrow keys move by row. */
  const columnsOf = (active: HTMLElement) => {
    const siblings = [...(active.parentElement?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    if (siblings.length < 2) {
      return 1;
    }
    const top = siblings[0].offsetTop;
    const inRow = siblings.filter((element) => element.offsetTop === top).length;
    return inRow === siblings.length && siblings.length > 8 ? 8 : Math.max(1, inRow);
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && event.target === search) {
      // Never submit an enclosing form from the icon search.
      event.preventDefault();
      return;
    }
    if (event.key === 'Escape') {
      if (inline) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose?.();
      return;
    }
    const options = [...(root?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])];
    const index = options.indexOf(document.activeElement as HTMLElement);
    const columns = index === -1 ? 1 : columnsOf(options[index]);
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    if (step === undefined) {
      return;
    }
    if (index === -1) {
      if (event.key === 'ArrowDown' && options[0]) {
        event.preventDefault();
        options[0].focus();
      }
      return;
    }
    event.preventDefault();
    const next = index + step;
    if (next < 0) {
      search?.focus();
    } else {
      options[Math.min(options.length - 1, next)]?.focus();
    }
  };
</script>

{#snippet option(name: string, text: string)}
  <button
    type="button"
    role="option"
    aria-selected={value === name}
    aria-label={text}
    title={text}
    class:chosen={value === name}
    onclick={() => choose(name)}
  >
    <Icon icon={iconPathFor(name, paths)} size="20" />
  </button>
{/snippet}

<div
  bind:this={root}
  class="chooser"
  class:inline
  role={inline ? 'group' : 'dialog'}
  aria-label={title}
  onkeydown={onKeydown}
>
  <label class="search">
    <Icon icon={mdiMagnify} size="16" />
    <input
      bind:this={search}
      type="search"
      placeholder={catalogue
        ? $t('frameleaf_icons_search_count', { values: { count: catalogue.names.length } })
        : $t('frameleaf_icons_search')}
      aria-label={$t('frameleaf_icons_search')}
      bind:value={query}
      disabled={!catalogue}
    />
  </label>
  <div class="scroll">
    {#if failed}
      <div class="state">
        <Status message={$t('frameleaf_icons_load_failed')} />
        <button type="button" class="retry" onclick={() => void load()}>{$t('retry')}</button>
      </div>
    {:else if !catalogue}
      <div class="state"><Status message={$t('frameleaf_icons_loading')} busy /></div>
    {:else}
      {#if !terms}
        {#each catalogue.suggested as group (group.label)}
          <section>
            <h3>{group.label}</h3>
            <div class="grid" role="listbox" aria-label={group.label}>
              {#each group.icons as icon (icon.name)}
                {@render option(icon.name, icon.label)}
              {/each}
            </div>
          </section>
        {/each}
      {/if}
      <section>
        <h3>
          {terms
            ? $t('frameleaf_icons_matching', { values: { count: results.length } })
            : $t('frameleaf_icons_all', { values: { count: catalogue.names.length } })}
        </h3>
        {#if results.length > 0}
          <div
            class="grid"
            role="listbox"
            aria-label={$t('frameleaf_icons_all', { values: { count: results.length } })}
          >
            {#each shown as entry (entry.name)}
              {@render option(entry.name, entry.label)}
            {/each}
          </div>
          {#if remaining > 0}
            <button type="button" class="more" onclick={() => (limit += PAGE * 2)}>
              {$t('frameleaf_icons_more', { values: { count: Math.min(PAGE * 2, remaining), total: results.length } })}
            </button>
          {/if}
        {:else}
          <p class="empty">{$t('frameleaf_icons_none')}</p>
        {/if}
      </section>
    {/if}
  </div>
</div>

<style>
  .chooser {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(26rem, calc(100vw - 2rem));
    max-height: 24rem;
    padding: 0.5rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    box-shadow: 0 12px 32px rgb(0 0 0 / 25%);
  }
  .chooser.inline {
    width: 100%;
    max-height: 18rem;
    box-shadow: none;
    background: var(--fl-canvas);
  }
  .search {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding-inline-start: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .search input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  .search input:focus-visible {
    outline: none;
  }
  .search:focus-within {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .scroll {
    overflow-y: auto;
    min-height: 0;
  }
  section + section {
    margin-block-start: 0.5rem;
  }
  h3 {
    margin: 0.25rem 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--fl-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(8, minmax(0, 1fr));
    gap: 0.25rem;
  }
  .grid button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    aspect-ratio: 1;
    min-height: 44px;
    min-width: 0;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
    background: transparent;
    color: var(--fl-text);
  }
  .grid button:hover {
    background: var(--fl-raised);
  }
  .grid button.chosen {
    border-color: var(--fl-accent);
    background: var(--fl-raised);
    color: var(--fl-accent);
  }
  .more,
  .retry {
    margin-block-start: 0.5rem;
    width: 100%;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .empty {
    margin: 0.5rem 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .state {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem;
  }
  @media (max-width: 480px) {
    .grid {
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
  }
</style>
