<script lang="ts">
  /**
   * Mobile applications and Obtainium setup (FL-82), ported from `ApplicationSetup` in the design
   * template's `UtilitiesManager.jsx`: the Utilities pages `/utilities/downloads` and
   * `/utilities/obtainium`, and the same content in onboarding.
   *
   * Downloads come only from this server's configured signed release destinations. With none
   * configured the page says no signed release is available and every download control stays
   * disabled; it never falls back to another product's stores or releases. Obtainium gets a
   * configuration generated and validated here, with download-only access, opened directly in the
   * Obtainium app.
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    ANDROID_ARCHITECTURES,
    appDownload,
    obtainiumConfig,
    obtainiumProblems,
    type AndroidArchitecture,
    type AppPlatform,
  } from '$lib/frameleaf/app-releases';
  import AboutDialog from '$lib/components/frameleaf/AboutDialog.svelte';
  import { Route } from '$lib/route';
  import { handleCreateApiKey } from '$lib/services/api-key.service';
  import { userInteraction } from '$lib/stores/user.svelte';
  import { copyToClipboard } from '$lib/utils';
  import {
    getAboutInfo,
    getAppReleases,
    getVersionHistory,
    Permission,
    type ServerAppReleasesResponseDto,
  } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import { mdiDevices } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let {
    tool,
    onLeave,
  }: {
    tool: 'downloads' | 'obtainium';
    /** Called before leaving for another page or dialog. */ onLeave?: () => void;
  } = $props();

  let releases = $state<ServerAppReleasesResponseDto | null>(null);
  let platform = $state<AppPlatform>('Android');
  let architecture = $state<AndroidArchitecture>('Automatic');
  let step = $state(0);
  let serverUrl = $state(typeof location === 'undefined' ? '' : location.origin);
  let apiKey = $state('');
  let notice = $state('');

  onMount(async () => {
    try {
      releases = await getAppReleases();
    } catch {
      // without an answer nothing is offered: the page stays in its unavailable state
      releases = null;
    }
  });

  const obtainium = $derived(tool === 'obtainium');
  const download = $derived(appDownload(releases, obtainium ? 'Android' : platform, architecture));
  const appId = $derived(releases?.android.available ? (releases.android.appId ?? '') : '');
  const configInput = $derived({ serverUrl, apiKey, architecture, appId });
  const configProblems = $derived(obtainium && download.available ? obtainiumProblems(configInput) : []);
  const config = $derived(
    obtainium && download.available && configProblems.length === 0 ? obtainiumConfig(configInput) : null,
  );

  const steps = $derived(
    obtainium
      ? ['setup_release_service', 'setup_access', 'setup_architecture', 'setup_import']
      : ['setup_sign_in', 'setup_grant', 'setup_backup', 'setup_disable_previous'],
  );

  const architectureLabel = (value: AndroidArchitecture) =>
    value === 'Automatic'
      ? $t('frameleaf_apps.automatic')
      : value === 'Universal'
        ? $t('frameleaf_apps.universal')
        : value;

  const createAccess = async () => {
    const response = await handleCreateApiKey({
      name: $t('frameleaf_apps.access_key_name'),
      permissions: [Permission.ServerApkLinks],
    });
    if (response) {
      apiKey = response.secret;
      notice = $t('frameleaf_apps.access_created');
    }
  };

  const copyConfig = async () => {
    if (!config) {
      return;
    }

    await copyToClipboard(JSON.stringify(config.app, null, 2));
    notice = $t('frameleaf_apps.config_copied');
  };

  const manageAccess = async () => {
    onLeave?.();
    await goto(Route.userSettings());
  };

  const releaseInformation = async () => {
    // in onboarding the release notes open over the page, not behind its dialog
    onLeave?.();
    const [info, versions] = await Promise.all([
      userInteraction.aboutInfo ?? getAboutInfo(),
      userInteraction.versions ?? getVersionHistory(),
    ]);
    userInteraction.aboutInfo = info;
    userInteraction.versions = versions;
    await modalManager.show(AboutDialog, { info, versions });
  };
</script>

