<script lang="ts">
  /**
   * Frameleaf FL-38: the inline per-person "…" menu inside the viewer's People section
   * (`DetailPanelPeople.svelte`), ported from the design template's `mv-chip-menu`
   * (`design/frameleaf/template/src/MediaViewer.jsx`, `PeopleSection`).
   *
   * Every action calls the real face/person endpoints. Since V-22 this menu is the only
   * per-face editing surface in the info panel, so it also serves unassigned faces: the
   * prototype's `peopleChips` (media-viewer.mjs:451) gives every detected face a chip, named
   * "Unnamed person" when it has no person, with the chip menu of MediaViewer.jsx:2920-2988
   * (Open person / Reassign face… / Create new person… / Remove face / Hide face). Hide face is
   * offered for unassigned faces too (owner default, FL-146).
   *
   * FL-38 corrections are revision-checked: reassign, create-and-assign, hide and show go
   * through `correctFace` and remove through `deleteFace`, each at the face `revision` this chip
   * was drawn from (and, for reassignment, the person it showed). When another view changed
   * the face meanwhile the server answers 409; the menu then says so and re-reads the faces
   * instead of overwriting that change.
   *
   * Remove is permanent (`deleteFace` with `force`). Hide is the server's restorable soft
   * delete (`correctFace` `hidden: true` sets `deletedAt`; face detection keeps such a face
   * hidden rather than re-adding it), and "Show face" on a hidden face's chip — listed with
   * the People section's "Show hidden" toggle — brings it back. `asset_face.isVisible` is not
   * used for this: it records whether a crop left the face in view and is recomputed on every
   * edit. The menu also names the face's provenance (detected, added by you, corrected).
   */
  import { goto } from '$app/navigation';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { faceProvenance, type FaceProvenance } from '$lib/frameleaf/face-tags';
  import {
    correctFace,
    createPerson,
    deleteFace,
    getAllPeople,
    isHttpError,
    type AssetFaceResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon, Input, modalManager, toastManager } from '@immich/ui';
  import {
    mdiAccountEditOutline,
    mdiAccountOutline,
    mdiAccountPlusOutline,
    mdiClose,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiEyeOutline,
  } from '@mdi/js';
  import { tick } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    /** Absent for a detected face that nobody has been assigned to yet. */
    person?: PersonResponseDto | null;
    face: AssetFaceResponseDto;
    previousRoute: string;
    /** Re-reads the asset's faces from the server after a mutation lands. */
    onFacesChanged: () => void | Promise<void>;
  };

  const { person, face, previousRoute, onFacesChanged }: Props = $props();

  const name = $derived(person?.name || $t('unnamed_person'));
  const isHidden = $derived(!!face.hiddenAt);
  const PROVENANCE: Record<FaceProvenance, Translations> = {
    detected: 'frameleaf_face_provenance_detected',
    manual: 'frameleaf_face_provenance_manual',
    corrected: 'frameleaf_face_provenance_corrected',
  };
  const provenance = $derived(PROVENANCE[faceProvenance(face)]);

  /** A revision-checked correction of this face, as the chip showed it. */
  const correct = (change: { personId?: string | null; hidden?: boolean }) =>
    correctFace({
      id: face.id,
      assetFaceCorrectionDto: { expectedRevision: face.revision, expectedPersonId: person?.id ?? null, ...change },
    });

  /** 409: another view changed this face; say so and show what the server holds now. */
  const handleFailure = async (error: unknown, message: string) => {
    if (isHttpError(error) && error.status === 409) {
      toastManager.warning($t('frameleaf_faces_conflict'));
      await onFacesChanged();
      return;
    }
    handleError(error, message);
  };

  let open = $state(false);
  let mode = $state<'menu' | 'reassign' | 'create'>('menu');
  let searchTerm = $state('');
  let newName = $state('');
  let candidates = $state<PersonResponseDto[]>([]);
  let isLoadingCandidates = $state(false);
  let isBusy = $state(false);
  // `null`, not `undefined`: @immich/ui `Input` gives `ref` a fallback, and binding `undefined` to it throws.
  let searchInputEl = $state<HTMLInputElement | null>(null);
  let nameInputEl = $state<HTMLInputElement | null>(null);

  const matches = $derived(
    searchTerm.trim()
      ? candidates.filter((candidate) =>
          candidate.name.toLocaleLowerCase().includes(searchTerm.trim().toLocaleLowerCase()),
        )
      : candidates,
  );

  const resetToMenu = () => {
    mode = 'menu';
    searchTerm = '';
    newName = '';
  };

  const enterReassignMode = async () => {
    mode = 'reassign';
    isLoadingCandidates = true;
    try {
      // closestAssetId takes a face id here (the server's person search ranks by that
      // face's embedding), returning people ordered by similarity rather than alphabetically.
      const { people } = await getAllPeople({ withHidden: true, closestAssetId: face.id });
      candidates = people.filter((candidate) => candidate.id !== person?.id);
    } catch (error) {
      handleError(error, $t('errors.cant_get_faces'));
      candidates = [];
    } finally {
      isLoadingCandidates = false;
    }
    await tick();
    searchInputEl?.focus();
  };

  const enterCreateMode = async () => {
    mode = 'create';
    await tick();
    nameInputEl?.focus();
  };

  const finishMutation = async () => {
    open = false;
    resetToMenu();
    await onFacesChanged();
  };

  const reassignTo = async (target: PersonResponseDto) => {
    isBusy = true;
    try {
      await correct({ personId: target.id });
      toastManager.primary($t('frameleaf_faces_reassigned_toast', { values: { name: target.name } }));
      await finishMutation();
    } catch (error) {
      open = false;
      await handleFailure(error, $t('frameleaf_faces_reassign_error'));
    } finally {
      isBusy = false;
    }
  };

  const createAndAssign = async () => {
    const name = newName.trim();
    if (!name) {
      return;
    }
    isBusy = true;
    try {
      const created = await createPerson({ personCreateDto: { name } });
      await correct({ personId: created.id });
      toastManager.primary($t('frameleaf_faces_created_toast', { values: { name } }));
      await finishMutation();
    } catch (error) {
      open = false;
      await handleFailure(error, $t('frameleaf_faces_create_error'));
    } finally {
      isBusy = false;
    }
  };

  const removeFace = async () => {
    open = false;
    const isConfirmed = await modalManager.showDialog({
      prompt: $t('frameleaf_faces_confirm_remove', { values: { name } }),
    });
    if (!isConfirmed) {
      return;
    }
    try {
      // Permanent: deletes the asset_face row outright, only at the revision shown.
      await deleteFace({ id: face.id, assetFaceDeleteDto: { force: true, expectedRevision: face.revision } });
      toastManager.primary($t('frameleaf_faces_removed_toast', { values: { name } }));
      await onFacesChanged();
    } catch (error) {
      await handleFailure(error, $t('frameleaf_faces_remove_error'));
    }
  };

  const setHidden = async (hidden: boolean) => {
    open = false;
    try {
      await correct({ hidden });
      toastManager.primary(
        $t(hidden ? 'frameleaf_faces_hidden_toast' : 'frameleaf_faces_shown_toast', { values: { name } }),
      );
      await onFacesChanged();
    } catch (error) {
      await handleFailure(error, $t(hidden ? 'frameleaf_faces_hide_error' : 'frameleaf_faces_show_error'));
    }
  };

  const openPerson = () => {
    open = false;
    if (person) {
      void goto(Route.viewPerson(person, { previousRoute }));
    }
  };

  $effect(() => {
    if (!open) {
      resetToMenu();
    }
  });
