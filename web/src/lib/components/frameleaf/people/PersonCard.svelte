<script lang="ts">
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import PersonNameField from '$lib/components/frameleaf/people/PersonNameField.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiCakeVariantOutline,
    mdiCallMerge,
    mdiDotsVertical,
    mdiEyeOffOutline,
    mdiEyeOutline,
    mdiHeart,
    mdiHeartOffOutline,
    mdiHeartOutline,
    mdiPencilOutline,
    mdiPlus,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf People grid card (FL-37), ported from the prototype's `pl-card` in
   * design/frameleaf/template/src/People.jsx:861-931 (menu labels 720-764). Every action calls
   * the caller's handler; this component performs no network call of its own.
   */

  interface Props {
    person: PersonResponseDto & { assetCount?: number };
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

  const unnamed = $derived(isUnnamedPerson(person));
  const name = $derived(unnamed ? $t('unnamed_person') : person.name);
</script>

<article class="pl-card" class:is-hidden={person.isHidden} class:is-editing={editing}>
  <button
    type="button"
    class="pl-face"
    aria-label={$t('frameleaf_people_open_person', { values: { name } })}
    onclick={onOpen}
  >
    <PersonAvatar {person} {size} />
    {#if person.isFavorite}
      <span class="pl-badge favorite" title={$t('favorite')}>
        <Icon icon={mdiHeart} size="14" aria-hidden="true" />
      </span>
    {/if}
    {#if person.isHidden}
      <span class="pl-badge hidden-badge" title={$t('frameleaf_people_hidden_badge')}>
        <Icon icon={mdiEyeOffOutline} size="14" aria-hidden="true" />
      </span>
    {/if}
  </button>
  <div class="pl-meta">
    {#if editing}
      <PersonNameField
        {person}
        placeholder={unnamed ? $t('add_a_name') : $t('name')}
        onCommit={onCommitRename}
        onCancel={onCancelRename}
      />
    {:else if unnamed}
      <button type="button" class="pl-add-name" onclick={onStartRename}>
        <Icon icon={mdiPlus} size="14" aria-hidden="true" />
        {$t('add_a_name')}
      </button>
    {:else}
      <button
        type="button"
        class="pl-name"
        title={$t('frameleaf_people_rename')}
        aria-label={$t('frameleaf_people_rename_person', { values: { name } })}
        onclick={onStartRename}
      >
        {name}
      </button>
    {/if}
    {#if person.assetCount !== undefined}
      <span class="pl-count">{$t('frameleaf_people_items_count', { values: { count: person.assetCount } })}</span>
    {/if}
  </div>
  <div class="pl-menu">
    <Menu label={$t('frameleaf_people_more_actions_for', { values: { name } })} align="end">
      {#snippet trigger()}
        <Icon icon={mdiDotsVertical} size="18" aria-hidden="true" />
      {/snippet}
      <MenuItem onSelect={onStartRename}>
        <Icon icon={mdiPencilOutline} size="16" aria-hidden="true" />
        <span>{unnamed ? $t('add_a_name') : $t('frameleaf_people_rename')}</span>
      </MenuItem>
      <MenuItem onSelect={onToggleFavorite}>
        <Icon icon={person.isFavorite ? mdiHeartOffOutline : mdiHeartOutline} size="16" aria-hidden="true" />
        <span>{person.isFavorite ? $t('frameleaf_people_remove_favorite') : $t('favorite')}</span>
      </MenuItem>
      <MenuItem onSelect={onToggleHide}>
        <Icon icon={person.isHidden ? mdiEyeOutline : mdiEyeOffOutline} size="16" aria-hidden="true" />
        <span>{person.isHidden ? $t('frameleaf_people_show_on_people') : $t('frameleaf_people_hide')}</span>
      </MenuItem>
      <hr />
      <MenuItem onSelect={onMerge}>
        <Icon icon={mdiCallMerge} size="16" aria-hidden="true" />
        <span>{$t('frameleaf_people_merge_into')}</span>
      </MenuItem>
      <MenuItem onSelect={onSetBirthday}>
        <Icon icon={mdiCakeVariantOutline} size="16" aria-hidden="true" />
        <span>{person.birthDate ? $t('frameleaf_people_change_birthday') : $t('set_date_of_birth')}</span>
      </MenuItem>
    </Menu>
  </div>
</article>

<style>
  /* template/src/people.css `.pl-card` and friends. */
  .pl-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    padding: 18px 12px 16px;
    border-radius: var(--fl-radius-card);
    transition: background var(--fl-motion) var(--fl-ease);
  }
  .pl-card:hover,
  .pl-card:focus-within {
    background: var(--fl-panel);
  }
  .pl-card.is-hidden .pl-face {
    opacity: 0.55;
  }
  .pl-face {
    position: relative;
    display: inline-flex;
    padding: 0;
    background: none;
    border: 0;
    border-radius: 50%;
    transition: transform var(--fl-motion) var(--fl-ease);
  }
  .pl-face:hover {
    transform: scale(1.02);
  }
  .pl-face :global(.avatar) {
    border: 2px solid var(--fl-border);
  }
  .pl-badge {
    position: absolute;
    right: 6px;
    bottom: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 2px solid var(--fl-canvas);
    border-radius: 50%;
  }
  .pl-badge.favorite {
    color: var(--fl-danger);
  }
  .pl-badge.hidden-badge {
    right: auto;
    left: 6px;
    color: var(--fl-muted);
  }
  .pl-meta {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    width: 100%;
    min-width: 0;
  }
  .pl-name,
  .pl-add-name {
    max-width: 100%;
    padding: 4px 10px;
    overflow: hidden;
    color: var(--fl-text);
    font-size: 16px;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .pl-name:hover,
  .pl-add-name:hover {
    background: var(--fl-raised);
  }
  .pl-add-name {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--fl-muted);
    font-size: var(--fl-font-size);
    border-style: dashed;
    border-color: var(--fl-border);
  }
  .pl-count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .pl-menu {
    position: absolute;
    top: 10px;
    right: 10px;
    opacity: 0;
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  /* people.css:529-533; the aria-expanded trigger belongs to the Menu child, hence :global. */
  .pl-card:hover .pl-menu,
  .pl-card:focus-within .pl-menu,
  .pl-menu:has(:global([aria-expanded='true'])) {
    opacity: 1;
  }
  @media (hover: none) {
    .pl-menu {
      opacity: 1;
    }
  }
  .pl-card.is-editing .pl-menu {
    opacity: 0;
    pointer-events: none;
  }
  .pl-menu :global(.menu-root > button) {
    min-width: 44px;
    padding: 0 8px;
    border-color: transparent;
  }
  .pl-menu :global([role='menu'] hr) {
    margin: 6px 4px;
    border: 0;
    border-top: 1px solid var(--fl-border);
  }
  .pl-card :global(.name-field) {
    max-width: 100%;
  }
  @media (max-width: 700px) {
    .pl-card {
      padding: 14px 8px 12px;
    }
    .pl-menu {
      top: 6px;
      right: 6px;
      opacity: 1;
    }
    .pl-name {
      font-size: 15px;
    }
  }
</style>
