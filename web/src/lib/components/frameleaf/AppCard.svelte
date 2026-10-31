<script lang="ts">
  /**
   * The phone "Get the app" sheet (owner request and approval 2026-10-16; prototype `AppCard.jsx`,
   * `?screen=library&appcard=ios|android`). Mounted once in the user layout; `app-card.ts` holds
   * the rules: the Photos library on a phone browser, a visit that began there, a release named by
   * `GET /server/app-releases`, once per page load and not within 30 days of being closed.
   *
   * The store button is the only action (the store page offers "Open" when the app is installed);
   * a server that only has its own signed Android download offers "Get the app" for its Downloads
   * page instead. A server that isn't linked to Frameleaf Cloud also shows its address to type into
   * the app. Every way of closing it (store button, Continue in the browser, the scrim, Escape,
   * dragging it down) keeps it away for 30 days.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import {
    appCardOffer,
    appCardPlatform,
    appCardStorage,
    firstLoadUrl,
    isNormalArrival,
    isSnoozed,
    LIBRARY_ROUTE_ID,
    markShownThisLoad,
    snooze,
    wasShownThisLoad,
    type AppCardOffer,
  } from '$lib/components/frameleaf/app-card';
  import { nextStepsOffered } from '$lib/components/timeline/next-steps.svelte';
  import { motionFade, motionFly } from '$lib/frameleaf/motion';
  import '$lib/frameleaf/tokens.css';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { mediaQueryManager } from '$lib/stores/media-query-manager.svelte';
  import { getTabbable } from '$lib/utils/focus-util';
  import { handleError } from '$lib/utils/handle-error';
  import { getAppReleases } from '@frameleaf/sdk';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiAirplane, mdiCloudUploadOutline, mdiLightningBoltOutline } from '@mdi/js';
  import { quartIn, quartOut } from 'svelte/easing';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /** How long the library shows before the sheet rises, so it never covers a blank page. */
  const SHOW_DELAY_MS = 1200;
  /** While a dialog or the viewer is in front, look again this often, this many times. */
  const RETRY_MS = 1500;
  const MAX_ATTEMPTS = 8;
  /** A downward drag past this many px, or a flick, closes the sheet. */
  const DRAG_CLOSE_PX = 96;

  // Where this page load began: client-side redirects (the root, sign-in) don't change it.
  const arrivedNormally = isNormalArrival(firstLoadUrl(globalThis.location?.href ?? 'http://localhost/'));

  let offer = $state<AppCardOffer | null>(null);
  let open = $state(false);
  let checking = false;
  let attempts = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let copied = $state(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  let sheet = $state<HTMLElement>();
  let returnFocus: HTMLElement | null = null;
  let dragY = $state(0);
  let dragging = $state(false);
  let drag: { startY: number; startTime: number; pointerId: number } | undefined;

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const address = $derived(page.url.origin);
  const linkedToCloud = $derived.by(() => {
    try {
      return featureFlagsManager.value.frameleafCloud;
    } catch {
      return false;
    }
  });

  const onLibrary = () =>
    page.route.id === LIBRARY_ROUTE_ID && !page.params.assetId && !page.url.searchParams.has('area');

  const otherSurface = () =>
    assetViewerManager.isViewing ||
    nextStepsOffered(authManager.authenticated ? authManager.user.id : undefined) ||
    !!document.querySelector('[role="dialog"][aria-modal="true"], dialog[open]');

  const standalone = () =>
    !!globalThis.matchMedia?.('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;

  const context = (surface: boolean) => ({
    userAgent: navigator.userAgent,
    coarsePointer: mediaQueryManager.pointerCoarse,
    screenWidth: screen.width,
    screenHeight: screen.height,
    standalone: standalone(),
    arrivedNormally,
    onLibrary: authManager.authenticated && onLibrary(),
    otherSurface: surface,
    snoozed: isSnoozed(appCardStorage(), Date.now()),
    shownThisLoad: wasShownThisLoad(),
  });

  /** The platform the sheet would open for now, or null. */
  const eligiblePlatform = () => appCardPlatform(context(otherSurface()));

  /** Whether only something in front of the library (a dialog, the viewer) keeps it closed. */
  const couldOpenLater = () => appCardPlatform(context(false)) !== null;

  const schedule = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(() => void show(), delay);
  };

  const show = async () => {
    timer = undefined;
    if (open || checking) {
      return;
    }
    const platform = eligiblePlatform();
    if (!platform) {
      // something is still in front of the library: look again for a little while
      if (couldOpenLater() && ++attempts < MAX_ATTEMPTS) {
        schedule(RETRY_MS);
      }
      return;
    }
    checking = true;
    try {
      const found = appCardOffer(await getAppReleases(), platform);
      // the library may have been left, or something opened over it, while the releases loaded
      if (!found || eligiblePlatform() !== platform) {
        return;
      }
      offer = found;
      markShownThisLoad();
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      open = true;
      await tick();
      sheet?.focus({ preventScroll: true });
    } catch {
      // no answer about the releases: nothing to offer
    } finally {
      checking = false;
    }
  };

  $effect(() => {
    // re-checked whenever the page changes; the timer is the only thing scheduled
    void page.route.id;
    void page.params.assetId;
    if (open || timer || !couldOpenLater()) {
      return;
    }
    attempts = 0;
    schedule(SHOW_DELAY_MS);
  });

  $effect(() => {
    // leaving the library (the back gesture) closes it like any other way out
    if (open && !onLibrary()) {
      close();
    }
  });

  const close = () => {
    if (!open) {
      return;
    }
    snooze(appCardStorage(), Date.now());
    open = false;
    dragY = 0;
    dragging = false;
    drag = undefined;
    returnFocus?.focus?.({ preventScroll: true });
  };

  const openDownloads = async () => {
    close();
    await goto(Route.downloadsUtility());
  };

  const copyAddress = async () => {
    try {
      await navigator.clipboard.writeText(address);
      copied = true;
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => (copied = false), 2000);
    } catch (error) {
      handleError(error, $t('errors.unable_to_copy_to_clipboard'));
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (!open || !sheet) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') {
      return;
    }
    // keep focus inside the sheet
    const items = getTabbable(sheet);
    const first = items.at(0);
    const last = items.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === sheet)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.button !== 0) {
      return;
    }
    drag = { startY: event.clientY, startTime: event.timeStamp, pointerId: event.pointerId };
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    dragging = true;
    dragY = Math.max(0, event.clientY - drag.startY);
  };

  const onPointerUp = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const distance = Math.max(0, event.clientY - drag.startY);
    const velocity = distance / Math.max(1, event.timeStamp - drag.startTime);
    drag = undefined;
    dragging = false;
    if (distance > DRAG_CLOSE_PX || (distance > 24 && velocity > 0.6)) {
      close();
    } else {
      dragY = 0;
    }
  };

  onDestroy(() => {
    clearTimeout(timer);
    clearTimeout(copiedTimer);
  });

  const benefits = [
    { icon: mdiCloudUploadOutline, title: 'frameleaf_app_card.backup_title', body: 'frameleaf_app_card.backup_body' },
    { icon: mdiAirplane, title: 'frameleaf_app_card.offline_title', body: 'frameleaf_app_card.offline_body' },
    { icon: mdiLightningBoltOutline, title: 'frameleaf_app_card.fast_title', body: 'frameleaf_app_card.fast_body' },
  ] as const;
