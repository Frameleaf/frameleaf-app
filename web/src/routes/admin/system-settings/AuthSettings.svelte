<script lang="ts">
  /**
   * Who can sign in › Sign-in methods (the approved prototype's `settings-v2/cloud/SignInMethods.jsx`):
   * a hero that says how many ways people can sign in, "Ways to sign in" with a switch for the
   * password and for another sign-in provider (the Frameleaf account row opens Sign in with
   * Frameleaf), the provider's three fields, check and accounts once it is on (everything else
   * under Advanced), and the numbered "If nobody can sign in" steps. Every value is the shared
   * settings draft, saved with the settings bar.
   */
  import { goto } from '$app/navigation';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Steps from '$lib/components/frameleaf/settings/kit/Steps.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import RegisteredApps from '$lib/components/frameleaf/settings/security/RegisteredApps.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { mdiAccountKeyOutline, mdiAlertCircleOutline, mdiChevronRight } from '@mdi/js';
  import { onMount } from 'svelte';
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
  import { Icon, toastManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import { locale } from '$lib/stores/preferences.store';

  onMount(() => cloudManager.listen());

  const disabled = $derived(featureFlagsManager.value.configFile);
  /** Sign in with Frameleaf works once the server is linked (FL-158). */
  const frameleafOn = $derived(cloudManager.status?.state === 'linked');
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
      frameleafOn ? $t('frameleaf_signin_way_frameleaf') : '',
      configToEdit.oauth.enabled ? $t('frameleaf_signin_way_provider') : '',
    ].filter(Boolean),
  );
  const either = (items: string[]) => new Intl.ListFormat($locale, { type: 'disjunction' }).format(items);

  /** The addresses a provider asks for, from this server's own address. */
  const origin = typeof location === 'undefined' ? '' : location.origin;

  const checkHelp = $derived(
    checking
      ? $t('frameleaf_signin_checking')
      : checked?.ok && checked.issuer
        ? $t('frameleaf_signin_check_ok', { values: { provider: providerHost(checked.issuer) } })
        : checked
          ? $t('frameleaf_signin_check_failed', { values: { error: checked.error ?? '' } })
          : $t('frameleaf_signin_check_help'),
  );

  // FL-135: this installation's documentation, or no link at all
  const oauthDocs = $derived(helpLinks.docs('administration/oauth'));

  // FL-131: what the identity provider must allow for the app, derived the way the server does
  const callback = $derived(
    appCallback(configToEdit.oauth.mobileOverrideEnabled, configToEdit.oauth.mobileRedirectUri),
  );
</script>

