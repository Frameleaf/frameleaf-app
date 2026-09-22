<script lang="ts">
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import PersonNameField from '$lib/components/frameleaf/people/PersonNameField.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountMultipleCheckOutline,
    mdiCakeVariantOutline,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiHeart,
    mdiHeartMinusOutline,
    mdiHeartOutline,
    mdiPencilOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf People grid card (FL-37), ported from the prototype's `pl-card` in
   * `design/frameleaf/template/src/People.jsx`. Every action calls the caller's handler,
   * which the People index page wires to the existing `updatePerson` service; this
   * component performs no network call of its own.
   */

  interface Props {
    person: PersonResponseDto;
    editing?: boolean;
    size?: number;
    onOpen: () => void;
    onStartRename: () => void;
    onCommitRename: (name: string) => void;
    onCancelRename: () => void;
    onToggleFavorite: () => void;
    onToggleHide: () => void;
    onMerge: () => void;
    onSetBirthday: () => void;
  }

  let {
    person,
    editing = false,
    size = 160,
    onOpen,
    onStartRename,
    onCommitRename,
    onCancelRename,
    onToggleFavorite,
    onToggleHide,
    onMerge,
    onSetBirthday,
  }: Props = $props();

  const name = $derived(person.name || $t('add_a_name'));
</script>

<article class="pl-card" class:hidden={person.isHidden} class:editing>
  <div class="pl-face-wrap">
    <button type="button" class="pl-face" aria-label={$t('frameleaf_people_open_person', { values: { name } })} onclick={onOpen}>
      <PersonAvatar {person} {size} />
    </button>
    {#if person.isFavorite}
      <span class="badge favorite" title={$t('to_favorite')}>
        <Icon icon={mdiHeart} size="14" />
      </span>
    {/if}
    {#if person.isHidden}
      <span class="badge hidden-badge" title={$t('hide_person')}>
        <Icon icon={mdiEyeOffOutline} size="14" />
      </span>
    {/if}
    <div class="menu-anchor">
      <Menu label={$t('show_person_options')} align="end">
        {#snippet trigger()}
          <Icon icon={mdiDotsVertical} size="18" />
        {/snippet}
        <MenuItem onSelect={onStartRename}>
          <Icon icon={mdiPencilOutline} size="16" />
          <span>{person.name ? $t('edit_name') : $t('add_a_name')}</span>
        </MenuItem>
        <MenuItem onSelect={onToggleFavorite}>
          <Icon icon={person.isFavorite ? mdiHeartMinusOutline : mdiHeartOutline} size="16" />
          <span>{person.isFavorite ? $t('unfavorite') : $t('to_favorite')}</span>
        </MenuItem>
        <MenuItem onSelect={onToggleHide}>
          <Icon icon={person.isHidden ? mdiEyeOutline : mdiEyeOffOutline} size="16" />
          <span>{person.isHidden ? $t('unhide_person') : $t('hide_person')}</span>
        </MenuItem>
        <MenuItem onSelect={onMerge}>
          <Icon icon={mdiAccountMultipleCheckOutline} size="16" />
          <span>{$t('frameleaf_people_merge_into')}</span>
        </MenuItem>
        <MenuItem onSelect={onSetBirthday}>
          <Icon icon={mdiCakeVariantOutline} size="16" />
          <span>{$t('set_date_of_birth')}</span>
        </MenuItem>
      </Menu>
    </div>
  </div>
  <div class="pl-meta">
    {#if editing}
      <PersonNameField {person} onCommit={onCommitRename} onCancel={onCancelRename} />
    {:else}
      <button type="button" class="pl-name" class:unnamed={!person.name} onclick={onStartRename}>
        {name}
      </button>
    {/if}
  </div>
</article>

<style>
  .pl-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    border-radius: var(--fl-radius-card);
  }
  .pl-card:hover {
    background: var(--fl-raised);
  }
  .pl-card.hidden {
    opacity: 0.6;
  }
  .pl-face-wrap {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
  }
  .pl-face {
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
  .pl-meta {
    width: 100%;
    text-align: center;
  }
  .pl-name {
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
  .pl-name:hover {
    background: var(--fl-raised);
  }
  .pl-name.unnamed {
    color: var(--fl-muted);
  }
</style>