</script>

<svelte:window onkeydown={onKeydown} />

{#if open && offer}
  <div class="frameleaf app-card-layer" data-theme={appTheme} data-testid="app-card">
    <div
      class="app-card-scrim"
      aria-hidden="true"
      onclick={close}
      in:motionFade={{ duration: 200 }}
      out:motionFade={{ duration: 240 }}
    ></div>
    <div
      bind:this={sheet}
      class="app-card"
      class:dragging
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-card-title"
      tabindex="-1"
      style:transform={dragY > 0 ? `translateY(${dragY}px)` : undefined}
      in:motionFly={{ y: '100%', opacity: 1, duration: 380, easing: quartOut }}
      out:motionFly={{ y: '100%', opacity: 1, duration: 240, easing: quartIn }}
    >
      <!-- The drag-down gesture is pointer-only; Escape and Continue in the browser close it by keyboard. -->
      <div
        class="app-card-grab"
        role="presentation"
        onpointerdown={onPointerDown}
        onpointermove={onPointerMove}
        onpointerup={onPointerUp}
        onpointercancel={onPointerUp}
      >
        <span class="app-card-handle" aria-hidden="true"></span>
        <img class="app-card-icon" src="/frameleaf/frameleaf-app-icon.svg" alt="" width="72" height="72" />
        <h2 id="app-card-title">
          {offer.platform === 'ios' ? $t('frameleaf_app_card.title_ios') : $t('frameleaf_app_card.title_android')}
        </h2>
        <p class="app-card-lede">{$t('frameleaf_app_card.lede')}</p>
      </div>

      <ul class="app-card-benefits">
        {#each benefits as benefit (benefit.title)}
          <li>
            <Icon icon={benefit.icon} size="28" />
            <div>
              <strong>{$t(benefit.title)}</strong>
              <span>{$t(benefit.body)}</span>
            </div>
          </li>
        {/each}
      </ul>

      <p class="app-card-note">{$t('frameleaf_app_card.network_note')}</p>

      {#if offer.kind === 'store'}
        <a
          class="app-card-badge"
          class:is-android={offer.platform === 'android'}
          href={offer.href}
          target="_blank"
          rel="noopener noreferrer"
          onclick={close}
        >
          {#if offer.platform === 'ios'}
            <img src="/badges/app-store-black.svg" alt={$t('frameleaf_app_card.app_store_badge')} />
          {:else}
            <img src="/badges/google-play.png" alt={$t('frameleaf_app_card.google_play_badge')} />
          {/if}
        </a>
      {:else}
        <button type="button" class="app-card-get" onclick={() => void openDownloads()}>
          {$t('frameleaf_app_card.get_the_app')}
        </button>
      {/if}

      {#if !linkedToCloud}
        <div class="app-card-address">
          <div>
            <span>{$t('frameleaf_app_card.address_label')}</span>
            <strong>{address}</strong>
          </div>
          <button type="button" onclick={() => void copyAddress()} aria-live="polite">
            {copied ? $t('frameleaf_app_card.copied') : $t('frameleaf_app_card.copy')}
          </button>
        </div>
      {/if}

      <button type="button" class="app-card-browser" onclick={close}>
        {$t('frameleaf_app_card.continue_in_browser')}
      </button>
    </div>
  </div>
{/if}

<style>
  .app-card-layer {
    position: fixed;
    inset: 0;
    z-index: 60;
    background: transparent;
  }
  .app-card-scrim {
    position: fixed;
    inset: 0;
    background: #0009;
    backdrop-filter: blur(2px);
    -webkit-backdrop-filter: blur(2px);
  }
  .app-card {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    max-width: 520px;
    max-height: calc(100dvh - var(--fl-space-12));
    margin: 0 auto;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: var(--fl-space-2) var(--fl-space-5) calc(var(--fl-space-4) + env(safe-area-inset-bottom));
    background: var(--fl-panel);
    color: var(--fl-text);
    border-top: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-sheet) var(--fl-radius-sheet) 0 0;
    box-shadow: 0 -12px 48px #0006;
    outline: none;
    transition: transform 240ms var(--fl-snappy);
  }
  .app-card.dragging {
    transition: none;
  }
  .app-card-grab {
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    touch-action: none;
  }
  .app-card-handle {
    width: 36px;
    height: 5px;
    margin-bottom: var(--fl-space-4);
    border-radius: 3px;
    background: color-mix(in srgb, var(--fl-text) 22%, transparent);
  }
  .app-card-icon {
    width: 72px;
    height: 72px;
    border-radius: 16px;
    box-shadow: 0 4px 14px #0003;
    -webkit-user-drag: none;
    user-select: none;
  }
  .app-card h2 {
    margin: var(--fl-space-4) 0 0;
    font-size: var(--fl-font-title);
    line-height: 28px;
    font-weight: 650;
    letter-spacing: -0.015em;
    color: var(--fl-text);
  }
  .app-card-lede {
    margin: 6px 0 0;
    font-size: 15px;
    line-height: 20px;
    color: var(--fl-muted);
  }
  .app-card-benefits {
    display: grid;
    gap: var(--fl-space-4);
    width: 100%;
    max-width: 340px;
    margin: var(--fl-space-6) auto 0;
    padding: 0;
    list-style: none;
    text-align: start;
  }
  .app-card-benefits li {
    display: grid;
    grid-template-columns: 40px 1fr;
    column-gap: var(--fl-space-3);
    align-items: start;
  }
  .app-card-benefits li > :global(svg) {
    justify-self: center;
    margin-top: -4px;
    color: var(--fl-accent);
  }
  .app-card-benefits strong {
    display: block;
    font-size: 15px;
    line-height: 20px;
    font-weight: 600;
    color: var(--fl-text);
  }
  .app-card-benefits span {
    display: block;
    margin-top: var(--fl-space-half);
    font-size: var(--fl-font-size);
    line-height: 19px;
    color: var(--fl-muted);
  }
  .app-card-note {
    max-width: 320px;
    margin: var(--fl-space-4) auto 0;
    font-size: var(--fl-font-small);
    line-height: 16px;
    text-align: center;
    color: var(--fl-muted);
  }
  .app-card-badge {
    align-self: center;
    display: inline-flex;
    margin-top: var(--fl-space-6);
    border-radius: var(--fl-radius);
  }
  .app-card-badge:focus-visible,
  .app-card button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .app-card-badge img {
    display: block;
    height: 48px;
    width: auto;
  }
  /* The Google Play artwork carries 41px of clear space on a 250px-tall image: trim it so the badge itself is 48px. */
  .app-card-badge.is-android img {
    height: 71.4px;
    margin: -11.7px;
  }
  .app-card-get {
    min-height: 48px;
    margin-top: var(--fl-space-6);
    padding: 0 var(--fl-space-4);
    border-radius: var(--fl-radius-card);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-size: 16px;
    font-weight: 600;
  }
  .app-card-address {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    margin-top: var(--fl-space-4);
    padding: var(--fl-space-2) var(--fl-space-2) var(--fl-space-2) var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: color-mix(in srgb, var(--fl-text) 6%, transparent);
  }
  .app-card-address > div {
    display: grid;
    flex: 1;
    min-width: 0;
  }
  .app-card-address span {
    font-size: var(--fl-font-small);
    line-height: 16px;
    color: var(--fl-muted);
  }
  .app-card-address strong {
    overflow: hidden;
    font-size: 15px;
    line-height: 20px;
    font-weight: 600;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--fl-text);
    user-select: all;
    font-variant-numeric: tabular-nums;
  }
  .app-card-address button {
    flex: none;
    min-height: 48px;
    padding: 0 var(--fl-space-4);
    border-radius: var(--fl-radius);
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
    color: var(--fl-accent);
    font-size: 15px;
    font-weight: 600;
  }
  .app-card-browser {
    width: 100%;
    min-height: 48px;
    margin-top: var(--fl-space-3);
    border-radius: var(--fl-radius-card);
    background: none;
    color: var(--fl-accent);
    font-size: 16px;
    font-weight: 500;
  }
  .app-card-browser:hover,
  .app-card-browser:active {
    background: color-mix(in srgb, var(--fl-text) 6%, transparent);
  }
  .app-card-address button:hover,
  .app-card-address button:active {
    background: color-mix(in srgb, var(--fl-text) 14%, transparent);
  }
</style>
