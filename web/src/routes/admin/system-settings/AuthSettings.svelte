<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { appCallback, FRAMELEAF_APP_CALLBACK } from '$lib/frameleaf/oauth-callbacks';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import CredentialRow from '$lib/components/frameleaf/settings/CredentialRow.svelte';
  import {
    checkOAuthProvider,
    ConfigCredential,
    OAuthTokenEndpointAuthMethod,
    unlinkAllOAuthAccountsAdmin,
    type OAuthCheckResponseDto,
  } from '@frameleaf/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { Link, Text, toastManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { reveal } from '$lib/frameleaf/motion';
  import { locale } from '$lib/stores/preferences.store';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  const handleToggleOverride = () => {
    // click runs before bind
    const previouslyEnabled = configToEdit.oauth.mobileOverrideEnabled;
    if (!previouslyEnabled && !configToEdit.oauth.mobileRedirectUri) {
      configToEdit.oauth.mobileRedirectUri = location.origin + '/api/oauth/mobile-redirect';
    }
  };

  const handleUnlinkAllOAuthAccounts = async () => {
    const confirmed = await confirmFrameleaf({
      title: $t('admin.unlink_all_oauth_accounts'),
      prompt: $t('admin.unlink_all_oauth_accounts_prompt'),
      confirmText: $t('confirm'),
      danger: true,
    });

    if (!confirmed) {
      return;
    }

    try {
      await unlinkAllOAuthAccountsAdmin();
      toastManager.primary();
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    }
  };

  /**
   * FL-367: "Check" reads the provider with what is typed so far (the saved secret when none is
   * typed) and says what it found. Nothing is saved.
   */
  let checking = $state(false);
  let checked = $state<OAuthCheckResponseDto | null>(null);
  const check = async () => {
    checking = true;
    checked = null;
    try {
      checked = await checkOAuthProvider({
        oAuthCheckDto: {
          issuerUrl: configToEdit.oauth.issuerUrl,
          clientId: configToEdit.oauth.clientId,
          allowInsecureRequests: configToEdit.oauth.allowInsecureRequests,
        },
      });
    } catch {
      checked = { ok: false, issuer: null, error: $t('frameleaf_signin_check_incomplete') };
    } finally {
      checking = false;
    }
  };
  const providerHost = (issuer: string) => {
    try {
      return new URL(issuer).host;
    } catch {
      return issuer;
    }
  };

  /** FL-367: "Wait for the provider" in seconds; the setting keeps milliseconds. */
  // the draft is the only copy, so discard and reload reset this field too
  const getTimeoutSeconds = () => Math.max(1, Math.round(configToEdit.oauth.timeout / 1000));
  const setTimeoutSeconds = (seconds: unknown) => {
    // a cleared field stays empty while typing; the field clamps it when the edit is committed
    if (seconds === null || seconds === '') {
      return;
    }
    configToEdit.oauth.timeout = Math.max(1, Math.round(Number(seconds) || 1)) * 1000;
  };

  /** FL-367: the ways in that are on, said in one sentence at the top. */
  const ways = $derived(
    [
      configToEdit.passwordLogin.enabled ? $t('frameleaf_signin_way_password') : '',
      configToEdit.oauth.enabled ? configToEdit.oauth.buttonText || $t('frameleaf_signin_way_provider') : '',
    ].filter(Boolean),
  );

  // FL-135: this installation's documentation, or no link at all
  const oauthDocs = $derived(helpLinks.docs('administration/oauth'));

  // FL-131: what the identity provider must allow for the app, derived the way the server does
  const callback = $derived(
    appCallback(configToEdit.oauth.mobileOverrideEnabled, configToEdit.oauth.mobileRedirectUri),
  );
</script>

