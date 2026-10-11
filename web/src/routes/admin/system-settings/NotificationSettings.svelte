<script lang="ts">
  /**
   * Notifications › Email delivery (FL-368, after the approved prototype
   * `settings-v2/server/notifications.jsx`). It starts with "Which email should Frameleaf send
   * from?": a provider is only a preset that fills in today's saved values (mail server, port and
   * encryption), and which provider is shown is read back from those values, so nothing new is
   * stored. "Other" shows every field in plain words.
   *
   * The password stays the write-only credential it was (FL-67): it is never part of the draft.
   * The server tests with the saved password only when the mail server, port, account, encryption
   * and certificate setting are the saved ones, so a test is offered once those are saved, and its
   * result stays on the page. Which step of a test failed is the server's to say; until it does,
   * the one reason it gives is shown as it is.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CredentialRow from '$lib/components/frameleaf/settings/CredentialRow.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Amount from '$lib/components/frameleaf/settings/kit/Amount.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import { MAIL_PROVIDERS, providerOf } from '$lib/components/frameleaf/settings/notifications/mail-providers';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { ConfigCredential, sendTestEmailAdmin } from '@frameleaf/sdk';
  import { mdiEmailCheckOutline, mdiEmailOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import TemplateSettings from './TemplateSettings.svelte';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const smtp = $derived(settingsDraft.draft.notifications.smtp);
  const saved = $derived(settingsDraft.baseline.notifications.smtp);

  /** "Other" was picked on this page; otherwise the provider is read back from the saved values. */
  let pickedOther = $state(false);
  const detected = $derived(providerOf(smtp.transport));
  const provider = $derived(pickedOther ? 'other' : detected);
  const preset = $derived(MAIL_PROVIDERS.find((item) => item.id === provider));

  const choose = (id: string) => {
    const next = MAIL_PROVIDERS.find((item) => item.id === id);
    pickedOther = !next;
    if (next) {
      smtp.transport.host = next.host;
      smtp.transport.port = next.port;
      smtp.transport.secure = next.secure;
    }
  };
  /** With a provider, the email address is the account name and, until a sender is typed, the sender. */
  const setAddress = (value: string) => {
    if (!smtp.from.trim() || smtp.from === smtp.transport.username) {
      smtp.from = value;
    }
    smtp.transport.username = value;
  };

  const TESTED = ['host', 'port', 'username', 'secure', 'ignoreCert'] as const;
  /** The server can only test what is saved (see above). */
  const unsaved = $derived(TESTED.some((key) => smtp.transport[key] !== saved.transport[key]));

  let sending = $state(false);
  let result = $state<{ ok: true; at: Date } | { ok: false; reason: string } | null>(null);
  const sendTest = async () => {
    if (sending) {
      return;
    }
    sending = true;
    try {
      await sendTestEmailAdmin({
        adminConfigSmtpDto: {
          enabled: smtp.enabled,
          transport: {
            host: smtp.transport.host,
            port: smtp.transport.port,
            secure: smtp.transport.secure,
            username: smtp.transport.username,
            // FL-67: never sent from the browser; the server uses the stored password for the
            // stored server and account.
            password: '',
            ignoreCert: smtp.transport.ignoreCert,
          },
          from: smtp.from,
          // FL-71: the test uses the reply-to address being edited, as a real email would
          replyTo: smtp.replyTo,
        },
      });
      result = { ok: true, at: new Date() };
      // FL-66: a successful delivery test saves the email settings only, against the draft's
      // revision; every other pending change stays in the draft for review.
      if (!disabled) {
        await settingsDraft.saveKeys(['notifications']);
      }
    } catch (error) {
      result = { ok: false, reason: getServerErrorMessage(error) ?? $t('frameleaf_notify_test_failed_unknown') };
    } finally {
      sending = false;
    }
  };

  const hasAccount = $derived(!!saved.transport.host.trim());
  const hero = $derived(
    saved.enabled
      ? {
          tone: 'good' as const,
          icon: mdiEmailCheckOutline,
          title: $t('frameleaf_notify_hero_on'),
          body: $t('frameleaf_notify_hero_on_body'),
        }
      : {
          tone: 'quiet' as const,
          icon: mdiEmailOffOutline,
          title: hasAccount ? $t('frameleaf_notify_hero_paused') : $t('frameleaf_notify_hero_off'),
          body: $t('frameleaf_notify_delivery_off_body'),
        },
  );
</script>

