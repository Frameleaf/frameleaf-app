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
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import '$lib/frameleaf/libraries.css';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { UUID_REGEX } from '$lib/constants';
  import { Route } from '$lib/route';
  import { getUserAdminsActions } from '$lib/services/user-admin.service';
  import { requestServerInfo } from '$lib/utils/auth';
  import { getServerStatistics, searchUsersAdmin, type UsageByUserDto, type UserAdminResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider } from '@immich/ui';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import UserDetail from './UserDetail.svelte';

  const selectedId = $derived(page.url.searchParams.get('user'));
  const selected = $derived(selectedId && UUID_REGEX.test(selectedId) ? selectedId : undefined);
  const creating = $derived(page.url.searchParams.get('new') === '1');

  let users: UserAdminResponseDto[] = $state([]);
  /** Each account's photos and videos for the Items column (CC-26); the list works without them. */
  let usage: UsageByUserDto[] = $state([]);
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
    void getServerStatistics()
      .then((statistics) => (usage = statistics.usageByUser))
      .catch(() => {
        // The Items column stays empty rather than failing the account list.
      });
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

<!-- The template's `accounts-libraries.css` layout, shared with the Libraries manager. -->
<section class="fl-libraries" aria-label={$t('frameleaf_users_accounts_label')}>
  <header class="resource-heading">
    <div>
      <SettingsOverline>{$t('frameleaf_users_eyebrow')}</SettingsOverline>
      <h1>{$t('frameleaf_settings_area_users')}</h1>
      <p>{$t('frameleaf_users_subtitle')}</p>
    </div>
    <div class="resource-actions">
      <Button variant="primary" onclick={() => void goto(Route.newUser())}>{$t('frameleaf_users_create')}</Button>
    </div>
  </header>

  {#if loaded}
    <AccountTable {users} {usage} />
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
