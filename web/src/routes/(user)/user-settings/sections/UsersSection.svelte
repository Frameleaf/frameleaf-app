<script lang="ts">
  /**
   * Users → People with server access (FL-71, FL-76): the old `/admin/users` pages in the Command
   * Center. The account list, the events that keep it fresh and the Create action are production's;
   * one account opens inside the section (`?user=<id>`), and the create and edit forms open over it
   * (`?new=1`, `?edit=1`). The old addresses only redirect here.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import AccountTable from '$lib/components/frameleaf/AccountTable.svelte';
  import CommandCenterActions from '$lib/components/frameleaf/settings/CommandCenterActions.svelte';
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
</script>

{#if selected}
  <a class="cc-back-link" href={Route.users()}>← {$t('frameleaf_settings_area_users')}</a>
  <UserDetail id={selected} />
{:else}
  <OnEvents
    onUserAdminCreate={onUpdate}
    onUserAdminUpdate={onUpdate}
    onUserAdminDelete={onUpdate}
    onUserAdminRestore={onUpdate}
    {onUserAdminDeleted}
  />

  <CommandPaletteDefaultProvider name={$t('users')} actions={[Create]} />

  <header class="users-heading">
    <h1>{$t('frameleaf_settings_area_users')}</h1>
    <p>{$t('frameleaf_users_subtitle')}</p>
  </header>
  <CommandCenterActions actions={[Create]} />
  {#if loaded}
    <AccountTable {users} />
  {:else if failed}
    <p role="alert">{$t('frameleaf_cc_load_failed')}</p>
  {:else}
    <p role="status">{$t('loading')}</p>
  {/if}

  {#if creating}
    <AccountFormDialog onClose={onCreateClose} />
  {/if}
{/if}

<style>
  .users-heading {
    margin-bottom: 16px;
  }
  .users-heading h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 550;
    letter-spacing: -0.9px;
  }
  .users-heading p {
    margin: 8px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .cc-back-link {
    display: inline-block;
    margin-bottom: 12px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    text-decoration: none;
  }
  .cc-back-link:hover {
    color: var(--fl-accent);
  }
</style>
