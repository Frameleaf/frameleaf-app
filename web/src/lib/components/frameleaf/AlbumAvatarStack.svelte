<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import type { UserResponseDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Overlapping avatars for the people who can see an album, current user excluded by the caller.
   * `sm` is the prototype's 18px face (AlbumCard.jsx AvatarStack size 18), `md` its 22px shelf face.
   */
  let { users, max = 3, size = 'sm' }: { users: UserResponseDto[]; max?: number; size?: 'sm' | 'md' } = $props();

  const shown = $derived(users.slice(0, max));
  const more = $derived(users.length - shown.length);
  const names = $derived(users.map((user) => user.name).join(', '));
</script>

{#if users.length > 0}
  <span
    class="avatars"
    class:md={size === 'md'}
    title={names}
    aria-label={$t('frameleaf_albums_shared_with', { values: { names } })}
  >
    {#each shown as user (user.id)}
      <span class="avatar fl-squircle"><span class="face"><UserAvatar {user} size="full" noTitle /></span></span>
    {/each}
    {#if more > 0}
      <span class="more">+{more}</span>
    {/if}
  </span>
{/if}

<style>
  .avatars {
    --face: 18px;
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  .avatars.md {
    --face: 22px;
  }
  /* A panel-coloured squircle ring separates the overlapping photos; a mask clips any shadow. */
  .avatar {
    display: inline-flex;
    padding: 2px;
    background: var(--fl-panel);
  }
  .face {
    display: inline-flex;
    width: var(--face);
    height: var(--face);
    font-size: 10px;
  }
  .avatar + .avatar,
  .avatar + .more {
    margin-inline-start: -0.375rem;
  }
  .more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: var(--face);
    height: var(--face);
    padding: 0 0.25rem;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 10px;
    font-weight: 600;
    box-shadow: 0 0 0 2px var(--fl-panel);
  }
</style>
