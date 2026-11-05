<script lang="ts">
  /**
   * The account lifecycle zone (FL-76): the `resource-danger-zone` block at the foot of the
   * design template's account detail Overview tab
   * (`design/frameleaf/template/src/AccountsLibraries.jsx`), so this mounts inside
   * the person page's Overview rather than owning a tab or card of its own.
   *
   * Four states, each matching what the server will actually accept:
   * deleted (restore, with the end of the configured recovery window), removing (no way back),
   * the calling administrator's own account (the server refuses self-deletion), and a live
   * account (delete, which starts the recovery period).
   *
   * On the person page it is the prototype's last card (`settings-v2/cloud/People.jsx`): "Remove Emma",
   * what happens, and a danger "Remove…" that asks first.
   */
  import AccountDeleteDialog from '$lib/components/frameleaf/AccountDeleteDialog.svelte';
  import AccountRestoreDialog from '$lib/components/frameleaf/AccountRestoreDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { accountLifecycle, accountRecoveryDeadline, canDeleteAccount } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import type { UserAdminResponseDto } from '@frameleaf/sdk';
  import { modalManager } from '@frameleaf/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let { user }: { user: UserAdminResponseDto } = $props();

  const delay = $derived(serverConfigManager.value.userDeleteDelay);
  const lifecycle = $derived(accountLifecycle(user));
  const deadline = $derived(accountRecoveryDeadline(user, delay));
  const isSelf = $derived(authManager.user.id === user.id);

  const asDate = (value: Date | string) =>
    DateTime.fromJSDate(value instanceof Date ? value : new Date(value)).toLocaleString(DateTime.DATE_MED, {
      locale: $locale,
    });
</script>

{#if lifecycle === 'deleted'}
  <Section
    title={$t('frameleaf_users_lifecycle_title')}
    description={$t('frameleaf_users_deleted_notice', {
      values: {
        date: user.deletedAt ? asDate(user.deletedAt) : '',
        deadline: deadline ? asDate(deadline) : '',
      },
    })}
  >
    {#snippet action()}
      <Button variant="primary" onclick={() => modalManager.show(AccountRestoreDialog, { user })}>
        {$t('frameleaf_users_restore')}
      </Button>
    {/snippet}
  </Section>
{:else if lifecycle === 'removing'}
  <Section title={$t('frameleaf_users_lifecycle_title')} description={$t('frameleaf_users_removing_notice')} />
{:else if isSelf}
  <Section
    title={$t('frameleaf_users_remove_named', { values: { name: user.name } })}
    description={$t('frameleaf_users_self_notice')}
  />
{:else}
  <Section
    title={$t('frameleaf_users_remove_named', { values: { name: user.name } })}
    description={$t('frameleaf_users_delete_description', { values: { delay } })}
  >
    {#snippet action()}
      <Button
        variant="danger"
        disabled={!canDeleteAccount(user, authManager.user.id)}
        onclick={() => modalManager.show(AccountDeleteDialog, { user })}
      >
        {$t('frameleaf_users_remove_open')}
      </Button>
    {/snippet}
  </Section>
{/if}
