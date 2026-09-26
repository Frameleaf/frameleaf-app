<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import PersonNameField from '$lib/components/frameleaf/people/PersonNameField.svelte';
  import PersonPicker from '$lib/components/frameleaf/people/PersonPicker.svelte';
  import { isUnnamedPerson, normalizedFaceBox } from '$lib/frameleaf/people';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetVisibility,
    correctFace,
    createPerson,
    deleteFace,
    getAllPeople,
    getFaces,
    isHttpError,
    searchAssets,
    SourceType,
    type AssetFaceResponseDto,
    type AssetResponseDto,
    type PeopleListItemDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import {
    mdiAccountArrowRightOutline,
    mdiAccountEditOutline,
    mdiAccountOffOutline,
    mdiAccountOutline,
    mdiAccountPlusOutline,
    mdiAccountSearchOutline,
    mdiClose,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';

  /**
   * "Fix incorrect match" (FL-37/FL-57, PD-3), ported from `FixMatchPanel` in
   * design/frameleaf/template/src/PersonDetail.jsx:43-212. Every face grouped under the person
   * is listed with "Not this person" → "This is {name}" (the six people with the most photos),
   * "Someone else…" (any person, searchable), "Someone new…" or "Not a face of anyone". It
   * replaces the legacy `UnmergeFaceSelector`, which opened over an empty selection.
   *
   * FL-57 cleanup: faces can also be selected and split off together — into an existing person
   * (the searchable `PersonPicker` over all people), into someone new, or as "not a face of
   * anyone". The prototype has no multi-select here; the check boxes and the bar that appears
   * with a selection follow its selection pattern (`SelectionBar.jsx`: a count, then the actions,
   * then clear), inside the panel's footer.
   *
   * Faces are read a page of the person's timeline photos at a time (metadata search filtered
   * to the person, Locked photos left out) and `getFaces` for each photo. Every action is
   * revision-checked (FL-38): a move is `correctFace` (`PATCH /faces/:id` at the face's
   * `revision`, from this person), someone new is `createPerson` then that move, and "not a face
   * of anyone" is `deleteFace` without `force` (a recoverable soft delete) at the revision; the
   * server records each one in the person's correction history (FL-57).
   */
  interface Props {
    person: PersonResponseDto;
    onOpenAsset?: (assetId: string) => void;
    /** Called once when the panel closes, when at least one face moved, with the people faces moved to. */
    onChanged?: (personIds: string[]) => void;
    close: () => void;
  }

  let { person, onOpenAsset, onChanged, close }: Props = $props();

  const PAGE_SIZE = 25;

  type Row = { asset: AssetResponseDto; face: AssetFaceResponseDto };
  let rows: Row[] = $state([]);
  let others: PeopleListItemDto[] = $state([]);
  let hasMore = $state(false);
  let loading = $state(false);
  const resolved = new SvelteMap<string, string>();
  const selected = new SvelteSet<string>();
  let naming: string | null = $state(null);
  // the faces the searchable picker or the new-name field is choosing a person for
  let picking: Row[] | null = $state(null);
  let namingSelection = $state(false);
  let busy = $state(false);
  let message = $state('');
  let heading: HTMLHeadingElement | undefined = $state();
  let changed = false;
  let previous: Element | null = null;

  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
  const open = $derived(rows.filter(({ face }) => !resolved.has(face.id)).length);
  const selectedRows = $derived(rows.filter(({ face }) => selected.has(face.id) && !resolved.has(face.id)));

  // Photos already listed (or skipped as Locked), so a later page never repeats one.
  const seen = new Set<string>();

  /**
   * Reads the next photos of this person. Moving a face away can drop a photo out of the
   * person's results and shift every later page, so paging by number alone would skip photos.
   * Each "Show more" instead starts at a page that cannot be past the first unseen photo (the
   * number of photos seen, less one per face resolved here, which is the most that can have
   * left the results) and skips any photo it has already listed.
   */
  const loadPage = async () => {
    loading = true;
    try {
      let page = Math.floor(Math.max(0, seen.size - resolved.size) / PAGE_SIZE) + 1;
      const photos: AssetResponseDto[] = [];
      let more = true;
      while (photos.length < PAGE_SIZE && more) {
        const { assets } = await searchAssets({
          metadataSearchDto: { personIds: [person.id], visibility: AssetVisibility.Timeline, size: PAGE_SIZE, page },
        });
        for (const asset of assets.items) {
          if (seen.has(asset.id)) {
            continue;
          }
          seen.add(asset.id);
          if (asset.visibility !== AssetVisibility.Locked) {
            photos.push(asset);
          }
        }
        more = !!assets.nextPage;
        page++;
      }
      const faces = await Promise.all(photos.map((asset) => getFaces({ id: asset.id })));
      const next = photos.flatMap((asset, index) =>
        faces[index].filter((face) => face.person?.id === person.id).map((face) => ({ asset, face })),
      );
      rows = [...rows, ...next];
      hasMore = more;
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
    } finally {
      loading = false;
    }
  };

  const loadOthers = async () => {
    try {
      const { people } = await getAllPeople({ withHidden: false });
      others = people
        .filter((candidate) => candidate.id !== person.id && !isUnnamedPerson(candidate))
        .sort((a, b) => b.assetCount - a.assetCount)
        .slice(0, 6);
    } catch {
      others = [];
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || document.querySelector('dialog[open]')) {
      return;
    }

    event.preventDefault();
    finish();
  };

  onMount(() => {
    previous = document.activeElement;
    heading?.focus();
    document.addEventListener('keydown', onKeydown);
    void loadPage();
    void loadOthers();
  });

  onDestroy(() => {
    document.removeEventListener('keydown', onKeydown);
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
  });

  // the people faces were moved to, announced once when the panel closes
  const movedTo = new Set<string>();

  const finish = () => {
    if (changed) {
      onChanged?.([...movedTo]);
    }
    close();
  };

  /**
   * FL-38: every change is revision-checked, so it never overwrites a change made elsewhere
   * meanwhile. On 409 the photo's faces are read again: a face still grouped under this person
   * stays in the list with its new revision to try again, any other is marked changed elsewhere.
   */
  const handleFailure = async (row: Row, error: unknown) => {
    if (!isHttpError(error) || error.status !== 409) {
      handleError(error, $t('frameleaf_people_fix_error'));
      return;
    }
    toastManager.warning($t('frameleaf_faces_conflict'));
    try {
      const current = (await getFaces({ id: row.asset.id })).find(({ id }) => id === row.face.id);
      if (current && current.person?.id === person.id && !current.hiddenAt) {
        rows = rows.map((entry) => (entry.face.id === current.id ? { ...entry, face: current } : entry));
      } else {
        changed = true;
        resolved.set(row.face.id, $t('frameleaf_people_fix_changed_elsewhere'));
        selected.delete(row.face.id);
      }
    } catch (reloadError) {
      handleError(reloadError, $t('errors.cant_get_faces'));
    }
  };

  /** A revision-checked move of one face from this person to `targetId` (FL-38 `PATCH /faces/:id`). */
  const moveFace = async (row: Row, targetId: string) => {
    await correctFace({
      id: row.face.id,
      assetFaceCorrectionDto: { expectedRevision: row.face.revision, expectedPersonId: person.id, personId: targetId },
    });
    movedTo.add(targetId);
  };

  /**
   * Recoverable, as the old side panel: a soft delete (`force: false`) takes the face off this
   * person without destroying the detection. A permanent removal stays behind the confirmation in
   * the viewer's face menu (`PersonFaceActions`).
   */
  const removeFace = (row: Row) =>
    deleteFace({ id: row.face.id, assetFaceDeleteDto: { force: false, expectedRevision: row.face.revision } });

  const act = async (row: Row, action: () => Promise<unknown>, note: string) => {
    try {
      await action();
      changed = true;
      resolved.set(row.face.id, note);
      selected.delete(row.face.id);
      naming = null;
      message = note;
    } catch (error) {
      await handleFailure(row, error);
    }
  };

  /** Runs one action per face, one at a time; a face that fails stays selected to try again. */
  const actOnAll = async (
    targets: Row[],
    action: (row: Row) => Promise<unknown>,
    note: string,
    summary: (count: number) => string,
  ) => {
    busy = true;
    let done = 0;
    try {
      for (const row of targets) {
        try {
          await action(row);
          changed = true;
          done++;
          resolved.set(row.face.id, note);
          selected.delete(row.face.id);
        } catch (error) {
          await handleFailure(row, error);
        }
      }
    } finally {
      busy = false;
      picking = null;
      namingSelection = false;
      naming = null;
      if (done > 0) {
        message = summary(done);
      }
    }
  };

  const reassign = (row: Row, target: PersonResponseDto) =>
    act(row, () => moveFace(row, target.id), $t('frameleaf_people_fix_moved', { values: { name: target.name } }));

  const moveAll = (targets: Row[], target: PersonResponseDto) =>
    actOnAll(
      targets,
      (row) => moveFace(row, target.id),
      $t('frameleaf_people_fix_moved', { values: { name: nameOf(target) } }),
      (count) => $t('frameleaf_people_fix_moved_count', { values: { count, name: nameOf(target) } }),
    );

  const createAndAssign = (row: Row, newName: string) => {
    if (!newName) {
      naming = null;
      return;
    }
    return act(
      row,
      async () => {
        const created = await createPerson({ personCreateDto: { name: newName } });
        await moveFace(row, created.id);
      },
      $t('frameleaf_people_fix_moved', { values: { name: newName } }),
    );
  };

  const createForSelection = async (newName: string) => {
    const targets = selectedRows;
    if (!newName || targets.length === 0) {
      namingSelection = false;
      return;
    }
    let created: PersonResponseDto;
    try {
      created = await createPerson({ personCreateDto: { name: newName } });
    } catch (error) {
      handleError(error, $t('frameleaf_people_fix_error'));
      return;
    }
    await moveAll(targets, created);
  };

  const remove = (row: Row) => act(row, () => removeFace(row), $t('frameleaf_people_fix_removed'));

  const removeAll = (targets: Row[]) =>
    actOnAll(
      targets,
      (row) => removeFace(row),
      $t('frameleaf_people_fix_removed'),
      (count) => $t('frameleaf_people_fix_removed_count', { values: { count } }),
    );

  const pickPerson = async (target: PersonResponseDto) => {
    const targets = picking ?? [];
    if (targets.length === 1) {
      await reassign(targets[0], target);
      picking = null;
      return;
    }
    await moveAll(targets, target);
  };

  const toggle = (row: Row) => {
    if (selected.has(row.face.id)) {
      selected.delete(row.face.id);
    } else {
      selected.add(row.face.id);
    }
  };

  const nameOf = (candidate: { name: string }) => (isUnnamedPerson(candidate) ? $t('unnamed_person') : candidate.name);

  const shortDate = (asset: AssetResponseDto) =>
    DateTime.fromISO(asset.localDateTime, { zone: 'utc' }).toLocaleString(DateTime.DATE_MED);
</script>

<div class="pd-fix" role="dialog" aria-labelledby="pd-fix-title" aria-modal="false">
  <header class="pd-fix-header">
    <div>
      <h2 id="pd-fix-title" bind:this={heading} tabindex="-1">{$t('fix_incorrect_match')}</h2>
      <p>{$t('frameleaf_people_fix_description', { values: { name } })}</p>
    </div>
    <IconButton label={$t('frameleaf_people_fix_close')} onclick={finish}>
      <Icon icon={mdiClose} size="18" aria-hidden="true" />
    </IconButton>
  </header>
  <ul class="pd-fix-list">
    {#each rows as row (row.face.id)}
      {@const done = resolved.get(row.face.id)}
      <li class="pd-fix-row" class:is-done={!!done} class:is-selected={selected.has(row.face.id)}>
        <input
          type="checkbox"
          class="pd-fix-check"
          aria-label={$t('frameleaf_people_fix_select_face', { values: { name: row.asset.originalFileName } })}
          checked={selected.has(row.face.id)}
          disabled={!!done || busy}
          onchange={() => toggle(row)}
        />
        <button
          type="button"
          class="pd-fix-thumb"
          aria-label={$t('frameleaf_people_open_person', { values: { name: row.asset.originalFileName } })}
          onclick={() => onOpenAsset?.(row.asset.id)}
        >
          <FaceCrop
            src={getAssetMediaUrl({ id: row.asset.id, size: AssetMediaSize.Preview })}
            box={normalizedFaceBox(row.face)}
            size={56}
          />
        </button>
        <div class="pd-fix-copy">
          <strong>{row.asset.originalFileName}</strong>
          <span>
            {shortDate(row.asset)} · {row.face.sourceType === SourceType.Manual
              ? $t('frameleaf_people_fix_tagged')
              : $t('frameleaf_people_fix_recognized')}
          </span>
          {#if done}
            <em>{done}</em>
          {/if}
        </div>
        {#if !done && naming !== row.face.id}
          <div class="pd-fix-menu">
            <Menu
              label={$t('frameleaf_people_fix_not_this_person_in', { values: { name: row.asset.originalFileName } })}
              align="end"
            >
              {#snippet trigger()}
                <Icon icon={mdiAccountEditOutline} size="16" aria-hidden="true" />
                <span>{$t('frameleaf_people_fix_not_this_person')}</span>
              {/snippet}
              {#each others as candidate (candidate.id)}
                <MenuItem onSelect={() => void reassign(row, candidate)}>
                  <Icon icon={mdiAccountOutline} size="16" aria-hidden="true" />
                  <span>{$t('frameleaf_people_fix_this_is', { values: { name: candidate.name } })}</span>
                </MenuItem>
              {/each}
              <MenuItem onSelect={() => (picking = [row])}>
                <Icon icon={mdiAccountSearchOutline} size="16" aria-hidden="true" />
                <span>{$t('frameleaf_people_fix_someone_else')}</span>
              </MenuItem>
              <hr />
              <MenuItem onSelect={() => (naming = row.face.id)}>
                <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden="true" />
                <span>{$t('frameleaf_people_fix_someone_new')}</span>
              </MenuItem>
              <MenuItem onSelect={() => void remove(row)}>
                <span class="danger">
                  <Icon icon={mdiAccountOffOutline} size="16" aria-hidden="true" />
                  <span>{$t('frameleaf_people_fix_not_a_face')}</span>
                </span>
              </MenuItem>
            </Menu>
          </div>
        {/if}
        {#if naming === row.face.id}
          <div class="pd-fix-naming">
            <PersonNameField
              person={{ id: `new-${row.face.id}`, name: '' }}
              placeholder={$t('frameleaf_people_fix_new_name')}
              label={$t('frameleaf_people_fix_new_name_label')}
              onCommit={(newName) => void createAndAssign(row, newName)}
              onCancel={() => (naming = null)}
            />
          </div>
        {/if}
      </li>
    {/each}
  </ul>
  {#if loading}
    <p class="note" role="status">{$t('loading')}</p>
  {:else if rows.length === 0}
    <p class="note">{$t('frameleaf_people_fix_empty')}</p>
  {:else if hasMore}
    <div class="more">
      <Button onclick={() => void loadPage()}>{$t('frameleaf_people_show_more')}</Button>
    </div>
  {/if}
  {#if picking}
    <div class="pd-fix-picker">
      <PersonPicker
        excludeId={person.id}
        label={$t('frameleaf_people_fix_move_faces_to', { values: { count: picking.length } })}
        onPick={(target) => void pickPerson(target)}
        onCancel={() => (picking = null)}
      />
    </div>
  {:else if namingSelection}
    <div class="pd-fix-picker">
      <PersonNameField
        person={{ id: 'new-selection', name: '' }}
        placeholder={$t('frameleaf_people_fix_new_name')}
        label={$t('frameleaf_people_fix_new_name_label')}
        onCommit={(newName) => void createForSelection(newName)}
        onCancel={() => (namingSelection = false)}
      />
    </div>
  {/if}
  {#if selectedRows.length > 0 && !picking && !namingSelection}
    <div class="pd-fix-selection" role="toolbar" aria-label={$t('frameleaf_people_fix_selection')}>
      <strong>{$t('frameleaf_people_fix_selected', { values: { count: selectedRows.length } })}</strong>
      <Button disabled={busy} onclick={() => (picking = selectedRows)}>
        <Icon icon={mdiAccountArrowRightOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_people_fix_move_to')}
      </Button>
      <Button disabled={busy} onclick={() => (namingSelection = true)}>
        <Icon icon={mdiAccountPlusOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_people_fix_someone_new')}
      </Button>
      <Button variant="danger" disabled={busy} onclick={() => void removeAll(selectedRows)}>
        <Icon icon={mdiAccountOffOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_people_fix_not_a_face')}
      </Button>
      <Button variant="quiet" disabled={busy} onclick={() => selected.clear()}>
        {$t('frameleaf_people_fix_clear_selection')}
      </Button>
    </div>
  {/if}
  <footer class="pd-fix-footer">
    <span role="status" aria-live="polite">
      {message ||
        (open > 0
          ? $t('frameleaf_people_fix_to_review', { values: { count: open } })
          : $t('frameleaf_people_fix_done'))}
    </span>
    <Button variant="primary" onclick={finish}>{$t('done')}</Button>
  </footer>
</div>

<style>
  /* template/src/people.css "fix-match side panel". */
  .pd-fix {
    position: fixed;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 40;
    display: flex;
    flex-direction: column;
    width: min(420px, 100vw);
    color: var(--fl-text);
    background: var(--fl-panel);
    border-left: 1px solid var(--fl-border);
    box-shadow: var(--fl-shadow-2);
    animation: pd-fix-in var(--fl-motion-slow) var(--fl-ease);
  }
  @keyframes pd-fix-in {
    from {
      transform: translateX(24px);
      opacity: 0;
    }
    to {
      transform: none;
      opacity: 1;
    }
  }
  .pd-fix-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--fl-border);
  }
  .pd-fix-header h2 {
    margin: 0 0 4px;
    font-size: 17px;
    font-weight: 600;
  }
  .pd-fix-header h2:focus {
    outline: none;
  }
  .pd-fix-header p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .pd-fix-list {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 4px;
    margin: 0;
    padding: 10px;
    overflow: auto;
    list-style: none;
  }
  .pd-fix-row {
    display: grid;
    grid-template-columns: auto auto 1fr auto;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: var(--fl-radius-card);
    transition: background var(--fl-motion) var(--fl-ease);
  }
  .pd-fix-row:hover {
    background: var(--fl-raised);
  }
  .pd-fix-row.is-done {
    opacity: 0.6;
  }
  .pd-fix-row.is-selected {
    background: var(--fl-accent-soft);
  }
  .pd-fix-check {
    width: 16px;
    height: 16px;
    accent-color: var(--fl-accent);
  }
  /* template/src/selection-bar.css: a count, the actions, then clear */
  .pd-fix-selection {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 10px 20px;
    border-top: 1px solid var(--fl-border);
  }
  .pd-fix-selection strong {
    margin-inline-end: auto;
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .pd-fix-picker {
    padding: 12px 20px;
    border-top: 1px solid var(--fl-border);
  }
  .pd-fix-thumb {
    display: inline-flex;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 50%;
  }
  .pd-fix-copy {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .pd-fix-copy strong {
    overflow: hidden;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pd-fix-copy span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pd-fix-copy em {
    color: var(--fl-teal);
    font-size: var(--fl-font-small);
    font-style: normal;
  }
  .pd-fix-menu :global(.menu-root > button) {
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .pd-fix-menu :global([role='menu'] hr) {
    margin: 6px 4px;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  .danger {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--fl-danger);
  }
  .pd-fix-naming {
    grid-column: 1 / -1;
  }
  .pd-fix-naming :global(.name-field) {
    max-width: none;
  }
  .note {
    padding: 0 20px 12px;
    color: var(--fl-muted);
  }
  .more {
    display: flex;
    justify-content: center;
    padding: 0 20px 12px;
  }
  .pd-fix-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 20px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    border-top: 1px solid var(--fl-border);
  }
  @media (max-width: 700px) {
    .pd-fix {
      top: auto;
      left: 0;
      width: 100%;
      max-height: 82dvh;
      border-top: 1px solid var(--fl-border);
      border-left: 0;
      border-radius: var(--fl-radius-card) var(--fl-radius-card) 0 0;
    }
    .pd-fix-row {
      grid-template-columns: auto auto 1fr;
    }
    .pd-fix-menu {
      grid-column: 1 / -1;
    }
    .pd-fix-menu :global(.menu-root),
    .pd-fix-menu :global(.menu-root > button) {
      width: 100%;
    }
  }
</style>
