<script lang="ts">
  /**
   * FL-196: when the linked-server tour opens, as the prototype's `CommandCenter` decides it
   * (design/frameleaf/template/src/CommandCenter.jsx, c4a009f8b5). Mounted by the Command Center for
   * administrators only.
   *
   * - It opens by itself for an administrator who has not seen it, once this server is linked: right
   *   after linking from Settings → Frameleaf Cloud → Account & link, or on another administrator's
   *   next visit to Settings. `GET admin/cloud/tour` says so (`offer`); first-run setup records its own
   *   summary as the ending, so a server linked during setup never offers it.
   * - `?tour=cloud&tourStep=N` opens it at a step; Account & link's "Take the tour" uses that.
   * - Done, Skip tour, Escape and every "Open …" link record the ending on the server, per account.
   *   A link closes the tour and opens its page; skipping leaves the "Take the tour again" notice.
   *
   * The status chips read state already on this server (the link status, licence and prices the cloud
   * manager loads, and the tour's own answer); nothing contacts Frameleaf Cloud because of the tour.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import CloudTour from '$lib/components/frameleaf/cloud/CloudTour.svelte';
  import {
    lowestMonthlyPlanUsd,
    requestedTourStep,
    type CloudTourEnding,
    type CloudTourLink,
  } from '$lib/frameleaf/cloud-tour';
  import type { SettingsAreaId } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import {
    getCloudTour,
    markCloudTourSeen,
    type CloudTourEnding as SdkCloudTourEnding,
    type CloudTourResponseDto,
  } from '@frameleaf/sdk';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** Opens a settings page (the Command Center's own navigation). */
    navigate: (area: SettingsAreaId, section?: string, params?: Record<string, string>) => Promise<void> | void;
    /** Shows (or, with '', clears) the "Take the tour again" notice under the page heading. */
    onNotice: (text: string) => void;
  };

  const { navigate, onNotice }: Props = $props();

  let tour = $state<CloudTourResponseDto | null>(null);
  let open = $state<{ step: number } | null>(null);
  let loading: Promise<void> | null = null;

  const fetchTour = async () => {
    try {
      const result = await getCloudTour();
      if (result) {
        tour = result;
        if (result.offer && !open) {
          open = { step: 0 };
        }
      }
    } catch {
      // an older server, or no answer: the tour simply is not offered
    } finally {
      loading = null;
    }
  };
  const load = () => (loading ??= fetchTour());

  onMount(() => {
    void load();
  });

  // Linking from Account & link: the status there turns linked, so ask again (still no cloud call).
  let lastState: string | undefined;
  $effect(() => {
    const state = cloudManager.status?.state;
    if (state === 'linked' && lastState !== undefined && lastState !== 'linked' && !tour?.seen) {
      void load();
    }
    lastState = state;
  });

  // A review or "Take the tour" link. Only an address change opens it: closing must not reopen it
  // while the address still carries the request.
  $effect(() => {
    const step = requestedTourStep(page.url.searchParams);
    untrack(() => {
      if (step === null || open) {
        return;
      }
      open = { step };
      if (!tour) {
        void load();
      }
    });
  });

  // The chips need the link status, licence and prices: keep them current while the tour is open.
  $effect(() => {
    if (open) {
      return cloudManager.listen();
    }
  });

  const status = $derived(cloudManager.status);
  const license = $derived(cloudManager.license);
  const products = $derived(cloudManager.products);
  const facts = $derived({
    license: {
      entitlements: license?.entitlements ?? {
        cloudBackup: false,
        cloudMl: false,
        frameleafCloud: false,
        remoteAccess: false,
        supporter: false,
      },
      plan: license?.plan ?? null,
    },
    remoteAccessEnabled: !!status?.remoteAccessEnabled,
    customHostnameVerified: !!tour?.customHostnameVerified,
    processingEnabled: !!tour?.processingEnabled,
    walletAvailableUsd: tour?.walletAvailableUsd ?? null,
    backupConfigured: !!tour?.backupConfigured,
  });

  const record = async (ending: CloudTourEnding) => {
    try {
      tour = (await markCloudTourSeen({ cloudTourSeenDto: { ending: ending as SdkCloudTourEnding } })) ?? tour;
    } catch {
      // not recorded: the tour may be offered once more, which is harmless
    }
  };

  const close = async (ending: Exclude<CloudTourEnding, 'setup'>, link?: CloudTourLink) => {
    open = null;
    void record(ending);
    onNotice(ending === 'skipped' ? $t('frameleaf_cloud_tour_again') : '');
    if (link) {
      await (link.params ? navigate(link.area, link.section, link.params) : navigate(link.area, link.section));
      return;
    }
    if (page.url.searchParams.has('tour')) {
      const url = new URL(page.url);
      url.searchParams.delete('tour');
      url.searchParams.delete('tourStep');
      await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
    }
  };
</script>

{#if open}
  <CloudTour
    {facts}
    account={status?.account?.label ?? null}
    planFromUsd={products ? lowestMonthlyPlanUsd(products.products) : null}
    licensedDiscount={products?.licensedDiscount ?? null}
    initialStep={open.step}
    onClose={(ending) => void close(ending)}
    onOpen={(link) => void close('opened-settings', link)}
  />
{/if}
