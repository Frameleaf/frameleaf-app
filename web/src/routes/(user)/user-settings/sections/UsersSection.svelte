<script lang="ts">
  /**
   * Users → People with server access (FL-71, FL-76): the old `/admin/users` pages in the Command
   * Center, laid out as the template's Users manager (`AccountsLibraries.jsx`): the "Command center /
   * Users" heading with its primary Create account action, the account list, and one account's
   * detail (`?user=<id>`) below the list, scrolled into view. The create and edit forms open over it
   * (`?new=1`, `?edit=1`). The old addresses only redirect here.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import AccountTable from '$lib/components/frameleaf/AccountTable.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { UUID_REGEX } from '$lib/constants';
  import { Route } from '$lib/route';
  import { getUserAdminsActions } from '$lib/services/user-admin.service';
  import { requestServerInfo } from '$lib/utils/auth';
  import { searchUsersAdmin, type UserAdminResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserDetail from './UserDetail.svelte';

  const selectedId = $derived(page.url.searchParams.get('user'));
  const selected = $derived(selectedId && UUID_REGEX.test(selectedId) ? selectedId : undefined);
  const creating = $derived(page.url.searchParams.get('new') === '1');

  let users: UserAdminResponseDto[] = $state([]);
  let loaded = $state(false);
  let failed = $state(false);

  // What the old `/admin/users` layout loaded: the server's storage info and every account.
  onMount(() => {
    void requestServerInfo()
      .then(() => searchUsersAdmin({ withDeleted: true }))
      .then((result) => {
        users = result;
        loaded = true;
      })
      .catch(() => (failed = true));
  });

  const onUpdate = async (user: UserAdminResponseDto) => {
    const index = users.findIndex(({ id }) => id === user.id);
    if (index === -1) {
      users = await searchUsersAdmin({ withDeleted: true });
    } else {
      users[index] = user;
    }
  };

  const onUserAdminDeleted = ({ id: userId }: { id: string }) => {
    users = users.filter(({ id }) => id !== userId);
  };

  const onCreateClose = async (created?: UserAdminResponseDto) => {
    await (created ? goto(Route.viewUser(created), { replaceState: true }) : goto(Route.users()));
  };

  const { Create } = $derived(getUserAdminsActions($t));

  // The template scrolls an account's detail into view when it opens (`AccountsLibraries.jsx`).
  let detailElement: HTMLElement | undefined = $state();
  $effect(() => {
    if (selected && detailElement) {
      detailElement.scrollIntoView?.({ block: 'start' });
    }
  });
</script>

<OnEvents
  onUserAdminCreate={onUpdate}
  onUserAdminUpdate={onUpdate}
  onUserAdminDelete={onUpdate}
  onUserAdminRestore={onUpdate}
  {onUserAdminDeleted}
/>

<CommandPaletteDefaultProvider name={$t('users')} actions={[Create]} />

<section class="fl-users" aria-label={$t('frameleaf_users_accounts_label')}>
  <header class="resource-heading">
    <div>
      <p class="resource-eyebrow">{$t('frameleaf_users_eyebrow')}</p>
      <h1>{$t('frameleaf_settings_area_users')}</h1>
      <p>{$t('frameleaf_users_subtitle')}</p>
    </div>
    <div class="resource-actions">
      <button type="button" class="resource-button primary" onclick={() => void goto(Route.newUser())}>
        {$t('frameleaf_users_create')}
      </button>
    </div>
  </header>

  {#if loaded}
    <AccountTable {users} />
  {:else if failed}
    <p role="alert">{$t('frameleaf_cc_load_failed')}</p>
  {:else}
    <p role="status">{$t('loading')}</p>
  {/if}

  <!-- As in the template, one account's detail opens below the list, which stays in view above it. -->
  {#if selected}
    <div class="resource-detail" bind:this={detailElement}>
      <UserDetail id={selected} />
    </div>
  {/if}
</section>

{#if creating}
  <AccountFormDialog onClose={onCreateClose} />
{/if}

<style>
  /* The template's `accounts-libraries.css` resource heading and detail panel. */
  .fl-users {
    min-width: 0;
    color: var(--fl-text);
  }
  .resource-heading {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 24px;
    margin-bottom: 28px;
  }
  .resource-heading h1 {
    font-size: 28px;
    letter-spacing: -0.035em;
    font-weight: 580;
    margin: 8px 0;
  }
  .resource-heading p {
    color: var(--fl-muted);
    font-size: 13px;
    line-height: 1.6;
    margin: 0;
  }
  .resource-heading .resource-eyebrow {
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 11px;
  }
  .resource-actions {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .resource-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 34px;
    border: 1px solid var(--fl-border);
    border-radius: 6px;
    padding: 7px 12px;
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .resource-button.primary {
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    border-color: transparent;
    font-weight: 650;
  }
  .resource-button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .resource-detail {
    margin-top: 24px;
    border: 1px solid var(--fl-border);
    border-radius: 8px;
    padding: 24px;
    background: var(--fl-panel);
    scroll-margin-top: 16px;
  }
  @media (max-width: 767px) {
    .resource-heading {
      flex-direction: column;
      align-items: flex-start;
    }
    .resource-detail {
      padding: 16px;
    }
  }
</style>
