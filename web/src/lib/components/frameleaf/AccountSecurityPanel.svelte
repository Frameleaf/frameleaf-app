<script lang="ts">
  /**
   * Sign-in and security for one account (FL-76), from the `security` tab of the design
   * template's account detail panel (`design/frameleaf/template/src/AccountsLibraries.jsx`).
   *
   * Against the template, which simulates its own store:
   *
   * - The PIN row is the template's (CC-30, `AccountsLibraries.jsx` 1403-1435): "PIN is set" /
   *   "No PIN set", Set PIN or Change PIN, and Reset PIN only while a PIN is set. Whether a PIN
   *   is set comes from its own admin-only endpoint (`getUserPinCodeStateAdmin`), never from a
   *   user DTO, and never the PIN itself.
   * - One honest difference: "Last changed" for a password is not recorded per secret; the account's `updatedAt` is
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
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import { canChangeSecrets } from '$lib/frameleaf/accounts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    deleteUserSessionAdmin,
    getUserPinCodeStateAdmin,
    removeUserPasskeysAdmin,
    resetUserTwoFactorAdmin,
    sendUserPasswordLinkAdmin,
    type SessionResponseDto,
    type UserAdminResponseDto,
  } from '@frameleaf/sdk';
  import { modalManager, toastManager } from '@frameleaf/ui';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { DateTime } from 'luxon';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    user,
    sessions,
    children,
  }: {
    user: UserAdminResponseDto;
    sessions: SessionResponseDto[];
    /** More rows of the same section (the person page's desktop AI approval), before Advanced. */
    children?: Snippet;
  } = $props();

  const live = $derived(canChangeSecrets(user));
  // An administrator resets their own password in their account settings, not from here. The
  // server does not refuse it on this path, so this is a courtesy that matches the legacy action.
  const canResetPassword = $derived(live && authManager.user.id !== user.id);

  // FL-538: a single-use link by email, so they choose their own password and you never see it
  let sendingLink = $state(false);
  const sendLink = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_users_password_link_title', { values: { name: user.name } }),
      prompt: $t('frameleaf_users_password_link_confirm', { values: { name: user.name, email: user.email } }),
      confirmText: $t('frameleaf_users_password_link_send'),
    });
    if (!confirmed) {
      return;
    }
    sendingLink = true;
    try {
      await sendUserPasswordLinkAdmin({ id: user.id });
      toastManager.primary($t('frameleaf_users_password_link_sent', { values: { email: user.email } }));
    } catch (error) {
      handleError(error, $t('frameleaf_users_password_link_failed'));
    } finally {
      sendingLink = false;
    }
  };

  /** Whether the account has a PIN; undefined until the server says (or when it could not). */
  let hasPin = $state<boolean | undefined>();
  /** FL-859: how many passkeys the account has; undefined until the server says. */
  let passkeys = $state<number | undefined>();
  /** FL-831: whether the account has two-step sign-in on; undefined until the server says. */
  let twoStep = $state<boolean | undefined>();
  let pinReload = $state(0);
  $effect(() => {
    const id = user.id;
    void pinReload;
    let cancelled = false;
    hasPin = undefined;
    passkeys = undefined;
    twoStep = undefined;
    getUserPinCodeStateAdmin({ id })
      .then((state) => {
        if (!cancelled) {
          hasPin = state.pinCode;
          passkeys = state.passkeys;
          twoStep = state.twoFactorEnabled;
        }
      })
      .catch(() => {
        // Unknown: both actions stay offered, as before the state was reported.
      });
    return () => {
      cancelled = true;
    };
  });

  const changePin = async (mode: 'set' | 'clear') => {
    await modalManager.show(AccountPinDialog, { user, mode, hasPin: hasPin === true });
    pinReload++;
  };

  /**
   * FL-831 (FL-776 prototype, People.jsx): turn off two-step sign-in for someone who lost their phone
   * and their recovery codes. The server signs them out everywhere and notes it in their account
   * history with your name.
   */
  let resettingTwoStep = $state(false);
  const resetTwoStep = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_two_step_admin_confirm_title', { values: { name: user.name } }),
      prompt: $t('frameleaf_two_step_admin_confirm', { values: { name: user.name } }),
      confirmText: $t('frameleaf_two_step_turn_off'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    resettingTwoStep = true;
    try {
      await resetUserTwoFactorAdmin({ id: user.id });
      twoStep = false;
      toastManager.primary($t('frameleaf_two_step_admin_done', { values: { name: user.name } }));
    } catch (error) {
      handleError(error, $t('frameleaf_two_step_admin_failed'));
    } finally {
      resettingTwoStep = false;
    }
  };

  /**
   * FL-859 (FL-767 prototype, People.jsx): remove every passkey of someone who lost a device and can't
   * sign in to remove its passkey. Noted in their account history with your name.
   */
  let removingPasskeys = $state(false);
  const removePasskeys = async () => {
    const count = passkeys ?? 0;
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_users_passkeys_remove_title', { values: { name: user.name } }),
      prompt: $t('frameleaf_users_passkeys_remove_confirm', { values: { name: user.name, count } }),
      confirmText: $t('frameleaf_users_passkeys_remove_all'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    removingPasskeys = true;
    try {
      await removeUserPasskeysAdmin({ id: user.id });
      passkeys = 0;
      toastManager.primary($t('frameleaf_users_passkeys_removed', { values: { name: user.name } }));
    } catch (error) {
      handleError(error, $t('frameleaf_users_passkeys_remove_failed'));
    } finally {
      removingPasskeys = false;
    }
  };

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

  /** Every device but the one you are using now, which is only listed when this is your own account. */
  const others = $derived(visibleSessions.filter((session) => !session.current));
  const lastActive = $derived.by(() => {
    let latest: (typeof visibleSessions)[number] | undefined;
    for (const session of visibleSessions) {
      if (!latest || session.updatedAt > latest.updatedAt) {
        latest = session;
      }
    }
    return latest;
  });
  const devicesHelp = $derived(
    visibleSessions.length === 0
      ? $t('frameleaf_users_devices_none')
      : $t('frameleaf_users_devices_summary', {
          values: { count: visibleSessions.length, date: lastActive ? lastSeen(lastActive) : '' },
        }),
  );
  let signingOut = $state(false);
  /** Prototype "Sign out everywhere": one confirmation, then each device through the same admin endpoint. */
  const signOutEverywhere = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_users_devices_all_title', { values: { name: user.name } }),
      prompt: $t('frameleaf_users_devices_all_confirm', { values: { name: user.name } }),
      confirmText: $t('frameleaf_users_devices_all'),
      danger: true,
    });
    if (!confirmed) {
      return;
    }
    signingOut = true;
    try {
      for (const session of others) {
        await deleteUserSessionAdmin({ id: user.id, sessionId: session.id });
        revokedIds = new Set([...revokedIds, session.id]);
      }
      toastManager.primary($t('frameleaf_users_devices_all_done'));
    } catch (error) {
      handleError(error, $t('errors.unable_to_log_out_device'));
    } finally {
      signingOut = false;
    }
  };

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

