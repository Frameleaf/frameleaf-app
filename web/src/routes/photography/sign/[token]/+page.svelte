<script lang="ts">
  import { page } from '$app/state';
  import PhotographyContractSign from '$lib/components/frameleaf/PhotographyContractSign.svelte';
</script>

{#key page.params.token}<PhotographyContractSign token={page.params.token!} />{/key}
