<script lang="ts">
  import { page } from '$app/state';
  import PhotographyClient from '$lib/components/frameleaf/PhotographyClient.svelte';
</script>

{#key page.params.id}<PhotographyClient galleryId={page.params.id!} />{/key}
