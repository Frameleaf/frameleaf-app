<script lang="ts">
  /**
   * One account (FL-76) inside Users → People with server access (FL-71): the old
   * `/admin/users/<id>` page. Its header actions sit at the top of the section; `?edit=1` opens the
   * account form over it.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import CommandCenterActions from '$lib/components/frameleaf/settings/CommandCenterActions.svelte';
  import AccountDetailTabs from '$lib/components/frameleaf/AccountDetailTabs.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { accountLifecycle } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserAdminActions } from '$lib/services/user-admin.service';
  import {
    getMyPreferences,
    getUserPreferencesAdmin,
    updateUserPreferencesAdmin,
    type UserAdminResponseDto,
  } from '@immich/sdk';
  import { Alert, Badge, CommandPaletteDefaultProvider, Heading, MenuItemType, Text, toastManager } from '@immich/ui';
  import { mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { loadUserDetail, type UserDetailData } from './loaders';

  type Props = {
    id: string;
  };

  const { id }: Props = $props();

  let data = $state<UserDetailData | null>();
  let reload = $state(0);
  $effect(() => {
    const wanted = id;
    void reload;
    let cancelled = false;
    void loadUserDetail(wanted)
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result) {
          data = result;
        } else {
          // An unknown account falls back to the list, as the old page did.
          void goto(Route.users(), { replaceState: true });
        }
      })
      .catch(() => {
        if (!cancelled) {
          data = null;
        }
      });
    return () => {
      cancelled = true;
    };
  });

  const editing = $derived(page.url.searchParams.get('edit') === '1');

  const onUpdate = (update: UserAdminResponseDto) => {
    if (update.id !== data?.user.id) {
      return;
    }
    data.user = update;
    reload++;
  };

  // FL-77: the administrator's own account links to its Locked settings; nobody else's does.
  const openOwnLockedSettings = () => goto(`${Route.userSettings()}?isOpen=suppressed-content`);

  const onPreferencesSaved = async (user: UserAdminResponseDto) => {
    toastManager.primary($t('frameleaf_account_prefs_saved_toast', { values: { name: user.name } }));
    // Saving their own account applies to this session at once. The admin response leaves out
    // Locked choices, so the session reloads its own full preferences instead of using it.
    if (user.id === authManager.user.id) {
      try {
        authManager.setPreferences(await getMyPreferences());
      } catch {
        // The saved values still apply on the next load.
      }
    }
  };

  const onUserAdminDeleted = async ({ id: deletedId }: { id: string }) => {
    if (deletedId === id) {
      await goto(Route.users());
    }
  };
</script>

<OnEvents
  onUserAdminUpdate={onUpdate}
  onUserAdminDelete={onUpdate}
  onUserAdminRestore={onUpdate}
  {onUserAdminDeleted}
/>

{#if data}
  {@render detail(data)}
{:else if data === null}
  <p role="alert">{$t('frameleaf_cc_load_failed')}</p>
{:else}
  <p role="status">{$t('loading')}</p>
{/if}

{#snippet detail({ user, userPreferences, userStatistics, userSessions, libraries, libraryStatistics }: UserDetailData)}
  {@const { ResetPassword, ResetPinCode, Update, Delete, Restore } = getUserAdminActions($t, user)}
  <CommandPaletteDefaultProvider name={$t('user')} actions={[ResetPassword, ResetPinCode, Update, Delete, Restore]} />

  {#if user.deletedAt}
    <Alert color="danger" class="my-4" title={$t('user_has_been_deleted')} icon={mdiTrashCanOutline} />
  {/if}

  <div class="mb-4 flex flex-col gap-4">
    <div class="flex items-center gap-4">
      <UserAvatar {user} size="md" />
      <div>
        <Heading tag="h2" size="large">{user.name}</Heading>
        <Text color="secondary">{user.email}</Text>
      </div>
    </div>
    {#if user.isAdmin}
      <div>
        <Badge color="primary" size="small">{$t('admin.admin_user')}</Badge>
      </div>
    {/if}
  </div>

  <CommandCenterActions actions={[ResetPassword, ResetPinCode, Update, Restore, MenuItemType.Divider, Delete]} />

  <!--
    The account detail's tabs (FL-76): Overview, Features / Preferences / Notifications
    (FL-77's AccountPreferencesEditor), Libraries, Security and Activity, exactly the
    `resource-tabs` layout of the design template's account detail panel.
  -->
  <Pane label={$t('frameleaf_account_detail_aria_label', { values: { name: user.name } })}>
    {#key user.id}
      <AccountDetailTabs
        {user}
        preferences={userPreferences}
        statistics={userStatistics}
        sessions={userSessions}
        {libraries}
        {libraryStatistics}
        preferencesEditable={accountLifecycle(user) === 'active'}
        savePreferences={(update) => updateUserPreferencesAdmin({ id: user.id, userPreferencesUpdateDto: update })}
        loadPreferences={() => getUserPreferencesAdmin({ id: user.id })}
        onPreferencesSaved={() => onPreferencesSaved(user)}
        onOpenPrivacy={user.id === authManager.user.id ? openOwnLockedSettings : undefined}
      />
    {/key}
  </Pane>

  {#if editing}
    <AccountFormDialog {user} onClose={() => goto(Route.viewUser(user))} />
  {/if}
{/snippet}
