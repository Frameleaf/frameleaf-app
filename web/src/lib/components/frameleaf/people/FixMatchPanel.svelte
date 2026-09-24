<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import PersonNameField from '$lib/components/frameleaf/people/PersonNameField.svelte';
  import { isUnnamedPerson, normalizedFaceBox } from '$lib/frameleaf/people';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetVisibility,
    createPerson,
    deleteFace,
    getAllPeople,
    getFaces,
    reassignFacesById,
    searchAssets,
    SourceType,
    type AssetFaceResponseDto,
    type AssetResponseDto,
    type PeopleListItemDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountEditOutline,
    mdiAccountOffOutline,
    mdiAccountOutline,
    mdiAccountPlusOutline,
    mdiClose,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import { SvelteMap } from 'svelte/reactivity';

  /**
   * "Fix incorrect match" (FL-37/FL-57, PD-3), ported from `FixMatchPanel` in
   * design/frameleaf/template/src/PersonDetail.jsx:43-212. Every face grouped under the person
   * is listed with "Not this person" → "This is {name}" (the six people with the most photos),
   * "Someone new…" or "Not a face of anyone". It replaces the legacy `UnmergeFaceSelector`,
   * which opened over an empty selection.
   *
   * Faces are read a page of the person's timeline photos at a time (metadata search filtered
   * to the person, Locked photos left out) and `getFaces` for each photo. Every action calls
   * the existing face endpoints: `reassignFacesById`, `createPerson` + `reassignFacesById`,
   * and `deleteFace` (permanent).
   */
  interface Props {
    person: PersonResponseDto;
    onOpenAsset?: (assetId: string) => void;
    /** Called once when the panel closes, when at least one face moved. */
    onChanged?: () => void;
    close: () => void;
  }

  let { person, onOpenAsset, onChanged, close }: Props = $props();

  const PAGE_SIZE = 25;

  type Row = { asset: AssetResponseDto; face: AssetFaceResponseDto };
  let rows: Row[] = $state([]);
  let others: PeopleListItemDto[] = $state([]);
  let nextPage: string | null = $state(null);
  let loading = $state(false);
  const resolved = new SvelteMap<string, string>();
  let naming: string | null = $state(null);
  let message = $state('');
  let heading: HTMLHeadingElement | undefined = $state();
  let changed = false;
  let previous: Element | null = null;

  const name = $derived(isUnnamedPerson(person) ? $t('unnamed_person') : person.name);
  const open = $derived(rows.filter(({ face }) => !resolved.has(face.id)).length);

  const loadPage = async (page?: string) => {
    loading = true;
    try {
      const { assets } = await searchAssets({
        metadataSearchDto: {
          personIds: [person.id],
          visibility: AssetVisibility.Timeline,
          size: PAGE_SIZE,
          page: page ? Number(page) : undefined,
        },
      });
      const photos = assets.items.filter((asset) => asset.visibility !== AssetVisibility.Locked);
      const faces = await Promise.all(photos.map((asset) => getFaces({ id: asset.id })));
      const next = photos.flatMap((asset, index) =>
        faces[index].filter((face) => face.person?.id === person.id).map((face) => ({ asset, face })),
      );
      rows = [...rows, ...next];
      nextPage = assets.nextPage;
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

  const finish = () => {
    if (changed) {
      onChanged?.();
    }
    close();
  };

  const act = async (row: Row, action: () => Promise<unknown>, note: string) => {
    try {
      await action();
      changed = true;
      resolved.set(row.face.id, note);
      naming = null;
      message = note;
    } catch (error) {
      handleError(error, $t('frameleaf_people_fix_error'));
    }
  };

  const reassign = (row: Row, target: PersonResponseDto) =>
    act(
      row,
      () => reassignFacesById({ id: target.id, faceDto: { id: row.face.id } }),
      $t('frameleaf_people_fix_moved', { values: { name: target.name } }),
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
        await reassignFacesById({ id: created.id, faceDto: { id: row.face.id } });
      },
      $t('frameleaf_people_fix_moved', { values: { name: newName } }),
    );
  };

  const remove = (row: Row) =>
    act(
      row,
      () => deleteFace({ id: row.face.id, assetFaceDeleteDto: { force: true } }),
      $t('frameleaf_people_fix_removed'),
    );

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
      <li class="pd-fix-row" class:is-done={!!done}>
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
              {#if others.length > 0}
                <hr />
              {/if}
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
  {:else if nextPage}
    <div class="more">
      <Button onclick={() => void loadPage(nextPage!)}>{$t('frameleaf_people_show_more')}</Button>
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
    grid-template-columns: auto 1fr auto;
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
      grid-template-columns: auto 1fr;
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
