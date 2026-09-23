<script lang="ts">
  /**
   * The account lifecycle zone (FL-76), from the `resource-danger-zone` block of the design
   * template's account detail panel (`design/frameleaf/template/src/AccountsLibraries.jsx`).
   *
   * Four states, each matching what the server will actually accept:
   * deleted (restore, with the end of the configured recovery window), removing (no way back),
   * the calling administrator's own account (the server refuses self-deletion), and a live
   * account (delete, which starts the recovery period).
   */
  import AccountDeleteDialog from '$lib/components/frameleaf/AccountDeleteDialog.svelte';
  import AccountRestoreDialog from '$lib/components/frameleaf/AccountRestoreDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import { accountLifecycle, accountRecoveryDeadline, canDeleteAccount } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import type { UserAdminResponseDto } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let { user }: { user: UserAdminResponseDto } = $props();

  const delay = $derived(serverConfigManager.value.userDeleteDelay);
  const lifecycle = $derived(accountLifecycle(user));
  const deadline = $derived(accountRecoveryDeadline(user, delay));
  const isSelf = $derived(authManager.user.id === user.id);

  const asDate = (value: Date | string) =>
    DateTime.fromJSDate(value instanceof Date ? value : new Date(value), { locale: $locale }).toLocaleString(
      DateTime.DATE_MED,
    );
</script>

<Pane label={$t('frameleaf_users_lifecycle_title')}>
  <h2>{$t('frameleaf_users_lifecycle_title')}</h2>

  {#if lifecycle === 'deleted'}
    <p>
      {$t('frameleaf_users_deleted_notice', {
        values: {
          date: user.deletedAt ? asDate(user.deletedAt) : '',
          deadline: deadline ? asDate(deadline) : '',
        },
      })}
    </p>
    <Button variant="primary" onclick={() => modalManager.show(AccountRestoreDialog, { user })}>
      {$t('frameleaf_users_restore')}
    </Button>
  {:else if lifecycle === 'removing'}
    <p>{$t('frameleaf_users_removing_notice')}</p>
  {:else if isSelf}
    <p>{$t('frameleaf_users_self_notice')}</p>
  {:else}
    <p>{$t('frameleaf_users_delete_description', { values: { delay } })}</p>
    <Button
      disabled={!canDeleteAccount(user, authManager.user.id)}
      onclick={() => modalManager.show(AccountDeleteDialog, { user })}
    >
      {$t('frameleaf_users_delete')}
    </Button>
  {/if}
</Pane>

<style>
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    color: var(--fl-text);
  }
  p {
    margin: 0 0 0.75rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
