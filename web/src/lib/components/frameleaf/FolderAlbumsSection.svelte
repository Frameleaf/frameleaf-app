<script lang="ts">
  /**
   * FL-838: "Make an album for each folder", on a folder's page (Libraries › a folder) and as step 4 of Add a folder,
   * after the approved prototype (`settings-v2/library/folders.jsx` FolderAlbums, `mock=folder-albums`). With the
   * switch on, the albums it makes are shown as a tree, read from the folder estimate (the same walk a check does,
   * with the folder's skips). On a folder's page, turning it off asks first: keep the albums as ordinary albums
   * (preselected) or remove them. Photos are never deleted either way.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import { folderAlbumCounts, folderAlbumTree, type FolderAlbumNode } from '$lib/frameleaf/folder-albums';
  import { formatCount } from '$lib/frameleaf/number-format';
  import { locale } from '$lib/stores/preferences.store';
  import { estimateLibraryFolder, type LibraryFolderEstimateResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiFolderMultipleOutline, mdiImageAlbum } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Estimate = Pick<LibraryFolderEstimateResponseDto, 'folders' | 'complete'>;

  type Props = {
    title: string;
    roots: string[];
    exclusionPatterns: string[];
    libraryName: string;
    ownerName: string;
    checked: boolean;
    /** A folder already added: the albums exist, and turning off asks what happens to them. */
    editing?: boolean;
    /** The estimate the page already has (Add a folder); left out, the section reads one itself. */
    estimate?: Estimate | null;
    busy?: boolean;
    onChange: (on: boolean, removeAlbums: boolean) => void;
  };

  let {
    title,
    roots,
    exclusionPatterns,
    libraryName,
    ownerName,
    checked,
    editing = false,
    estimate: given,
    busy = false,
    onChange,
  }: Props = $props();

  /** The preview folds after this many folders (prototype edge states: "and 120 more folders"). */
  const SHOWN = 50;

  let read = $state<Estimate | null>(null);
  $effect(() => {
    if (given !== undefined || !checked || roots.length === 0) {
      return;
    }
    const paths = roots;
    const skips = exclusionPatterns;
    let active = true;
    void Promise.all(paths.map((path) => estimateLibraryFolder({ path, exclusionPatterns: skips })))
      .then((answers) => {
        if (active) {
          read = {
            folders: answers.flatMap((answer) => answer.folders),
            complete: answers.every((answer) => answer.complete),
          };
        }
      })
      .catch(() => {
        if (active) {
          read = null;
        }
      });
    return () => {
      active = false;
    };
  });
  const estimate = $derived(given === undefined ? read : given);
  const tree = $derived(estimate ? folderAlbumTree(roots, estimate.folders, libraryName) : null);
  const made = $derived(tree ? folderAlbumCounts(tree) : null);
  const madeWords = $derived(made ? $t('frameleaf_folder_albums_made', { values: made }) : '');

  /** The tree, depth first, folded after SHOWN folders. */
  const rows = $derived.by(() => {
    const out: { node: FolderAlbumNode; depth: number }[] = [];
    const walk = (node: FolderAlbumNode, depth: number) => {
      out.push({ node, depth });
      for (const child of node.children) {
        walk(child, depth + 1);
      }
    };
    for (const node of tree ?? []) {
      walk(node, 0);
    }
    return out;
  });

  const count = (value: number) => formatCount(value, $locale);
  const folderWords = $derived(
    roots.length === 1 ? roots[0].split('/').filter(Boolean).slice(-2).join(' › ') || roots[0] : libraryName,
  );

  let asking = $state(false);
  let choice = $state<'keep' | 'remove'>('keep');
  const toggle = (next: boolean) => {
    if (!next && editing) {
      choice = 'keep';
      asking = true;
      return;
    }
    onChange(next, false);
  };
  const turnOff = () => {
    asking = false;
    onChange(false, choice === 'remove');
  };
</script>

