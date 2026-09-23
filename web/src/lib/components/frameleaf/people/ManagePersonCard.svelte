<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Frameleaf manage-people visibility card (FL-37), ported from the prototype's
   * `pm-card` in `design/frameleaf/template/src/ManagePeople.jsx`. Toggling only flips a
   * local draft; the page's existing `updatePeople` bulk-visibility save is what commits
   * it, unchanged from the production manage page.
   */
  interface Props {
    person: PersonResponseDto;
    hidden: boolean;
    changed: boolean;
    onToggle: () => void;
  }

  let { person, hidden, changed, onToggle }: Props = $props();
  const name = $derived(person.name || $t('add_a_name'));
</script>

<button
  type="button"
  class="pm-card"
  class:hidden
  class:changed
  aria-pressed={!hidden}
  aria-label={$t('frameleaf_people_manage_toggle', {
    values: { name, state: hidden ? $t('hide_person') : $t('unhide_person') },
  })}
  onclick={onToggle}
>
  <PersonAvatar {person} size={104} />
  <span class="name" class:unnamed={!person.name}>{name}</span>
  <span class="eye" aria-hidden="true">
    <Icon icon={hidden ? mdiEyeOffOutline : mdiEyeOutline} size="18" />
  </span>
  {#if changed}
    <span class="dot" aria-hidden="true"></span>
  {/if}
</button>

<style>
  .pm-card {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.375rem;
    padding: 0.625rem;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
  }
  .pm-card:hover {
    background: var(--fl-raised);
  }
  .pm-card.hidden {
    opacity: 0.55;
  }
  .pm-card.changed {
    border-color: var(--fl-accent);
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.unnamed {
    color: var(--fl-muted);
  }
  .eye {
    position: absolute;
    top: 0.5rem;
    inset-inline-end: 0.5rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    color: #fff;
    background: rgb(0 0 0 / 45%);
    border-radius: 50%;
  }
  .dot {
    position: absolute;
    top: 0.5rem;
    inset-inline-start: 0.5rem;
    width: 0.5rem;
    height: 0.5rem;
    background: var(--fl-accent);
    border-radius: 50%;
  }
</style>
