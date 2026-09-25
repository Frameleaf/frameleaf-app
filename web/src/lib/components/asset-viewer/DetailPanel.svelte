<script lang="ts">
  import { goto } from '$app/navigation';
  import DetailPanelDate from '$lib/components/asset-viewer/DetailPanelDate.svelte';
  import DetailPanelDescription from '$lib/components/asset-viewer/DetailPanelDescription.svelte';
  import DetailPanelImageEnrichment from '$lib/components/asset-viewer/DetailPanelImageEnrichment.svelte';
  import DetailPanelLocation from '$lib/components/asset-viewer/DetailPanelLocation.svelte';
  import DetailPanelRating from '$lib/components/asset-viewer/DetailPanelStarRating.svelte';
  import DetailPanelClassification from '$lib/components/asset-viewer/DetailPanelClassification.svelte';
  import DetailPanelTags from '$lib/components/asset-viewer/DetailPanelTags.svelte';
  import DocumentTextSection from '$lib/components/frameleaf/DocumentTextSection.svelte';
  import VideoMomentsPanel from '$lib/components/frameleaf/VideoMomentsPanel.svelte';
  import ViewerDetailRows from '$lib/components/frameleaf/ViewerDetailRows.svelte';
  import { timeToLoadTheMap } from '$lib/constants';
  import { ownerLine, type DescriptionReview } from '$lib/frameleaf/info-panel';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl } from '$lib/utils';
  import { delay } from '$lib/utils/asset-utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getAllAlbums,
    getAssetInfo,
    type AlbumResponseDto,
    type AssetResponseDto,
  } from '@immich/sdk';
  import { Icon, IconButton, Link, LoadingSpinner, Text } from '@immich/ui';
  import { mdiAccountOutline, mdiClose } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import OnEvents from '../OnEvents.svelte';
  import AlbumListItemDetails from './AlbumListItemDetails.svelte';
  import DetailPanelPeople from '$lib/components/asset-viewer/DetailPanelPeople.svelte';
  import { faceManager } from '$lib/stores/face.svelte';

  interface Props {
    asset: AssetResponseDto;
    currentAlbum?: AlbumResponseDto | null;
    onAssetSuppressed?: (asset: AssetResponseDto) => void | Promise<void>;
    onAssetUpdate?: (asset: AssetResponseDto) => void;
  }

  let { asset, currentAlbum = null, onAssetSuppressed, onAssetUpdate }: Props = $props();

  let isOwner = $derived(authManager.authenticated && authManager.user.id === asset.ownerId);
  // A shared link strips the owner from the asset, so it never shows one (the server drops it).
  const owner = $derived(
    ownerLine(asset, authManager.authenticated ? authManager.user.id : undefined, {
      sharedAlbum: !!currentAlbum && currentAlbum.albumUsers.length > 1,
    }),
  );
  let latlng = $derived(
    (() => {
      const lat = asset.exifInfo?.latitude;
      const lng = asset.exifInfo?.longitude;

      if (lat && lng) {
        return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
      }
    })(),
  );
  let previousId: string | undefined = $state();
  let previousRoute = $derived(currentAlbum?.id ? Route.viewAlbum(currentAlbum) : Route.photos());
  /**
   * FL-36: where the stored description came from, reported by the enrichment card so the
   * editor above can badge it without a second request. Reset per asset, because a
   * provenance carried over from the previous item would be a lie about this one.
   */
  let descriptionReview = $state<DescriptionReview | null>(null);

  const refreshAlbums = async () => {
    if (authManager.isSharedLink) {
      return [];
    }

    try {
      return await getAllAlbums({ assetId: asset.id });
    } catch (error) {
      handleError(error, 'Error getting asset album membership');
      return [];
    }
  };

  let albums = $derived(refreshAlbums());

  $effect(() => {
    if (!previousId) {
      previousId = asset.id;
      return;
    }

    if (asset.id === previousId) {
      return;
    }

    descriptionReview = null;
    previousId = asset.id;
  });

  const handleRefreshPeople = async () => {
    const updatedAsset = await getAssetInfo({ id: asset.id });
    onAssetUpdate?.(updatedAsset);
    faceManager.clear();
    await faceManager.getAssetFaces(asset.id);
  };
</script>

<OnEvents onAlbumAddAssets={() => (albums = refreshAlbums())} />

