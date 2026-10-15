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
   *
   * FL-379: Gmail and Microsoft can be connected by signing in instead (`MailSignInPanel`), with no
   * mail server or password at all. Signing in and disconnecting are the server's own steps, not
   * part of the draft: the server points email at the account and this page then follows the saved
   * settings. Gmail keeps its app password route beside it; Microsoft is sign-in only, and is only
   * offered when Frameleaf Cloud offers it (or to say why it cannot be used yet).
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
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import Tiles from '$lib/components/frameleaf/settings/kit/Tiles.svelte';
  import {
    MAIL_PROVIDERS,
    MICROSOFT_TILE,
    providerOf,
    signInProviderFor,
  } from '$lib/components/frameleaf/settings/notifications/mail-providers';
  import { MailSignInStore } from '$lib/components/frameleaf/settings/notifications/mail-sign-in.svelte';
  import MailSignInPanel from '$lib/components/frameleaf/settings/notifications/MailSignInPanel.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    ConfigCredential,
    MailConnectionStatus,
    MailTransportType,
    sendTestEmailAdmin,
    type MailDisconnectResponseDto,
  } from '@frameleaf/sdk';
  import { mdiEmailAlertOutline, mdiEmailCheckOutline, mdiEmailOffOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import TemplateSettings from './TemplateSettings.svelte';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const smtp = $derived(settingsDraft.draft.notifications.smtp);
  const saved = $derived(settingsDraft.baseline.notifications.smtp);

  /** What just happened, said once at the top of the page. */
  let said = $state('');
  /** Disconnecting could not remove Frameleaf at this provider; the person can, on this page of theirs. */
  let leftover = $state<{ who: string; href: string } | null>(null);

  const mail = new MailSignInStore(async (connection) => {
    // the server pointed email at the account; the page follows what is saved now
    await settingsDraft.refresh();
    leftover = null;
    said = $t('frameleaf_notify_signin_said_connected', {
      values: { who: signInProviderFor(connection.provider)?.who ?? '', email: connection.email },
    });
  });
  onMount(() => {
    void mail.load();
    return () => mail.stop();
  });

  /** The tile picked on this page; otherwise the provider is read back from the saved values. */
  let picked = $state<string>();
  /** Gmail only: "Use an app password instead" (true) or "Sign in with Google instead" (false), chosen here. */
  let passwordChosen = $state<boolean>();
  const detected = $derived(providerOf(smtp.transport));
  const provider = $derived(picked ?? detected);
  const signIn = $derived(signInProviderFor(provider));

  /** Sign-in is not on offer for a provider when a linked server's Frameleaf Cloud does not list it. */
  const notOffered = (id: 'gmail' | 'microsoft') => {
    const item = signInProviderFor(id);
    const state = mail.state;
    return (
      !!item &&
      !!state &&
      !state.unavailableReason &&
      !state.providers.includes(item.provider) &&
      state.connection?.provider !== id
    );
  };
  /** Gmail is saved with an app password: its mail server is what is saved, and no account is signed in. */
  const gmailSavedByPassword = $derived(
    (saved.transport.type ?? MailTransportType.Smtp) === MailTransportType.Smtp &&
      providerOf(saved.transport) === 'gmail',
  );
  const byPassword = $derived(
    provider === 'gmail' && (passwordChosen ?? (gmailSavedByPassword || notOffered('gmail'))),
  );
  /** The provider is used by signing in: no mail server, port or password. */
  const oneClick = $derived(signIn && !byPassword ? signIn : undefined);
  const preset = $derived(oneClick ? undefined : MAIL_PROVIDERS.find((item) => item.id === provider));
  const connection = $derived(oneClick && mail.connection?.provider === oneClick.provider ? mail.connection : null);
  const signedIn = $derived(connection?.status === MailConnectionStatus.Connected);
  /** The rows of a way of sending that is set up: a mail server's form, or a signed-in account. */
  const settled = $derived(!!provider && (!oneClick || signedIn));

  const tiles = $derived.by(() => {
    const presets = MAIL_PROVIDERS.map((item) => ({ id: item.id, name: item.name, hint: $t(item.hint) }));
    const microsoft =
      smtp.transport.type === MailTransportType.Microsoft || (!!mail.state && !notOffered('microsoft'))
        ? [{ id: MICROSOFT_TILE.id, name: MICROSOFT_TILE.name, hint: $t(MICROSOFT_TILE.hint) }]
        : [];
    return [
      ...presets.slice(0, 2),
      ...microsoft,
      ...presets.slice(2),
      { id: 'other', name: $t('frameleaf_notify_delivery_other'), hint: $t('frameleaf_notify_delivery_other_hint') },
    ];
  });

  const usePreset = (id: string) => {
    const next = MAIL_PROVIDERS.find((item) => item.id === id);
    smtp.transport.type = MailTransportType.Smtp;
    if (next) {
      smtp.transport.host = next.host;
      smtp.transport.port = next.port;
      smtp.transport.secure = next.secure;
    }
  };
  const choose = (id: string) => {
    picked = id;
    passwordChosen = undefined;
    const item = signInProviderFor(id);
    if (item && !(id === 'gmail' && (gmailSavedByPassword || notOffered('gmail')))) {
      // Signing in is the server's step, so nothing is written to the draft, except to point email
      // back at an account that is already signed in.
      if (mail.connection?.provider === item.provider) {
        smtp.transport.type = item.transport;
      }
      return;
    }
    usePreset(id);
  };
  const usePassword = () => {
    passwordChosen = true;
    usePreset('gmail');
  };
  const useSignIn = () => {
    passwordChosen = false;
    // back to what is saved: the app password form's mail server is not wanted any more
    smtp.transport.type = saved.transport.type;
    smtp.transport.host = saved.transport.host;
    smtp.transport.port = saved.transport.port;
    smtp.transport.secure = saved.transport.secure;
  };
  /** With a provider, the email address is the account name and, until a sender is typed, the sender. */
  const setAddress = (value: string) => {
    if (!smtp.from.trim() || smtp.from === smtp.transport.username) {
      smtp.from = value;
    }
    smtp.transport.username = value;
  };

  const disconnected = async (result: MailDisconnectResponseDto) => {
    const item = signInProviderFor(result.provider);
    // the provider stays chosen, back at "Sign in with …"
    picked = item?.id;
    passwordChosen = undefined;
    await settingsDraft.refresh();
    leftover = !result.revoked && item?.permissions ? { who: item.who, href: item.permissions } : null;
    said = $t('frameleaf_notify_signin_said_disconnected', { values: { who: item?.who ?? '' } });
  };

  const TESTED = ['host', 'port', 'username', 'secure', 'ignoreCert'] as const;
  /** The server can only test what is saved (see above). A signed-in account has nothing to save first. */
  const unsaved = $derived(!oneClick && TESTED.some((key) => smtp.transport[key] !== saved.transport[key]));

  let sending = $state(false);
  let result = $state<{ ok: true; at: Date } | { ok: false; reason: string; account: boolean } | null>(null);
  const sendTest = async () => {
    if (sending) {
      return;
    }
    sending = true;
    const account = oneClick;
    const testedSettings = JSON.stringify(smtp);
    try {
      await sendTestEmailAdmin({
        adminConfigSmtpDto: {
          enabled: smtp.enabled,
          transport: {
            type: account ? account.transport : MailTransportType.Smtp,
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
      // revision; every other pending change stays in the draft for review. A signed-in account
      // was saved by the server when it was connected.
      // Edits made while the test ran still need their own review and save.
      if (!disabled && !account && testedSettings === JSON.stringify(smtp)) {
        await settingsDraft.saveKeys(['notifications']);
      }
    } catch (error) {
      result = {
        ok: false,
        reason: getServerErrorMessage(error) ?? $t('frameleaf_notify_test_failed_unknown'),
        account: !!account,
      };
      if (account) {
        // a refused renewal is found by sending: show "Sign in again" if that is what happened
        await mail.load();
      }
    } finally {
      sending = false;
    }
  };

  const hasAccount = $derived(!!saved.transport.host.trim());
  /** The account email is saved to go through, when it goes through a signed-in account. */
  const savedSignIn = $derived(signInProviderFor(providerOf(saved.transport)));
  const savedConnection = $derived(
    savedSignIn &&
      (saved.transport.type ?? MailTransportType.Smtp) !== MailTransportType.Smtp &&
      mail.connection?.provider === savedSignIn.provider
      ? mail.connection
      : null,
  );
  const hero = $derived.by(() => {
    if (!saved.enabled) {
      return {
        tone: 'quiet' as const,
        icon: mdiEmailOffOutline,
        title: hasAccount || savedConnection ? $t('frameleaf_notify_hero_paused') : $t('frameleaf_notify_hero_off'),
        body: $t('frameleaf_notify_delivery_off_body'),
      };
    }
    if (savedSignIn && savedConnection?.status === MailConnectionStatus.NeedsSignIn) {
      return {
        tone: 'warn' as const,
        icon: mdiEmailAlertOutline,
        title: $t('frameleaf_notify_hero_stopped'),
        body: $t('frameleaf_notify_hero_stopped_signin', { values: { who: savedSignIn.who } }),
      };
    }
    return {
      tone: 'good' as const,
      icon: mdiEmailCheckOutline,
      title: $t('frameleaf_notify_hero_on'),
      body: savedConnection
        ? $t('frameleaf_notify_hero_on_from', { values: { email: savedConnection.email } })
        : $t('frameleaf_notify_hero_on_body'),
    };
  });
</script>

<KitPage>
  <Said message={said} onDismiss={() => (said = '')} />

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
      options={tiles}
      onChange={choose}
    />

    {#if leftover}
      <div class="notice">
        <Notice title={$t('frameleaf_notify_signin_leftover_title', { values: { who: leftover.who } })}>
          {#snippet action()}
            <TextLink href={leftover?.href} external>
              {$t('frameleaf_notify_signin_leftover_link', { values: { who: leftover?.who ?? '' } })}
            </TextLink>
          {/snippet}
          {$t('frameleaf_notify_signin_leftover_body', { values: { who: leftover.who } })}
        </Notice>
      </div>
    {/if}

    {#if oneClick}
      <MailSignInPanel signIn={oneClick} store={mail} {disabled} onDisconnected={disconnected} />
      {#if oneClick.id === 'gmail' && !signedIn && !disabled}
        <p class="hint">
          <TextLink onclick={usePassword}>{$t('frameleaf_notify_signin_use_password')}</TextLink>
        </p>
      {/if}
    {/if}

    {#if settled}
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
    {/if}
    {#if provider && !oneClick}
      {#if preset}
        {#if signIn && !notOffered('gmail') && !disabled}
          <p class="hint is-row">
            <TextLink onclick={useSignIn}
              >{$t('frameleaf_notify_signin_use_signin', { values: { who: signIn.who } })}</TextLink
            >{$t('frameleaf_notify_signin_use_signin_tail')}
          </p>
        {/if}
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
    {/if}

    {#if settled}
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
        {#if oneClick}
          <!-- FL-379: a signed-in account has no mail server, port, password or certificate to set. -->
          <Row label={$t('frameleaf_notify_delivery_type')} help={$t('frameleaf_notify_signin_how_sent_help')}>
            <span class="value">{$t('frameleaf_notify_signin_how_sent', { values: { who: oneClick.who } })}</span>
          </Row>
        {:else}
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
        {/if}
      </Advanced>
    {/if}
  </Section>

  {#if settled}
    <Section
      title={$t('frameleaf_notify_test_title')}
      description={oneClick ? $t('frameleaf_notify_signin_test_description') : $t('frameleaf_notify_test_description')}
    >
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
              {result.account ? '' : $t('frameleaf_notify_test_failed_body')}
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
  .notice {
    padding-bottom: var(--fl-space-4);
  }
  .hint {
    margin: 0;
    padding-bottom: var(--fl-space-5);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .hint.is-row {
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .value {
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .result,
  .wording {
    padding-bottom: var(--fl-space-5);
  }
</style>
