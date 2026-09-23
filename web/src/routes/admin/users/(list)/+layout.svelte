<script lang="ts">
  import AccountTable from '$lib/components/frameleaf/AccountTable.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import { getUserAdminsActions } from '$lib/services/user-admin.service';
  import { searchUsersAdmin, type UserAdminResponseDto } from '@immich/sdk';
  import { CommandPaletteDefaultProvider, Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { LayoutData } from './$types';

  type Props = {
    children?: Snippet;
    data: LayoutData;
  };

  let { children, data }: Props = $props();

  let users: UserAdminResponseDto[] = $state(data.users);

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

  const { Create } = $derived(getUserAdminsActions($t));
</script>

<!--
  Frameleaf Users list (FL-76). The account rows, the events that keep them fresh and the
  Create action are production's; only the presentation is the Frameleaf one, and the
  per-account actions moved onto each account's own page, where the design template puts them.
-->
<OnEvents
  onUserAdminCreate={onUpdate}
  onUserAdminUpdate={onUpdate}
  onUserAdminDelete={onUpdate}
  onUserAdminRestore={onUpdate}
  {onUserAdminDeleted}
/>

<CommandPaletteDefaultProvider name={$t('users')} actions={[Create]} />

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]} actions={[Create]}>
  <Container center size="large">
    <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
      <div class="my-4">
        <p class="mb-4 text-sm" style="color: var(--fl-muted)">{$t('frameleaf_users_subtitle')}</p>
        <AccountTable {users} />
      </div>
    </Theme>

    {@render children?.()}
  </Container>
</AdminPageLayout>
