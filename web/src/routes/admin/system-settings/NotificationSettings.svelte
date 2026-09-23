<script lang="ts">
  import TemplateSettings from './TemplateSettings.svelte';
  import SettingGroup from '$lib/components/frameleaf/settings/SettingGroup.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { sendTestEmailAdmin } from '@immich/sdk';
  import { Button, toastManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import { fade } from 'svelte/transition';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const configToEdit = $derived(settingsDraft.draft);
  const config = $derived(settingsDraft.baseline);

  let isSending = $state(false);

  const handleSendTestEmail = async () => {
    if (isSending) {
      return;
    }

    isSending = true;

    try {
      await sendTestEmailAdmin({
        adminConfigSmtpDto: {
          enabled: configToEdit.notifications.smtp.enabled,
          transport: {
            host: configToEdit.notifications.smtp.transport.host,
            port: configToEdit.notifications.smtp.transport.port,
            secure: configToEdit.notifications.smtp.transport.secure,
            username: configToEdit.notifications.smtp.transport.username,
            password: configToEdit.notifications.smtp.transport.password,
            ignoreCert: configToEdit.notifications.smtp.transport.ignoreCert,
          },
          from: configToEdit.notifications.smtp.from,
          replyTo: configToEdit.notifications.smtp.from,
        },
      });

      toastManager.primary(
        $t('admin.notification_email_test_email_sent', { values: { email: authManager.user.email } }),
      );

      // FL-66: a successful delivery test saves the email settings only, against the draft's
      // revision; every other pending change stays in the draft for review.
      if (!disabled) {
        await settingsDraft.saveKeys(['notifications']);
      }
    } catch (error) {
      handleError(error, $t('admin.notification_email_test_email_failed'));
    } finally {
      isSending = false;
    }
  };
</script>

<div>
  <div in:fade={{ duration: 500 }}>
    <form autocomplete="off" class="mt-4" onsubmit={(event) => event.preventDefault()}>
      <div class="flex flex-col gap-4">
        <SettingGroup key="email" title={$t('email')} subtitle={$t('admin.notification_email_setting_description')}>
          <div class="flex flex-col gap-4">
            <SettingToggle
              title={$t('admin.notification_enable_email_notifications')}
              {disabled}
              bind:checked={configToEdit.notifications.smtp.enabled}
            />

            <hr />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              required
              label={$t('host')}
              description={$t('admin.notification_email_host_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:value={configToEdit.notifications.smtp.transport.host}
              isEdited={configToEdit.notifications.smtp.transport.host !== config.notifications.smtp.transport.host}
            />

            <SettingField
              inputType={SettingInputFieldType.NUMBER}
              required
              label={$t('port')}
              description={$t('admin.notification_email_port_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:value={configToEdit.notifications.smtp.transport.port}
              isEdited={configToEdit.notifications.smtp.transport.port !== config.notifications.smtp.transport.port}
            />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              label={$t('username')}
              description={$t('admin.notification_email_username_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:value={configToEdit.notifications.smtp.transport.username}
              isEdited={configToEdit.notifications.smtp.transport.username !==
                config.notifications.smtp.transport.username}
            />

            <SettingField
              inputType={SettingInputFieldType.PASSWORD}
              label={$t('password')}
              description={$t('admin.notification_email_password_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:value={configToEdit.notifications.smtp.transport.password}
              isEdited={configToEdit.notifications.smtp.transport.password !==
                config.notifications.smtp.transport.password}
            />

            <SettingToggle
              title={$t('admin.notification_email_secure')}
              subtitle={$t('admin.notification_email_secure_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:checked={configToEdit.notifications.smtp.transport.secure}
            />

            <SettingToggle
              title={$t('admin.notification_email_ignore_certificate_errors')}
              subtitle={$t('admin.notification_email_ignore_certificate_errors_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:checked={configToEdit.notifications.smtp.transport.ignoreCert}
            />

            <hr />

            <SettingField
              inputType={SettingInputFieldType.TEXT}
              required
              label={$t('admin.notification_email_from_address')}
              description={$t('admin.notification_email_from_address_description')}
              disabled={disabled || !configToEdit.notifications.smtp.enabled}
              bind:value={configToEdit.notifications.smtp.from}
              isEdited={configToEdit.notifications.smtp.from !== config.notifications.smtp.from}
            />

            <div class="flex place-items-center gap-2">
              <Button
                size="small"
                shape="round"
                loading={isSending}
                disabled={!configToEdit.notifications.smtp.enabled}
                onclick={handleSendTestEmail}
              >
                {#if disabled}
                  {$t('admin.notification_email_test_email')}
                {:else}
                  {$t('admin.notification_email_sent_test_email_button')}
                {/if}
              </Button>
            </div>
            {#if !disabled}
              <p class="test-note">{$t('frameleaf_settings_draft_email_test_note')}</p>
            {/if}
          </div>
        </SettingGroup>
      </div>
    </form>
  </div>
  <TemplateSettings />

  <SettingActions keys={['notifications', 'templates']} {disabled} />
</div>

<style>
  .test-note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
</style>
