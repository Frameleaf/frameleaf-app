<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import AlbumViewer from '$lib/components/album-page/AlbumViewer.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import PublicShellFrame from '$lib/components/frameleaf/PublicShellFrame.svelte';
  import IndividualSharedViewer from '$lib/components/share-page/IndividualSharedViewer.svelte';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { setSharedLink } from '$lib/utils';
  import { handleError, setUnauthorizedHandler } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import {
    isHttpError,
    sharedLinkLogin,
    SharedLinkType,
    type AssetResponseDto,
    type SharedLinkResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiEyeOffOutline, mdiEyeOutline, mdiLockOutline } from '@mdi/js';
  import { onDestroy, onMount, tick } from 'svelte';
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
  let showPassword = $state(false);
  /** The prototype's inline wrong-password message (`PublicViewer.jsx`), shown instead of a toast. */
  let passwordError = $state('');

  if (passwordRequired) {
    assetViewerManager.showAssetViewer(false);
  }

  const handlePasswordSubmit = async () => {
    // Cleared first so a repeated wrong password is announced again.
    passwordError = '';
    await tick();
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
      if (isHttpError(error) && error.status === 401) {
        // Only the service's own answer is a wrong password; any other 401 means the link itself
        // expired or was revoked meanwhile, so reload into the unavailable state.
        if (error.data?.message === 'Invalid password') {
          passwordError = $t('frameleaf_public_password_wrong');
        } else {
          await invalidateAll();
        }
        return;
      }
      handleError(error, $t('errors.unable_to_get_shared_link'));
    }
  };

  const onsubmit = async (event: Event) => {
    event.preventDefault();
    await handlePasswordSubmit();
  };

  // FL-56: an action refused because the link was revoked or expired while this page was open
  // reloads the route; the fresh link lookup fails and the unavailable state replaces the content.
  // A reload that finds the link still valid means the 401 had another cause: it is shown as usual.
  const onUnauthorized = async (showError: () => void) => {
    setSharedLink(undefined);
    await invalidateAll();
    if (!page.error && page.data.sharedLink) {
      showError();
    }
  };

  onMount(() => {
    setUnauthorizedHandler((showError) => void onUnauthorized(showError));
  });

  onDestroy(() => {
    setUnauthorizedHandler(undefined);
    setSharedLink(undefined);
  });
</script>

<svelte:head>
  <title>{title}</title>
  <meta name="description" content={description} />
</svelte:head>
{#if passwordRequired}
  <!-- FL-56: the prototype draws the password prompt inside the public frame, with no private navigation. -->
  <PublicShellFrame hero>
    <form class="pv-password-card" novalidate {onsubmit}>
      <Icon icon={mdiLockOutline} size="40" aria-hidden={true} />
      <h1>{$t('frameleaf_public_password_title')}</h1>
      <p>{$t('frameleaf_public_password_body')}</p>
      <div class="pv-password-field">
        <input
          type={showPassword ? 'text' : 'password'}
          autocomplete="off"
          placeholder={$t('password')}
          aria-label={$t('password')}
          aria-invalid={!!passwordError}
          aria-describedby={passwordError ? 'pv-password-error' : undefined}
          bind:value={password}
          oninput={() => (passwordError = '')}
        />
        <IconButton
          label={showPassword ? $t('hide_password') : $t('show_password')}
          pressed={showPassword}
          onclick={() => (showPassword = !showPassword)}
        >
          <Icon icon={showPassword ? mdiEyeOffOutline : mdiEyeOutline} size="1.25em" aria-hidden={true} />
        </IconButton>
      </div>
      {#if passwordError}
        <p id="pv-password-error" class="pv-password-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
          {passwordError}
        </p>
      {/if}
      <Button type="submit" variant="primary">{$t('continue')}</Button>
    </form>
  </PublicShellFrame>
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
  /* The template's `.slf-error` (sharing.css). */
  .pv-password-error {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    width: 100%;
    margin: 0.25rem 0 0;
    padding: 0.625rem 0.75rem;
    border-radius: var(--fl-radius-control);
    background: color-mix(in srgb, var(--fl-danger), transparent 88%);
    line-height: 1.5;
    text-align: start;
  }
  .pv-password-error :global(svg) {
    flex-shrink: 0;
    margin-top: 1px;
  }
  /* Above `.pv-password-card p`, which mutes the body text. */
  .pv-password-card .pv-password-error {
    color: var(--fl-danger);
  }
  .pv-password-field {
    display: flex;
    gap: 0.375rem;
    width: 100%;
  }
  .pv-password-field input {
    flex: 1;
    min-width: 0;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0.5rem 0.75rem;
  }
</style>
