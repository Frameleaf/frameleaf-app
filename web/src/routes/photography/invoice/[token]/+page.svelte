<script lang="ts">
  import { page } from '$app/state';
  import PhotographyInvoicePay from '$lib/components/frameleaf/PhotographyInvoicePay.svelte';
</script>

{#key page.params.token}<PhotographyInvoicePay
    token={page.params.token!}
    paymentId={page.url.searchParams.get('payment')}
  />{/key}