<!-- FL-367: the area's other pages are kit pages; this form keeps its card of its own. -->
<div class="legacy-card fl-continuous-corners">
  <div in:reveal>
    <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
      <p class="answer" role="status">
        {ways.length > 0
          ? $t('frameleaf_signin_answer', {
              values: { ways: new Intl.ListFormat($locale, { type: 'disjunction' }).format(ways) },
            })
          : $t('frameleaf_signin_answer_none')}
      </p>
      <div class="flex flex-col">
        <SettingGroup key="oauth" title={$t('admin.oauth_settings')} subtitle={$t('admin.oauth_settings_description')}>
          <div class="flex flex-col gap-4">
            {#if oauthDocs}
              <Text size="small">
                <FormatMessage key="admin.oauth_settings_more_details">
                  {#snippet children({ message })}
                    <Link href={oauthDocs}>{message}</Link>
                  {/snippet}
                </FormatMessage>
              </Text>
            {/if}

            <SettingToggle
              {disabled}
              title={$t('admin.oauth_enable_description')}
              bind:checked={configToEdit.oauth.enabled}
            />

            {#if configToEdit.oauth.enabled}
              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label={$t('frameleaf_signin_issuer_url')}
                description={$t('frameleaf_signin_issuer_url_description')}
                bind:value={configToEdit.oauth.issuerUrl}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.issuerUrl !== config.oauth.issuerUrl}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label={$t('frameleaf_signin_client_id_label')}
                bind:value={configToEdit.oauth.clientId}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.clientId !== config.oauth.clientId}
              />

              <!-- FL-67: the client secret is write-only and never part of this form's draft. -->
              <CredentialRow
                name={ConfigCredential.OauthClientSecret}
                {disabled}
                reason={disabled ? $t('frameleaf_credentials_config_file') : undefined}
              />

              <div class="check">
                <Button
                  disabled={checking || !configToEdit.oauth.issuerUrl || !configToEdit.oauth.clientId}
                  onclick={check}>{$t('frameleaf_signin_check')}</Button
                >
                <p role="status">
                  {#if checking}
                    {$t('frameleaf_signin_checking')}
                  {:else if checked?.ok && checked.issuer}
                    {$t('frameleaf_signin_check_ok', { values: { provider: providerHost(checked.issuer) } })}
                  {:else if checked}
                    {$t('frameleaf_signin_check_failed', { values: { error: checked.error ?? '' } })}
                  {/if}
                </p>
              </div>

              <!-- FL-516: the space a new account starts with is one setting, "Space for new people" under Users. -->
              <p class="new-space">
                {$t('frameleaf_signin_new_space')}
                <a href={commandCenterUrl('users')}>{$t('frameleaf_signin_new_space_link')}</a>
              </p>

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_button_text')}
                bind:value={configToEdit.oauth.buttonText}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.buttonText !== config.oauth.buttonText}
              />

              <SettingToggle
                title={$t('admin.oauth_auto_register')}
                subtitle={$t('admin.oauth_auto_register_description')}
                bind:checked={configToEdit.oauth.autoRegister}
                disabled={disabled || !configToEdit.oauth.enabled}
              />

              <details class="expert">
                <summary>{$t('frameleaf_signin_advanced')}</summary>
                <div class="flex flex-col gap-4">
                  {#if config.oauth.clientSecretConfigured}
                    <SettingSelect
                      label={$t('frameleaf_signin_proves')}
                      bind:value={configToEdit.oauth.tokenEndpointAuthMethod}
                      disabled={disabled || !configToEdit.oauth.enabled}
                      isEdited={configToEdit.oauth.tokenEndpointAuthMethod !== config.oauth.tokenEndpointAuthMethod}
                      options={[
                        { value: OAuthTokenEndpointAuthMethod.ClientSecretPost, text: 'client_secret_post' },
                        { value: OAuthTokenEndpointAuthMethod.ClientSecretBasic, text: 'client_secret_basic' },
                      ]}
                      name="tokenEndpointAuthMethod"
                    />
                  {/if}

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('frameleaf_signin_scope')}
                    bind:value={configToEdit.oauth.scope}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.scope !== config.oauth.scope}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('frameleaf_signin_signing')}
                    bind:value={configToEdit.oauth.signingAlgorithm}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.signingAlgorithm !== config.oauth.signingAlgorithm}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('frameleaf_signin_profile_signing')}
                    bind:value={configToEdit.oauth.profileSigningAlgorithm}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.profileSigningAlgorithm !== config.oauth.profileSigningAlgorithm}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('frameleaf_signin_prompt')}
                    description={$t('admin.oauth_prompt_description')}
                    bind:value={configToEdit.oauth.prompt}
                    required={false}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.prompt !== config.oauth.prompt}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('frameleaf_signin_end_session')}
                    description={$t('admin.oauth_end_session_url_description')}
                    bind:value={configToEdit.oauth.endSessionEndpoint}
                    required={false}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.endSessionEndpoint !== config.oauth.endSessionEndpoint}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.NUMBER}
                    label={$t('frameleaf_signin_timeout')}
                    description={$t('frameleaf_signin_timeout_description')}
                    required={true}
                    bind:value={getTimeoutSeconds, setTimeoutSeconds}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.timeout !== config.oauth.timeout}
                  />

                  <SettingToggle
                    title={$t('frameleaf_signin_insecure')}
                    subtitle={$t('frameleaf_signin_insecure_description')}
                    bind:checked={configToEdit.oauth.allowInsecureRequests}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.allowInsecureRequests !== config.oauth.allowInsecureRequests}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('admin.oauth_storage_label_claim')}
                    description={$t('admin.oauth_storage_label_claim_description')}
                    bind:value={configToEdit.oauth.storageLabelClaim}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.storageLabelClaim !== config.oauth.storageLabelClaim}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('admin.oauth_role_claim')}
                    description={$t('admin.oauth_role_claim_description')}
                    bind:value={configToEdit.oauth.roleClaim}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.roleClaim !== config.oauth.roleClaim}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('admin.oauth_storage_quota_claim')}
                    description={$t('admin.oauth_storage_quota_claim_description')}
                    bind:value={configToEdit.oauth.storageQuotaClaim}
                    required={true}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.storageQuotaClaim !== config.oauth.storageQuotaClaim}
                  />

                  <SettingField
                    inputType={SettingInputFieldType.TEXT}
                    label={$t('admin.oauth_account_management_url')}
                    description={$t('admin.oauth_account_management_url_description')}
                    bind:value={configToEdit.oauth.accountManagementUrl}
                    required={false}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    isEdited={configToEdit.oauth.accountManagementUrl !== config.oauth.accountManagementUrl}
                  />

                  <SettingToggle
                    title={$t('admin.oauth_auto_launch')}
                    subtitle={$t('admin.oauth_auto_launch_description')}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    bind:checked={configToEdit.oauth.autoLaunch}
                  />

                  <SettingToggle
                    title={$t('admin.oauth_mobile_redirect_uri_override')}
                    subtitle={$t('admin.oauth_mobile_redirect_uri_override_description', {
                      values: { callback: FRAMELEAF_APP_CALLBACK },
                    })}
                    disabled={disabled || !configToEdit.oauth.enabled}
                    onToggle={() => handleToggleOverride()}
                    bind:checked={configToEdit.oauth.mobileOverrideEnabled}
                  />

                  {#if configToEdit.oauth.mobileOverrideEnabled}
                    <SettingField
                      inputType={SettingInputFieldType.TEXT}
                      label={$t('admin.oauth_mobile_redirect_uri')}
                      bind:value={configToEdit.oauth.mobileRedirectUri}
                      required={true}
                      disabled={disabled || !configToEdit.oauth.enabled}
                      isEdited={configToEdit.oauth.mobileRedirectUri !== config.oauth.mobileRedirectUri}
                    />
                  {/if}
                </div>
              </details>

              <!-- FL-131: the Frameleaf app's callback the identity provider must allow.
                   Grouped-list pattern from the prototype's settings rows (SystemPanels.jsx). -->
              <section class="app-callbacks" aria-labelledby="app-callbacks-title">
                <h4 id="app-callbacks-title">{$t('frameleaf_oauth_app_callbacks_title')}</h4>
                <p>{$t('frameleaf_oauth_app_callbacks_description')}</p>
                <dl>
                  <div>
                    <dt>{$t('frameleaf_oauth_app_callbacks_frameleaf')}</dt>
                    <dd>
                      {#if callback}
                        <code>{callback}</code>
                      {:else}
                        <span class="refused" role="alert">{$t('frameleaf_oauth_app_callbacks_frameleaf_refused')}</span
                        >
                      {/if}
                    </dd>
                  </div>
                </dl>
              </section>

              <div class="flex items-center justify-between gap-2">
                <Text size="small">{$t('frameleaf_signin_disconnect_description')}</Text>
                <Button onclick={handleUnlinkAllOAuthAccounts}>{$t('frameleaf_signin_disconnect')}</Button>
              </div>
            {/if}
          </div>
        </SettingGroup>

        <SettingGroup
          key="password"
          title={$t('admin.password_settings')}
          subtitle={$t('admin.password_settings_description')}
        >
          <div class="flex flex-col gap-4">
            <div class="flex flex-col">
              <SettingToggle
                title={$t('admin.password_enable_description')}
                {disabled}
                bind:checked={configToEdit.passwordLogin.enabled}
              />
            </div>
          </div>
        </SettingGroup>

        <SettingActions keys={['passwordLogin', 'oauth']} {disabled} />
      </div>
    </form>
  </div>
</div>

<style>
  .legacy-card {
    padding: var(--fl-space-4) var(--fl-space-5);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .answer {
    margin: 0 0 var(--fl-space-4);
    font-size: var(--fl-font-callout);
  }
  .check {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .check p {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .expert > summary {
    padding: var(--fl-space-2) 0;
    color: var(--fl-muted);
    cursor: pointer;
  }
  .expert[open] > summary {
    margin-bottom: var(--fl-space-3);
  }
  .app-callbacks {
    display: grid;
    gap: 0.5rem;
    padding: 0.75rem 0.875rem;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .app-callbacks h4 {
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: 600;
    color: var(--fl-text);
  }
  .app-callbacks p,
  .app-callbacks dl {
    margin: 0;
  }
  .app-callbacks dl {
    display: grid;
    gap: 0.375rem;
  }
  .app-callbacks dl > div {
    display: grid;
    grid-template-columns: minmax(7rem, auto) 1fr;
    gap: 0.75rem;
    align-items: baseline;
  }
  .app-callbacks dt {
    color: var(--fl-text);
  }
  .app-callbacks dd {
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .app-callbacks code {
    color: var(--fl-text);
  }
  .refused {
    color: var(--fl-danger);
  }
</style>
