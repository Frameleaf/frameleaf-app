<script lang="ts">
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { provideUserShell } from '$lib/components/layouts/user-shell.svelte';
  import UserShell from '$lib/components/layouts/UserShell.svelte';

  /** Stands in for `(user)/+layout.svelte` with the page SvelteKit would put inside it. */
  let { page }: { page: 'photos' | 'albums' | 'studio' | 'viewer' } = $props();
  const shell = provideUserShell();
</script>

<UserShell page={shell.current}>
  {#if page === 'photos'}
    <UserPageLayout><span>Photos page</span></UserPageLayout>
  {:else if page === 'albums'}
    <UserPageLayout>
      {#snippet railExtra()}<a href="#albums">Skip to albums</a>{/snippet}
      <span>Albums page</span>
    </UserPageLayout>
  {:else if page === 'studio'}
    <UserPageLayout rail={false}><span>Studio page</span></UserPageLayout>
  {:else}
    <span>Viewer page</span>
  {/if}
</UserShell>
