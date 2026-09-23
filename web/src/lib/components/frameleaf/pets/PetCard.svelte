<script lang="ts">
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import { petAgeInYears, speciesLabelKey } from '$lib/frameleaf/pets';
  import type { PetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCakeVariantOutline,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiHeart,
    mdiHeartMinusOutline,
    mdiHeartOutline,
    mdiPencilOutline,
    mdiSetMerge,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf Pets grid card (FL-58), mirroring `people/PersonCard.svelte` so the two
   * grids read the same way. Every action calls the caller's handler; the Pets page wires
   * those to the `@immich/sdk` pet services. This component performs no network call.
   *
   * The count under the name is the number of photos the owner has confirmed, not the
   * number a model proposed: a proposal is not a fact about the library until someone
   * accepts it.
   */
  interface Props {
    pet: PetResponseDto;
    editing?: boolean;
    size?: number;
    onOpen: () => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onToggleFavorite: () => void;
    onToggleHide: () => void;
    onMerge: () => void;
    onEditDetails: () => void;
    onDelete: () => void;
  }

  let {
    pet,
    editing = false,
    size = 160,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onToggleFavorite,
    onToggleHide,
    onMerge,
    onEditDetails,
    onDelete,
  }: Props = $props();

  const name = $derived(pet.name || $t('frameleaf_pets_add_a_name'));
  const age = $derived(petAgeInYears(pet.birthDate));

  let draft = $state(pet.name ?? '');

  // A fresh edit session starts from the stored name, so cancelling and reopening never
  // resurrects an abandoned draft.
  $effect(() => {
    if (editing) {
      draft = pet.name ?? '';
    }
  });

  const commit = (event: Event) => {
    event.preventDefault();
    onCommitRename(draft.trim());
  };

  const onkeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    onCancelRename();
  };
</script>

<article class="pet-card" class:hidden={pet.isHidden} class:editing>
  <div class="thumb-wrap">
    <button
      type="button"
      class="thumb"
      aria-label={$t('frameleaf_pets_open_pet', { values: { name } })}
      onclick={onOpen}
    >
      <PetThumbnail assetId={pet.featuredAssetId} cacheKey={pet.updatedAt} {size} />
    </button>
    {#if pet.isFavorite}
      <span class="badge favorite" title={$t('to_favorite')}>
        <Icon icon={mdiHeart} size="14" />
      </span>
    {/if}
    {#if pet.isHidden}
      <span class="badge hidden-badge" title={$t('frameleaf_pets_hide')}>
        <Icon icon={mdiEyeOffOutline} size="14" />
      </span>
    {/if}
    <div class="menu-anchor">
      <Menu label={$t('frameleaf_pets_options', { values: { name } })} align="end">
        {#snippet trigger()}
          <Icon icon={mdiDotsVertical} size="18" />
        {/snippet}
        <MenuItem onSelect={onStartRename}>
          <Icon icon={mdiPencilOutline} size="16" />
          <span>{pet.name ? $t('frameleaf_pets_edit_name') : $t('frameleaf_pets_add_a_name')}</span>
        </MenuItem>
        <MenuItem onSelect={onEditDetails}>
          <Icon icon={mdiCakeVariantOutline} size="16" />
          <span>{$t('frameleaf_pets_edit_details')}</span>
        </MenuItem>
        <MenuItem onSelect={onToggleFavorite}>
          <Icon icon={pet.isFavorite ? mdiHeartMinusOutline : mdiHeartOutline} size="16" />
          <span>{pet.isFavorite ? $t('unfavorite') : $t('to_favorite')}</span>
        </MenuItem>
        <MenuItem onSelect={onToggleHide}>
          <Icon icon={pet.isHidden ? mdiEyeOutline : mdiEyeOffOutline} size="16" />
          <span>{pet.isHidden ? $t('frameleaf_pets_unhide') : $t('frameleaf_pets_hide')}</span>
        </MenuItem>
        <MenuItem onSelect={onMerge}>
          <Icon icon={mdiSetMerge} size="16" />
          <span>{$t('frameleaf_pets_merge_into')}</span>
        </MenuItem>
        <MenuItem onSelect={onDelete}>
          <Icon icon={mdiTrashCanOutline} size="16" />
          <span>{$t('frameleaf_pets_delete')}</span>
        </MenuItem>
      </Menu>
    </div>
  </div>

  <div class="meta">
    {#if editing}
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions (Escape from the field inside cancels the edit) -->
      <form
        class="name-field"
        onsubmit={commit}
        {onkeydown}
        aria-label={$t('frameleaf_pets_name_editor_label', { values: { name } })}
      >
        <!-- svelte-ignore a11y_autofocus -->
        <input
          type="text"
          autofocus
          bind:value={draft}
          maxlength="100"
          placeholder={$t('frameleaf_pets_add_a_name')}
          aria-label={$t('frameleaf_pets_name')}
        />
        <button type="submit">{$t('done')}</button>
        <button type="button" onclick={() => onCancelRename()}>{$t('cancel')}</button>
      </form>
    {:else}
      <button type="button" class="name" class:unnamed={!pet.name} onclick={onStartRename}>
        {name}
      </button>
      <p class="sub">
        <span>{$t(speciesLabelKey(pet.species))}</span>
        {#if age !== null}
          <span aria-hidden="true">&middot;</span>
          <span>{$t('frameleaf_pets_age_years', { values: { count: age } })}</span>
        {/if}
      </p>
      <p class="count">{$t('frameleaf_pets_confirmed_photos', { values: { count: pet.assetCount } })}</p>
    {/if}
  </div>
</article>

<style>
  .pet-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: var(--fl-radius-card);
  }
  .pet-card:hover {
    background: var(--fl-raised);
  }
  .pet-card.hidden {
    opacity: 0.6;
  }
  .thumb-wrap {
    position: relative;
    display: flex;
    justify-content: center;
    width: 100%;
  }
  .thumb {
    padding: 0;
    background: transparent;
    border: 0;
    border-radius: 50%;
  }
  .badge {
    position: absolute;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    color: #fff;
    background: rgb(0 0 0 / 45%);
    border-radius: 50%;
  }
  .badge.favorite {
    inset-inline-start: 0.25rem;
    top: 0.25rem;
  }
  .badge.hidden-badge {
    inset-inline-start: 0.25rem;
    bottom: 0.25rem;
  }
  .menu-anchor {
    position: absolute;
    top: 0.25rem;
    inset-inline-end: 0.25rem;
  }
  .menu-anchor :global(.menu-root > button) {
    min-width: 32px;
    padding: 0.25rem;
    color: #fff;
    background: rgb(0 0 0 / 45%);
    border: 0;
    border-radius: 50%;
  }
  .meta {
    width: 100%;
    text-align: center;
  }
  .name {
    max-width: 100%;
    padding: 0.25rem 0.5rem;
    overflow: hidden;
    font-weight: 500;
    color: var(--fl-text);
    text-overflow: ellipsis;
    white-space: nowrap;
    background: transparent;
    border: 0;
    border-radius: var(--fl-radius-control);
  }
  .name:hover {
    background: var(--fl-raised);
  }
  .name.unnamed {
    color: var(--fl-muted);
  }
  .sub,
  .count {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .sub {
    display: flex;
    justify-content: center;
    gap: 0.25rem;
  }
  .name-field {
    display: flex;
    align-items: center;
    gap: 0.25rem;
  }
  .name-field input {
    min-width: 0;
    flex: 1;
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .name-field button {
    flex-shrink: 0;
    min-width: 44px;
    padding: 0.375rem 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .name-field button:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
</style>
