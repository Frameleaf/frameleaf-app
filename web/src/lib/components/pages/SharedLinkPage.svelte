<script lang="ts">
  import AlbumViewer from '$lib/components/album-page/AlbumViewer.svelte';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IndividualSharedViewer from '$lib/components/share-page/IndividualSharedViewer.svelte';
  import '$lib/frameleaf/tokens.css';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { setSharedLink } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { sharedLinkLogin, SharedLinkType, type AssetResponseDto, type SharedLinkResponseDto } from '@immich/sdk';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    data: {
      meta: {
        title: string;
        description?: string;
        imageUrl?: string;
      };

      sharedLink?: SharedLinkResponseDto;
      key?: string;
      slug?: string;
      asset?: AssetResponseDto;
      passwordRequired?: boolean;
    };
  };

  const { data }: Props = $props();

  let { sharedLink, passwordRequired, key, slug, meta } = $state(data);
  let { title, description } = $state(meta);
  let isOwned = $derived(authManager.authenticated && authManager.user.id === sharedLink?.userId);
  let password = $state('');

  if (passwordRequired) {
    assetViewerManager.showAssetViewer(false);
  }

  const handlePasswordSubmit = async () => {
    try {
      sharedLink = await sharedLinkLogin({ key, slug, sharedLinkLoginDto: { password } });
      setSharedLink(sharedLink);
      passwordRequired = false;
      title = (sharedLink.album ? sharedLink.album.albumName : $t('public_share')) + ' - Frameleaf';
      description =
        sharedLink.description ||
        $t('shared_photos_and_videos_count', { values: { assetCount: sharedLink.assets.length } });
      await tick();
      await navigate(
        { targetRoute: 'current', assetId: null, assetGridRouteSearchParams: assetViewerManager.gridScrollTarget },
        { forceNavigate: true, replaceState: true },
      );
    } catch (error) {
      handleError(error, $t('errors.unable_to_get_shared_link'));
    }
  };

  const onsubmit = async (event: Event) => {
    event.preventDefault();
    await handlePasswordSubmit();
  };

  onDestroy(() => {
    setSharedLink(undefined);
  });

  // FL-56: own layout, no LibraryRail/TopBar/account menu — a public visitor never sees
  // private navigation.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
</svelte:head>
{#if passwordRequired}
  <main class="frameleaf pv-password-shell" data-theme={appTheme}>
    <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
      <Brand />
    </a>
    <form class="pv-password-card" novalidate {onsubmit}>
      <h1>{$t('frameleaf_public_password_title')}</h1>
      <p>{$t('frameleaf_public_password_body')}</p>
      <label class="pv-password-field">
        <span class="sr-only">{$t('password')}</span>
        <input
          type="password"
          autocomplete="off"
          placeholder={$t('password')}
          aria-label={$t('password')}
          bind:value={password}
        />
      </label>
      <Button type="submit" variant="primary">{$t('submit')}</Button>
    </form>
  </main>
{/if}

{#if !passwordRequired && sharedLink?.type === SharedLinkType.Album}
  <AlbumViewer {sharedLink} />
{/if}
{#if !passwordRequired && sharedLink?.type === SharedLinkType.Individual}
  <div class="immich-scrollbar">
    <IndividualSharedViewer {sharedLink} {isOwned} />
  </div>
{/if}

<style>
  .pv-password-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    min-height: 100dvh;
    padding: 1.5rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .pv-brand {
    display: inline-flex;
  }
  .pv-password-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: min(24rem, 100%);
    padding: 1.5rem;
    text-align: center;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-1);
  }
  .pv-password-card h1 {
    font-size: 1.25rem;
  }
  .pv-password-card p {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .pv-password-field {
    width: 100%;
  }
  .pv-password-field input {
    width: 100%;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0.5rem 0.75rem;
  }
</style>
