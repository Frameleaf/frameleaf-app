<script lang="ts">
  /**
   * One account (FL-76) inside Users (FL-71): the old `/admin/users/<id>` page, opened in place of
   * the list as the prototype's person page (`settings-v2/cloud/People.jsx`): their name as the page
   * heading with email, role and when they joined, "‹ Users" back to the list, and View analytics. FL-516: the person opens in three parts
   * (`PersonPage`: About; Sign-in & security; What they've turned on) in place of seven tabs, with
   * removing them last. `?edit=1`, an older address, still opens the account form over it.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AccountFormDialog from '$lib/components/frameleaf/AccountFormDialog.svelte';
  import PersonPage from '$lib/components/frameleaf/settings/people/PersonPage.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import PageHeading from '$lib/components/frameleaf/settings/kit/PageHeading.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserAdminActions } from '$lib/services/user-admin.service';
  import { getUserPreferencesAdmin, updateUserPreferencesAdmin, type UserAdminResponseDto } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { CommandPaletteDefaultProvider, toastManager } from '@frameleaf/ui';
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
    if (authManager.authenticated && user.id === authManager.user.id) {
      await authManager.refreshPreferences();
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
  <InlineError
    message={$t('frameleaf_cc_section_load_failed')}
    onRetry={() => {
      data = undefined;
      reload++;
    }}
  />
{:else}
  <div class="detail-loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <Skeleton variant="circle" />
    <Skeleton variant="text" lines={2} width="16rem" />
  </div>
{/if}

{#snippet detail({ user, userPreferences, userSessions }: UserDetailData)}
  {@const { ResetPassword, ResetPinCode, Update, Delete, Restore } = getUserAdminActions($t, user)}
  <CommandPaletteDefaultProvider name={$t('user')} actions={[ResetPassword, ResetPinCode, Update, Delete, Restore]} />

  <!-- The prototype's person page (People.jsx): their name as the page heading, "‹ Users" back to the list.
       Held to the cards' width, so "View analytics" ends where the cards do. -->
  <div class="heading">
    <PageHeading
      overline={$t('frameleaf_users_eyebrow')}
      title={user.name}
      description={$t('frameleaf_users_person_description', {
        values: {
          email: user.email,
          role: user.isAdmin ? $t('frameleaf_users_role_admin') : $t('frameleaf_userpage_role_member'),
          date: new Date(user.createdAt).toLocaleDateString($locale, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          }),
        },
      })}
      back={{ href: Route.users(), label: $t('frameleaf_settings_area_users') }}
    >
      {#snippet actions()}
        <Button onclick={() => void goto(Route.libraryAnalytics({ scope: `account:${user.id}` }))}>
          {$t('frameleaf_users_view_analytics')}
        </Button>
      {/snippet}
    </PageHeading>
  </div>

  <!-- FL-516: one person in three parts, in place of the seven tabs (FL-76). -->
  <!-- The person's own cards follow the header directly: no frame around the cards (prototype People.jsx). -->
  <section aria-label={$t('frameleaf_account_detail_aria_label', { values: { name: user.name } })}>
    {#key user.id}
      <PersonPage
        {user}
        preferences={userPreferences}
        sessions={userSessions}
        savePreferences={(update) => updateUserPreferencesAdmin({ id: user.id, userPreferencesUpdateDto: update })}
        loadPreferences={() => getUserPreferencesAdmin({ id: user.id })}
        onPreferencesSaved={() => onPreferencesSaved(user)}
        onOpenPrivacy={authManager.authenticated && user.id === authManager.user.id ? openOwnLockedSettings : undefined}
      />
    {/key}
  </section>

  {#if editing}
    <AccountFormDialog {user} onClose={() => goto(Route.viewUser(user))} />
  {/if}
{/snippet}

<style>
  .heading {
    max-width: 1120px;
  }
  .detail-loading {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) 0;
  }
</style>
