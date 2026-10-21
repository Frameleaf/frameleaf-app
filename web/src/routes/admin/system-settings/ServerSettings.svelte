<script lang="ts">
  /**
   * Server & updates › Server name & welcome (FL-368, after the approved prototype
   * `settings-v2/server/server-updates.jsx` `Identity`): the name, the welcome message and the time
   * zone in one group, local network discovery in plain words, and beside them "What people will
   * see" (ADMIN-P7), a sample of the phone app's server list and the sign-in page that follows what
   * is typed. "People can find each other when sharing" has moved to People & sharing.
   *
   * FL-426: the time zone is chosen here (`server.timeZone`). It starts as "Same as this computer",
   * the zone of the computer Frameleaf runs on, which is how every server kept time before. Under
   * Advanced, "Welcome message is" switches the message between plain text (the default, shown
   * exactly as typed) and web formatting, which is cleaned before it is shown. The sample and the
   * sign-in page draw the message with the same `WelcomeMessage`.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { goto } from '$app/navigation';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Field from '$lib/components/frameleaf/settings/kit/Field.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import TextArea from '$lib/components/frameleaf/settings/kit/TextArea.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import WelcomeMessage from '$lib/components/frameleaf/WelcomeMessage.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { requireSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { timeZoneChoices, timeZoneLabel } from '$lib/frameleaf/time-zones';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAboutInfo, LoginPageMessageFormat } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiServerOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const disabled = $derived(featureFlagsManager.value.configFile);
  const settingsDraft = requireSystemConfigDraft();
  const server = $derived(settingsDraft.draft.server);
  // the server always returns the help group (FL-488); the SDK marks it optional because it has a default
  const help = $derived(settingsDraft.draft.help!);

  /** The zone of the computer Frameleaf runs on, which "Same as this computer" means. */
  let computerZone = $state<string>();
  onMount(() => {
    void getAboutInfo()
      .then((about) => (computerZone = about.systemTimeZone))
      .catch(() => {
        // Without it the choice still reads "Same as this computer".
      });
  });
  const labelOf = (zone: string) =>
    timeZoneLabel(zone, DateTime.now().setZone(zone).toFormat("yyyy-MM-dd'T'HH:mm"), $locale).label;
  /** Every zone, west to east (worked out once per language: there are several hundred). */
  const choices = $derived(
    timeZoneChoices({ locale: $locale }).map((choice) => ({ value: choice.value, label: choice.label })),
  );
  const zoneOptions = $derived.by(() => {
    const chosen = server.timeZone;
    // a saved zone the list leaves out (an offset such as Etc/GMT+5) still shows as chosen
    const saved =
      chosen && choices.every((choice) => choice.value !== chosen) ? [{ value: chosen, label: chosen }] : [];
    return [
      {
        value: '',
        label: computerZone
          ? $t('frameleaf_server_identity_zone_computer_named', { values: { zone: labelOf(computerZone) } })
          : $t('frameleaf_server_identity_zone_computer'),
      },
      ...saved,
      ...choices,
    ];
  });

  const formats = $derived([
    { value: LoginPageMessageFormat.Plain, label: $t('frameleaf_server_identity_format_plain') },
    { value: LoginPageMessageFormat.Html, label: $t('frameleaf_server_identity_format_html') },
  ]);
</script>

