<script lang="ts">
  /**
   * Sign-in and security for one account (FL-76), from the `security` tab of the design
   * template's account detail panel (`design/frameleaf/template/src/AccountsLibraries.jsx`).
   *
   * Two honest differences from the template, which simulates its own store:
   *
   * - The template shows "PIN is set" / "No PIN set". Production never tells an administrator
   *   whether another account has a PIN: `UserAdminResponseDto` carries no PIN state, and
   *   adding one would mean putting a secret's presence into a widely shared DTO. So the row
   *   says so plainly and offers the two actions that are always meaningful: set or replace a
   *   PIN, and clear it.
   * - "Last changed" for a password is not recorded per secret; the account's `updatedAt` is
   *   the closest true statement, so the row reports the change requirement instead of
   *   inventing a password age.
   *
   * The device list used to be read-only because `SessionService.delete` is owner-scoped
   * (`Permission.AuthDeviceDelete` over the caller's own sessions) and no admin revoke endpoint
   * existed. `deleteUserSessionAdmin` (FL-76) is that endpoint: every device but the
   * administrator's own current one (only possible when viewing their own account) can be
   * signed out from here, the same confirm-then-revoke flow as the account's own device list.
   */
  import AccountPasswordResetDialog from '$lib/components/frameleaf/AccountPasswordResetDialog.svelte';
  import AccountPinDialog from '$lib/components/frameleaf/AccountPinDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { canChangeSecrets } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { deleteUserSessionAdmin, type SessionResponseDto, type UserAdminResponseDto } from '@immich/sdk';
  import { modalManager, toastManager } from '@immich/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let { user, sessions }: { user: UserAdminResponseDto; sessions: SessionResponseDto[] } = $props();

  const live = $derived(canChangeSecrets(user));
  // An administrator resets their own password in their account settings, not from here. The
  // server does not refuse it on this path, so this is a courtesy that matches the legacy action.
  const canResetPassword = $derived(live && authManager.user.id !== user.id);

  const lastSeen = (session: SessionResponseDto) =>
    DateTime.fromISO(session.updatedAt, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);

  // Reset when the account changes, so a revoke on one account's devices never hides a session
  // of the next account shown in this same panel instance.
  let revokedIds = $state<Set<string>>(new Set());
  $effect(() => {
    void user.id;
    revokedIds = new Set();
  });
  const visibleSessions = $derived(sessions.filter((session) => !revokedIds.has(session.id)));

  const revoke = async (session: SessionResponseDto) => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_users_device_revoke_title'),
      prompt: $t('frameleaf_users_device_revoke_confirm'),
      confirmText: $t('frameleaf_users_device_revoke'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }

    try {
      await deleteUserSessionAdmin({ id: user.id, sessionId: session.id });
      revokedIds = new Set([...revokedIds, session.id]);
      toastManager.primary($t('frameleaf_users_device_revoked'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_log_out_device'));
    }
  };
</script>

<div class="account-security" aria-label={$t('frameleaf_users_security_title')}>
  <div class="row">
    <div>
      <strong>{$t('frameleaf_users_password_title')}</strong>
      <small>
        {user.shouldChangePassword
          ? $t('frameleaf_users_password_change_required')
          : $t('frameleaf_users_password_no_change_required')}
      </small>
    </div>
    <Button disabled={!canResetPassword} onclick={() => modalManager.show(AccountPasswordResetDialog, { user })}>
      {$t('frameleaf_users_password_reset')}
    </Button>
  </div>

  <div class="row">
    <div>
      <strong>{$t('frameleaf_users_pin_title')}</strong>
      <small>{$t('frameleaf_users_pin_unknown')}</small>
    </div>
    <Button disabled={!live} onclick={() => modalManager.show(AccountPinDialog, { user, mode: 'set' })}>
      {$t('frameleaf_users_pin_set')}
    </Button>
    <Button disabled={!live} onclick={() => modalManager.show(AccountPinDialog, { user, mode: 'clear' })}>
      {$t('frameleaf_users_pin_clear')}
    </Button>
  </div>

  <!-- CC-31 (AccountsLibraries.jsx:1437-1445): whether a sign-in provider is connected; only the owner manages it. -->
  <div class="row">
    <div>
      <strong>{$t('frameleaf_users_provider_title')}</strong>
      <small>
        {user.oauthId ? $t('frameleaf_users_provider_connected') : $t('frameleaf_users_provider_not_connected')} ·
        {$t('frameleaf_users_provider_owner_managed')}
      </small>
    </div>
  </div>

  <h3>{$t('frameleaf_users_devices_title')}</h3>
  <ul>
    {#each visibleSessions as session (session.id)}
      <li>
        <div>
          <span>{session.deviceOS || $t('unknown')} · {session.deviceType || $t('unknown')}</span>
          <small>{$t('frameleaf_users_device_last_seen', { values: { date: lastSeen(session) } })}</small>
        </div>
        {#if session.current}
          <span class="current">{$t('frameleaf_users_device_current')}</span>
        {:else}
          <Button onclick={() => revoke(session)}>{$t('frameleaf_users_device_revoke')}</Button>
        {/if}
      </li>
    {:else}
      <li class="empty">{$t('frameleaf_users_devices_none')}</li>
    {/each}
  </ul>
</div>

<style>
  .account-security {
    min-width: 0;
  }
  h3 {
    margin: 1.25rem 0 0.375rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 0;
    border-top: 1px solid var(--fl-border);
  }
  .row > div {
    display: grid;
    flex: 1 1 14rem;
    min-width: 0;
  }
  .row strong {
    color: var(--fl-text);
  }
  .row small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  ul {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  li > div {
    display: grid;
    min-width: 0;
  }
  li small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  li .current {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  li.empty {
    color: var(--fl-muted);
    background: transparent;
    border-style: dashed;
  }
</style>