<Section {title} description={$t('frameleaf_folder_albums_description')}>
  <Row
    label={$t('frameleaf_folder_albums_switch')}
    help={checked ? $t('frameleaf_folder_albums_on') : $t('frameleaf_folder_albums_off')}
  >
    <Switch label={$t('frameleaf_folder_albums_switch')} {checked} held={busy} onChange={toggle} />
  </Row>
  {#if checked && roots.length > 0}
    <div class="preview" role="status" data-testid="folder-albums-preview">
      {#if !tree}
        <p>{$t('frameleaf_addfolder_counting')}</p>
      {:else}
        <p>
          {$t(editing ? 'frameleaf_folder_albums_keeps' : 'frameleaf_folder_albums_will_make', {
            values: { folder: folderWords, made: madeWords },
          })}
        </p>
        {#if rows.length > 0}
          <ul class="tree">
            {#each rows.slice(0, SHOWN) as { node, depth } (node.path)}
              <li style:--depth={depth}>
                <Icon icon={node.kind === 'collection' ? mdiFolderMultipleOutline : mdiImageAlbum} size="18" />
                <strong>{node.name}</strong>
                <small>
                  {#if node.kind === 'collection'}
                    {$t('frameleaf_folder_albums_collection_photos', { values: { count: count(node.total) } })}
                  {:else if node.photos > 0}
                    {$t('frameleaf_folder_albums_photos', { values: { count: count(node.photos) } })}
                  {:else}
                    {$t('frameleaf_folder_albums_holds_albums')}
                  {/if}
                </small>
              </li>
            {/each}
          </ul>
          {#if rows.length > SHOWN}
            <p class="more">{$t('frameleaf_folder_albums_more', { values: { count: rows.length - SHOWN } })}</p>
          {/if}
        {/if}
        <p>{$t('frameleaf_folder_albums_follow')}</p>
        {#if estimate && !estimate.complete}
          <p class="more">{$t('frameleaf_folder_albums_partial')}</p>
        {/if}
      {/if}
    </div>
  {/if}
</Section>

{#if asking}
  <Dialog bind:open={asking} title={$t('frameleaf_folder_albums_off_title')} closeLabel={$t('close')}>
    <p class="body">
      {made
        ? $t('frameleaf_folder_albums_off_body', { values: { name: libraryName, made: madeWords } })
        : $t('frameleaf_folder_albums_off_body_unknown', { values: { name: libraryName } })}
    </p>
    <Choice
      label={$t('frameleaf_folder_albums_off_title')}
      value={choice}
      options={[
        {
          value: 'keep',
          label: $t('frameleaf_folder_albums_keep'),
          detail: $t('frameleaf_folder_albums_keep_detail'),
        },
        {
          value: 'remove',
          label: $t('frameleaf_folder_albums_remove'),
          detail: $t('frameleaf_folder_albums_remove_detail'),
        },
      ]}
      onChange={(value) => (choice = value === 'remove' ? 'remove' : 'keep')}
    />
    <Notice title={$t('frameleaf_folder_albums_never_deleted')}>
      {$t('frameleaf_folder_albums_never_deleted_body', { values: { name: ownerName } })}
    </Notice>
    {#snippet actions()}
      <Button onclick={() => (asking = false)}>{$t('cancel')}</Button>
      <Button variant={choice === 'remove' ? 'danger' : 'primary'} onclick={turnOff}>
        {choice === 'keep'
          ? $t('frameleaf_folder_albums_turn_off_keep')
          : made
            ? $t('frameleaf_folder_albums_turn_off_remove', { values: { count: made.albums + made.collections } })
            : $t('frameleaf_folder_albums_remove')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .preview {
    display: grid;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-3);
    padding: var(--fl-space-3);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .preview p {
    margin: 0;
    font-size: var(--fl-font-callout);
  }
  .tree {
    display: grid;
    gap: var(--fl-space-1);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tree li {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 32px;
    padding-inline-start: calc(var(--depth) * 27px);
  }
  .tree li :global(svg) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .tree strong {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .tree small,
  .more {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .body {
    margin: 0 0 var(--fl-space-2);
  }
</style>