<section class="relative p-2">
  <div class="flex place-items-center gap-2">
    <IconButton
      icon={mdiClose}
      aria-label={$t('close')}
      onclick={() => assetViewerManager.closeDetailPanel()}
      shape="round"
      color="secondary"
      variant="ghost"
    />
    <p class="text-lg text-immich-fg dark:text-immich-dark-fg">{$t('frameleaf_viewer_information_heading')}</p>
  </div>

  <!-- V-6: a missing original is explained by the viewer's offline banner (ViewerOfflineBanner), not again here. -->

  <DetailPanelDescription
    {asset}
    {isOwner}
    review={descriptionReview}
    onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)}
  />
  <DetailPanelImageEnrichment
    {asset}
    {isOwner}
    onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)}
    {onAssetSuppressed}
    onDescriptionReview={(review) => (descriptionReview = review)}
  />
  <!-- FL-59: a video's reusable frames, cover and timestamped moments. -->
  <VideoMomentsPanel {asset} {isOwner} />
  <DetailPanelRating {asset} {isOwner} onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)} />
  <DetailPanelPeople {asset} {isOwner} {previousRoute} onFacesChanged={handleRefreshPeople} />

  <!-- FL-36: the design's Captured section carries the date, the timezone and the place. -->
  <div class="p-4">
    <div class="flex h-10 w-full items-center justify-between text-sm">
      <Text size="small" color="muted">{$t('frameleaf_info_captured')}</Text>
    </div>

    {#if !asset.exifInfo}
      <Text size="small" color="muted">{$t('no_exif_info_available')}</Text>
    {/if}

    <DetailPanelDate {asset} onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)} />

    <DetailPanelLocation {isOwner} {asset} onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)} />
  </div>

  <!--
      FL-36: the file, path, image, camera, lens, exposure, video and checksum rows the design
      puts under Details. `infoDetailRows` decides which of them this asset can fill and keeps
      the path and the checksum owner-only.
    -->
  <ViewerDetailRows {asset} {isOwner} />

  {#if authManager.authenticated && authManager.preferences.tags.enabled}
    <DetailPanelTags {asset} {isOwner} onAssetRefresh={(updatedAsset) => onAssetUpdate?.(updatedAsset)} />
  {/if}
  {#if authManager.authenticated}
    <DetailPanelClassification {asset} {isOwner} />
  {/if}
</section>

{#if latlng && featureFlagsManager.value.map}
  <div class="h-90">
    {#await import('$lib/components/shared-components/map/Map.svelte')}
      {#await delay(timeToLoadTheMap) then}
        <!-- show the loading spinner only if loading the map takes too much time -->
        <div class="flex size-full items-center justify-center">
          <LoadingSpinner />
        </div>
      {/await}
    {:then { default: Map }}
      <Map
        mapMarkers={[
          {
            lat: latlng.lat,
            lon: latlng.lng,
            id: asset.id,
            city: asset.exifInfo?.city ?? null,
            state: asset.exifInfo?.state ?? null,
            country: asset.exifInfo?.country ?? null,
          },
        ]}
        center={latlng}
        zoom={12.5}
        simplified
        useLocationPin
        showSimpleControls
        onOpenInMapView={() => goto(Route.map({ ...latlng, zoom: 12.5 }))}
      >
        {#snippet popup({ marker })}
          {@const { lat, lon } = marker}
          <div class="flex flex-col items-center gap-1">
            <Text fontWeight="bold">{lat.toPrecision(6)}, {lon.toPrecision(6)}</Text>
            <Link
              href="https://www.openstreetmap.org/?mlat={lat}&mlon={lon}&zoom=13#map=15/{lat}/{lon}"
              class="text-primary"
            >
              {$t('open_in_openstreetmap')}
            </Link>
          </div>
        {/snippet}
      </Map>
    {/await}
  </div>
{/if}

{#await albums then albums}
  {#if albums.length > 0}
    <section class="p-6 dark:text-immich-dark-fg">
      <div class="pb-4">
        <Text size="small" color="muted">{$t('appears_in')}</Text>
      </div>
      {#each albums as album (album.id)}
        <a href={Route.viewAlbum(album)}>
          <div class="flex items-center gap-4 pt-2 hover:cursor-pointer">
            <div>
              <img
                alt={album.albumName}
                class="size-12.5 rounded-sm object-cover"
                src={album.albumThumbnailAssetId &&
                  getAssetMediaUrl({ id: album.albumThumbnailAssetId, size: AssetMediaSize.Preview })}
                draggable="false"
              />
            </div>

            <div class="my-auto">
              <p class="dark:text-immich-dark-primary">{album.albumName}</p>
              <div class="flex flex-col gap-0 text-sm">
                <div>
                  <AlbumListItemDetails {album} />
                </div>
              </div>
            </div>
          </div>
        </a>
      {/each}
    </section>
  {/if}
{/await}

<!-- V-27: who owns or shared someone else's item, under the albums (MediaViewer.jsx:2514-2519). -->
{#if owner}
  <p class="fl-owner" data-testid="detail-panel-owner">
    <Icon icon={mdiAccountOutline} size="16" aria-hidden />
    {owner.kind === 'shared'
      ? $t('frameleaf_info_shared_by', { values: { name: owner.name } })
      : $t('frameleaf_info_owned_by', { values: { name: owner.name } })}
  </p>
{/if}

<!-- FL-63: the design puts "Text in this photo" last, after the albums and the owner. -->
<DocumentTextSection {asset} />

<div class="pb-12"></div>

<style>
  /* .mv-owner (media-viewer.css:1690-1699). */
  .fl-owner {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0 24px;
    padding: 16px 0;
    border-bottom: 1px solid var(--fl-viewer-border, rgb(255 255 255 / 8%));
    color: var(--fl-viewer-muted, #979ba2);
    font-size: var(--fl-font-small, 13px);
  }
</style>
