<script lang="ts">
  /**
   * Sign-in and security for one account (FL-76), from the `security` tab of the design
   * template's account detail panel (`design/frameleaf/template/src/AccountsLibraries.jsx`).
   *
   * Three honest differences from the template, which simulates its own store:
   *
   * - The template shows "PIN is set" / "No PIN set". Production never tells an administrator
   *   whether another account has a PIN: `UserAdminResponseDto` carries no PIN state, and
   *   adding one would mean putting a secret's presence into a widely shared DTO. So the row
   *   says so plainly and offers the two actions that are always meaningful: set or replace a
   *   PIN, and clear it.
   * - The template lists each device with a "Sign out device" button. `SessionService.delete`
   *   is owner-scoped (`Permission.AuthDeviceDelete` over the caller's own sessions), so an
   *   administrator cannot revoke a foreign session, and there is no admin revoke endpoint
   *   yet. Rather than offer a control that would always fail, the device list is read-only
   *   and says why.
   * - "Last changed" for a password is not recorded per secret; the account's `updatedAt` is
   *   the closest true statement, so the row reports the change requirement instead of
   *   inventing a password age.
   */
  import AccountPasswordResetDialog from '$lib/components/frameleaf/AccountPasswordResetDialog.svelte';
  import AccountPinDialog from '$lib/components/frameleaf/AccountPinDialog.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import { canChangeSecrets } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import type { SessionResponseDto, UserAdminResponseDto } from '@immich/sdk';
  import { modalManager } from '@immich/ui';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  let { user, sessions }: { user: UserAdminResponseDto; sessions: SessionResponseDto[] } = $props();

  const live = $derived(canChangeSecrets(user));
  // An administrator resets their own password in their account settings, not from here. The
  // server does not refuse it on this path, so this is a courtesy that matches the legacy action.
  const canResetPassword = $derived(live && authManager.user.id !== user.id);

  const lastSeen = (session: SessionResponseDto) =>
    DateTime.fromISO(session.updatedAt, { locale: $locale }).toLocaleString(DateTime.DATETIME_MED);
</script>

<Pane label={$t('frameleaf_users_security_title')}>
  <h2>{$t('frameleaf_users_security_title')}</h2>

  <div class="row">
    <div>
      <strong>{$t('frameleaf_users_password_title')}</strong>
      <small>
        {user.shouldChangePassword
          ? $t('frameleaf_users_password_change_required')
          : $t('frameleaf_users_password_no_change_required')}
      </small>
    </div>
    <Button
      disabled={!canResetPassword}
      onclick={() => modalManager.show(AccountPasswordResetDialog, { user })}
    >
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

  <h3>{$t('frameleaf_users_devices_title')}</h3>
  <p class="note">{$t('frameleaf_users_devices_readonly')}</p>
  <ul>
    {#each sessions as session (session.id)}
      <li>
        <span>{session.deviceOS || $t('unknown')} · {session.deviceType || $t('unknown')}</span>
        <small>{$t('frameleaf_users_device_last_seen', { values: { date: lastSeen(session) } })}</small>
      </li>
    {:else}
      <li class="empty">{$t('frameleaf_users_devices_none')}</li>
    {/each}
  </ul>
</Pane>

<style>
  h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    color: var(--fl-text);
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
  .row small,
  .note {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .note {
    margin: 0 0 0.75rem;
  }
  ul {
    display: grid;
    gap: 0.5rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: grid;
    padding: 0.5rem 0.6875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  li small {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  li.empty {
    color: var(--fl-muted);
    background: transparent;
    border-style: dashed;
  }
</style>
