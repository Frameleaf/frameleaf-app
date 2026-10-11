<script lang="ts">
  /**
   * Email delivery › signing in with Google or Microsoft (FL-379, after the approved prototype
   * `settings-v2/server/notifications.jsx`, `ONE_CLICK`). One provider's sign-in, in whichever state
   * the server says it is in:
   *
   * - not signed in: one row with "Sign in with …", which opens the provider's page in a new tab;
   * - waiting for that page to be finished;
   * - signed in: the connected address and "Disconnect…";
   * - the provider is asking for a new sign-in: why, and "Sign in again";
   * - this server is not linked to a Frameleaf account, which signing in needs: why, and where to link.
   *
   * Every state is the server's own answer (`MailSignInStore`); nothing here is assumed.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import type { SignInProvider } from '$lib/components/frameleaf/settings/notifications/mail-providers';
  import type { MailSignInStore } from '$lib/components/frameleaf/settings/notifications/mail-sign-in.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { MailConnectionStatus, MailSignInUnavailableReason, type MailDisconnectResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiEmailAlertOutline, mdiLinkVariant, mdiOpenInNew } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    signIn,
    store,
    disabled = false,
    onDisconnected,
  }: {
    signIn: SignInProvider;
    store: MailSignInStore;
    /** The settings come from a configuration file: nothing here can be changed. */
    disabled?: boolean;
    onDisconnected: (result: MailDisconnectResponseDto) => void;
  } = $props();

  const who = $derived({ values: { who: signIn.who } });
  const connection = $derived(store.connection?.provider === signIn.provider ? store.connection : null);
  const signedIn = $derived(connection?.status === MailConnectionStatus.Connected);
  const again = $derived(connection?.status === MailConnectionStatus.NeedsSignIn);
  const waiting = $derived(store.waiting === signIn.provider);
  const reason = $derived(store.state && !store.state.available ? store.state.unavailableReason : undefined);
  const unreachable = $derived(reason === MailSignInUnavailableReason.CloudUnreachable);
  /** Signing in needs a linked server; without Frameleaf Cloud at all, linking is where that starts too. */
  const unlinked = $derived(!!reason && !unreachable);
  const offered = $derived(!!store.state?.available && store.state.providers.includes(signIn.provider));
  const since = $derived(
    connection?.needsSignInSince
      ? new Date(connection.needsSignInSince).toLocaleString($locale, { dateStyle: 'medium', timeStyle: 'short' })
      : undefined,
  );

  const disconnect = async () => {
    if (!connection) {
      return;
    }
    const confirmed = await confirmFrameleaf({
      title: $t('frameleaf_notify_signin_disconnect_title', { values: { email: connection.email } }),
      // Google removes Frameleaf's access for the whole account, so another server using it stops too
      prompt:
        signIn.id === 'gmail'
          ? `${$t('frameleaf_notify_signin_disconnect_prompt')} ${$t('frameleaf_notify_signin_disconnect_prompt_google')}`
          : $t('frameleaf_notify_signin_disconnect_prompt'),
      confirmText: $t('frameleaf_notify_signin_disconnect_confirm'),
    });
    if (!confirmed) {
      return;
    }
    const result = await store.disconnect();
    if (result) {
      onDisconnected(result);
    }
  };
</script>

{#if store.outcome}
  <div class="block">
    {#if store.outcome.kind === 'denied'}
      <Notice title={$t('frameleaf_notify_signin_denied')}>{$t('frameleaf_notify_signin_nothing_changed')}</Notice>
    {:else if store.outcome.kind === 'expired'}
      <Notice tone="warn" title={$t('frameleaf_notify_signin_expired')}>
        {$t('frameleaf_notify_signin_expired_body')}
      </Notice>
    {:else if store.outcome.kind === 'failed'}
      <Notice tone="warn" title={$t('frameleaf_notify_signin_failed')}>
        {store.outcome.reason ?? $t('frameleaf_notify_signin_failed_unknown')}
      </Notice>
    {/if}
  </div>
{/if}

{#if store.loadFailed && !store.state}
  <div class="block">
    <Notice tone="warn" title={$t('frameleaf_notify_signin_load_failed')}>
      {#snippet action()}
        <Button onclick={() => store.load()}>{$t('frameleaf_notify_signin_try_again')}</Button>
      {/snippet}
      {$t('frameleaf_notify_signin_load_failed_body')}
    </Notice>
  </div>
{:else if signedIn && connection}
  <Row label={$t('frameleaf_notify_signin_signed_in_as')} help={$t('frameleaf_notify_signin_signed_in_help', who)}>
    <span class="value">{connection.email}</span>
    <Button disabled={disabled || store.busy} onclick={disconnect}>{$t('frameleaf_notify_signin_disconnect')}</Button>
  </Row>
{:else if waiting}
  <Row label={$t('frameleaf_notify_signin_waiting', who)} help={$t('frameleaf_notify_signin_waiting_help', who)}>
    <Button onclick={() => store.cancel()}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={disabled || store.busy} onclick={() => store.signIn(signIn.provider)}>
      <Icon icon={mdiOpenInNew} size="18" aria-hidden />
      {$t('frameleaf_notify_signin_open_again', who)}
    </Button>
  </Row>
{:else if store.state}
  {#if again}
    <div class="block">
      <Notice tone="warn" icon={mdiEmailAlertOutline} title={$t('frameleaf_notify_signin_again_title', who)}>
        {#snippet action()}
          {#if offered}
            <Button variant="primary" disabled={disabled || store.busy} onclick={() => store.signIn(signIn.provider)}>
              <Icon icon={mdiOpenInNew} size="18" aria-hidden />
              {$t('frameleaf_notify_signin_again')}
            </Button>
          {/if}
        {/snippet}
        {since
          ? $t('frameleaf_notify_signin_again_body_since', { values: { who: signIn.who, since } })
          : $t('frameleaf_notify_signin_again_body', who)}
      </Notice>
    </div>
  {/if}
  {#if unlinked}
    <div class="block">
      <Notice icon={mdiLinkVariant} title={$t('frameleaf_notify_signin_unlinked_title', who)}>
        {#snippet action()}
          <Button onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}>
            {$t('frameleaf_notify_signin_link_server')}
          </Button>
        {/snippet}
        {$t('frameleaf_notify_signin_unlinked_body', who)}
      </Notice>
    </div>
  {:else if unreachable}
    <div class="block">
      <Notice tone="warn" title={$t('frameleaf_notify_signin_unreachable_title')}>
        {#snippet action()}
          <Button onclick={() => store.load()}>{$t('frameleaf_notify_signin_try_again')}</Button>
        {/snippet}
        {$t('frameleaf_notify_signin_unreachable_body', who)}
      </Notice>
    </div>
  {:else if offered && !again}
    <Row label={$t('frameleaf_notify_signin_row', who)} help={$t('frameleaf_notify_signin_help', who)}>
      <Button variant="primary" disabled={disabled || store.busy} onclick={() => store.signIn(signIn.provider)}>
        <Icon icon={mdiOpenInNew} size="18" aria-hidden />
        {$t('frameleaf_notify_signin_row', who)}
      </Button>
    </Row>
  {/if}
{/if}

<style>
  .block {
    padding-bottom: var(--fl-space-4);
  }
  .value {
    min-width: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    overflow-wrap: anywhere;
  }
</style>
