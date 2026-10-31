<script lang="ts">
  import { page } from '$app/state';
  import PhotographyStudio from '$lib/components/frameleaf/PhotographyStudio.svelte';
</script>

<!-- FL-702: `id` is the website's address (/studio/<slug>); links made earlier carry the owner's id. -->
{#key page.params.id}<PhotographyStudio site={page.params.id!} />{/key}
