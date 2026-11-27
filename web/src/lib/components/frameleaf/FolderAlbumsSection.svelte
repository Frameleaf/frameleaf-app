<script lang="ts">
  /**
   * FL-838 / FL-1837: "Albums from folders", on a folder's page (Libraries › a folder) and as step 4 of Add a folder,
   * after the approved prototype (`settings-v2/library/FolderAlbumsV2.jsx`, owner 2026-11-27). With the switch on it
   * asks which folders become albums (one album for each event folder, an album for every folder, or a chosen level),
   * what the folders inside each album's folder do, whether empty folders get albums and how albums are named, and
   * previews the result from the folder estimate. On a folder already added, Save asks what happens to the albums made
   * so far. Turning the switch off asks first: keep the albums as ordinary albums (preselected) or remove them. Photos
   * are never deleted either way.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Choice from '$lib/components/frameleaf/settings/kit/Choice.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import {
    EVENT_FOLDER_ALBUM_OPTIONS,
    LEGACY_FOLDER_ALBUM_OPTIONS,
    folderAlbumCounts,
    folderAlbumExample,
    looksLikeEventFolders,
    planFolderAlbums,
    subfolderNames,
    subfolderRule,
  } from '$lib/frameleaf/folder-albums';
  import { formatCount } from '$lib/frameleaf/number-format';
  import { locale } from '$lib/stores/preferences.store';
  import {
    estimateLibraryFolder,
    FolderAlbumShape,
    type FolderAlbumOptionsDto,
    type FolderAlbumSubfolderRule,
    type LibraryFolderEstimateResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight, mdiFolderMultipleOutline, mdiFolderOutline, mdiImageAlbum } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Estimate = Pick<LibraryFolderEstimateResponseDto, 'folders' | 'complete'>;
  type Existing = 'match' | 'newOnly';

  type Props = {
    title: string;
    roots: string[];
    exclusionPatterns: string[];
    libraryName: string;
    ownerName: string;
    checked: boolean;
    /** The folder's rules as saved (a folder already added), or as chosen so far (Add a folder). */
    options?: FolderAlbumOptionsDto;
    /** A folder already added: the albums exist, Save asks what happens to them, and turning off asks too. */
    editing?: boolean;
    /** The estimate the page already has (Add a folder); left out, the section reads one itself. */
    estimate?: Estimate | null;
    busy?: boolean;
    onChange: (on: boolean, removeAlbums: boolean) => void;
    /** Editing: called on Save. Adding: called on every change, so the page sends them with the new folder. */
    onOptions?: (options: FolderAlbumOptionsDto, existing: Existing) => void | Promise<void>;
  };

  let {
    title,
    roots,
    exclusionPatterns,
    libraryName,
    ownerName,
    checked,
    options = LEGACY_FOLDER_ALBUM_OPTIONS,
    editing = false,
    estimate: given,
    busy = false,
    onChange,
    onOptions,
  }: Props = $props();

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
  const folders = $derived(estimate?.folders ?? []);

  const clone = (value: FolderAlbumOptionsDto): FolderAlbumOptionsDto => ({
    ...value,
    subfolders: { ...value.subfolders },
  });
  // svelte-ignore state_referenced_locally
  let draft = $state(clone(options));
  let touched = $state(false);
  // stored rules come back with their keys in another order (jsonb), so compare them sorted
  const stable = (value: object) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
        : item,
    );
  const same = (a: object, b: object) => stable(a) === stable(b);
  const dirty = $derived(!same(draft, options));

  const eventLike = $derived(looksLikeEventFolders(roots, folders));
  // Add a folder: a folder laid out by event starts at one album for each event folder (the recommendation)
  $effect(() => {
    if (!editing && !touched && eventLike && draft.shape === FolderAlbumShape.Every) {
      draft = { ...clone(draft), shape: FolderAlbumShape.Events };
      void onOptions?.(clone(draft), 'match');
    }
  });

  const set = (patch: Partial<FolderAlbumOptionsDto>) => {
    touched = true;
    draft = { ...clone(draft), ...patch };
    if (!editing) {
      void onOptions?.(clone(draft), 'match');
    }
  };
  const setRule = (name: string, rule: FolderAlbumSubfolderRule) =>
    set({ subfolders: { ...draft.subfolders, [name]: rule } });

  const count = (value: number) => formatCount(value, $locale);
  const folderWords = $derived(
    roots.length === 1 ? roots[0].split('/').filter(Boolean).slice(-2).join(' › ') || roots[0] : libraryName,
  );
  const madeWords = (made: { albums: number; collections: number }) =>
    $t('frameleaf_folder_albums_made', { values: made });

  const plan = $derived(estimate ? planFolderAlbums(roots, folders, draft, libraryName) : null);
  const made = $derived(plan ? folderAlbumCounts(plan) : null);
  const before = $derived(
    estimate
      ? folderAlbumCounts(
          planFolderAlbums(roots, folders, editing ? options : LEGACY_FOLDER_ALBUM_OPTIONS, libraryName),
        )
      : null,
  );
  const names = $derived(subfolderNames(roots, folders, draft).slice(0, 12));
  const example = $derived(plan ? folderAlbumExample(roots, folders, plan) : undefined);
  const exampleName = $derived(example?.albums.find(({ photos }) => photos > 0)?.name ?? example?.albums[0]?.name);

  let existing = $state<Existing>('match');
  let saving = $state(false);
  const save = async () => {
    saving = true;
    try {
      await onOptions?.(clone(draft), existing);
    } finally {
      saving = false;
    }
  };

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
    <div class="block">
      <h3>{$t('frameleaf_folder_albums_shape_title')}</h3>
      {#if eventLike && names.length > 0}
        <p class="hint">
          {$t('frameleaf_folder_albums_shape_hint', {
            values: {
              folder: folderWords,
              count: count(subfolderNames(roots, folders, EVENT_FOLDER_ALBUM_OPTIONS)[0]?.folders ?? 0),
              names: names
                .slice(0, 4)
                .map(({ name }) => name)
                .join(', '),
            },
          })}
        </p>
      {/if}
      <Choice
        label={$t('frameleaf_folder_albums_shape_title')}
        value={draft.shape}
        options={[
          {
            value: FolderAlbumShape.Events,
            label: $t('frameleaf_folder_albums_shape_events'),
            detail: $t('frameleaf_folder_albums_shape_events_detail'),
            badge: eventLike ? $t('frameleaf_folder_albums_recommended') : undefined,
          },
          {
            value: FolderAlbumShape.Every,
            label: $t('frameleaf_folder_albums_shape_every'),
            detail: $t('frameleaf_folder_albums_shape_every_detail'),
          },
          {
            value: FolderAlbumShape.Level,
            label: $t('frameleaf_folder_albums_shape_level'),
            detail: $t('frameleaf_folder_albums_shape_level_detail'),
          },
        ]}
        onChange={(value) => set({ shape: value as FolderAlbumOptionsDto['shape'] })}
      />
      {#if draft.shape === FolderAlbumShape.Level}
        <Row
          label={$t('frameleaf_folder_albums_level')}
          help={$t('frameleaf_folder_albums_level_help', { values: { folder: folderWords } })}
        >
          <SegmentedControl
            label={$t('frameleaf_folder_albums_level')}
            value={String(draft.level)}
            options={[1, 2, 3].map((level) => ({
              value: String(level),
              label: $t('frameleaf_folder_albums_level_option', { values: { level } }),
            }))}
            onChange={(value) => set({ level: Number(value) })}
          />
        </Row>
        {#if draft.level > 1}
          <Row label={$t('frameleaf_folder_albums_above')} help={$t('frameleaf_folder_albums_above_help')}>
            <Switch
              label={$t('frameleaf_folder_albums_above')}
              checked={draft.collectionsAbove}
              onChange={(value) => set({ collectionsAbove: value })}
            />
          </Row>
        {/if}
      {/if}
    </div>

    {#if draft.shape !== FolderAlbumShape.Every && names.length > 0}
      <div class="block">
        <h3>{$t('frameleaf_folder_albums_inside_title')}</h3>
        <p class="hint">{$t('frameleaf_folder_albums_inside_hint')}</p>
        <ul class="inside">
          {#each names as { name, folders: found } (name)}
            <li>
              <Icon icon={mdiFolderOutline} size="20" />
              <span class="inside-name">
                <strong>{name}</strong>
                <small>{$t('frameleaf_folder_albums_inside_count', { values: { count: found } })}</small>
              </span>
              <SegmentedControl
                label={$t('frameleaf_folder_albums_rule_label', { values: { name } })}
                value={subfolderRule(draft, name)}
                options={[
                  { value: 'join', label: $t('frameleaf_folder_albums_rule_join') },
                  { value: 'own', label: $t('frameleaf_folder_albums_rule_own') },
                  { value: 'skip', label: $t('frameleaf_folder_albums_rule_skip') },
                ]}
                onChange={(value) => setRule(name, value as FolderAlbumSubfolderRule)}
              />
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <Row label={$t('frameleaf_folder_albums_skip_empty')} help={$t('frameleaf_folder_albums_skip_empty_help')}>
      <Switch
        label={$t('frameleaf_folder_albums_skip_empty')}
        checked={draft.skipEmpty}
        onChange={(value) => set({ skipEmpty: value })}
      />
    </Row>
    <Row
      label={$t('frameleaf_folder_albums_naming')}
      help={exampleName ? $t('frameleaf_folder_albums_naming_help', { values: { name: exampleName } }) : undefined}
    >
      <SegmentedControl
        label={$t('frameleaf_folder_albums_naming')}
        value={draft.naming}
        options={[
          { value: 'folder', label: $t('frameleaf_folder_albums_naming_folder') },
          { value: 'path', label: $t('frameleaf_folder_albums_naming_path') },
        ]}
        onChange={(value) => set({ naming: value as FolderAlbumOptionsDto['naming'] })}
      />
    </Row>

    <div class="preview" role="status" data-testid="folder-albums-preview">
      {#if !made || !before}
        <p>{$t('frameleaf_addfolder_counting')}</p>
      {:else}
        <p>
          {same(made, before)
            ? $t('frameleaf_folder_albums_preview', { values: { made: madeWords(made), folder: folderWords } })
            : $t('frameleaf_folder_albums_preview_instead', {
                values: { made: madeWords(made), folder: folderWords, before: madeWords(before) },
              })}
        </p>
        {#if example}
          <div class="example">
            <div>
              <span class="example-head">{$t('frameleaf_folder_albums_on_drive')}</span>
              <ul class="tree">
                <li><Icon icon={mdiFolderOutline} size="18" /> {example.name}</li>
                {#each example.drive as folder (folder.name)}
                  <li class="nested" style:--depth={1}>
                    <Icon icon={mdiFolderOutline} size="18" />
                    {folder.name}
                    <small>{$t('frameleaf_folder_albums_photos', { values: { count: folder.photos } })}</small>
                  </li>
                {/each}
              </ul>
            </div>
            <span class="arrow" aria-hidden="true"><Icon icon={mdiArrowRight} size="20" /></span>
            <div>
              <span class="example-head">{$t('frameleaf_folder_albums_in_albums')}</span>
              <ul class="tree">
                {#each example.albums as album (album.path)}
                  <li style:--depth={album.depth}>
                    <Icon icon={album.kind === 'collection' ? mdiFolderMultipleOutline : mdiImageAlbum} size="18" />
                    {album.name}
                    <small>
                      {album.kind === 'collection'
                        ? $t('frameleaf_folder_albums_collection')
                        : $t('frameleaf_folder_albums_photos', { values: { count: album.photos } })}
                    </small>
                  </li>
                {/each}
              </ul>
            </div>
          </div>
        {/if}
        {#if estimate && !estimate.complete}
          <p class="more">{$t('frameleaf_folder_albums_partial')}</p>
        {/if}
      {/if}
    </div>

    {#if editing}
      <div class="block">
        {#if dirty}
          <Notice
            title={before
              ? $t('frameleaf_folder_albums_existing_title', { values: { name: libraryName, made: madeWords(before) } })
              : undefined}
          >
            {$t('frameleaf_folder_albums_existing_body')}
          </Notice>
          <Choice
            label={$t('frameleaf_folder_albums_existing_body')}
            value={existing}
            options={[
              {
                value: 'match',
                label: $t('frameleaf_folder_albums_existing_match'),
                detail: $t('frameleaf_folder_albums_existing_match_detail'),
              },
              {
                value: 'newOnly',
                label: $t('frameleaf_folder_albums_existing_new'),
                detail: $t('frameleaf_folder_albums_existing_new_detail'),
              },
            ]}
            onChange={(value) => (existing = value === 'newOnly' ? 'newOnly' : 'match')}
          />
        {/if}
        <div class="actions">
          <Button variant="primary" disabled={!dirty || saving || busy} onclick={save}>{$t('save')}</Button>
        </div>
      </div>
    {/if}
  {/if}
</Section>

{#if asking}
  <Dialog bind:open={asking} title={$t('frameleaf_folder_albums_off_title')} closeLabel={$t('close')}>
    <p class="body">
      {before
        ? $t('frameleaf_folder_albums_off_body', { values: { name: libraryName, made: madeWords(before) } })
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
          : before
            ? $t('frameleaf_folder_albums_turn_off_remove', { values: { count: before.albums + before.collections } })
            : $t('frameleaf_folder_albums_remove')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .block {
    display: grid;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-5);
  }
  h3 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .inside {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .inside li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control, 10px);
  }
  .inside li > :global(svg) {
    flex-shrink: 0;
    color: var(--fl-muted);
  }
  .inside-name {
    display: grid;
    flex: 1 1 10rem;
    gap: 0.15rem;
  }
  .inside-name small,
  .tree small,
  .more {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .preview {
    display: grid;
    gap: var(--fl-space-4);
    margin-top: var(--fl-space-5);
    padding: var(--fl-space-4);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .preview p {
    margin: 0;
    font-size: var(--fl-font-callout);
  }
  .example {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
    gap: var(--fl-space-4);
    align-items: start;
  }
  .example-head {
    display: block;
    margin-bottom: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .arrow {
    align-self: center;
    color: var(--fl-muted);
  }
  .tree {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tree li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 28px;
    padding-inline-start: calc(var(--depth, 0) * 24px);
    overflow-wrap: anywhere;
  }
  .tree li :global(svg) {
    flex-shrink: 0;
    color: var(--fl-accent);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
  }
  .body {
    margin: 0 0 var(--fl-space-2);
  }
  @media (max-width: 640px) {
    .example {
      grid-template-columns: minmax(0, 1fr);
    }
    .arrow {
      transform: rotate(90deg);
      justify-self: start;
    }
  }
</style>
