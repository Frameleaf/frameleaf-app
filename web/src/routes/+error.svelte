<script lang="ts">
  import { page } from '$app/state';
  import FrameleafErrorPage from '$lib/components/frameleaf/FrameleafErrorPage.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { ERROR_COPY, errorKind, errorStatus, type ErrorPageAction } from '$lib/frameleaf/error-page';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { mdiAlertCircleOutline, mdiImageOffOutline, mdiLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import ErrorLayout from './ErrorLayout.svelte';

  /**
   * The root error boundary. A page inside the signed-in app that fails keeps the app around it:
   * the rail and top bar stay, so the person can go somewhere else without starting over, and only
   * the page area explains what happened. Everything else (signed out, a public link, sign-in,
   * setup, maintenance) gets the standalone branded page from ErrorLayout.
   *
   * A session that is no longer valid (401) also gets the standalone page: the shell would only
   * fail again around it.
   */
  const code = $derived(errorStatus(page.status, page.error));
  const kind = $derived(errorKind(code));
  const copy = $derived(ERROR_COPY[kind]);
  const icon = $derived(
    kind === 'not-found' ? mdiImageOffOutline : kind === 'forbidden' ? mdiLockOutline : mdiAlertCircleOutline,
  );

  // No route id means the address matched nothing: for someone signed in that is still "inside the app".
  const routeId = $derived(page.route.id);
  const inApp = $derived(
    authManager.authenticated &&
      code !== 401 &&
      (routeId === null || routeId.startsWith('/(user)') || routeId.startsWith('/admin')),
  );

  // An address that names an item makes the (user) layout hide the page behind the viewer. There
  // is no viewer on an error page, so the explanation must show.
  $effect(() => {
    if (inApp && assetViewerManager.isViewing) {
      assetViewerManager.showAssetViewer(false);
    }
  });

  const actions = $derived.by(() => {
    const list: ErrorPageAction[] = [{ label: $t('frameleaf_error_go_photos'), href: Route.photos(), primary: true }];
    if (kind === 'server') {
      list.push({ label: $t('frameleaf_error_retry'), onclick: () => location.reload() });
    }
    if (typeof history !== 'undefined' && history.length > 1) {
      list.push({ label: $t('frameleaf_error_go_back'), onclick: () => history.back() });
    }
    return list;
  });
</script>

{#if inApp}
  <UserPageLayout>
    <FrameleafErrorPage title={$t(copy.title)} message={$t(copy.body)} {code} {icon} {actions} />
  </UserPageLayout>
{:else}
  <ErrorLayout error={page.error} status={page.status}></ErrorLayout>
{/if}
