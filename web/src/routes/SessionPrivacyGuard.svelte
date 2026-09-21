<script lang="ts">
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { getAssetInfo } from '@immich/sdk';
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { watchSessionPrivacy } from '$lib/utils/session-privacy-guard';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { children }: { children: Snippet } = $props();
  let status = $state<'pending' | 'ready' | 'error'>('pending');
  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;
  onMount(() => {
    guard = watchSessionPrivacy(
      () => authManager.authenticated,
      (value) => (status = value),
      async () => {
        assetCacheManager.invalidate();
        if (page.params.assetId) {
          // Check the preloaded viewer directly: route invalidation can render
          // an error boundary, but must never release an old authorized asset.
          await getAssetInfo({ id: page.params.assetId, ...authManager.params }, { cache: 'no-store' });
        }
        await invalidateAll();
      },
    );
    return () => guard?.dispose();
  });
  afterNavigate(() => void guard?.refresh());
</script>

{#if status === 'ready'}
  {@render children()}
{:else}
  <div class="flex min-h-screen items-center justify-center" role="status">
    {#if status === 'error'}
      <button type="button" class="text-primary underline" onclick={() => void guard?.refresh()}>{$t('retry')}</button>
    {:else}
      {$t('loading')}
    {/if}
  </div>
{/if}
