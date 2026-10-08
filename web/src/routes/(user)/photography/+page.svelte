<script lang="ts">
  import PhotographyWorkspace from '$lib/components/frameleaf/PhotographyWorkspace.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
</script>

<!--
  No layout title: the workspace has its own "Photography" heading, and the name would show twice.
  The tab title still comes from this page's `meta.title`.
-->
<UserPageLayout rail={false}><PhotographyWorkspace /></UserPageLayout>
