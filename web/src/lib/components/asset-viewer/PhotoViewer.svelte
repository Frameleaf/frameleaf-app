<script lang="ts">
  import { shortcuts } from '$lib/actions/shortcut';
  import { isControlTarget } from '$lib/frameleaf/viewer-keys';
  import { zoomImageAction } from '$lib/actions/zoom-image';
  import AdaptiveImage from '$lib/components/AdaptiveImage.svelte';
  import OcrBoundingBox from '$lib/components/asset-viewer/OcrBoundingBox.svelte';
  import AssetViewerEvents from '$lib/components/AssetViewerEvents.svelte';
  import Thumbhash from '$lib/components/Thumbhash.svelte';
  import { assetViewerManager, type Faces } from '$lib/managers/asset-viewer-manager.svelte';
  import { castManager } from '$lib/managers/cast-manager.svelte';
  import { faceManager } from '$lib/stores/face.svelte';
  import { ocrManager } from '$lib/stores/ocr.svelte';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import { effectiveTransition, SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';
  import { SlideshowLook, SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { handlePromiseError } from '$lib/utils';
  import { canCopyImageToClipboard, copyImageToClipboard } from '$lib/utils/asset-utils';
  import { getNaturalSize, scaleToFit, type Size } from '$lib/utils/container-utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getOcrBoundingBoxes } from '$lib/utils/ocr-utils';
  import { getBoundingBox, type BoundingBox } from '$lib/utils/people-utils';
  import { type SharedLinkResponseDto } from '@immich/sdk';
  import { toastManager } from '@immich/ui';
  import { onDestroy, untrack } from 'svelte';
  import { useSwipe, type SwipeCustomEvent } from 'svelte-gestures';
  import { t } from 'svelte-i18n';
  import type { AssetCursor } from './AssetViewer.svelte';

  type Props = {
    cursor: AssetCursor;
    element?: HTMLDivElement;
    sharedLink?: SharedLinkResponseDto;
    onReady?: () => void;
    onError?: () => void;
    onSwipe?: (event: SwipeCustomEvent) => void;
  };

  let { cursor, element = $bindable(), sharedLink, onReady, onError, onSwipe }: Props = $props();

  const { slideshowState, slideshowLook, slideshowTransition } = slideshowStore;
  const asset = $derived(cursor.current);

  let visibleImageReady: boolean = $state(false);

  let previousAssetId: string | undefined;
  $effect.pre(() => {
    const id = asset.id;
    if (id === previousAssetId) {
      return;
    }
    previousAssetId = id;
    untrack(() => {
      assetViewerManager.resetZoomState();
      visibleImageReady = false;
      assetViewerManager.clearHighlightedFaces();
    });
  });

  onDestroy(() => {
    assetViewerManager.clearHighlightedFaces();
    assetViewerManager.hideHiddenPeople();
  });

  let containerWidth = $state(0);
  let containerHeight = $state(0);

  const container = $derived({
    width: containerWidth,
    height: containerHeight,
  });

  const overlaySize = $derived.by((): Size => {
    if (!assetViewerManager.imgRef || !visibleImageReady) {
      return { width: 0, height: 0 };
    }

    return scaleToFit(getNaturalSize(assetViewerManager.imgRef), { width: containerWidth, height: containerHeight });
  });

  const highlightedBoxes = $derived(getBoundingBox(assetViewerManager.highlightedFaces, overlaySize));
  const isHighlighting = $derived(highlightedBoxes.length > 0);

  let visibleBoxes = $state<BoundingBox[]>([]);
  $effect(() => {
    if (isHighlighting) {
      visibleBoxes = highlightedBoxes;
    }
  });

  const ocrBoxes = $derived(ocrManager.showOverlay ? getOcrBoundingBoxes(ocrManager.data, overlaySize) : []);

  // FL-63: the region of the line or value the information panel points at, on this photo only
  const documentHighlight = $derived(
    ocrManager.highlight?.assetId === asset.id
      ? getOcrBoundingBoxes([ocrManager.highlight], overlaySize)[0]
      : undefined,
  );

  const onCopy = async () => {
    if (!canCopyImageToClipboard() || !assetViewerManager.imgRef) {
      return;
    }

    try {
      await copyImageToClipboard(assetViewerManager.imgRef);
      toastManager.info($t('copied_image_to_clipboard'));
    } catch (error) {
      handleError(error, $t('copy_error'));
    }
  };

  const onZoom = () => {
    const targetZoom = assetViewerManager.zoom > 1 ? 1 : 2;
    assetViewerManager.animatedZoom(targetZoom);
  };

  // Keyboard zoom steps (+ / = and -), bounded by the fit level and the wheel zoom's maximum.
  const onZoomIn = () => assetViewerManager.animatedZoom(Math.min(assetViewerManager.zoom * 1.25, 10));
  const onZoomOut = () => assetViewerManager.animatedZoom(Math.max(assetViewerManager.zoom / 1.25, 1));

  // S starts a slideshow; while one runs, the slideshow controls own S (play and pause).
  const onPlaySlideshow = () => {
    if ($slideshowState === SlideshowState.None) {
      $slideshowState = SlideshowState.PlaySlideshow;
    }
  };

  // TODO move to action + command palette
  const onCopyShortcut = (event: KeyboardEvent) => {
    // eslint-disable-next-line unicorn/no-unnecessary-global-this
    if (globalThis.getSelection()?.type === 'Range') {
      return;
    }
    event.preventDefault();

    handlePromiseError(onCopy());
  };

  let currentPreviewUrl = $state<string>();

  const onUrlChange = (url: string) => {
    currentPreviewUrl = url;
  };

  $effect(() => {
    if (currentPreviewUrl) {
      void cast(currentPreviewUrl);
    }
  });

  const cast = async (url: string) => {
    if (!url || !castManager.isCasting) {
      return;
    }
    const fullUrl = new URL(url, location.href);

    try {
      await castManager.loadMedia(fullUrl.href);
    } catch (error) {
      handleError(error, 'Unable to cast');
      return;
    }
  };

  // FL-36: the Memories transition plays over a dimmed, blurred backdrop of the photo
  // (MediaViewer.jsx:1350-1358), as the Blurred background look does.
  const memoriesBackdrop = $derived(
    $slideshowState !== SlideshowState.None &&
      effectiveTransition($slideshowTransition, prefersReducedMotion()) === SlideshowTransition.Memories,
  );
  const blurredSlideshow = $derived(
    $slideshowState !== SlideshowState.None &&
      ($slideshowLook === SlideshowLook.BlurredBackground || memoriesBackdrop) &&
      !!asset.thumbhash,
  );

  let adaptiveImage = $state<HTMLDivElement | undefined>();

  const faceToNameMap = $derived.by(() => {
    const map = new Map<Faces, string>();
    for (const face of faceManager.data) {
      if (!face.person) {
        continue;
      }
      if (face.person.isHidden && !assetViewerManager.isShowingHiddenPeople) {
        continue;
      }
      map.set(face, face.person.name);
    }
    return map;
  });

  const faces = $derived(Array.from(faceToNameMap.keys()));

  const boundingBoxes = $derived.by(() => {
    if (assetViewerManager.isFaceEditMode || ocrManager.showOverlay) {
      return [];
    }

    const knownBoxes = getBoundingBox(faces, overlaySize);
    const result = knownBoxes.map((box, index) => ({
      ...box,
      face: faces[index],
      name: faceToNameMap.get(faces[index]),
    }));

    if (assetViewerManager.highlightedFaces.length === 0) {
      return result;
    }

    const knownIds = new Set(faces.map((f) => f.id));
    const unassignedFaces = assetViewerManager.highlightedFaces.filter((f) => !knownIds.has(f.id));
    const unassignedBoxes = getBoundingBox(unassignedFaces, overlaySize);
    for (let i = 0; i < unassignedBoxes.length; i++) {
      result.push({ ...unassignedBoxes[i], face: unassignedFaces[i], name: undefined });
    }

    return result;
  });
</script>

<AssetViewerEvents {onCopy} {onZoom} />

<svelte:document
  use:shortcuts={[
    { shortcut: { key: 'z' }, onShortcut: onZoom, preventDefault: true },
    // FL-38: the face tagger is a modal dialog that keeps its keys to itself, so zoom needs no carve-out.
    { shortcut: { key: '=' }, onShortcut: onZoomIn, preventDefault: true },
    { shortcut: { key: '+' }, onShortcut: onZoomIn, preventDefault: true },
    { shortcut: { key: '+', shift: true }, onShortcut: onZoomIn, preventDefault: true },
    { shortcut: { key: '-' }, onShortcut: onZoomOut, preventDefault: true },
    { shortcut: { key: 's' }, onShortcut: onPlaySlideshow, preventDefault: true },
    // V-15: Space plays the slideshow too, unless it is pressing a focused control (MediaViewer.jsx:781-784).
    {
      shortcut: { key: ' ' },
      onShortcut: (event) => {
        if (isControlTarget(event.target)) {
          return;
        }
        event.preventDefault();
        onPlaySlideshow();
      },
    },
    { shortcut: { key: 'c', ctrl: true }, onShortcut: onCopyShortcut, preventDefault: false },
    { shortcut: { key: 'c', meta: true }, onShortcut: onCopyShortcut, preventDefault: false },
  ]}
/>

<div
  bind:this={element}
  class="relative size-full select-none"
  bind:clientWidth={containerWidth}
  bind:clientHeight={containerHeight}
  role="presentation"
  ondblclick={onZoom}
  use:zoomImageAction={{ zoomTarget: adaptiveImage }}
  {...useSwipe((event) => onSwipe?.(event))}
>
  <AdaptiveImage
    {asset}
    {sharedLink}
    {container}
    objectFit={$slideshowState !== SlideshowState.None && $slideshowLook === SlideshowLook.Cover ? 'cover' : 'contain'}
    {onUrlChange}
    onImageReady={() => {
      visibleImageReady = true;
      onReady?.();
    }}
    onError={() => {
      onError?.();
      onReady?.();
    }}
    bind:imgRef={assetViewerManager.imgRef}
    bind:ref={adaptiveImage}
  >
    {#snippet backdrop()}
      {#if blurredSlideshow}
        <Thumbhash
          base64ThumbHash={asset.thumbhash!}
          class="absolute inset-s-0 top-0 left-0 h-dvh w-dvw {memoriesBackdrop ? 'brightness-50 saturate-[1.15]' : ''}"
        />
      {/if}
    {/snippet}
    {#snippet overlays()}
      <div
        class="pointer-events-none absolute inset-0 transition-opacity duration-150"
        style:opacity={isHighlighting ? 1 : 0}
      >
        <svg class="absolute inset-0 size-full">
          <defs>
            <mask id="face-dim-mask">
              <rect width="100%" height="100%" fill="white" />
              {#each visibleBoxes as box (box.id)}
                <rect x={box.left} y={box.top} width={box.width} height={box.height} fill="black" rx="8" />
              {/each}
            </mask>
          </defs>
          <rect width="100%" height="100%" fill="rgba(0,0,0,0.4)" mask="url(#face-dim-mask)" />
        </svg>
      </div>
      {#each boundingBoxes as boundingbox (boundingbox.id)}
        {@const isActive = assetViewerManager.highlightedFaces.some((f) => f.id === boundingbox.id)}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div
          class="pointer-events-auto absolute rounded-lg {isActive && 'border-3 border-solid border-white'}"
          style="top: {boundingbox.top}px; left: {boundingbox.left}px; height: {boundingbox.height}px; width: {boundingbox.width}px;"
          onpointerenter={() => assetViewerManager.setHighlightedFaces([boundingbox.face])}
          onpointerleave={() => assetViewerManager.clearHighlightedFaces()}
        >
          {#if isActive && boundingbox.name}
            <div
              aria-hidden="true"
              class="absolute rounded-sm bg-white/90 px-2 py-1 text-sm font-medium whitespace-nowrap text-black shadow-lg"
              style="top: {boundingbox.height + 4}px; {assetViewerManager.imgRef
                ? boundingbox.left >= 0
                  ? `right: ${Math.max(boundingbox.left + boundingbox.width - assetViewerManager.imgRef.clientWidth, 0)}px;`
                  : `left: ${-boundingbox.left}px;`
                : ''}"
            >
              {boundingbox.name}
            </div>
          {/if}
        </div>
      {/each}

      {#each ocrBoxes as ocrBox (ocrBox.id)}
        <OcrBoundingBox {ocrBox} />
      {/each}

      {#if documentHighlight}
        <svg
          class="pointer-events-none absolute top-0 left-0 overflow-visible"
          width={overlaySize.width}
          height={overlaySize.height}
          aria-hidden="true"
          data-testid="document-region-highlight"
        >
          <polygon
            points={documentHighlight.points.map((point) => `${point.x},${point.y}`).join(' ')}
            fill="rgb(14 165 160 / 18%)"
            stroke="#0ea5a0"
            stroke-width="2"
            stroke-dasharray="6 4"
          />
        </svg>
      {/if}
    {/snippet}
  </AdaptiveImage>
</div>
