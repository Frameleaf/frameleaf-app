<script lang="ts" generics="Extra">
  /**
   * The one folder chooser (FL-1814; the prototype's `FolderChooser` in
   * `settings-v2/library/parts.jsx`): browse the folders this server can open and choose one.
   * Nothing is typed. Where the folders come from is the caller's `read`: the import locations
   * (`$lib/frameleaf/folder-readers` `takeoutFolderReader`) or the server's disks
   * (`libraryFolderReader`).
   *
   * Mount it while choosing (`{#if choosing}<FolderChooser …>`).
   */
  import type { FolderEntry, FolderListing } from '$lib/frameleaf/folder-readers';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiFolderOutline } from '@mdi/js';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { tick, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    rootName,
    start = [],
    read,
    note,
    empty,
    refresh = 0,
    onClose,
    onChoose,
  }: {
    title?: string;
    /** The first step of the trail: "Allowed folders", "This server". */
    rootName: string;
    /** The folder to open first. */
    start?: FolderEntry[];
    read: (trail: FolderEntry[]) => Promise<FolderListing<Extra>>;
    /** The standing line under the list: which folders are listed, and why one may be missing. */
    note?: string;
    /** In place of "No folders inside this one" when the open folder has none. */
    empty?: Snippet<[FolderListing<Extra>]>;
    /** Change it to read the open folder again (the window came back into focus). */
    refresh?: number;
    onClose: () => void;
    onChoose: (trail: FolderEntry[], listing: FolderListing<Extra>) => void;
  } = $props();

  let open = $state(true);
  let trail = $state<FolderEntry[]>(start);
  let retries = $state(0);
  let listing = $state<{ key: string; place: string; result?: FolderListing<Extra>; failed?: string }>();
  const place = $derived(trail.map((step) => step.id ?? step.name).join('\n'));
  const key = $derived(`${refresh}\n${retries}\n${place}`);
  const current = $derived(listing?.key === key ? listing : undefined);
  // Reading the same folder again (a refresh) keeps its list on screen instead of flashing the skeleton.
  // Moving to another folder never does: a row of the folder just left must not be clickable.
  const shown = $derived(current ?? (listing?.result && listing.place === place ? listing : undefined));
  const crumbs = $derived(shown?.result?.trail ?? trail);
  const choosable = $derived(!!current?.result?.choosable);

  let list: HTMLUListElement | undefined = $state();
  let nav: HTMLElement | undefined = $state();
  /** Set on open and on each move: the next list read takes the focus, on its first folder. */
  let moved = true;
  const go = (next: FolderEntry[]) => {
    moved = true;
    trail = next;
  };

  $effect(() => {
    const requested = key;
    const at = place;
    void read(trail)
      .then(async (result) => {
        if (requested !== key) {
          return;
        }
        listing = { key: requested, place: at, result };
        if (moved) {
          moved = false;
          await tick();
          (list?.querySelector('button') ?? nav?.querySelector<HTMLElement>('[aria-current]'))?.focus();
        }
      })
      .catch((error: unknown) => {
        if (requested === key) {
          listing = {
            key: requested,
            place: at,
            failed: getServerErrorMessage(error) ?? $t('frameleaf_libraries_browse_failed'),
          };
        }
      });
  });

  const choose = () => {
    if (current?.result?.choosable) {
      onChoose(crumbs, current.result);
      open = false;
    }
  };
</script>

<Dialog
  title={title ?? $t('frameleaf_backup_browse_chooser_title')}
  closeLabel={$t('close')}
  bind:open
  onClosed={onClose}
>
  <nav class="crumbs" bind:this={nav} aria-label={$t('frameleaf_takeout_folder_where')}>
    {#each [rootName, ...crumbs.map((step) => step.name)] as name, index (index)}
      {#if index > 0}<Icon icon={mdiChevronRight} size="14" aria-hidden={true} />{/if}
      <button
        type="button"
        aria-current={index === crumbs.length ? 'page' : undefined}
        onclick={() => go(crumbs.slice(0, index))}
      >
        {name}
      </button>
    {/each}
  </nav>

  {#if shown?.result}
    {@const result = shown.result}
    <ul class="folders" bind:this={list}>
      {#each result.folders as folder (folder.id ?? folder.name)}
        <li>
          <button type="button" onclick={() => go([...crumbs, folder])}>
            <span class="icon"><Icon icon={folder.icon ?? mdiFolderOutline} size="20" aria-hidden={true} /></span>
            <span>
              <strong>{folder.name}</strong>
              {#if folder.detail}<small>{folder.detail}</small>{/if}
            </span>
            <Icon icon={mdiChevronRight} aria-hidden={true} />
          </button>
        </li>
      {/each}
      {#if result.folders.length === 0 && !result.problem && !empty}
        <li class="hint">{$t('frameleaf_takeout_folder_none')}</li>
      {/if}
    </ul>
    {#if result.problem}
      <p class="hint" role="alert">{result.problem}</p>
    {:else if result.folders.length === 0 && empty}
      {@render empty(result)}
    {:else if result.note ?? note}
      <p class="hint">{result.note ?? note}</p>
    {/if}
  {:else if current?.failed}
    <InlineError compact message={current.failed} onRetry={() => retries++} />
  {:else}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="text" lines={3} />
    </div>
  {/if}

  {#snippet actions()}
    <span class="count">
      {choosable ? (current?.result?.detail ?? '') : $t('frameleaf_takeout_folder_open_to_choose')}
    </span>
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!choosable} onclick={choose}>
      {$t('frameleaf_takeout_folder_choose_this')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-1);
    align-items: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .crumbs button {
    min-height: 32px;
    padding: 0 var(--fl-space-2);
    color: var(--fl-muted);
    font: inherit;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .crumbs button[aria-current] {
    color: var(--fl-text);
    font-weight: 600;
  }
  .crumbs button:hover {
    background: var(--fl-raised);
  }
  .folders {
    max-height: min(48dvh, 380px);
    margin: var(--fl-space-3) 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .folders button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--fl-space-3);
    align-items: center;
    width: 100%;
    min-height: 60px;
    padding: var(--fl-space-2);
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    background: none;
    border: 0;
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .folders button:hover {
    background: var(--fl-raised);
  }
  .folders button > :global(svg) {
    color: var(--fl-muted);
  }
  .folders strong {
    display: block;
    overflow-wrap: anywhere;
    font-weight: 600;
  }
  .folders small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .icon {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, var(--fl-panel));
    border-radius: var(--fl-radius-control);
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .count {
    align-self: center;
    min-width: 0;
    overflow-wrap: anywhere;
    margin-inline-end: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
