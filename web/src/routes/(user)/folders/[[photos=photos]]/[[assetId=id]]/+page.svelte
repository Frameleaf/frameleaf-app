<script lang="ts">
  /**
   * Frameleaf Folders (FL-46): storage folders as a visual browser. See
   * `$lib/components/frameleaf/folders/FolderBrowser.svelte`, built on `foldersStore`
   * (`GET /view/folder/summary`, `GET /view/folder`). The page is always reachable by its address,
   * whatever the rail shows: the rail honours the account's Folders preferences, the page and the
   * server's access checks do not.
   */
  import FolderBrowser from '$lib/components/frameleaf/folders/FolderBrowser.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // Whose uploads a folder holds: this account's, and those of the people sharing a library with it.
  const accounts = $derived({
    [authManager.user.id]: authManager.user.name,
    ...Object.fromEntries(data.partners.map(({ id, name }) => [id, name])),
  });
</script>

<UserPageLayout scrollbar={true}>
  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <!-- The page surface reaches the foot of the window however few folders there are, as on Albums. -->
    <div class="fl-page-fill">
      <FolderBrowser
        tree={data.tree}
        path={data.path}
        assets={data.assets}
        assetsFailed={data.assetsFailed}
        assetsDeferred={data.assetsDeferred}
        {accounts}
      />
    </div>
  </Theme>
</UserPageLayout>

<style>
  .fl-page-fill {
    min-height: calc(100dvh - var(--fl-topbar-height) - 1rem);
  }
  @media (max-width: 767px) {
    .fl-page-fill {
      min-height: calc(100dvh - var(--fl-topbar-height-phone) - 0.5rem - max(0.5rem, var(--fl-tabbar-space, 0px)));
    }
  }
</style>
