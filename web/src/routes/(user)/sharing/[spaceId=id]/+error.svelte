<script lang="ts">
  import { page } from '$app/state';
  import FrameleafErrorPage from '$lib/components/frameleaf/FrameleafErrorPage.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { errorStatus, spaceErrorKind, type ErrorPageAction } from '$lib/frameleaf/error-page';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { Route } from '$lib/route';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiAccountMultipleRemoveOutline, mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * A shared space that cannot be opened (FL-55).
   *
   * The address names something that is not a shared space this person is in — an album, a space
   * they were never invited to, one they left or were removed from, or one that was deleted — or the
   * space could not be loaded at all. Either way the person gets a plain explanation and a way on,
   * inside the app's own frame, never the server's message.
   */
  // A viewer address for a space that cannot be opened still names an item, and the (user) layout
  // hides the page behind the viewer for it. There is no viewer here, so the explanation must show.
  $effect(() => {
    if (assetViewerManager.isViewing) {
      assetViewerManager.showAssetViewer(false);
    }
  });

  const code = $derived(errorStatus(page.status, page.error));
  const kind = $derived(spaceErrorKind(code));

  const actions = $derived.by(() => {
    const list: ErrorPageAction[] = [
      { label: $t('frameleaf_spaces_viewer_back_to_sharing'), href: Route.sharing(), primary: true },
      { label: $t('frameleaf_error_go_photos'), href: Route.photos() },
    ];
    if (kind === 'failed') {
      list.push({ label: $t('frameleaf_error_retry'), onclick: () => location.reload() });
    }
    return list;
  });
</script>

<UserPageLayout>
  {#snippet sidebar()}
    <UserSidebar />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    {#if kind === 'unavailable'}
      <FrameleafErrorPage
        title={$t('frameleaf_spaces_viewer_unavailable_title')}
        message={$t('frameleaf_spaces_viewer_unavailable_body')}
        icon={mdiAccountMultipleRemoveOutline}
        {code}
        {actions}
      />
    {:else}
      <FrameleafErrorPage
        title={$t('frameleaf_spaces_viewer_failed_title')}
        message={$t('frameleaf_spaces_viewer_failed_body')}
        icon={mdiAlertCircleOutline}
        {code}
        {actions}
      />
    {/if}
  </Theme>
</UserPageLayout>
