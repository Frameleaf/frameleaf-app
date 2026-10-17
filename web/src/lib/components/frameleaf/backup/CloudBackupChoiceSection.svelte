<script lang="ts">
  /**
   * Each person's own Backup page, Cloud Backup (FL-362), after the approved prototype's `WhatsBackedUp`
   * (`BackupV2.jsx`): Everything (the default), or only what the person chooses from their own library:
   * albums, collections, people, tags, folders, favorites and dates. A photo is kept when it matches any
   * choice, and a date range adds photos rather than narrowing the others. The choice stays on this
   * server; an administrator sees only how much of each library is covered. Every change is saved at
   * once and the server says back how many of the person's photos and videos it keeps now.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AlbumKind,
    CloudBackupDateRangeKind,
    CloudBackupSelectionMode,
    getAllAlbums,
    getAllPeople,
    getAllTags,
    getOwnCloudBackupSelection,
    getUniqueOriginalPaths,
    setOwnCloudBackupSelection,
    type CloudBackupDateRangeDto,
    type CloudBackupSelectionResponseDto,
    type CloudBackupSelectionUpdateDto,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Kind = 'albums' | 'collections' | 'people' | 'tags' | 'folders';
  type Option = { id: string; name: string; detail?: string };
  type Field = 'albumIds' | 'collectionIds' | 'personIds' | 'tagIds' | 'folders';

  const KINDS: ReadonlyArray<{
    kind: Kind;
    field: Field;
    label: Translations;
    none: Translations;
    pick: Translations;
  }> = [
    {
      kind: 'albums',
      field: 'albumIds',
      label: 'frameleaf_backup_keeps_albums',
      none: 'frameleaf_backup_keeps_albums_none',
      pick: 'frameleaf_backup_keeps_pick_albums',
    },
    {
      kind: 'collections',
      field: 'collectionIds',
      label: 'frameleaf_backup_keeps_collections',
      none: 'frameleaf_backup_keeps_collections_none',
      pick: 'frameleaf_backup_keeps_pick_collections',
    },
    {
      kind: 'people',
      field: 'personIds',
      label: 'frameleaf_backup_keeps_people',
      none: 'frameleaf_backup_keeps_people_none',
      pick: 'frameleaf_backup_keeps_pick_people',
    },
    {
      kind: 'tags',
      field: 'tagIds',
      label: 'frameleaf_backup_keeps_tags',
      none: 'frameleaf_backup_keeps_tags_none',
      pick: 'frameleaf_backup_keeps_pick_tags',
    },
    {
      kind: 'folders',
      field: 'folders',
      label: 'frameleaf_backup_keeps_folders',
      none: 'frameleaf_backup_keeps_folders_none',
      pick: 'frameleaf_backup_keeps_pick_folders',
    },
  ];

  /** The periods the prototype offers; `between` shows two dates. */
  type Period = 'none' | '12m' | '5y' | 'between';
  const PERIODS: ReadonlyArray<[Period, Translations]> = [
    ['none', 'frameleaf_backup_keeps_period_none'],
    ['12m', 'frameleaf_backup_keeps_period_12m'],
    ['5y', 'frameleaf_backup_keeps_period_5y'],
    ['between', 'frameleaf_backup_keeps_period_between'],
  ];

  let selection = $state<CloudBackupSelectionResponseDto | null>(null);
  let loadFailed = $state(false);
  let saving = $state(false);
  let failure = $state('');
  /** The names the pickers offer, read once a picker or a summary needs them. */
  let options = $state<Partial<Record<Kind, Option[]>>>({});
  let picking = $state<Kind | null>(null);
  let pickerOpen = $state(false);
  let draft = $state<string[]>([]);
  let filter = $state('');

  const count = (value: number) => new Intl.NumberFormat($locale).format(value);

  const load = async () => {
    loadFailed = false;
    try {
      selection = await getOwnCloudBackupSelection();
      if (selection.mode === CloudBackupSelectionMode.Chosen) {
        await Promise.all(KINDS.map(({ kind }) => loadOptions(kind)));
      }
    } catch {
      loadFailed = true;
    }
  };

  onMount(() => {
    void load();
  });

  /** What each picker can choose from: only the person's own library. */
  const loadOptions = async (kind: Kind) => {
    if (Object.hasOwn(options, kind)) {
      return;
    }
    try {
      let found: Option[];
      switch (kind) {
        case 'albums':
        case 'collections': {
          const albums = await getAllAlbums({});
          const wanted = kind === 'albums' ? AlbumKind.Album : AlbumKind.Collection;
          found = albums
            .filter((album) => album.kind === wanted)
            .map((album) => ({ id: album.id, name: album.albumName || $t('frameleaf_backup_keeps_untitled') }));
          break;
        }
        case 'people': {
          const { people } = await getAllPeople({ withHidden: false });
          found = people.map((person) => ({
            id: person.id,
            name: person.name || $t('frameleaf_backup_keeps_unnamed_person'),
          }));
          break;
        }
        case 'tags': {
          const tags = await getAllTags();
          found = tags.map((tag) => ({ id: tag.id, name: tag.value }));
          break;
        }
        case 'folders': {
          const paths = await getUniqueOriginalPaths();
          found = paths.map((path) => ({ id: path, name: path.split('/').findLast(Boolean) ?? path, detail: path }));
          break;
        }
      }
      options = {
        ...options,
        [kind]: [...found].sort((a, b) => a.name.localeCompare(b.name, $locale) || a.id.localeCompare(b.id)),
      };
    } catch {
      options = { ...options, [kind]: [] };
    }
  };

  /** Save the choice with one part changed; the server answers what it keeps now. */
  const save = async (change: Partial<CloudBackupSelectionUpdateDto>) => {
    if (!selection) {
      return;
    }
    saving = true;
    failure = '';
    const { mode, albumIds, collectionIds, personIds, tagIds, folders, favorites, dateRanges } = selection;
    try {
      selection = await setOwnCloudBackupSelection({
        cloudBackupSelectionUpdateDto: {
          mode,
          albumIds,
          collectionIds,
          personIds,
          tagIds,
          folders,
          favorites,
          dateRanges,
          ...change,
        },
      });
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_backup_keeps_save_failed');
    } finally {
      saving = false;
    }
  };

  const setMode = async (mode: string) => {
    if (mode === selection?.mode) {
      return;
    }
    await save({ mode: mode as CloudBackupSelectionMode });
    if (mode === CloudBackupSelectionMode.Chosen) {
      await Promise.all(KINDS.map(({ kind }) => loadOptions(kind)));
    }
  };

  const chosenOf = (field: Field) => selection?.[field] ?? [];

  /** The names of what is chosen of one kind, in a sentence; ids the person can no longer see are left out. */
  const summaryOf = (kind: Kind, field: Field, none: Translations) => {
    const ids = chosenOf(field);
    if (ids.length === 0) {
      return $t(none);
    }
    const named = ids.map((id) => options[kind]?.find((option) => option.id === id)?.name).filter(Boolean) as string[];
    if (named.length === 0) {
      return $t('frameleaf_backup_keeps_count', { values: { count: ids.length } });
    }
    return new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }).format(named);
  };

  const openPicker = async (kind: Kind, field: Field) => {
    draft = [...chosenOf(field)];
    filter = '';
    picking = kind;
    pickerOpen = true;
    await loadOptions(kind);
  };

  const picker = $derived(KINDS.find(({ kind }) => kind === picking));
  const shown = $derived(
    (picking ? (options[picking] ?? []) : []).filter((option) =>
      `${option.name} ${option.detail ?? ''}`.toLowerCase().includes(filter.trim().toLowerCase()),
    ),
  );

  const toggle = (id: string, on: boolean) => {
    draft = on ? [...new Set([...draft, id])] : draft.filter((value) => value !== id);
  };

  const keepPicked = async () => {
    if (!picker) {
      return;
    }
    pickerOpen = false;
    await save({ [picker.field]: draft });
  };

  // The prototype offers one period; a choice saved with more than one keeps them all and shows the first.
  const today = () => new Date().toISOString().slice(0, 10);
  const yearAgo = () => {
    const date = new Date();
    date.setFullYear(date.getFullYear() - 1);
    return date.toISOString().slice(0, 10);
  };
  const period = $derived.by((): Period => {
    const first = selection?.dateRanges[0];
    if (!first) {
      return 'none';
    }
    if (first.kind === CloudBackupDateRangeKind.Between) {
      return 'between';
    }
    return first.months === 60 ? '5y' : '12m';
  });
  const between = $derived(
    selection?.dateRanges.find((range) => range.kind === CloudBackupDateRangeKind.Between) ?? null,
  );

  const setPeriod = (value: string) => {
    const ranges: Record<Period, CloudBackupDateRangeDto[]> = {
      none: [],
      '12m': [{ kind: CloudBackupDateRangeKind.Recent, months: 12 }],
      '5y': [{ kind: CloudBackupDateRangeKind.Recent, months: 60 }],
      between: [
        { kind: CloudBackupDateRangeKind.Between, from: between?.from ?? yearAgo(), to: between?.to ?? today() },
      ],
    };
    void save({ dateRanges: ranges[value as Period] });
  };

  const setBetween = (edge: 'from' | 'to', value: string) => {
    if (!value || !between) {
      return;
    }
    const next = { ...between, [edge]: value };
    if (next.from && next.to && next.from > next.to) {
      failure = $t('frameleaf_backup_keeps_period_order');
      return;
    }
    void save({ dateRanges: [{ kind: CloudBackupDateRangeKind.Between, from: next.from, to: next.to }] });
  };

  const chosen = $derived(selection?.mode === CloudBackupSelectionMode.Chosen);
  const nothing = $derived(chosen && selection?.selectedOriginals === 0);
  const helpId = $props.id();
