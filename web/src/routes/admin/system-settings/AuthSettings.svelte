<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { appCallbacks } from '$lib/frameleaf/oauth-callbacks';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import CredentialRow from '$lib/components/frameleaf/settings/CredentialRow.svelte';
  import { ConfigCredential, OAuthTokenEndpointAuthMethod, unlinkAllOAuthAccountsAdmin } from '@immich/sdk';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { confirmFrameleaf } from '$lib/frameleaf/confirm';
  import { Link, Text, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
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

  // FL-135: this installation's documentation, or no link at all
  const oauthDocs = $derived(helpLinks.docs('administration/oauth'));

  // FL-131: what the identity provider must allow for each app, derived the way the server does
  const callbacks = $derived(
    appCallbacks(configToEdit.oauth.mobileOverrideEnabled, configToEdit.oauth.mobileRedirectUri),
  );
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
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
              <hr />

              <div class="flex items-center justify-between gap-2">
                <Text size="small">{$t('admin.unlink_all_oauth_accounts_description')}</Text>
                <Button onclick={handleUnlinkAllOAuthAccounts}>{$t('admin.unlink_all_oauth_accounts')}</Button>
              </div>

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="issuer_url"
                bind:value={configToEdit.oauth.issuerUrl}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.issuerUrl !== config.oauth.issuerUrl}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="client_id"
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

              {#if config.oauth.clientSecretConfigured}
                <SettingSelect
                  label="token_endpoint_auth_method"
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
                label="scope"
                bind:value={configToEdit.oauth.scope}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.scope !== config.oauth.scope}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="id_token_signed_response_alg"
                bind:value={configToEdit.oauth.signingAlgorithm}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.signingAlgorithm !== config.oauth.signingAlgorithm}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="userinfo_signed_response_alg"
                bind:value={configToEdit.oauth.profileSigningAlgorithm}
                required={true}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.profileSigningAlgorithm !== config.oauth.profileSigningAlgorithm}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="prompt"
                description={$t('admin.oauth_prompt_description')}
                bind:value={configToEdit.oauth.prompt}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.prompt !== config.oauth.prompt}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label="end_session_endpoint"
                description={$t('admin.oauth_end_session_url_description')}
                bind:value={configToEdit.oauth.endSessionEndpoint}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.endSessionEndpoint !== config.oauth.endSessionEndpoint}
              />

              <SettingField
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.oauth_timeout')}
                description={$t('admin.oauth_timeout_description')}
                required={true}
                bind:value={configToEdit.oauth.timeout}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.timeout !== config.oauth.timeout}
              />

              <SettingToggle
                title={$t('admin.oauth_allow_insecure_requests')}
                subtitle={$t('admin.oauth_allow_insecure_requests_description')}
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
                inputType={SettingInputFieldType.NUMBER}
                label={$t('admin.oauth_storage_quota_default')}
                description={$t('admin.oauth_storage_quota_default_description')}
                bind:value={configToEdit.oauth.defaultStorageQuota}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.defaultStorageQuota !== config.oauth.defaultStorageQuota}
              />

              <SettingField
                inputType={SettingInputFieldType.TEXT}
                label={$t('admin.oauth_button_text')}
                bind:value={configToEdit.oauth.buttonText}
                required={false}
                disabled={disabled || !configToEdit.oauth.enabled}
                isEdited={configToEdit.oauth.buttonText !== config.oauth.buttonText}
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
                title={$t('admin.oauth_auto_register')}
                subtitle={$t('admin.oauth_auto_register_description')}
                bind:checked={configToEdit.oauth.autoRegister}
                disabled={disabled || !configToEdit.oauth.enabled}
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
                  values: { callback: 'app.immich:///oauth-callback' },
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

              <!-- FL-131: both apps sign in against this server; each needs its own callback allowed.
                   Grouped-list pattern from the prototype's settings rows (SystemPanels.jsx). -->
              <section class="app-callbacks" aria-labelledby="app-callbacks-title">
                <h4 id="app-callbacks-title">{$t('frameleaf_oauth_app_callbacks_title')}</h4>
                <p>{$t('frameleaf_oauth_app_callbacks_description')}</p>
                <dl>
                  <div>
                    <dt>{$t('frameleaf_oauth_app_callbacks_frameleaf')}</dt>
                    <dd>
                      {#if callbacks.frameleaf}
                        <code>{callbacks.frameleaf}</code>
                      {:else}
                        <span class="refused" role="alert">{$t('frameleaf_oauth_app_callbacks_frameleaf_refused')}</span
                        >
                      {/if}
                    </dd>
                  </div>
                  <div>
                    <dt>{$t('frameleaf_oauth_app_callbacks_immich')}</dt>
                    <dd><code>{callbacks.immich}</code></dd>
                  </div>
                </dl>
                <p>{$t('frameleaf_oauth_app_callbacks_independent')}</p>
              </section>
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
