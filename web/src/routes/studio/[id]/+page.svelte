<script lang="ts">
  import { page } from '$app/state';
  import PhotographyStudio from '$lib/components/frameleaf/PhotographyStudio.svelte';
</script>

{#key page.params.id}<PhotographyStudio ownerId={page.params.id!} />{/key}