</script>

<Section title={$t('frameleaf_backup_keeps_title')} description={$t('frameleaf_backup_keeps_description')}>
  {#if loadFailed}
    <InlineError compact message={$t('frameleaf_backup_keeps_load_failed')} onRetry={load} />
  {:else if !selection}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="120px" />
    </div>
  {:else}
    <Row
      label={$t('frameleaf_backup_keeps_mode_label')}
      help={chosen
        ? $t('frameleaf_backup_keeps_union')
        : $t('frameleaf_backup_keeps_everything_help', { values: { count: count(selection.totalOriginals) } })}
    />
    <Tiles
      label={$t('frameleaf_backup_keeps_mode_group')}
      value={selection.mode}
      disabled={saving}
      options={[
        {
          id: CloudBackupSelectionMode.Everything,
          name: $t('frameleaf_backup_keeps_everything'),
          hint: $t('frameleaf_backup_keeps_everything_hint'),
        },
        {
          id: CloudBackupSelectionMode.Chosen,
          name: $t('frameleaf_backup_keeps_chosen'),
          hint: $t('frameleaf_backup_keeps_chosen_hint'),
        },
      ]}
      onChange={(id) => void setMode(id)}
    />

    {#if chosen}
      {#each KINDS as { kind, field, label, none } (kind)}
        {@const picked = chosenOf(field).length > 0}
        <Row label={$t(label)} help={summaryOf(kind, field, none)}>
          <Button
            disabled={saving}
            label={$t(picked ? 'frameleaf_backup_keeps_change_kind' : 'frameleaf_backup_keeps_choose_kind', {
              values: { kind: $t(label).toLowerCase() },
            })}
            onclick={() => void openPicker(kind, field)}
          >
            {$t(picked ? 'frameleaf_backup_keeps_change' : 'frameleaf_backup_keeps_choose')}
          </Button>
        </Row>
      {/each}
      <Row label={$t('frameleaf_backup_keeps_favorites')} help={$t('frameleaf_backup_keeps_favorites_help')}>
        <Switch
          label={$t('frameleaf_backup_keeps_favorites_switch')}
          checked={selection.favorites}
          held={saving}
          onChange={(favorites) => void save({ favorites })}
        />
      </Row>
      <Row label={$t('frameleaf_backup_keeps_dates')} help={$t('frameleaf_backup_keeps_dates_help')} {helpId}>
        <div class="dates">
          {#if period === 'between' && between}
            <input
              type="date"
              aria-label={$t('frameleaf_backup_keeps_from')}
              value={between.from}
              max={between.to}
              disabled={saving}
              onchange={(event) => setBetween('from', event.currentTarget.value)}
            />
            <input
              type="date"
              aria-label={$t('frameleaf_backup_keeps_to')}
              value={between.to}
              min={between.from}
              disabled={saving}
              onchange={(event) => setBetween('to', event.currentTarget.value)}
            />
          {/if}
          <Select
            label={$t('frameleaf_backup_keeps_period_label')}
            value={period}
            disabled={saving}
            describedBy={helpId}
            options={PERIODS.map(([value, key]) => ({ value, label: $t(key) }))}
            onChange={setPeriod}
          />
        </div>
      </Row>
      <Notice
        tone={nothing ? 'warn' : 'info'}
        title={nothing
          ? $t('frameleaf_backup_keeps_nothing_title')
          : $t('frameleaf_backup_keeps_about', {
              values: { selected: count(selection.selectedOriginals), total: count(selection.totalOriginals) },
            })}
      >
        <span class="figures">
          {nothing
            ? $t('frameleaf_backup_keeps_nothing_body')
            : selection.selectedOriginals >= selection.totalOriginals
              ? $t('frameleaf_backup_keeps_whole')
              : $t('frameleaf_backup_keeps_left', {
                  values: { count: count(selection.totalOriginals - selection.selectedOriginals) },
                })}
        </span>
      </Notice>
    {/if}
    {#if failure}
      <p class="failure" role="alert">{failure}</p>
    {/if}
  {/if}
</Section>

{#if picking && picker}
  <Dialog bind:open={pickerOpen} title={$t(picker.pick)} closeLabel={$t('close')} onClosed={() => (picking = null)}>
    <input
      class="filter"
      type="search"
      data-initial-focus
      aria-label={$t('frameleaf_backup_keeps_pick_filter')}
      placeholder={$t('frameleaf_backup_keeps_pick_filter')}
      value={filter}
      oninput={(event) => (filter = event.currentTarget.value)}
    />
    {#if options[picking] === undefined}
      <p class="muted" role="status">{$t('loading')}</p>
    {:else if shown.length === 0}
      <p class="muted">{$t('frameleaf_backup_keeps_pick_empty')}</p>
    {:else}
      <ul class="options" aria-label={$t(picker.pick)}>
        {#each shown as option (option.id)}
          <li>
            <label>
              <input
                type="checkbox"
                checked={draft.includes(option.id)}
                onchange={(event) => toggle(option.id, event.currentTarget.checked)}
              />
              <span>
                {option.name}
                {#if option.detail}<small>{option.detail}</small>{/if}
              </span>
            </label>
          </li>
        {/each}
      </ul>
    {/if}
    {#snippet actions()}
      <Button onclick={() => (pickerOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={saving} onclick={() => void keepPicked()}>
        {$t('frameleaf_backup_keeps_pick_save')}
      </Button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .dates {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  .dates input {
    font: inherit;
    font-variant-numeric: tabular-nums;
  }
  .figures {
    font-variant-numeric: tabular-nums;
  }
  .failure {
    margin: var(--fl-space-3) 0 var(--fl-space-5);
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .filter {
    width: 100%;
    margin-bottom: var(--fl-space-3);
    font: inherit;
  }
  .muted {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .options {
    display: grid;
    gap: var(--fl-space-1);
    max-height: 50vh;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .options label {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    min-height: 44px;
    cursor: pointer;
  }
  .options small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
</style>