<KitPage>
  <div class="columns">
    <div class="stack">
      <Section title={$t('frameleaf_server_identity_name_section')}>
        <Row
          label={$t('frameleaf_server_identity_name')}
          help={server.name.trim()
            ? $t('frameleaf_server_identity_name_help')
            : `${$t('frameleaf_server_identity_name_help')} ${$t('frameleaf_server_identity_name_empty')}`}
        >
          <Field
            wide
            label={$t('frameleaf_server_identity_name')}
            value={server.name}
            placeholder={$t('frameleaf_server_identity_name_placeholder')}
            {disabled}
            onChange={(value) => (settingsDraft.draft.server.name = value)}
          />
        </Row>
        <Row label={$t('frameleaf_server_identity_welcome')} help={$t('frameleaf_server_identity_welcome_help')}>
          <div class="area">
            <TextArea
              label={$t('frameleaf_server_identity_welcome')}
              rows={3}
              value={server.loginPageMessage}
              placeholder={$t('frameleaf_server_identity_welcome_placeholder')}
              {disabled}
              onChange={(value) => (settingsDraft.draft.server.loginPageMessage = value)}
            />
          </div>
        </Row>
        <Row label={$t('frameleaf_server_identity_zone')} help={$t('frameleaf_server_identity_zone_help')}>
          <div class="zone">
            <Select
              label={$t('frameleaf_server_identity_zone')}
              value={server.timeZone ?? ''}
              options={zoneOptions}
              {disabled}
              onChange={(value) => (settingsDraft.draft.server.timeZone = value)}
            />
          </div>
        </Row>
        <Advanced>
          <Row label={$t('frameleaf_server_identity_format')} help={$t('frameleaf_server_identity_format_help')}>
            <SegmentedControl
              label={$t('frameleaf_server_identity_format')}
              value={server.loginPageMessageFormat ?? 'plain'}
              options={formats}
              {disabled}
              onChange={(value) =>
                (settingsDraft.draft.server.loginPageMessageFormat = value as LoginPageMessageFormat)}
            />
          </Row>
        </Advanced>
      </Section>

      <Section title={$t('frameleaf_server_identity_finding')}>
        <Row
          label={$t('frameleaf_server_identity_lan')}
          help={server.lanDiscovery ? $t('frameleaf_server_identity_lan_on') : $t('frameleaf_server_identity_lan_off')}
        >
          <Switch
            label={$t('frameleaf_server_identity_lan')}
            checked={server.lanDiscovery}
            held={disabled}
            onChange={(value) => (settingsDraft.draft.server.lanDiscovery = value)}
          />
        </Row>
        <Row label={$t('frameleaf_sharing_find_label')} help={$t('frameleaf_server_identity_find_moved')}>
          <Button onclick={() => goto(commandCenterUrl('sharing'))}>{$t('frameleaf_server_identity_find_open')}</Button>
        </Row>
      </Section>

      <!-- FL-489: Ask Frameleaf in the help panel; the help articles are always there. -->
      <Section title={$t('frameleaf_help_panel_open')}>
        <Row label={$t('frameleaf_help_ask_setting')} help={$t('frameleaf_help_ask_setting_description')}>
          <Switch
            label={$t('frameleaf_help_ask_setting')}
            checked={help.askEnabled}
            held={disabled}
            onChange={(value) => (help.askEnabled = value)}
          />
        </Row>
      </Section>
    </div>

    <aside class="preview fl-continuous-corners" aria-label={$t('frameleaf_server_identity_preview')}>
      <h2>{$t('frameleaf_server_identity_preview')}</h2>
      <div>
        <p class="hint">{$t('frameleaf_server_identity_preview_phone')}</p>
        <div class="sample sample-row">
          <Icon icon={mdiServerOutline} size="22" aria-hidden />
          <div>
            <strong>{server.name.trim() || $t('frameleaf_server_identity_preview_unnamed')}</strong>
            <small>{$t('frameleaf_server_identity_preview_wifi')}</small>
          </div>
        </div>
      </div>
      <div>
        <p class="hint">{$t('frameleaf_server_identity_preview_signin')}</p>
        <div class="sample sample-signin">
          <strong>{$t('frameleaf_auth_welcome_title')}</strong>
          {#if server.loginPageMessage.trim()}
            <div class="message">
              <WelcomeMessage message={server.loginPageMessage} format={server.loginPageMessageFormat ?? 'plain'} />
            </div>
          {:else}
            <p class="hint">{$t('frameleaf_server_identity_preview_no_message')}</p>
          {/if}
          <span>{$t('frameleaf_auth_email')}</span>
          <span>{$t('frameleaf_auth_password')}</span>
          <span class="is-button">{$t('frameleaf_auth_sign_in')}</span>
        </div>
      </div>
      <p class="hint">{$t('frameleaf_server_identity_preview_note')}</p>
    </aside>
  </div>

  <SettingActions keys={['server', 'help']} {disabled} />
</KitPage>

<style>
  /* The settings beside a sample of what they change (backup-v2.css `.bk2-columns`, `.bk2-preview`). */
  .columns {
    display: grid;
    grid-template-columns: minmax(0, 1.35fr) minmax(280px, 0.65fr);
    align-items: start;
    gap: var(--fl-space-6);
  }
  .stack {
    display: grid;
    gap: var(--fl-space-6);
    min-width: 0;
  }
  .area {
    width: 380px;
    max-width: 100%;
  }
  .area :global(.kit-area) {
    margin-bottom: 0;
  }
  /* As wide as the other fields: several hundred places would otherwise widen it to the longest name. */
  .zone {
    width: 380px;
    max-width: 100%;
  }
  .zone :global(.kit-select) {
    width: 100%;
    text-overflow: ellipsis;
  }
  .preview {
    display: grid;
    gap: var(--fl-space-4);
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .preview {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .preview h2 {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  /* Small samples of what other people will see (settings-v2/server.css `.srv-sample-*`). */
  .sample {
    margin-top: var(--fl-space-2);
    padding: var(--fl-space-4);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .sample strong {
    display: block;
    font-size: var(--fl-font-callout);
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .sample-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    gap: var(--fl-space-3);
  }
  .sample-row :global(svg) {
    color: var(--fl-accent);
  }
  .sample-row small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .sample-signin {
    display: grid;
    gap: var(--fl-space-2);
  }
  .sample-signin p,
  .sample-signin .message {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .sample-signin > span {
    display: flex;
    align-items: center;
    min-height: 36px;
    padding: 0 var(--fl-space-3);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .sample-signin > span.is-button {
    justify-content: center;
    color: var(--fl-accent-text);
    font-weight: 600;
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  @container kit (max-width: 860px) {
    .columns {
      grid-template-columns: 1fr;
    }
  }
  @container kit (max-width: 620px) {
    .stack {
      gap: var(--fl-space-4);
    }
    .preview {
      padding: var(--fl-space-4);
    }
  }
</style>
