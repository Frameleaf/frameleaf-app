<script lang="ts">
  /**
   * FL-860: the Allow page an app opens when it asks to use your library (an AI assistant such as
   * Claude or ChatGPT, Home Assistant, or an app Frameleaf doesn't know), as mocked in FL-778
   * (`ConnectScreens.jsx` `AllowApp`). The server's authorization endpoint (FL-803) checked the app
   * and its return address before sending the browser here; the page asks the server again, shows
   * the app, your account (with Switch account), what it will and won't be able to do in plain
   * words, and the technical names under Details. Deny and Allow go back to the app only through the
   * server. An app Frameleaf hasn't checked gets no highlighted Allow.
   */
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertOutline,
    mdiApplicationOutline,
    mdiCancel,
    mdiChatOutline,
    mdiCheck,
    mdiCheckCircleOutline,
    mdiCheckDecagram,
    mdiClockAlertOutline,
    mdiClose,
    mdiCreationOutline,
    mdiHomeAutomation,
    mdiInformationOutline,
    mdiLockOutline,
    mdiShieldAlertOutline,
  } from '@mdi/js';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import UserAvatar from '$lib/components/shared-components/UserAvatar.svelte';
  import { ALLOW_REQUEST_TTL_MS, isReturnTo, neverAllowed, plainAccess } from '$lib/frameleaf/connected-apps';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import {
    authorizeOAuthApp,
    startOAuthAppAuthorization,
    type OAuthAppAuthorizeStartResponseDto,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();

  type Phase = 'checking' | 'ask' | 'working' | 'allowed' | 'denied' | 'expired' | 'invalid';
  let phase = $state<Phase>('checking');
  let app = $state<OAuthAppAuthorizeStartResponseDto>();
  const openedAt = Date.now();
  const DONE: Phase[] = ['allowed', 'denied', 'expired', 'invalid'];

  const request = $derived(data.request);
  const user = $derived(authManager.authenticated ? authManager.user : undefined);
  const host = typeof location === 'undefined' ? '' : location.host;
  const name = $derived(app?.client.name ?? '');
  const access = $derived(plainAccess($t, app?.scopes ?? []));
  const never = $derived(neverAllowed($t));

  const ICONS: Record<string, string> = {
    claude: mdiCreationOutline,
    chatgpt: mdiChatOutline,
    homeassistant: mdiHomeAutomation,
  };
  const appIcon = $derived((app?.client.knownApp && ICONS[app.client.knownApp]) || mdiApplicationOutline);

  const decide = async (allow: boolean) => {
    if (!request || !app) {
      return;
    }
    if (Date.now() - openedAt > ALLOW_REQUEST_TTL_MS) {
      phase = 'expired';
      return;
    }
    phase = 'working';
    try {
      const { redirectUrl } = await authorizeOAuthApp({ oAuthAppAuthorizeDto: { ...request, allow } });
      // The browser only ever goes back to the app that asked.
      if (!isReturnTo(redirectUrl, request.redirectUri)) {
        phase = 'invalid';
        return;
      }
      phase = allow ? 'allowed' : 'denied';
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
    void startOAuthAppAuthorization({ oAuthAppAuthorizeStartDto: request })
      .then((result) => {
        app = result;
        // a scope this page can't put into words is refused rather than guessed
        phase = plainAccess($t, result.scopes).unknown.length > 0 ? 'invalid' : 'ask';
      })
      .catch(() => {
        phase = 'invalid';
      });
  });

  /** Sign out here and sign in as someone else, then come back to this request. */
  const switchAccount = () => {
    void authManager.logout({ continue: location.pathname + location.search });
  };
</script>

<AuthShell>
  {#if phase === 'checking'}
    <div class="allow-app" aria-busy="true">
      <div class="auth-heading">
        <h1>{$t('frameleaf_apps_allow_checking')}</h1>
        <p>{$t('frameleaf_apps_allow_checking_body')}</p>
      </div>
    </div>
  {:else if DONE.includes(phase)}
    <div class="allow-app">
      <div
        class="result"
        class:is-good={phase === 'allowed'}
        class:is-warn={phase === 'expired' || phase === 'invalid'}
        role="status"
      >
        <Icon
          icon={phase === 'allowed'
            ? mdiCheckCircleOutline
            : phase === 'denied'
              ? mdiCancel
              : phase === 'expired'
                ? mdiClockAlertOutline
                : mdiShieldAlertOutline}
          size="40"
          aria-hidden
        />
        {#if phase === 'allowed'}
          <h1>{$t('frameleaf_apps_allow_allowed_title', { values: { name } })}</h1>
          <p>{$t('frameleaf_apps_allow_allowed_body', { values: { back: app?.client.returnTo ?? '' } })}</p>
        {:else if phase === 'denied'}
          <h1>{$t('frameleaf_apps_allow_denied_title')}</h1>
          <p>{$t('frameleaf_apps_allow_denied_body', { values: { name } })}</p>
        {:else if phase === 'expired'}
          <h1>{$t('frameleaf_apps_allow_expired_title')}</h1>
          <p>{$t('frameleaf_apps_allow_expired_body', { values: { name } })}</p>
        {:else}
          <h1>{$t('frameleaf_apps_allow_invalid_title')}</h1>
          <p>{$t('frameleaf_apps_allow_invalid_body')}</p>
        {/if}
      </div>
      {#if phase === 'allowed'}
        <p class="auth-info">
          <Icon icon={mdiInformationOutline} size="16" aria-hidden /><span
            >{$t('frameleaf_apps_allow_allowed_note')}</span
          >
        </p>
        <div class="result-actions">
          <a class="button" href={commandCenterUrl('privacy', 'connected-apps')}
            >{$t('frameleaf_apps_allow_open_settings')}</a
          >
        </div>
      {/if}
    </div>
  {:else if app}
    <div class="allow-app">
      <div class="auth-heading">
        <span class="app-icon" aria-hidden="true"><Icon icon={appIcon} size="28" /></span>
        <h1>{$t('frameleaf_apps_allow_title', { values: { name } })}</h1>
        <p>{$t('frameleaf_apps_allow_body', { values: { name, server: host } })}</p>
      </div>

      <div class="auth-card allow">
        {#if app.client.verified}
          <p class="verified">
            <Icon icon={mdiCheckDecagram} size="18" aria-hidden />
            <span>
              <strong>{$t('frameleaf_apps_allow_verified_title')}</strong>
              {$t('frameleaf_apps_allow_verified_body', { values: { name, maker: app.client.maker ?? '' } })}
            </span>
          </p>
        {:else}
          <div class="unverified" role="note">
            <Icon icon={mdiAlertOutline} size="18" aria-hidden />
            <span>
              <strong>{$t('frameleaf_apps_allow_unverified_title')}</strong>
              {$t('frameleaf_apps_allow_unverified_body', { values: { back: app.client.returnTo } })}
            </span>
          </div>
        {/if}

        <div class="account">
          {#if user}<UserAvatar {user} size="md" noTitle />{/if}
          <span>
            <strong>{user?.name}</strong>
            <small>{user?.email} · {host}</small>
          </span>
          <button type="button" class="auth-link" disabled={phase === 'working'} onclick={switchAccount}
            >{$t('frameleaf_apps_allow_switch_account')}</button
          >
        </div>

        <section aria-labelledby="allow-app-can">
          <h2 id="allow-app-can">{$t('frameleaf_apps_allow_can_title')}</h2>
          <ul aria-labelledby="allow-app-can">
            {#each access.can as line (line)}
              <li><Icon icon={mdiCheck} size="16" class="is-can" aria-hidden />{line}</li>
            {/each}
          </ul>
        </section>
        <section aria-labelledby="allow-app-cant">
          <h2 id="allow-app-cant">{$t('frameleaf_apps_allow_cant_title')}</h2>
          <ul aria-labelledby="allow-app-cant">
            {#each never as line, index (line)}
              <li>
                <Icon icon={index === 0 ? mdiLockOutline : mdiClose} size="16" class="is-cant" aria-hidden />
                <span>{index === 0 ? `${line} ` : line}</span>
                {#if index === 0}<small class="never">· {$t('frameleaf_apps_cant_locked_never')}</small>{/if}
              </li>
            {/each}
          </ul>
        </section>

        <details class="details">
          <summary>{$t('frameleaf_apps_allow_details')}</summary>
          <dl>
            <div>
              <dt>{$t('frameleaf_apps_allow_details_permissions')}</dt>
              <dd>{app.scopes.join(', ')}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_apps_allow_details_app_id')}</dt>
              <dd>{app.client.id}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_apps_allow_details_back')}</dt>
              <dd>{request?.redirectUri}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_apps_allow_details_how_long')}</dt>
              <dd>{$t('frameleaf_apps_allow_details_how_long_value')}</dd>
            </div>
          </dl>
        </details>

        <div class="actions">
          <button type="button" class="button" disabled={phase === 'working'} onclick={() => decide(false)}
            >{$t('frameleaf_apps_allow_deny')}</button
          >
          <!-- An app Frameleaf hasn't checked gets no highlighted Allow: choosing it should be deliberate. -->
          <button
            type="button"
            class="button"
            class:primary={app.client.verified}
            disabled={phase === 'working'}
            onclick={() => decide(true)}>{$t('frameleaf_apps_allow_allow')}</button
          >
        </div>
      </div>
    </div>
  {/if}
</AuthShell>

<style>
  .allow-app {
    display: grid;
    gap: var(--fl-space-5);
  }
  .app-icon {
    display: inline-grid;
    place-items: center;
    width: 56px;
    height: 56px;
    margin-bottom: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .allow {
    display: grid;
    gap: var(--fl-space-5);
  }
  .verified,
  .unverified {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
    margin: 0;
    padding: var(--fl-space-3) var(--fl-space-4);
    border-radius: var(--fl-radius);
  }
  .verified {
    background: var(--fl-raised);
  }
  .verified :global(svg) {
    flex: none;
    margin-top: 0.15em;
    color: var(--fl-accent);
  }
  .unverified {
    background: var(--fl-raised);
  }
  .unverified :global(svg) {
    flex: none;
    margin-top: 0.15em;
    color: var(--fl-warning);
  }
  .verified span,
  .unverified span {
    display: grid;
    gap: var(--fl-space-1);
    color: var(--fl-muted);
  }
  .verified strong,
  .unverified strong {
    color: var(--fl-text);
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
    margin: 0 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  ul {
    display: grid;
    gap: var(--fl-space-3);
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
  .never {
    align-self: center;
    margin-left: calc(-1 * var(--fl-space-2));
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .details {
    padding-top: var(--fl-space-4);
    border-top: 1px solid var(--fl-border);
  }
  .details summary {
    cursor: pointer;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .details dl {
    display: grid;
    gap: var(--fl-space-3);
    margin: var(--fl-space-3) 0 0;
  }
  .details dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .details dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .result {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-3);
    text-align: center;
  }
  .result h1 {
    margin: 0;
  }
  .result p {
    margin: 0;
    color: var(--fl-muted);
  }
  .result.is-good :global(svg) {
    color: var(--fl-accent);
  }
  .result.is-warn :global(svg) {
    color: var(--fl-warning);
  }
  .result-actions {
    display: flex;
    justify-content: center;
  }
  /* Deny and Allow stay in view in a small sign-in window. */
  .actions {
    position: sticky;
    bottom: 0;
    display: flex;
    justify-content: flex-end;
    gap: var(--fl-space-3);
    background: inherit;
  }
  .actions .button {
    min-width: 120px;
  }
</style>