<!-- The prototype's Sign-in & security rows (`settings-v2/cloud/People.jsx` Person): what each thing is on
     the left, the one way to help on the right. Setting a PIN for them and each device on its own are
     kept under Advanced. -->
<div class="account-security" aria-label={$t('frameleaf_users_security_title')}>
  <Row
    label={$t('frameleaf_users_provider_title')}
    help={`${user.oauthId ? $t('frameleaf_users_provider_connected') : $t('frameleaf_users_provider_not_connected')} · ${$t('frameleaf_users_provider_owner_managed')}`}
  />

  <Row
    label={$t('frameleaf_users_password_title')}
    help={user.shouldChangePassword
      ? $t('frameleaf_users_password_change_required')
      : $t('frameleaf_users_password_no_change_required')}
  >
    {#if featureFlagsManager.value.email}
      <Button disabled={!canResetPassword || sendingLink} onclick={sendLink}>
        {$t('frameleaf_users_password_link')}
      </Button>
    {/if}
    <Button disabled={!canResetPassword} onclick={() => modalManager.show(AccountPasswordResetDialog, { user })}>
      {$t('frameleaf_users_password_reset')}
    </Button>
  </Row>

  <Row
    label={$t('frameleaf_users_pin_title')}
    help={[
      hasPin === undefined ? '' : hasPin ? $t('frameleaf_users_pin_is_set') : $t('frameleaf_users_pin_not_set'),
      // FL-721: their Locked files are encrypted with the PIN, so the server refuses to clear or change it
      user.lockedEncryption ? $t('frameleaf_users_pin_locked_encryption', { values: { name: user.name } }) : '',
    ]
      .filter(Boolean)
      .join(' ')}
  >
    <Button disabled={!live || hasPin === false || user.lockedEncryption} onclick={() => changePin('clear')}>
      {$t('frameleaf_users_pin_clear_open')}
    </Button>
  </Row>

  <Row
    label={$t('frameleaf_two_step_title')}
    help={twoStep === undefined
      ? ''
      : twoStep
        ? $t('frameleaf_two_step_admin_on', { values: { name: user.name } })
        : $t('frameleaf_two_step_admin_off', { values: { name: user.name } })}
  >
    {#if twoStep}
      <Button disabled={!live || resettingTwoStep} onclick={() => void resetTwoStep()}
        >{$t('frameleaf_two_step_admin_open')}</Button
      >
    {/if}
  </Row>

  <Row
    label={$t('frameleaf_users_passkeys_title')}
    help={passkeys === undefined
      ? ''
      : passkeys > 0
        ? $t('frameleaf_users_passkeys_some', { values: { name: user.name, count: passkeys } })
        : $t('frameleaf_users_passkeys_none', { values: { name: user.name } })}
  >
    {#if passkeys}
      <Button disabled={!live || removingPasskeys} onclick={() => void removePasskeys()}
        >{$t('frameleaf_users_passkeys_remove_open')}</Button
      >
    {/if}
  </Row>

  <Row label={$t('frameleaf_users_devices_title')} help={devicesHelp}>
    {#if others.length > 0}
      <Button disabled={signingOut} onclick={() => void signOutEverywhere()}>{$t('frameleaf_users_devices_all')}</Button
      >
    {/if}
  </Row>

  {@render children?.()}

  <Advanced>
    <Row
      label={$t('frameleaf_users_pin_choose')}
      help={$t('frameleaf_users_pin_choose_help', { values: { name: user.name } })}
    >
      <Button disabled={!live || user.lockedEncryption} onclick={() => changePin('set')}>
        {hasPin ? $t('frameleaf_users_pin_change') : $t('frameleaf_users_pin_set')}
      </Button>
    </Row>
    {#each visibleSessions as session (session.id)}
      <Row
        label={`${session.deviceOS || $t('unknown')} · ${session.deviceType || $t('unknown')}`}
        help={$t('frameleaf_users_device_last_seen', { values: { date: lastSeen(session) } })}
      >
        {#if session.current}
          <span class="current">{$t('frameleaf_users_device_current')}</span>
        {:else}
          <Button onclick={() => revoke(session)}>{$t('frameleaf_users_device_revoke')}</Button>
        {/if}
      </Row>
    {/each}
  </Advanced>
</div>

<style>
  .account-security {
    min-width: 0;
  }
  .current {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
