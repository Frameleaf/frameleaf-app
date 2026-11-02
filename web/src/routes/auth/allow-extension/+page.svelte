<script lang="ts">
  /**
   * FL-655: "Allow Save to Frameleaf" (prototype `AllowExtension` in AuthScreens.jsx, README point 52).
   * Shown once per browser, in the browser's sign-in window, after the normal Frameleaf sign-in. It
   * shows the account it will save to (with "Not you?"), what the extension can and can't do and
   * where its access is listed. Allow and Cancel both go back to the extension through the server,
   * which makes the single-use code (Allow) or nothing (Cancel). A browser already allowed goes
   * straight through.
   */
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCheck, mdiClose, mdiInformationOutline } from '@mdi/js';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { extensionBrowserName, isReturnFor } from '$lib/frameleaf/extension-sign-in';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { authorizeBrowserExtensionSignIn, startBrowserExtensionSignIn } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Phase = 'checking' | 'ask' | 'working' | 'allowed' | 'cancelled' | 'invalid';
  let phase = $state<Phase>('checking');
  let accessName = $state('');

  const request = $derived(data.request);
  const browser = $derived(request ? extensionBrowserName(request.client) : 'Chrome');
  const user = $derived(authManager.authenticated ? authManager.user : undefined);
  const host = typeof location === 'undefined' ? '' : location.host;

  const decide = async (allow: boolean) => {
    if (!request) {
      return;
    }
    phase = 'working';
    try {
      const { redirectUrl } = await authorizeBrowserExtensionSignIn({
        browserExtensionSignInAuthorizeDto: { ...request, allow },
      });
      // The window only ever goes back to the extension that opened it.
      if (!isReturnFor(redirectUrl, request.redirectUri)) {
        phase = 'invalid';
        return;
      }
      phase = allow ? 'allowed' : 'cancelled';
      location.replace(redirectUrl);
    } catch {
      phase = 'invalid';
    }
  };

  onMount(() => {
    if (!request) {
      phase = 'invalid';
      return;
    }
    void startBrowserExtensionSignIn({ browserExtensionSignInStartDto: request })
      .then(async (result) => {
        accessName = result.accessName;
        if (result.alreadyAllowed) {
          await decide(true);
        } else {
          phase = 'ask';
        }
      })
      .catch(() => {
        phase = 'invalid';
      });
  });

  const notYou = () => {
    void authManager.logout({ continue: location.pathname + location.search });
  };
</script>

<AuthShell>
  {#if phase === 'allowed' || phase === 'cancelled'}
    <div class="auth-heading" role="status">
      <h1>
        {phase === 'allowed'
          ? $t('frameleaf_extension_allow_allowed_title')
          : $t('frameleaf_extension_allow_cancelled_title')}
      </h1>
      <p>
        {phase === 'allowed'
          ? $t('frameleaf_extension_allow_allowed_body')
          : $t('frameleaf_extension_allow_cancelled_body')}
      </p>
    </div>
  {:else if phase === 'invalid'}
    <div class="auth-heading">
      <h1>{$t('frameleaf_extension_allow_invalid_title')}</h1>
    </div>
    <div class="auth-card auth-form">
      <p class="auth-error" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" /><span>{$t('frameleaf_extension_allow_invalid_body')}</span>
      </p>
    </div>
  {:else if phase === 'checking'}
    <p class="auth-info" role="status">
      <Icon icon={mdiInformationOutline} size="16" /><span>{$t('frameleaf_extension_allow_checking')}</span>
    </p>
  {:else}
    <div class="auth-heading">
      <h1>{$t('frameleaf_extension_allow_title')}</h1>
      <p>{$t('frameleaf_extension_allow_body', { values: { browser } })}</p>
    </div>
    <div class="auth-card allow">
      <div class="account">
        {#if user}<UserAvatar {user} size="md" noTitle />{/if}
        <span>
          <strong>{user?.name}</strong>
          <small>{user?.email} · {host}</small>
        </span>
        <button type="button" class="auth-link" disabled={phase === 'working'} onclick={notYou}
          >{$t('frameleaf_extension_allow_not_you')}</button
        >
      </div>
      <section aria-labelledby="allow-can">
        <h2 id="allow-can">{$t('frameleaf_extension_allow_can_title')}</h2>
        <ul>
          <li><Icon icon={mdiCheck} size="16" class="is-can" />{$t('frameleaf_extension_allow_can_save')}</li>
          <li><Icon icon={mdiCheck} size="16" class="is-can" />{$t('frameleaf_extension_allow_can_names')}</li>
        </ul>
      </section>
      <section aria-labelledby="allow-cant">
        <h2 id="allow-cant">{$t('frameleaf_extension_allow_cant_title')}</h2>
        <ul>
          <li><Icon icon={mdiClose} size="16" class="is-cant" />{$t('frameleaf_extension_allow_cant_photos')}</li>
          <li><Icon icon={mdiClose} size="16" class="is-cant" />{$t('frameleaf_extension_allow_cant_change')}</li>
          <li><Icon icon={mdiClose} size="16" class="is-cant" />{$t('frameleaf_extension_allow_cant_read')}</li>
        </ul>
      </section>
      <p class="auth-info">
        <Icon icon={mdiInformationOutline} size="16" /><span
          >{$t('frameleaf_extension_allow_note', { values: { name: accessName } })}</span
        >
      </p>
      <div class="actions">
        <button type="button" class="button" disabled={phase === 'working'} onclick={() => decide(false)}
          >{$t('cancel')}</button
        >
        <button type="button" class="button primary" disabled={phase === 'working'} onclick={() => decide(true)}
          >{$t('frameleaf_extension_allow_allow')}</button
        >
      </div>
    </div>
  {/if}
</AuthShell>

<style>
  .allow {
    display: grid;
    gap: var(--fl-space-4);
  }
  .account {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    padding-bottom: var(--fl-space-4);
    border-bottom: 1px solid var(--fl-border);
  }
  .account > span {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .account small {
    color: var(--fl-muted);
    overflow-wrap: anywhere;
  }
  h2 {
    margin: 0 0 var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  ul {
    display: grid;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
  }
  li :global(.is-can) {
    flex: none;
    margin-top: 0.2em;
    color: var(--fl-accent);
  }
  li :global(.is-cant) {
    flex: none;
    margin-top: 0.2em;
    color: var(--fl-muted);
  }
  /* Cancel and Allow stay in view in the small sign-in window. */
  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: var(--fl-space-3);
    padding-top: var(--fl-space-2);
    background: inherit;
  }
</style>
