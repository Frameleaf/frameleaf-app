<script lang="ts">
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import ServerAboutModal from '$lib/modals/ServerAboutModal.svelte';
  import { Route } from '$lib/route';
  import { websocketStore } from '$lib/stores/websocket';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import UtilitiesMenu from '../../../routes/(user)/utilities/UtilitiesMenu.svelte';
  import {
    getAboutInfo,
    getStorage,
    getVersionHistory,
    type ServerAboutResponseDto,
    type ServerStorageResponseDto,
  } from '@immich/sdk';
  import { modalManager, Theme as UiTheme, themeManager } from '@immich/ui';
  import { onMount, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import Theme from './Theme.svelte';

  const { connected } = websocketStore;

  let storage = $state<ServerStorageResponseDto>();
  let about = $state<ServerAboutResponseDto>();
  let loading = $state(true);
  let openingAbout = $state(false);
  let historyError = $state(false);
  let mounted = false;
  const bytes = (value: number) => getByteUnitString(value, $locale);

  const refresh = async () => {
    loading = true;
    storage = undefined;
    about = undefined;
    const [storageResult, aboutResult] = await Promise.allSettled([getStorage(), getAboutInfo()]);
    if (!mounted) {
      return;
    }
    storage = storageResult.status === 'fulfilled' ? storageResult.value : undefined;
    about = aboutResult.status === 'fulfilled' ? aboutResult.value : undefined;
    loading = false;
  };

  const openAbout = async (event: MouseEvent) => {
    const trigger = event.currentTarget;
    if (!about || openingAbout || !(trigger instanceof HTMLButtonElement)) {
      return;
    }
    const info = about;
    openingAbout = true;
    historyError = false;
    try {
      const versions = await getVersionHistory();
      if (mounted) {
        await modalManager.show(ServerAboutModal, { info, versions });
      }
    } catch {
      if (mounted) {
        historyError = true;
      }
    } finally {
      if (mounted) {
        openingAbout = false;
        await tick();
        if (mounted && trigger.isConnected) {
          trigger.focus();
        }
      }
    }
  };

  onMount(() => {
    mounted = true;
    void refresh();
    return () => {
      mounted = false;
    };
  });
</script>

<Theme theme={themeManager.value === UiTheme.Dark ? 'dark' : 'light'}>
  <section class="overview" aria-labelledby="settings-overview-title">
    <header>
      <div>
        <h2 id="settings-overview-title">{$t('frameleaf_settings_overview.title')}</h2>
        <p>{$t('frameleaf_settings_overview.description')}</p>
        <p role="status">{$connected ? $t('server_online') : $t('server_offline')}</p>
      </div>
      <button type="button" disabled={loading} onclick={refresh}>
        {loading ? $t('loading') : !storage || !about ? $t('retry') : $t('refresh')}
      </button>
    </header>
    <div class="metrics" aria-busy={loading}>
      <section class="metric" aria-labelledby="account-storage-title">
        <h3 id="account-storage-title">{$t('frameleaf_settings_overview.account_storage')}</h3>
        {#if authManager.user.quotaUsageInBytes === null}
          <strong>{$t('unknown')}</strong>
        {:else}
          <strong>{bytes(authManager.user.quotaUsageInBytes)}</strong>
          <p>
            {authManager.user.quotaSizeInBytes === null
              ? $t('frameleaf_settings_overview.no_quota')
              : $t('frameleaf_settings_overview.used_of', {
                  values: {
                    used: bytes(authManager.user.quotaUsageInBytes),
                    total: bytes(authManager.user.quotaSizeInBytes),
                  },
                })}
          </p>
        {/if}
        <p class="scope">{$t('frameleaf_settings_overview.account_scope')}</p>
      </section>
      <section class="metric" aria-labelledby="filesystem-title">
        <h3 id="filesystem-title">{$t('frameleaf_settings_overview.filesystem')}</h3>
        {#if loading}
          <p role="status">{$t('loading')}</p>
        {:else if storage}
          <strong>{bytes(storage.diskUseRaw)}</strong>
          <p>
            {$t('frameleaf_settings_overview.used_of', {
              values: { used: bytes(storage.diskUseRaw), total: bytes(storage.diskSizeRaw) },
            })}
          </p>
        {:else}
          <p role="status">{$t('frameleaf_settings_overview.unavailable')}</p>
        {/if}
        <p class="scope">{$t('frameleaf_settings_overview.filesystem_scope')}</p>
      </section>
      <section class="metric" aria-labelledby="server-version-title">
        <h3 id="server-version-title">{$t('version')}</h3>
        {#if loading}
          <p role="status">{$t('loading')}</p>
        {:else if about}
          <strong>{about.version}</strong>
          <p class="build">
            {$t('build')}: {about.build || about.sourceCommit || $t('frameleaf_settings_overview.build_unknown')}
          </p>
          <button type="button" onclick={openAbout} disabled={openingAbout}>{$t('about')}</button>
          {#if historyError}<p role="status">{$t('frameleaf_settings_overview.history_error')}</p>{/if}
        {:else}
          <p role="status">{$t('frameleaf_settings_overview.unavailable')}</p>
        {/if}
      </section>
    </div>
    <p class="scope">{$t('frameleaf_settings_overview.snapshot')}</p>
    <section aria-labelledby="settings-utilities-title">
      <h2 id="settings-utilities-title">{$t('utilities')}</h2>
      <p>{$t('frameleaf_settings_overview.utilities_description')}</p>
      <div class="utilities"><UtilitiesMenu /></div>
    </section>
    {#if featureFlagsManager.value.trash}
      <a class="trash" href={Route.trash()}>
        <span>{$t('trash')}</span>
        <span class="scope">{$t('frameleaf_settings_overview.trash_description')}</span>
      </a>
    {/if}
  </section>
</Theme>

<style>
  .overview {
    padding: 20px;
    margin-bottom: 24px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
  }
  header {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 18px;
    font-weight: 600;
    margin-bottom: 6px;
  }
  h3 {
    font-size: 13px;
    font-weight: 600;
    margin-bottom: 12px;
  }
  p {
    font-size: 13px;
    line-height: 1.6;
  }
  .scope {
    color: var(--fl-muted);
    font-size: 12px;
    margin-top: 8px;
  }
  .metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
  }
  .metric {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    padding: 16px;
  }
  strong {
    display: block;
    font-size: 22px;
    font-weight: 600;
  }
  .build {
    overflow-wrap: anywhere;
  }
  button {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 8px 14px;
    background: var(--fl-raised);
    font-size: 13px;
  }
  button:disabled {
    opacity: 0.6;
  }
  .overview > section {
    margin-top: 24px;
  }
  .utilities {
    margin-top: 16px;
  }
  .utilities :global(> div) {
    background: var(--fl-panel);
    border-color: var(--fl-border);
    border-radius: var(--fl-panel-radius);
    color: var(--fl-text);
  }
  .utilities :global(a:hover),
  .utilities :global(button:hover) {
    background: var(--fl-raised);
  }
  .trash {
    display: flex;
    flex-direction: column;
    margin-top: 20px;
    padding: 16px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
  }
  .trash:hover {
    background: var(--fl-raised);
  }
  @media (max-width: 700px) {
    .metrics {
      grid-template-columns: 1fr;
    }
    .overview {
      padding: 12px;
    }
  }
</style>