<div class="setup">
  <div class="grid">
    <section>
      <Icon icon={mdiDevices} size="35" aria-hidden={true} />
      <h3>{obtainium ? $t('frameleaf_apps.title_obtainium') : $t('frameleaf_apps.title_downloads')}</h3>
      <p>{$t('frameleaf_apps.lede')}</p>
      <label>
        {$t('frameleaf_apps.platform')}
        <select bind:value={platform}>
          <option value="Android">Android</option>
          {#if !obtainium}<option value="iOS">iOS</option>{/if}
        </select>
      </label>
      {#if platform === 'Android'}
        <label>
          {$t('frameleaf_apps.architecture')}
          <select bind:value={architecture}>
            {#each ANDROID_ARCHITECTURES as value (value)}
              <option {value}>{architectureLabel(value)}</option>
            {/each}
          </select>
        </label>
      {/if}

      {#if obtainium && download.available}
        <label>
          {$t('frameleaf_apps.server_url')}
          <input bind:value={serverUrl} autocomplete="off" />
        </label>
        <label>
          {$t('frameleaf_apps.access_key')}
          <input type="password" bind:value={apiKey} autocomplete="off" />
        </label>
        <div><Button onclick={() => void createAccess()}>{$t('frameleaf_apps.create_access')}</Button></div>
        {#if apiKey && configProblems.length > 0}<p class="problem">{configProblems[0]}</p>{/if}
      {/if}

      {#if !download.available}
        <p class="policy" role="status">{$t('frameleaf_apps.unavailable')}</p>
      {:else if download.fingerprint}
        <p class="fingerprint">
          {$t('frameleaf_apps.fingerprint', { values: { fingerprint: download.fingerprint } })}
        </p>
      {/if}
      {#if notice}<p role="status">{notice}</p>{/if}

      <div class="actions">
        {#if obtainium}
          {#if config}
            <a class="button primary" href={config.link}>{$t('frameleaf_apps.open_obtainium')}</a>
            <Button onclick={() => void copyConfig()}>{$t('frameleaf_apps.copy_config')}</Button>
          {:else}
            <Button disabled>{$t('frameleaf_apps.open_obtainium')}</Button>
          {/if}
        {:else if download.available}
          <a class="button primary" href={download.href} target="_blank" rel="noreferrer">
            {platform === 'iOS' ? $t('frameleaf_apps.open_app_store') : $t('frameleaf_apps.download_android')}
          </a>
        {:else}
          <Button disabled>
            {platform === 'iOS' ? $t('frameleaf_apps.open_app_store') : $t('frameleaf_apps.download_android')}
          </Button>
        {/if}
      </div>
      {#if obtainium}<small>{$t('frameleaf_apps.obtainium_attribution')}</small>{/if}
    </section>

    <section>
      <h3>{obtainium ? $t('frameleaf_apps.update_access') : $t('frameleaf_apps.checklist_title')}</h3>
      <ol class="checklist">
        {#each steps as key, index (key)}
          <li>
            <input
              type="checkbox"
              aria-label={$t(`frameleaf_apps.${key}` as Translations)}
              checked={step > index}
              onchange={() => (step = step > index ? index : index + 1)}
            />
            {$t(`frameleaf_apps.${key}` as Translations)}
          </li>
        {/each}
      </ol>
      <div class="actions">
        <Button onclick={() => void manageAccess()}>{$t('frameleaf_apps.manage_access')}</Button>
        <Button onclick={() => void releaseInformation()}>{$t('frameleaf_apps.release_information')}</Button>
      </div>
    </section>
  </div>
  <p class="policy">{$t('frameleaf_apps.policy')}</p>
</div>

<style>
  .setup {
    color: var(--fl-text);
    font-size: var(--fl-font-size);
  }
  .grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
  }
  section {
    display: grid;
    align-content: start;
    gap: 0.75rem;
    padding: 1.5rem;
    border: 1px solid var(--fl-border);
    background: var(--fl-panel);
    border-radius: var(--fl-radius-card);
  }
  h3 {
    font-size: 1rem;
    margin: 0;
  }
  p,
  small {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.6;
  }
  label {
    display: grid;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
  }
  input:not([type='checkbox']),
  select {
    width: 100%;
    min-height: 2.125rem;
    padding: 0.5rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    font: inherit;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
  .button {
    display: inline-flex;
    align-items: center;
    padding: 0.4375rem 0.6875rem;
    border-radius: var(--fl-radius-control);
    text-decoration: none;
  }
  .button.primary {
    font-weight: 600;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border: 1px solid var(--fl-accent);
  }
  .policy {
    background: var(--fl-panel);
    border-left: 2px solid var(--fl-muted);
    padding: 0.8rem 1rem;
    margin: 1rem 0 0;
  }
  section .policy {
    margin: 0;
  }
  .problem {
    color: var(--fl-warning-text);
  }
  .fingerprint {
    overflow-wrap: anywhere;
    font-family: ui-monospace, monospace;
  }
  .checklist {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .checklist li {
    display: flex;
    align-items: flex-start;
    gap: 0.625rem;
    font-size: var(--fl-font-small);
    line-height: 1.7;
    padding: 0.75rem 0;
    border-bottom: 1px solid var(--fl-border);
  }
  @media (max-width: 720px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
</style>
