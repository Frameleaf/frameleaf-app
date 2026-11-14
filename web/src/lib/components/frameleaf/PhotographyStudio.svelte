<script lang="ts">
  import PhotographyStudioBooking from '$lib/components/frameleaf/PhotographyStudioBooking.svelte';
  import StudioSite from '$lib/components/frameleaf/StudioSite.svelte';
  import { photographyPublicBookingTypes, type PhotographyPublicBookingTypeListDto } from '@frameleaf/sdk';
  import { publicStudio, sendInquiry, type PublicSite } from '$lib/frameleaf/photography/workflow-api';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import '$lib/frameleaf/photography/gallery.css';

  /** FL-702: the studio website a visitor opens at /studio/<address>. */
  let { site: address }: { site: string } = $props();
  let site = $state<PublicSite | null>(null);
  let error = $state('');
  /** FL-1053: the studio's bookable sessions; the header offers booking only when there are some. */
  let bookingTypes = $state<PhotographyPublicBookingTypeListDto['types']>([]);
  // Back from Stripe's deposit page (`?booking=sent`): the form opens on its confirmation.
  const returned = new URLSearchParams(location.search).get('booking') === 'sent';
  let booking = $state(returned);
  let disposed = false;

  async function reload() {
    error = '';
    try {
      const result = await publicStudio(address);
      if (!disposed) {
        site = result;
      }
    } catch {
      if (!disposed) {
        site = null;
        error = $t('frameleaf_photography_public_unavailable');
      }
    }
  }
  async function loadBookingTypes() {
    try {
      const answer = await photographyPublicBookingTypes({ site: address });
      if (!disposed) {
        bookingTypes = answer?.types ?? [];
      }
    } catch {
      // No booking types or an older server: the website simply offers no booking.
    }
  }
  onMount(() => {
    void reload();
    void loadBookingTypes();
  });
  onDestroy(() => {
    disposed = true;
  });
</script>

{#if site}
  <StudioSite
    {site}
    onInquiry={(inquiry) => sendInquiry(address, inquiry)}
    onBook={bookingTypes.length > 0 ? () => (booking = true) : undefined}
  />
  {#if booking}<PhotographyStudioBooking bind:open={booking} site={address} types={bookingTypes} sent={returned} />{/if}
{:else}<div class="pc pc-gate">
    <main class="pc-access">
      <h1>{error || $t('frameleaf_photography_public_opening')}</h1>
      {#if error}<button type="button" onclick={reload}>{$t('frameleaf_error_retry')}</button>{/if}
    </main>
  </div>{/if}
