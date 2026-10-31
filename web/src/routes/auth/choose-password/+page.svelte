<script lang="ts">
  /**
   * FL-538: choose a password with the single-use link an administrator emailed (from Add a person,
   * or "Email a link…" on a person's page). The token travels in the address's fragment, which the
   * browser never sends to a server or puts in a referrer; it is read here and the address is
   * cleared. The page looks like Change password (AuthScreens.jsx), and ends on the sign-in page with
   * the email filled in.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { goto } from '$app/navigation';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import AuthPasswordField from '$lib/components/frameleaf/AuthPasswordField.svelte';
  import AuthPasswordQuality from '$lib/components/frameleaf/AuthPasswordQuality.svelte';
  import { Route } from '$lib/route';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { checkPasswordLink, redeemPasswordLink } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { setAuthNotice } from '../auth-notice';
  import { t } from 'svelte-i18n';

  let token = $state('');
  let account = $state<{ name: string; email: string }>();
  let phase = $state<'checking' | 'ready' | 'expired'>('checking');
  let password = $state('');
  let passwordConfirm = $state('');
  let loading = $state(false);
  let errorMessage = $state('');
  const mismatch = $derived(passwordConfirm.length > 0 && password !== passwordConfirm);
  // The strength meter is advisory only: the server decides which passwords it accepts.
  const ready = $derived(password.length > 0 && password === passwordConfirm);

  onMount(() => {
    try {
      token = decodeURIComponent(location.hash.replace(/^#/, ''));
    } catch {
      // a truncated or mangled link: shown as expired below
    }
    // keep the token out of the history entry and of anything the page later shares
    history.replaceState(history.state, '', location.pathname);
    if (!token) {
      phase = 'expired';
      return;
    }
    void (async () => {
      try {
        account = await checkPasswordLink({ passwordLinkCheckDto: { token } });
        phase = 'ready';
      } catch {
        phase = 'expired';
      }
    })();
  });

  const onSubmit = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!ready || loading || !account) {
      return;
    }
    loading = true;
    errorMessage = '';
    try {
      await redeemPasswordLink({ passwordLinkRedeemDto: { token, newPassword: password } });
      setAuthNotice({ kind: 'password-changed', email: account.email });
      await goto(Route.login());
    } catch (error) {
      errorMessage = getServerErrorMessage(error) || $t('frameleaf_auth_choose_password_failed');
    } finally {
      loading = false;
    }
  };
</script>

<AuthShell>
  {#if phase === 'expired'}
    <div class="auth-heading">
      <h1>{$t('frameleaf_auth_choose_password_expired_title')}</h1>
      <p>{$t('frameleaf_auth_choose_password_expired')}</p>
    </div>
    <div class="auth-card auth-form">
      <a href={Route.login()} class="button primary auth-submit">{$t('frameleaf_auth_sign_in')}</a>
    </div>
  {:else if phase === 'checking' || !account}
    <div class="auth-heading">
      <h1>{$t('frameleaf_auth_choose_password_title')}</h1>
      <p role="status">{$t('frameleaf_auth_choose_password_checking')}</p>
    </div>
  {:else}
    <div class="auth-heading">
      <h1>{$t('frameleaf_auth_choose_password_title')}</h1>
      <p>{$t('frameleaf_auth_choose_password_body')}</p>
    </div>
    <form class="auth-card auth-form" onsubmit={onSubmit} novalidate>
      {#if errorMessage}<p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" /><span>{errorMessage}</span>
        </p>{/if}
      <div class="auth-field">
        <label for="account-email">{$t('frameleaf_auth_account')}</label><input
          id="account-email"
          value={account.email}
          readonly
          autocomplete="username"
        />
      </div>
      <AuthPasswordField
        id="new-password"
        label={$t('frameleaf_auth_new_password')}
        autofocus
        bind:value={password}
        describedBy="new-password-quality"
      />
      <AuthPasswordQuality id="new-password-quality" {password} />
      <AuthPasswordField
        id="confirm-password"
        label={$t('frameleaf_auth_confirm_new_password')}
        bind:value={passwordConfirm}
        invalid={mismatch}
        describedBy={mismatch ? 'new-password-match' : undefined}
      />
      {#if mismatch}<span class="auth-field-hint" id="new-password-match"
          >{$t('frameleaf_auth_passwords_mismatch_hint')}</span
        >{/if}
      <button type="submit" class="button primary auth-submit" disabled={!ready || loading}
        >{loading ? $t('frameleaf_auth_saving') : $t('frameleaf_auth_choose_password_save')}</button
      >
    </form>
  {/if}
</AuthShell>
