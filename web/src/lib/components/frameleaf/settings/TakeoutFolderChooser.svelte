<script lang="ts" module>
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import type { TakeoutFolderContentsDto } from '@frameleaf/sdk';
  import type { MessageFormatter } from 'svelte-i18n';

  /** A folder the administrator chose: its location, the folders below it, and what it holds. */
  export type ChosenTakeoutFolder = { rootId: string; parts: string[]; contents: TakeoutFolderContentsDto };

  /** The folder holds something a Google Photos import can read. */
  export const holdsTakeoutExport = ({ zip, tgz, unpacked }: TakeoutFolderContentsDto) => zip + tgz > 0 || unpacked;

  /** What a folder holds, in words: "3 .tgz files · 12 GB", "Google Photos folder" or "No Google export found". */
  export const describeTakeoutFolder = (contents: TakeoutFolderContentsDto, t: MessageFormatter, locale?: string) => {
    const parts = [];
    if (contents.zip > 0) {
      parts.push(t('frameleaf_takeout_folder_zip_files', { values: { count: contents.zip } }));
    }
    if (contents.tgz > 0) {
      parts.push(t('frameleaf_takeout_folder_tgz_files', { values: { count: contents.tgz } }));
    }
    if (parts.length > 0) {
      return [...parts, formatBytes(contents.bytes, locale)].join(' · ');
    }
    return contents.unpacked ? t('frameleaf_takeout_folder_unpacked') : t('frameleaf_takeout_folder_no_export');
  };
</script>

<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getTakeoutFolders, type TakeoutFoldersResponseDto, type TakeoutRootDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiFolderOutline, mdiHarddisk } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Browse the folders this server may import from and choose one, after the prototype's
   * `FolderChooser` (`settings-v2/library/parts.jsx`). Nothing is typed: the top level is the
   * permitted import locations, and each folder says what it holds (ZIP or .tgz archives, or an
   * unpacked export), as the server read it.
   */
  let {
    roots,
    onClose,
    onChoose,
  }: {
    roots: TakeoutRootDto[];
    onClose: () => void;
    onChoose: (folder: ChosenTakeoutFolder) => void;
  } = $props();

  let rootId = $state<string>();
  let trail = $state<string[]>([]);
  let listing = $state<{ key: string; result?: TakeoutFoldersResponseDto; failed?: boolean }>();
  const key = $derived(rootId === undefined ? '' : `${rootId}\n${trail.join('/')}`);
  const root = $derived(roots.find((item) => item.id === rootId));
  const current = $derived(listing?.key === key ? listing : undefined);

  $effect(() => {
    const requested = key;
    if (rootId === undefined) {
      return;
    }
    void getTakeoutFolders({ rootId, path: trail.join('/') })
      .then((result) => {
        if (requested === key) {
          listing = { key: requested, result };
        }
      })
      .catch(() => {
        if (requested === key) {
          listing = { key: requested, failed: true };
        }
      });
  });

  const describe = (contents: TakeoutFolderContentsDto) => describeTakeoutFolder(contents, $t, $locale);

  const crumbs = $derived(root ? [root.path, ...trail] : []);
  const goTo = (depth: number) => {
    if (depth === 0) {
      rootId = undefined;
      trail = [];
    } else {
      trail = trail.slice(0, depth - 1);
    }
  };
  const choose = () => {
    if (rootId !== undefined && current?.result) {
      onChoose({ rootId, parts: [...trail], contents: current.result.here });
    }
  };
</script>

<Dialog title={$t('frameleaf_takeout_folder_chooser_title')} closeLabel={$t('close')} open onRequestClose={onClose}>
  <nav class="crumbs" aria-label={$t('frameleaf_takeout_folder_where')}>
    {#each [$t('frameleaf_takeout_folder_allowed'), ...crumbs] as name, index (index)}
      {#if index > 0}<Icon icon={mdiChevronRight} size="14" aria-hidden={true} />{/if}
      <button type="button" aria-current={index === crumbs.length ? 'page' : undefined} onclick={() => goTo(index)}>
        {name}
      </button>
    {/each}
  </nav>

  {#if rootId === undefined}
    <ul class="folders">
      {#each roots as item (item.id)}
        <li>
          <button type="button" onclick={() => (rootId = item.id)}>
            <span class="icon"><Icon icon={mdiHarddisk} size="20" aria-hidden={true} /></span>
            <span><strong>{item.path}</strong></span>
            <Icon icon={mdiChevronRight} aria-hidden={true} />
          </button>
        </li>
      {/each}
    </ul>
  {:else if current?.result}
    <ul class="folders">
      {#each current.result.folders as folder (folder.name)}
        <li>
          <button type="button" onclick={() => (trail = [...trail, folder.name])}>
            <span class="icon"><Icon icon={mdiFolderOutline} size="20" aria-hidden={true} /></span>
            <span>
              <strong>{folder.name}</strong>
              <small>{describe(folder)}</small>
            </span>
            <Icon icon={mdiChevronRight} aria-hidden={true} />
          </button>
        </li>
      {/each}
      {#if current.result.folders.length === 0}
        <li class="hint">{$t('frameleaf_takeout_folder_none')}</li>
      {/if}
    </ul>
  {:else if current?.failed}
    <InlineError compact message={$t('frameleaf_takeout_error_generic')} />
  {:else}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="text" lines={3} />
    </div>
  {/if}
  <p class="hint">{$t('frameleaf_takeout_folder_only_allowed')}</p>

  {#snippet actions()}
    <span class="count">
      {current?.result ? describe(current.result.here) : $t('frameleaf_takeout_folder_open_to_choose')}
    </span>
    <Button onclick={onClose}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!current?.result} onclick={choose}>
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
    margin-inline-end: auto;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
