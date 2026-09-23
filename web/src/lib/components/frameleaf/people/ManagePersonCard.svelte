<script lang="ts">
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiEyeOffOutline, mdiEyeOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { MediaQuery } from 'svelte/reactivity';

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
    disabled?: boolean;
    onToggle: () => void;
  }

  let { person, hidden, changed, disabled = false, onToggle }: Props = $props();
  const unnamed = $derived(isUnnamedPerson(person));
  const name = $derived(unnamed ? $t('unnamed_person') : person.name.trim());
  const phone = new MediaQuery('(max-width: 700px)');
</script>

<button
  type="button"
  {disabled}
  class="pm-card"
  class:hidden
  class:changed
  aria-pressed={!hidden}
  aria-label={$t(changed ? 'frameleaf_people_manage_toggle_changed' : 'frameleaf_people_manage_toggle', {
    values: { name, state: $t(hidden ? 'frameleaf_people_state_hidden' : 'frameleaf_people_state_shown') },
  })}
  onclick={onToggle}
>
  <span class="avatar"><PersonAvatar {person} size={phone.current ? 96 : 120} /></span>
  <span class="name" class:unnamed>{name}</span>
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
    width: 100%;
    height: 100%;
    gap: 10px;
    padding: 18px 10px 14px;
    background: var(--fl-panel);
    color: var(--fl-text);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
  }
  .pm-card:hover:not(:disabled) {
    background: color-mix(in srgb, var(--fl-panel), var(--fl-text) 5%);
  }
  :global([data-theme='light']) .pm-card {
    border-color: var(--fl-border);
  }
  .pm-card.hidden .avatar {
    opacity: 0.4;
    filter: grayscale(0.6);
  }
  .pm-card.hidden .name {
    color: var(--fl-muted);
  }
  .pm-card.changed {
    border-color: var(--fl-accent);
  }
  .name {
    max-width: 100%;
    overflow: hidden;
    font-weight: 500;
    color: var(--fl-text);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.unnamed {
    color: var(--fl-muted);
    font-weight: 400;
    font-style: italic;
  }
  .eye {
    position: absolute;
    top: 10px;
    inset-inline-end: 10px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: 50%;
  }
  .pm-card[aria-pressed='true'] .eye {
    color: var(--fl-text);
  }
  .dot {
    position: absolute;
    top: 14px;
    inset-inline-start: 14px;
    width: 0.5rem;
    height: 0.5rem;
    background: var(--fl-accent);
    border-radius: 50%;
  }
</style>
