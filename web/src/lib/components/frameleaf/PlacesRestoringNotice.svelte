<script lang="ts">
  /**
   * FL-402: after a restore, an update or a first start the server puts the place data (place names and
   * landmarks) back in the background. Until it is done, places look missing on Map, Places and Explore;
   * this quiet note says why, and goes away by itself once the server reports the places are back.
   */
  import { serverConfigManager } from '$lib/managers/server-config-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import { getServerConfig } from '@frameleaf/sdk';
  import { mdiMapMarkerRadiusOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /** How often to look again while the places are being put back. */
  const POLL_MS = 30_000;

  interface Props {
    /** `page` lines up with a page's content column; `map` sits inset over the top of the map. */
    layout?: 'page' | 'map';
  }

  let { layout = 'page' }: Props = $props();

  const initial = () => {
    try {
      return serverConfigManager.value.placesRestoring;
    } catch {
      return false;
    }
  };

  let restoring = $state(initial());

  const refresh = async () => {
    try {
      const config = await getServerConfig();
      restoring = config?.placesRestoring;
    } catch {
      // Keep what we last knew; the next look tries again.
    }
  };

  // The worker may raise the flag after the app loaded its server details, so look once on arrival.
  onMount(() => {
    void refresh();
  });

  $effect(() => {
    if (!restoring) {
      return;
    }
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  });
</script>

{#if restoring}
  <div class="places-restoring-wrap" class:map={layout === 'map'}>
    <div class="places-restoring" role="status" data-testid="places-restoring-notice">
      <span class="icon" aria-hidden="true"><Icon icon={mdiMapMarkerRadiusOutline} size="20" /></span>
      <p>{$t('frameleaf_places_restoring')}</p>
    </div>
  </div>
{/if}

<style>
  /* Lines up with the Explore and Places content column (max 1400px, 30px sides). */
  .places-restoring-wrap {
    width: 100%;
    max-width: 1400px;
    margin: 0 auto;
    padding: var(--fl-space-6) 30px 0;
    box-sizing: border-box;
  }
  .places-restoring-wrap.map {
    max-width: none;
    padding: var(--fl-space-3) var(--fl-space-3) 0;
  }
  .places-restoring {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) var(--fl-space-4);
    font-size: var(--fl-font-callout);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .icon {
    display: inline-flex;
    flex: none;
    color: var(--fl-muted);
  }
  p {
    margin: 0;
    line-height: 1.5;
  }
  @media (max-width: 700px) {
    /* With the page's own 8px, the 16px phone gutter, as the panels below use. */
    .places-restoring-wrap:not(.map) {
      padding: var(--fl-space-4) var(--fl-space-2) 0;
    }
  }
</style>
