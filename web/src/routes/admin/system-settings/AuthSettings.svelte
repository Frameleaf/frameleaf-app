<script lang="ts">
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { systemConfigManager } from '$lib/managers/system-config-manager.svelte';
  import AuthDisableLoginConfirmModal from '$lib/modals/AuthDisableLoginConfirmModal.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import CredentialRow from '$lib/components/frameleaf/settings/CredentialRow.svelte';
  import { ConfigCredential, OAuthTokenEndpointAuthMethod, unlinkAllOAuthAccountsAdmin } from '@immich/sdk';
  import { Button, Link, modalManager, Text, toastManager } from '@immich/ui';
  import { mdiRestart } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const config = $derived(systemConfigManager.value);
  let configToEdit = $state(systemConfigManager.cloneValue());

  const handleToggleOverride = () => {
    // click runs before bind
    const previouslyEnabled = configToEdit.oauth.mobileOverrideEnabled;
    if (!previouslyEnabled && !configToEdit.oauth.mobileRedirectUri) {
      configToEdit.oauth.mobileRedirectUri = location.origin + '/api/oauth/mobile-redirect';
    }
  };

  const onBeforeSave = async () => {
    const allMethodsDisabled = !configToEdit.oauth.enabled && !configToEdit.passwordLogin.enabled;

    if (allMethodsDisabled) {
      const confirmed = await modalManager.show(AuthDisableLoginConfirmModal);
      if (!confirmed) {
        return false;
      }
    }

    return true;
  };

  const handleUnlinkAllOAuthAccounts = async () => {
    const confirmed = await modalManager.showDialog({
      icon: mdiRestart,
      title: $t('admin.unlink_all_oauth_accounts'),
      prompt: $t('admin.unlink_all_oauth_accounts_prompt'),
      confirmColor: 'danger',
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
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
      <div class="flex flex-col">
        <SettingGroup key="oauth" title={$t('admin.oauth_settings')} subtitle={$t('admin.oauth_settings_description')}>
          <div class="flex flex-col gap-4">
            <Text size="small">
              <FormatMessage key="admin.oauth_settings_more_details">
                {#snippet children({ message })}
                  <Link href="https://docs.immich.app/administration/oauth">{message}</Link>
                {/snippet}
              </FormatMessage>
            </Text>

            <SettingToggle
              {disabled}
              title={$t('admin.oauth_enable_description')}
              bind:checked={configToEdit.oauth.enabled}
            />

            {#if configToEdit.oauth.enabled}
              <hr />

              <div class="flex items-center justify-between gap-2">
                <Text size="small">{$t('admin.unlink_all_oauth_accounts_description')}</Text>
                <Button size="small" onclick={handleUnlinkAllOAuthAccounts}
                  >{$t('admin.unlink_all_oauth_accounts')}</Button
                >
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

        <SettingActions bind:configToEdit keys={['passwordLogin', 'oauth']} {onBeforeSave} {disabled} />
      </div>
    </form>
  </div>
</div>
