<script lang="ts">
  /**
   * The up/down control on a path pill: the folders beside that folder, the current one ticked, so a
   * neighbouring month or trip is one step away (mock `PathBar`, `11-folders-v2-sibling-menu`).
   *
   * It is the shared `Menu`, so the keyboard, Escape and focus behave as every other menu. A level
   * can hold hundreds of folders (a default install has up to 256 hash folders side by side), so the
   * list scrolls inside the popup, a long one gets a filter field, and no more than `LIMIT` rows are
   * drawn at once.
   */
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import { nameMatchesFind } from '$lib/frameleaf/discovery-find';
  import { folderSiblings, sortFolders, type FolderLabel, type FolderNode } from '$lib/frameleaf/folder-tree';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiMagnify, mdiUnfoldMoreHorizontal } from '@mdi/js';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    folder,
    name,
    label,
    onGo,
  }: {
    /** The folder the pill stands for; the menu lists it and the folders beside it. */
    folder: FolderNode;
    /** The pill's own text, for the control's accessible name. */
    name: string;
    label: FolderLabel;
    onGo: (folder: FolderNode) => void;
  } = $props();

  /** A list longer than this gets the filter field. */
  const FILTER_FROM = 12;
  /** The most rows drawn at once; the filter reaches the rest. */
  const LIMIT = 200;
  /** The popup's widest (`Menu`: 20rem), to keep it inside the window. */
  const POPUP_WIDTH = 320;

  let open = $state(false);
  let filter = $state('');
  let align = $state<'start' | 'end'>('start');
  let host = $state<HTMLElement>();
  let input = $state<HTMLInputElement>();

  const siblings = $derived(sortFolders(folderSiblings(folder), 'name', label));
  const filterable = $derived(siblings.length > FILTER_FROM);
  const needle = $derived(filter.trim());
  const matches = $derived(
    needle
      ? siblings.filter((sibling) => nameMatchesFind(label(sibling), needle) || nameMatchesFind(sibling.name, needle))
      : siblings,
  );
  const listed = $derived(matches.slice(0, LIMIT));

  $effect(() => {
    const element = host;
    if (!open) {
      filter = '';
      return;
    }
    if (!element) {
      return;
    }
    // The list hangs from the start of the pill; where that would run off the window, from its end.
    const pill = (element.offsetParent ?? element).getBoundingClientRect();
    align = pill.left + POPUP_WIDTH > innerWidth - 16 ? 'end' : 'start';
    // After the menu has placed focus on its first row: start in the filter, or on the current folder.
    void tick().then(() => {
      const current = element.querySelector<HTMLElement>('[aria-checked="true"]');
      (input ?? current)?.focus();
      current?.scrollIntoView?.({ block: 'nearest' });
    });
  });

  const go = (target: FolderNode) => {
    if (target !== folder) {
      onGo(target);
    }
  };

  const onFilterKeydown = (event: KeyboardEvent) => {
    // Home and End move the caret here; in the list they jump to its first and last row.
    if (event.key === 'Home' || event.key === 'End') {
      event.stopPropagation();
      return;
    }
    const first = listed.at(0);
    if (event.key === 'Enter' && first) {
      event.preventDefault();
      // Back on the control before the popup goes, so focus never falls to the page.
      host?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
      open = false;
      go(first);
    }
  };

  /** Typing while a row has focus goes on narrowing the list. */
  const onKeydown = (event: KeyboardEvent) => {
    const typing = event.key.length === 1 && event.key !== ' ' && !event.ctrlKey && !event.metaKey && !event.altKey;
    if (typing && input && event.target !== input) {
      input.focus();
    }
  };
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<span class="siblings" bind:this={host} onkeydown={onKeydown}>
  <Menu label={$t('frameleaf_folders_siblings_of', { values: { name } })} {align} bind:open>
    {#snippet trigger()}
      <Icon icon={mdiUnfoldMoreHorizontal} size="16" aria-hidden />
    {/snippet}
    {#if filterable}
      <div class="filter" role="presentation">
        <Icon icon={mdiMagnify} size="15" aria-hidden />
        <input
          type="text"
          autocomplete="off"
          spellcheck="false"
          placeholder={$t('frameleaf_folders_siblings_filter')}
          aria-label={$t('frameleaf_folders_siblings_filter')}
          bind:value={filter}
          bind:this={input}
          onkeydown={onFilterKeydown}
        />
      </div>
    {/if}
    {#each listed as sibling (sibling.path)}
      <MenuItem checked={sibling === folder} onSelect={() => go(sibling)}>
        <span class="name">{label(sibling)}</span>
        {#if sibling === folder}<Icon icon={mdiCheck} size="16" aria-hidden />{/if}
      </MenuItem>
    {:else}
      <p class="note">{$t('frameleaf_folders_find_none_title', { values: { query: needle } })}</p>
    {/each}
    {#if matches.length > listed.length}
      <p class="note">
        {$t('frameleaf_folders_siblings_more', { values: { shown: listed.length, total: matches.length } })}
      </p>
    {/if}
  </Menu>
</span>

<style>
  .siblings {
    display: inline-flex;
  }
  /* The list of folders lines up with the pill, not with its arrows. */
  .siblings :global(.menu-root) {
    position: static;
  }
  .siblings :global(.menu-root > button) {
    min-width: 0;
    min-height: 32px;
    padding: 0 9px 0 2px;
    border: 0;
    border-radius: 0 var(--fl-radius-pill) var(--fl-radius-pill) 0;
    background: none;
    color: var(--fl-muted);
  }
  .siblings :global(.menu-root > button:dir(rtl)) {
    border-radius: var(--fl-radius-pill) 0 0 var(--fl-radius-pill);
  }
  .siblings :global(.menu-root > button:hover),
  .siblings :global(.menu-root > button[aria-expanded='true']) {
    background: none;
    color: var(--fl-text);
  }
  .siblings :global(.menu-root > button:focus-visible) {
    outline-offset: 1px;
  }
  .siblings :global([role='menu']) {
    max-height: min(60dvh, 420px);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
    color: var(--fl-text);
    font-weight: 400;
  }
  .siblings :global([role='menu'] [role^='menuitem']) {
    min-height: 36px;
    padding-block: 0.375rem;
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* Stays in view while the list scrolls under it. */
  .filter {
    position: sticky;
    top: -0.375rem;
    z-index: 1;
    display: flex;
    align-items: center;
    gap: 0.375rem;
    margin: -0.375rem -0.375rem 0.25rem;
    padding: 0.25rem 0.75rem;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .filter input {
    flex: 1;
    min-width: 0;
    min-height: 34px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fl-text);
    font: inherit;
  }
  /* The field is the whole strip, so the strip wears the focus ring in the input's place. */
  .filter input:focus-visible {
    outline: none;
  }
  .filter:has(input:focus-visible) {
    box-shadow: inset 0 -2px 0 var(--fl-accent);
  }
  .note {
    margin: 0;
    padding: 0.5rem 0.625rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    white-space: normal;
  }
  @media (pointer: coarse) {
    .siblings :global(.menu-root > button) {
      min-width: 36px;
      min-height: 44px;
    }
    .siblings :global([role='menu'] [role^='menuitem']) {
      min-height: 44px;
    }
  }
</style>