</script>

<div class="fl-face-trigger">
  <Menu label={$t('frameleaf_faces_options_for', { values: { name } })} align="end" bind:open>
    {#snippet trigger()}
      <Icon icon={mdiDotsVertical} aria-hidden="true" size="16" />
    {/snippet}
    {#if mode === 'menu'}
      <p class="fl-face-provenance" data-provenance={faceProvenance(face)}>{$t(provenance)}</p>
      {#if person}
        <MenuItem onSelect={openPerson}>
          <Icon icon={mdiAccountOutline} aria-hidden="true" size="18" />
          {$t('frameleaf_faces_open_person')}
        </MenuItem>
      {/if}
      <MenuItem onSelect={enterReassignMode} disabled={isBusy} keepOpen>
        <Icon icon={mdiAccountEditOutline} aria-hidden="true" size="18" />
        {$t('frameleaf_faces_reassign')}
      </MenuItem>
      <MenuItem onSelect={enterCreateMode} disabled={isBusy} keepOpen>
        <Icon icon={mdiAccountPlusOutline} aria-hidden="true" size="18" />
        {$t('frameleaf_faces_create_new_person')}
      </MenuItem>
      <MenuItem onSelect={removeFace} disabled={isBusy}>
        <Icon icon={mdiClose} aria-hidden="true" size="18" />
        {$t('frameleaf_faces_remove_face')}
      </MenuItem>
      {#if isHidden}
        <MenuItem onSelect={() => setHidden(false)} disabled={isBusy}>
          <Icon icon={mdiEyeOutline} aria-hidden="true" size="18" />
          {$t('frameleaf_faces_show_face')}
        </MenuItem>
      {:else if !person?.isHidden}
        <MenuItem onSelect={() => setHidden(true)} disabled={isBusy}>
          <Icon icon={mdiEyeOffOutline} aria-hidden="true" size="18" />
          {$t('frameleaf_faces_hide_face')}
        </MenuItem>
      {/if}
    {:else if mode === 'reassign'}
      <div class="fl-face-picker">
        <Input
          bind:ref={searchInputEl}
          bind:value={searchTerm}
          size="tiny"
          placeholder={$t('frameleaf_faces_find_person')}
          aria-label={$t('frameleaf_faces_find_person')}
          onkeydown={(event: KeyboardEvent) => {
            // Keep typing (including arrow keys while editing text) from being swallowed by
            // the owning Menu's roving-focus handler; Escape still closes the whole popup.
            event.stopPropagation();
            if (event.key === 'Enter' && matches[0]) {
              event.preventDefault();
              void reassignTo(matches[0]);
            }
          }}
        />
        <div class="fl-face-picker-list">
          {#if isLoadingCandidates}
            <p class="fl-face-picker-empty">{$t('loading')}</p>
          {:else if matches.length === 0}
            <p class="fl-face-picker-empty">{$t('no_people_found')}</p>
          {:else}
            {#each matches.slice(0, 8) as candidate (candidate.id)}
              <MenuItem onSelect={() => reassignTo(candidate)} disabled={isBusy}>
                {candidate.name}
              </MenuItem>
            {/each}
          {/if}
        </div>
      </div>
    {:else if mode === 'create'}
      <form
        class="fl-face-picker"
        onsubmit={(event) => {
          event.preventDefault();
          void createAndAssign();
        }}
      >
        <Input
          bind:ref={nameInputEl}
          bind:value={newName}
          size="tiny"
          placeholder={$t('name')}
          aria-label={$t('frameleaf_faces_new_person_name')}
          onkeydown={(event: KeyboardEvent) => event.stopPropagation()}
        />
        <div class="fl-face-picker-actions">
          <button type="button" onclick={resetToMenu}>{$t('cancel')}</button>
          <button type="submit" class="primary" disabled={!newName.trim() || isBusy}>{$t('create_person')}</button>
        </div>
      </form>
    {/if}
  </Menu>
</div>

<style>
  .fl-face-trigger :global(.menu-root > button) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.75rem;
    height: 1.75rem;
    padding: 0;
    color: var(--fl-muted);
    background: color-mix(in srgb, var(--fl-panel), transparent 20%);
    border: none;
    border-radius: 999px;
  }
  .fl-face-trigger :global(.menu-root > button:hover) {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .fl-face-provenance {
    margin: 0;
    padding: 0.25rem 0.625rem 0.375rem;
    font-size: 0.75rem;
    color: var(--fl-muted);
  }
  .fl-face-picker {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.25rem;
    min-width: 12rem;
  }
  .fl-face-picker-list {
    display: flex;
    flex-direction: column;
    max-height: 12rem;
    overflow-y: auto;
  }
  .fl-face-picker-empty {
    padding: 0.5rem;
    font-size: 0.8125rem;
    color: var(--fl-muted);
  }
  .fl-face-picker-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .fl-face-picker-actions button {
    padding: 0.375rem 0.75rem;
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
  }
  .fl-face-picker-actions button.primary {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: transparent;
  }
  .fl-face-picker-actions button:disabled {
    opacity: 0.5;
    cursor: default;
  }
</style>
