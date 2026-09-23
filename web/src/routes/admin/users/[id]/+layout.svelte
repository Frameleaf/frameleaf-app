<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import AccountDetailTabs from '$lib/components/frameleaf/AccountDetailTabs.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
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
  import {
    Alert,
    Badge,
    CommandPaletteDefaultProvider,
    Container,
    Heading,
    MenuItemType,
    Text,
    Theme as AppTheme,
    themeManager,
    toastManager,
  } from '@immich/ui';
  import { mdiTrashCanOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { LayoutData } from './$types';

  type Props = {
    children?: Snippet;
    data: LayoutData;
  };

  const { children, data }: Props = $props();

  const { user, userPreferences, userStatistics, userSessions, libraries, libraryStatistics } = $derived(data);

  const { ResetPassword, ResetPinCode, Update, Delete, Restore } = $derived(getUserAdminActions($t, user));

  const onUpdate = async (update: UserAdminResponseDto) => {
    if (update.id !== user.id) {
      return;
    }

    data.user = update;
    await invalidateAll();
  };

  // FL-77: the administrator's own account links to its Locked settings; nobody else's does.
  const openOwnLockedSettings = () => goto(`${Route.userSettings()}?isOpen=suppressed-content`);

  const onPreferencesSaved = async () => {
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

  const onUserAdminDeleted = async ({ id }: { id: string }) => {
    if (id === user.id) {
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

<CommandPaletteDefaultProvider name={$t('user')} actions={[ResetPassword, ResetPinCode, Update, Delete, Restore]} />

<AdminPageLayout
  breadcrumbs={[{ title: $t('admin.user_management'), href: Route.users() }, { title: user.name }]}
  actions={[ResetPassword, ResetPinCode, Update, Restore, MenuItemType.Divider, Delete]}
>
  <div>
    <Container size="large" center>
      {#if user.deletedAt}
        <Alert color="danger" class="my-4" title={$t('user_has_been_deleted')} icon={mdiTrashCanOutline} />
      {/if}

      <div class="my-4 flex flex-col gap-4">
        <div class="flex items-center gap-4">
          <UserAvatar {user} size="md" />
          <div>
            <Heading tag="h1" size="large">{user.name}</Heading>
            <Text color="secondary">{user.email}</Text>
          </div>
        </div>
        {#if user.isAdmin}
          <div>
            <Badge color="primary" size="small">{$t('admin.admin_user')}</Badge>
          </div>
        {/if}
      </div>

      <!--
        The account detail's tabs (FL-76): Overview, Features / Preferences / Notifications
        (FL-77's AccountPreferencesEditor), Libraries, Security and Activity, exactly the
        `resource-tabs` layout of the design template's account detail panel.
      -->
      <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
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
              savePreferences={(update) =>
                updateUserPreferencesAdmin({ id: user.id, userPreferencesUpdateDto: update })}
              loadPreferences={() => getUserPreferencesAdmin({ id: user.id })}
              {onPreferencesSaved}
              onOpenPrivacy={user.id === authManager.user.id ? openOwnLockedSettings : undefined}
            />
          {/key}
        </Pane>
      </Theme>

      {@render children?.()}
    </Container>
  </div>
</AdminPageLayout>
