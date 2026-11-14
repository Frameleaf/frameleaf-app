<script lang="ts">
  import { page } from '$app/state';
  import PhotographyPay from '$lib/components/frameleaf/PhotographyPay.svelte';
</script>

{#key page.params.slug}<PhotographyPay
    slug={page.params.slug!}
    paymentId={page.url.searchParams.get('payment')}
  />{/key}
