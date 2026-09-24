<script lang="ts">
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import type { UserResponseDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /** Overlapping avatars for the people who can see an album, current user excluded by the caller. */
  let { users, max = 3, size = 'sm' }: { users: UserResponseDto[]; max?: number; size?: 'sm' | 'md' } = $props();

  const shown = $derived(users.slice(0, max));
  const more = $derived(users.length - shown.length);
  const names = $derived(users.map((user) => user.name).join(', '));
</script>

{#if users.length > 0}
  <span class="avatars" title={names} aria-label={$t('frameleaf_albums_shared_with', { values: { names } })}>
    {#each shown as user (user.id)}
      <span class="avatar fl-squircle"><UserAvatar {user} {size} noTitle /></span>
    {/each}
    {#if more > 0}
      <span class="more">+{more}</span>
    {/if}
  </span>
{/if}

<style>
  .avatars {
    display: inline-flex;
    align-items: center;
    flex-shrink: 0;
  }
  /* A panel-coloured squircle ring separates the overlapping photos; a mask clips any shadow. */
  .avatar {
    display: inline-flex;
    padding: 2px;
    background: var(--fl-panel);
  }
  .avatar + .avatar,
  .avatar + .more {
    margin-inline-start: -0.375rem;
  }
  .more {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.5rem;
    height: 1.5rem;
    padding: 0 0.25rem;
    border-radius: 999px;
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 0.75rem;
    box-shadow: 0 0 0 2px var(--fl-panel);
  }
</style>
