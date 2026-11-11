<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumCleanupArt from '$lib/components/frameleaf/album-cleanup/AlbumCleanupArt.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    buildPlan,
    CLEANUP_BANNER_MIN_SUGGESTIONS,
    messyAlbumNames,
    type CleanupPlan,
  } from '$lib/frameleaf/album-cleanup';
  import '$lib/frameleaf/album-cleanup.css';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { getAlbumCleanupSnapshot, getAlbumCleanupStatus, updateMyPreferences } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiAutoFix } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * The Magic Albums banner at the top of Albums (FL-1300, prototype `AlbumCleanupBanner`). It says nothing until
   * the scan has found enough to be worth mentioning, and never again after "Not now".
   */
  const SCAN_POLL_MS = 5000;
  const SCAN_POLLS = 12;

  let plan = $state<CleanupPlan>();
  let names = $state<string[]>([]);
  let covers = $state<string[]>([]);
  let dismissing = $state(false);

  const load = async (signal: AbortSignal) => {
    let status = await getAlbumCleanupStatus();
    // FL-1404: a scan from before the albums changed is not the answer either; wait for the one under way.
    for (let poll = 0; (!status.ready || status.checking) && poll < SCAN_POLLS && !signal.aborted; poll++) {
      await new Promise((resolve) => setTimeout(resolve, SCAN_POLL_MS));
      status = await getAlbumCleanupStatus();
    }
    // Still looking after the last poll: the count on record is the old one, so say nothing this visit.
    if (signal.aborted || status.checking || status.suggestionCount < CLEANUP_BANNER_MIN_SUGGESTIONS) {
      return;
    }
    const { facts } = await getAlbumCleanupSnapshot();
    if (!facts || signal.aborted) {
      return;
    }
    plan = buildPlan(facts);
    names = messyAlbumNames(facts);
    covers = facts.albums.flatMap(({ coverAssetId }) => coverAssetId ?? []);
  };

  onMount(() => {
    if (!authManager.authenticated || authManager.preferences.albums.cleanupBannerDismissed) {
      return;
    }
    const controller = new AbortController();
    // Quietly: a banner that can't be worked out is just not shown.
    void load(controller.signal).catch(() => undefined);
    return () => controller.abort();
  });

  const dismiss = async () => {
    dismissing = true;
    try {
      const preferences = await updateMyPreferences({
        userPreferencesUpdateDto: { albums: { cleanupBannerDismissed: true } },
      });
      authManager.setPreferences(preferences);
      plan = undefined;
      toastManager.primary($t('frameleaf_album_cleanup_banner_dismissed'));
    } catch (error) {
      handleError(error, $t('frameleaf_album_cleanup_banner_dismiss_failed'));
    } finally {
      dismissing = false;
    }
  };

  const number = (value: number) => value.toLocaleString($locale);
</script>

{#if plan}
  <aside class="ac-banner" aria-label={$t('frameleaf_album_cleanup_magic_albums')}>
    <div class="ac-banner-copy">
      <p class="ac-eyebrow">
        <Icon icon={mdiAutoFix} size="16" aria-hidden={true} />
        {$t('frameleaf_album_cleanup_magic_albums')}
      </p>
      <h2>
        {$t('frameleaf_album_cleanup_banner_title', {
          values: { before: number(plan.summary.albumsBefore), after: number(plan.summary.topLevelAfter) },
        })}
      </h2>
      <p>
        {$t('frameleaf_album_cleanup_banner_body', {
          values: {
            combined: plan.summary.albumsCombined,
            filed: number(plan.summary.albumsMoved),
            lost: plan.summary.lostPhotos,
          },
        })}
      </p>
      <div class="ac-banner-actions">
        <Button variant="primary" onclick={() => goto(Route.albumCleanup())}>
          {$t('frameleaf_album_cleanup_review_suggestions')}
        </Button>
        <Button disabled={dismissing} onclick={dismiss}>{$t('frameleaf_album_cleanup_not_now')}</Button>
      </div>
    </div>
    <AlbumCleanupArt {plan} {names} {covers} />
  </aside>
{/if}