<KitPage>
  <Hero
    tone={hero.tone}
    icon={hero.icon}
    title={hero.title}
    body={hero.body}
    label={$t('frameleaf_notify_hero_label')}
  />

  <Section
    title={$t('frameleaf_notify_delivery_which')}
    description={$t('frameleaf_notify_delivery_which_description')}
  >
    <Tiles
      label={$t('frameleaf_notify_delivery_which')}
      value={provider}
      {disabled}
      options={[
        ...MAIL_PROVIDERS.map((item) => ({ id: item.id, name: item.name })),
        { id: 'other', name: $t('frameleaf_notify_delivery_other'), hint: $t('frameleaf_notify_delivery_other_hint') },
      ]}
      onChange={choose}
    />

    {#if provider}
      <Row
        label={$t('frameleaf_notify_delivery_send')}
        help={smtp.enabled ? $t('frameleaf_notify_delivery_send_on') : $t('frameleaf_notify_delivery_send_off')}
      >
        <Switch
          label={$t('frameleaf_notify_delivery_send')}
          checked={smtp.enabled}
          held={disabled}
          onChange={(value) => (settingsDraft.draft.notifications.smtp.enabled = value)}
        />
      </Row>
      {#if preset}
        <Row label={$t('frameleaf_notify_delivery_address')} help={$t('frameleaf_notify_delivery_address_help')}>
          <Field
            wide
            type="email"
            label={$t('frameleaf_notify_delivery_address')}
            value={smtp.transport.username}
            {disabled}
            onChange={setAddress}
          />
        </Row>
        <Row
          label={$t('frameleaf_notify_delivery_app_password')}
          help={$t('frameleaf_notify_delivery_app_password_help', { values: { provider: preset.name } })}
          link={{
            text: $t('frameleaf_notify_delivery_app_password_how', { values: { provider: preset.name } }),
            href: preset.guide,
            external: true,
          }}
        />
      {:else}
        <Row label={$t('frameleaf_notify_delivery_host')} help={$t('frameleaf_notify_delivery_host_help')}>
          <Field
            wide
            label={$t('frameleaf_notify_delivery_host')}
            value={smtp.transport.host}
            placeholder="smtp.example.com"
            {disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.transport.host = value)}
          />
        </Row>
        <Row label={$t('frameleaf_notify_delivery_account')} help={$t('frameleaf_notify_delivery_account_help')}>
          <Field
            wide
            label={$t('frameleaf_notify_delivery_account')}
            value={smtp.transport.username}
            {disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.transport.username = value)}
          />
        </Row>
        <Row
          label={$t('frameleaf_notify_delivery_secure')}
          help={smtp.transport.secure
            ? $t('frameleaf_notify_delivery_secure_on')
            : $t('frameleaf_notify_delivery_secure_off')}
        >
          <Switch
            label={$t('frameleaf_notify_delivery_secure')}
            checked={smtp.transport.secure}
            held={disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.transport.secure = value)}
          />
        </Row>
        <Row label={$t('frameleaf_notify_delivery_sender')} help={$t('frameleaf_notify_delivery_sender_help')}>
          <Field
            wide
            label={$t('frameleaf_notify_delivery_sender')}
            value={smtp.from}
            {disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.from = value)}
          />
        </Row>
      {/if}
      <!-- FL-67: the password is write-only and never part of this page's draft. -->
      <div class="credential">
        <CredentialRow
          name={ConfigCredential.SmtpPassword}
          {disabled}
          reason={disabled ? $t('frameleaf_credentials_config_file') : undefined}
        />
      </div>

      <Advanced>
        {#if preset}
          <Row label={$t('frameleaf_notify_delivery_sender')} help={$t('frameleaf_notify_delivery_sender_help')}>
            <Field
              wide
              label={$t('frameleaf_notify_delivery_sender')}
              value={smtp.from}
              {disabled}
              onChange={(value) => (settingsDraft.draft.notifications.smtp.from = value)}
            />
          </Row>
        {/if}
        <Row label={$t('frameleaf_notify_delivery_reply')} help={$t('frameleaf_notify_delivery_reply_help')}>
          <Field
            wide
            type="email"
            label={$t('frameleaf_notify_delivery_reply')}
            value={smtp.replyTo}
            {disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.replyTo = value)}
          />
        </Row>
        <Row
          label={$t('frameleaf_notify_delivery_port')}
          help={preset
            ? $t('frameleaf_notify_delivery_port_preset', { values: { provider: preset.name } })
            : $t('frameleaf_notify_delivery_port_help')}
        >
          <Amount
            label={$t('frameleaf_notify_delivery_port')}
            value={smtp.transport.port}
            unit=""
            min={1}
            max={65_535}
            disabled={disabled || !!preset}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.transport.port = value)}
          />
        </Row>
        <Row
          label={$t('frameleaf_notify_delivery_ignore_cert')}
          help={$t('frameleaf_notify_delivery_ignore_cert_help')}
        >
          <Switch
            label={$t('frameleaf_notify_delivery_ignore_cert')}
            checked={smtp.transport.ignoreCert}
            held={disabled}
            onChange={(value) => (settingsDraft.draft.notifications.smtp.transport.ignoreCert = value)}
          />
        </Row>
      </Advanced>
    {/if}
  </Section>

  {#if provider}
    <Section title={$t('frameleaf_notify_test_title')} description={$t('frameleaf_notify_test_description')}>
      {#snippet action()}
        <Button disabled={sending || unsaved || !smtp.enabled} onclick={sendTest}>
          {sending ? $t('frameleaf_notify_test_sending') : $t('frameleaf_notify_test_send')}
        </Button>
      {/snippet}
      {#if unsaved || !smtp.enabled}
        <p class="hint">
          {unsaved ? $t('frameleaf_notify_test_save_first') : $t('frameleaf_notify_test_turn_on_first')}
        </p>
      {/if}
      {#if result}
        <div class="result">
          {#if result.ok}
            <Notice
              title={$t('frameleaf_notify_test_sent', {
                values: {
                  email: authManager.user.email,
                  time: result.at.toLocaleTimeString($locale, { hour: 'numeric', minute: '2-digit' }),
                },
              })}
            >
              {$t('frameleaf_notify_test_sent_body')}
            </Notice>
          {:else}
            <Notice tone="warn" title={$t('frameleaf_notify_test_failed')}>
              {result.reason}
              {$t('frameleaf_notify_test_failed_body')}
            </Notice>
          {/if}
        </div>
      {/if}
    </Section>
  {/if}

  <Section title={$t('frameleaf_notify_wording_title')} description={$t('frameleaf_notify_wording_description')}>
    <div class="wording"><TemplateSettings /></div>
  </Section>

  <SettingActions keys={['notifications', 'templates']} {disabled} />
</KitPage>

<style>
  .credential {
    border-top: 1px solid var(--fl-border);
  }
  .hint {
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .result,
  .wording {
    padding-bottom: var(--fl-space-5);
  }
</style>