{#snippet disconnectAll()}
  <Button variant="danger" {disabled} onclick={handleUnlinkAllOAuthAccounts}>{$t('frameleaf_signin_disconnect')}</Button
  >
{/snippet}

<form autocomplete="off" onsubmit={(e) => e.preventDefault()}>
  <KitPage>
    {#if ways.length > 0}
      <Hero
        tone="good"
        icon={mdiAccountKeyOutline}
        title={$t('frameleaf_signin_hero_ways', { values: { count: ways.length } })}
        body={$t('frameleaf_signin_hero_ways_body', { values: { ways: either(ways) } })}
        label={$t('frameleaf_cc_section_signin')}
      />
    {:else}
      <Hero
        tone="warn"
        icon={mdiAlertCircleOutline}
        title={$t('frameleaf_signin_hero_none')}
        body={$t('frameleaf_signin_answer_none')}
        label={$t('frameleaf_cc_section_signin')}
      />
    {/if}

    <Section title={$t('frameleaf_signin_ways')}>
      <Row label={$t('frameleaf_signin_password')} help={$t('frameleaf_signin_password_help')}>
        <Switch
          label={$t('frameleaf_signin_password_switch')}
          checked={configToEdit.passwordLogin.enabled}
          held={disabled}
          onChange={(value) => (configToEdit.passwordLogin.enabled = value)}
        />
      </Row>
      <Row
        label={$t('frameleaf_personal_title')}
        help={frameleafOn ? $t('frameleaf_signin_frameleaf_on_help') : $t('frameleaf_signin_frameleaf_off_help')}
      >
        <span class="value">{frameleafOn ? $t('frameleaf_kit_on') : $t('frameleaf_kit_off')}</span>
        <Button
          label={$t('frameleaf_signin_open_frameleaf')}
          onclick={() => goto(commandCenterUrl('security', 'frameleaf-signin'))}
          >{$t('frameleaf_signin_open_own_provider')}<Icon icon={mdiChevronRight} size="1em" aria-hidden /></Button
        >
      </Row>
      <Row label={$t('frameleaf_signin_provider')} help={$t('frameleaf_signin_provider_help')}>
        <Switch
          label={$t('frameleaf_signin_provider')}
          checked={configToEdit.oauth.enabled}
          held={disabled}
          onChange={(value) => (configToEdit.oauth.enabled = value)}
        />
      </Row>
      {#if !configToEdit.passwordLogin.enabled}
        <Notice tone="warn" title={$t('frameleaf_signin_password_off_title')}
          >{$t('frameleaf_signin_password_off_body')}</Notice
        >
      {/if}
    </Section>

    {#if configToEdit.oauth.enabled}
      <Section title={$t('frameleaf_signin_connect')} description={$t('frameleaf_signin_connect_description')}>
        <Row label={$t('frameleaf_signin_issuer_url')} help={$t('frameleaf_signin_issuer_url_description')}>
          <Field
            wide
            type="url"
            label={$t('frameleaf_signin_issuer_url')}
            value={configToEdit.oauth.issuerUrl}
            {disabled}
            invalid={!configToEdit.oauth.issuerUrl}
            onChange={(value) => (configToEdit.oauth.issuerUrl = value)}
          />
        </Row>
        <Row label={$t('frameleaf_signin_client_id_label')} help={$t('frameleaf_signin_client_id_help')}>
          <Field
            wide
            label={$t('frameleaf_signin_client_id_label')}
            value={configToEdit.oauth.clientId}
            {disabled}
            invalid={!configToEdit.oauth.clientId}
            onChange={(value) => (configToEdit.oauth.clientId = value)}
          />
        </Row>
        <!-- FL-67: the client secret is write-only and never part of this form's draft. -->
        <div class="credential">
          <CredentialRow
            name={ConfigCredential.OauthClientSecret}
            {disabled}
            reason={disabled ? $t('frameleaf_credentials_config_file') : undefined}
          />
        </div>
        <Row label={$t('frameleaf_signin_check_label')} help={checkHelp}>
          <Button disabled={checking || !configToEdit.oauth.issuerUrl || !configToEdit.oauth.clientId} onclick={check}
            >{$t('frameleaf_signin_check')}</Button
          >
        </Row>
        <Advanced summary={$t('frameleaf_signin_addresses')}>
          <p class="hint">{$t('frameleaf_signin_addresses_help')}</p>
          <Row label={$t('frameleaf_signin_address_web')}>
            <span class="value address">{origin}/auth/login</span>
          </Row>
          <Row label={$t('frameleaf_signin_address_account')}>
            <span class="value address">{origin}/user-settings</span>
          </Row>
          <!-- FL-131: the Frameleaf app's callback the identity provider must allow. -->
          <Row label={$t('frameleaf_signin_address_app')} help={$t('frameleaf_oauth_app_callbacks_description')}>
            {#if callback}
              <span class="value address">{callback}</span>
            {:else}
              <span class="refused" role="alert">{$t('frameleaf_oauth_app_callbacks_frameleaf_refused')}</span>
            {/if}
          </Row>
        </Advanced>
      </Section>

      <Section title={$t('frameleaf_signin_accounts')}>
        <Row label={$t('admin.oauth_auto_register')} help={$t('frameleaf_signin_auto_register_help')}>
          <Switch
            label={$t('admin.oauth_auto_register')}
            checked={configToEdit.oauth.autoRegister}
            held={disabled}
            onChange={(value) => (configToEdit.oauth.autoRegister = value)}
          />
        </Row>
        <!-- FL-516: the space a new account starts with is one setting, "Space for new people" under Users. -->
        <Row label={$t('frameleaf_signin_new_space_label')} help={$t('frameleaf_signin_space_help')}>
          <Button onclick={() => goto(commandCenterUrl('users'))}>{$t('frameleaf_signin_open_users')}</Button>
        </Row>
        <Row label={$t('frameleaf_signin_button_words')} help={$t('frameleaf_signin_button_words_help')}>
          <Field
            wide
            label={$t('frameleaf_signin_button_words')}
            value={configToEdit.oauth.buttonText}
            {disabled}
            onChange={(value) => (configToEdit.oauth.buttonText = value)}
          />
        </Row>
        <Advanced>
          <p class="hint">
            {$t('frameleaf_signin_oidc_hint')}
            {#if oauthDocs}<TextLink href={oauthDocs} external>{$t('frameleaf_signin_oidc_docs')}</TextLink>{/if}
          </p>
          {#if config.oauth.clientSecretConfigured}
            <Row label={$t('frameleaf_signin_proves')} help={$t('frameleaf_signin_proves_help')}>
              <Select
                label={$t('frameleaf_signin_proves')}
                value={configToEdit.oauth.tokenEndpointAuthMethod}
                {disabled}
                options={[
                  { value: OAuthTokenEndpointAuthMethod.ClientSecretPost, label: $t('frameleaf_signin_proves_body') },
                  {
                    value: OAuthTokenEndpointAuthMethod.ClientSecretBasic,
                    label: $t('frameleaf_signin_proves_header'),
                  },
                ]}
                onChange={(value) =>
                  (configToEdit.oauth.tokenEndpointAuthMethod = value as OAuthTokenEndpointAuthMethod)}
              />
            </Row>
          {/if}
          <Row label={$t('frameleaf_signin_scope')} help={$t('frameleaf_signin_scope_help')}>
            <Field
              label={$t('frameleaf_signin_scope')}
              value={configToEdit.oauth.scope}
              {disabled}
              onChange={(value) => (configToEdit.oauth.scope = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_signing')} help={$t('frameleaf_signin_signing_help')}>
            <Field
              label={$t('frameleaf_signin_signing')}
              value={configToEdit.oauth.signingAlgorithm}
              {disabled}
              onChange={(value) => (configToEdit.oauth.signingAlgorithm = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_profile_signing')} help={$t('frameleaf_signin_profile_signing_help')}>
            <Field
              label={$t('frameleaf_signin_profile_signing')}
              value={configToEdit.oauth.profileSigningAlgorithm}
              {disabled}
              onChange={(value) => (configToEdit.oauth.profileSigningAlgorithm = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_prompt')} help={$t('admin.oauth_prompt_description')}>
            <Field
              label={$t('frameleaf_signin_prompt')}
              value={configToEdit.oauth.prompt}
              {disabled}
              onChange={(value) => (configToEdit.oauth.prompt = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_end_session')} help={$t('admin.oauth_end_session_url_description')}>
            <Field
              wide
              type="url"
              label={$t('frameleaf_signin_end_session')}
              placeholder="https://"
              value={configToEdit.oauth.endSessionEndpoint}
              {disabled}
              onChange={(value) => (configToEdit.oauth.endSessionEndpoint = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_wait')} help={$t('frameleaf_signin_timeout_description')}>
            <Amount
              label={$t('frameleaf_signin_wait')}
              unit={$t('frameleaf_signin_seconds')}
              min={1}
              max={300}
              value={getTimeoutSeconds()}
              {disabled}
              onChange={(value) => setTimeoutSeconds(value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_insecure')} help={$t('frameleaf_signin_insecure_help')}>
            <Switch
              label={$t('frameleaf_signin_insecure')}
              checked={configToEdit.oauth.allowInsecureRequests}
              held={disabled}
              onChange={(value) => (configToEdit.oauth.allowInsecureRequests = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_straight')} help={$t('frameleaf_signin_straight_help')}>
            <Switch
              label={$t('frameleaf_signin_straight')}
              checked={configToEdit.oauth.autoLaunch}
              held={disabled}
              onChange={(value) => (configToEdit.oauth.autoLaunch = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_folder_claim')} help={$t('admin.oauth_storage_label_claim_description')}>
            <Field
              label={$t('frameleaf_signin_folder_claim')}
              value={configToEdit.oauth.storageLabelClaim}
              {disabled}
              onChange={(value) => (configToEdit.oauth.storageLabelClaim = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_role_claim')} help={$t('admin.oauth_role_claim_description')}>
            <Field
              label={$t('frameleaf_signin_role_claim')}
              value={configToEdit.oauth.roleClaim}
              {disabled}
              onChange={(value) => (configToEdit.oauth.roleClaim = value)}
            />
          </Row>
          <Row label={$t('frameleaf_signin_quota_claim')} help={$t('admin.oauth_storage_quota_claim_description')}>
            <Field
              label={$t('frameleaf_signin_quota_claim')}
              value={configToEdit.oauth.storageQuotaClaim}
              {disabled}
              onChange={(value) => (configToEdit.oauth.storageQuotaClaim = value)}
            />
          </Row>
          <Row
            label={$t('admin.oauth_account_management_url')}
            help={$t('admin.oauth_account_management_url_description')}
          >
            <Field
              wide
              type="url"
              label={$t('admin.oauth_account_management_url')}
              placeholder="https://"
              value={configToEdit.oauth.accountManagementUrl ?? ''}
              {disabled}
              onChange={(value) => (configToEdit.oauth.accountManagementUrl = value)}
            />
          </Row>
          <Row
            label={$t('frameleaf_signin_older_app')}
            help={$t('admin.oauth_mobile_redirect_uri_override_description', {
              values: { callback: FRAMELEAF_APP_CALLBACK },
            })}
          >
            <Switch
              label={$t('frameleaf_signin_older_app')}
              checked={configToEdit.oauth.mobileOverrideEnabled}
              held={disabled}
              onChange={(value) => {
                if (value) {
                  handleToggleOverride();
                }
                configToEdit.oauth.mobileOverrideEnabled = value;
              }}
            />
          </Row>
          {#if configToEdit.oauth.mobileOverrideEnabled}
            <Row label={$t('admin.oauth_mobile_redirect_uri')}>
              <Field
                wide
                type="url"
                label={$t('admin.oauth_mobile_redirect_uri')}
                value={configToEdit.oauth.mobileRedirectUri}
                {disabled}
                invalid={!configToEdit.oauth.mobileRedirectUri}
                onChange={(value) => (configToEdit.oauth.mobileRedirectUri = value)}
              />
            </Row>
          {/if}
          <Row label={$t('frameleaf_signin_changing')} help={$t('frameleaf_signin_disconnect_description')}>
            {@render disconnectAll()}
          </Row>
        </Advanced>
      </Section>
    {/if}

    <!-- FL-860: apps people connect through OAuth (FL-803), such as AI assistants and Home Assistant. -->
    <Section title={$t('frameleaf_apps_admin_title')} description={$t('frameleaf_apps_admin_description')}>
      <Row
        label={$t('frameleaf_apps_admin_allow_registration')}
        help={$t('frameleaf_apps_admin_allow_registration_description')}
      >
        <!-- The server always returns `connectedApps`; the DTO marks it optional only because it has a default. -->
        <Switch
          label={$t('frameleaf_apps_admin_allow_registration')}
          checked={configToEdit.connectedApps?.allowRegistration ?? true}
          held={disabled}
          onChange={(value) =>
            (configToEdit.connectedApps = { ...configToEdit.connectedApps, allowRegistration: value })}
        />
      </Row>
      <Row label={$t('frameleaf_apps_admin_allow_mcp')} help={$t('frameleaf_apps_admin_allow_mcp_description')}>
        <Switch
          label={$t('frameleaf_apps_admin_allow_mcp')}
          checked={configToEdit.connectedApps?.allowMcp ?? true}
          held={disabled}
          onChange={(value) =>
            (configToEdit.connectedApps = { allowRegistration: true, ...configToEdit.connectedApps, allowMcp: value })}
        />
      </Row>
      <RegisteredApps />
    </Section>

    <Section title={$t('frameleaf_signin_recover')} description={$t('frameleaf_signin_recover_description')}>
      <Steps
        stacked
        label={$t('frameleaf_signin_recover')}
        steps={[
          { title: $t('frameleaf_signin_recover_step_1'), detail: $t('frameleaf_signin_recover_step_1_detail') },
          { title: $t('frameleaf_signin_recover_step_2'), detail: $t('frameleaf_signin_recover_step_2_detail') },
          { title: $t('frameleaf_signin_recover_step_3'), detail: $t('frameleaf_signin_recover_step_3_detail') },
        ]}
      />
      <p class="hint">
        {$t('frameleaf_signin_recover_one')}
        <TextLink href={commandCenterUrl('users')}>{$t('frameleaf_signin_recover_one_link')}</TextLink>.
      </p>
      <Advanced summary={$t('frameleaf_signin_commands')}>
        <Row label={$t('frameleaf_signin_recover_step_1')}>
          <span class="value address">frameleaf-admin enable-password-login</span>
        </Row>
        <Row label={$t('frameleaf_signin_recover_step_2')}>
          <span class="value address">frameleaf-admin reset-admin-password</span>
        </Row>
      </Advanced>
    </Section>

    <SettingActions keys={['passwordLogin', 'oauth', 'connectedApps']} {disabled} />
  </KitPage>
</form>

<style>
  .value {
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
  }
  .address {
    max-width: 380px;
    overflow-wrap: anywhere;
    user-select: all;
  }
  .hint {
    margin: 0;
    padding: var(--fl-space-3) 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .credential {
    padding: var(--fl-space-2) 0;
    border-top: 1px solid var(--fl-border);
  }
  .refused {
    max-width: 380px;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
</style>
