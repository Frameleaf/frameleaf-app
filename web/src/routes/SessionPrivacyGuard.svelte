<script lang="ts">
  /**
   * FL-34 (ported from PR131 bebfed12ff and 25990c373c): holds the app until the session's
   * elevated (PIN-unlocked) access is verified, and discards the whole document when that access
   * is lost here, in another tab or on the server (`watchSessionPrivacy`).
   *
   * This is behaviour, not a screen: while the first check runs nothing new is drawn (the page is
   * still blank from boot), and only a check that cannot reach the server offers a retry. Locking,
   * unlocking and the Locked view itself stay with the top bar, the PIN prompt and the Locked route.
   */
  import { afterNavigate, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { getAssetInfo } from '@immich/sdk';
  import { Button } from '@immich/ui';
  import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { isLockedFolderRoute } from '$lib/utils/navigation';
  import { markRouterStarted } from '$lib/utils/router-started';
  import { watchSessionPrivacy, type SessionPrivacyStatus } from '$lib/utils/session-privacy-guard';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { children }: { children: Snippet } = $props();
  let status = $state<SessionPrivacyStatus>('pending');
  let guard: ReturnType<typeof watchSessionPrivacy> | undefined;

  const isSuppressedPath = (pathname: string) =>
    pathname === Route.suppressed() || pathname.startsWith(`${Route.suppressed()}/`);

  /**
   * Where a revoked view reloads: an open viewer or a Locked route goes to Photos, anything else
   * reloads where it is, so the fresh document shows only what the locked session may see.
   */
  const revokedDestination = () =>
    page.params.assetId || isLockedFolderRoute(page.route?.id) || isSuppressedPath(page.url.pathname)
      ? Route.photos()
      : `${page.url.pathname}${page.url.search}`;

  onMount(() => {
    guard = watchSessionPrivacy(
      () => authManager.authenticated,
      (value) => (status = value),
      async () => {
        assetCacheManager.invalidate();
        if (page.params.assetId) {
          // Check the preloaded viewer directly: route invalidation can render an error boundary,
          // but must never release an old authorized asset.
          await getAssetInfo({ id: page.params.assetId, ...authManager.params }, { cache: 'no-store' });
        }
        await invalidateAll();
      },
      revokedDestination,
    );
    return () => guard?.dispose();
  });

  afterNavigate(() => {
    markRouterStarted();
    void guard?.refresh();
  });
</script>

{#if status === 'ready'}
  {@render children()}
{:else if status === 'error'}
  <div class="flex min-h-dvh flex-col items-center justify-center gap-3 p-4 text-center" role="alert">
    <p class="text-sm">{$t('errors.something_went_wrong')}</p>
    <Button size="small" color="secondary" onclick={() => void guard?.refresh()}>{$t('retry')}</Button>
  </div>
{:else}
  <p class="sr-only" role="status">{$t('loading')}</p>
{/if}
