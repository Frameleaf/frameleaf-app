<!--
  The server preview panel (FL-96, `STU-402`).

  One picture, honestly labelled: while the editor plays, the render worker's WebRTC stream of the
  stored revision; while it is paused, or when streaming is not available, the exact frame rendered
  for the playhead. The stream is shown only once the worker reports a frame of the newest seek, so
  a picture from before a seek or from an earlier revision is never passed off as current. It works
  without WebCodecs and without local HEVC decoding, because the browser's own media stack decodes
  the stream.

  The panel is opened from the Studio header. It sits in the lower corner of the editor and moves
  clear of an open drawer (`--fl-studio-drawer-width`, set by the host), so it never covers the
  comment field. The host measures it (`data-studio-dock-clear`) so the upload and download dock, which
  lives in the same corner of the window, rises above it.

  The panel never fetches anything. The route owns both clients and hands them in as data; when the
  stream is revoked, closed or unavailable its `stream` is null and the video element is emptied.
-->
<script lang="ts">
  import type { StudioPreviewView } from '$lib/frameleaf/studio/preview';
  import { studioStreamMessageKey, type StudioStreamView } from '$lib/frameleaf/studio/preview-stream';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { pop } from '$lib/frameleaf/motion';
  import { popOut } from '$lib/frameleaf/studio/chrome-motion';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';

  let {
    open = $bindable(false),
    preview,
    stream,
    available,
    onVideoSize,
  }: {
    open?: boolean;
    preview: StudioPreviewView;
    stream: StudioStreamView;
    /** A render worker is live; without one the panel says so instead of waiting. */
    available: boolean;
    onVideoSize?: (width: number, height: number) => void;
  } = $props();

  let video = $state<HTMLVideoElement>();

  // The element always holds exactly the stream the client says may be shown, and nothing once it
  // says otherwise: a revoked or closed session leaves no picture behind in the element.
  $effect(() => {
    const element = video;
    const source = stream.stream;
    if (!element) {
      return;
    }
    if (element.srcObject !== source) {
      element.srcObject = source;
      if (source) {
        void element.play().catch(() => {});
      }
    }
  });

  const exactFrame = $derived(
    preview.phase === 'ready' ? preview.frame : preview.phase === 'stale' ? preview.staleFrame : null,
  );

  const message = $derived.by((): Translations | null => {
    if (!available) {
      return 'frameleaf_studio_server_preview_no_worker';
    }
    const streamKey = studioStreamMessageKey(stream);
    if (streamKey) {
      return streamKey as Translations;
    }
    if (stream.live) {
      return null;
    }
    if (['rendering', 'stale', 'unavailable'].includes(preview.phase)) {
      return preview.messageKey;
    }
    return preview.phase === 'ready' && preview.frame?.toneMapped ? 'frameleaf_studio_preview_tone_mapped' : null;
  });

  const onResize = () => {
    if (video && video.videoWidth > 0) {
      onVideoSize?.(video.videoWidth, video.videoHeight);
    }
  };
</script>

{#if open}
  <section
    class="fl-server-preview"
    aria-label={$t('frameleaf_studio_server_preview')}
    data-testid="studio-server-preview"
    data-studio-dock-clear
    data-stream-phase={stream.phase}
    data-preview-phase={preview.phase}
    in:pop
    out:popOut
  >
    <header>
      <strong>{$t('frameleaf_studio_server_preview')}</strong>
      <IconButton label={$t('frameleaf_studio_server_preview_hide')} onclick={() => (open = false)}>
        <Icon icon={mdiClose} size={ICON_SIZE.md} />
      </IconButton>
    </header>
    <div class="fl-server-preview-canvas">
      <!-- Muted: preview playback is picture only, and autoplay needs it. -->
      <video
        bind:this={video}
        muted
        playsinline
        autoplay
        class:hidden={!stream.live}
        data-testid="studio-stream-video"
        data-live={stream.live}
        onresize={onResize}
      ></video>
      {#if !stream.live && exactFrame}
        <img
          src={exactFrame.objectUrl}
          alt=""
          data-testid="studio-exact-frame"
          data-revision={exactFrame.revision}
          class:stale={preview.phase === 'stale'}
        />
      {/if}
    </div>
    {#if message}
      <p role="status" aria-live="polite" data-testid="studio-server-preview-status">{$t(message)}</p>
    {/if}
  </section>
{/if}

<style>
  .fl-server-preview {
    position: absolute;
    inset-inline-end: calc(var(--fl-space-4) + var(--fl-studio-drawer-width, 0rem));
    bottom: var(--fl-space-4);
    z-index: 3;
    width: 20rem;
    max-width: calc(100% - var(--fl-space-8));
    padding: var(--fl-space-2);
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-3);
    /* It grows from the corner it is docked in. */
    transform-origin: bottom right;
    transition: inset-inline-end var(--fl-motion-slow) var(--fl-ease);
  }
  :global([dir='rtl']) .fl-server-preview {
    transform-origin: bottom left;
  }
  /* A narrow editor has no room beside a drawer: the panel stays in its corner, above it. */
  @media (max-width: 43.75rem) {
    .fl-server-preview {
      inset-inline-end: var(--fl-space-4);
    }
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-2);
    margin-bottom: var(--fl-space-1);
    padding-inline-start: var(--fl-space-1);
  }
  .fl-server-preview-canvas {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--fl-viewer-canvas);
    border-radius: var(--fl-radius-sm);
  }
  .fl-server-preview-canvas video,
  .fl-server-preview-canvas img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .fl-server-preview-canvas video.hidden {
    visibility: hidden;
  }
  .fl-server-preview-canvas img {
    transition: opacity var(--fl-motion) var(--fl-ease);
  }
  .fl-server-preview-canvas img.stale {
    opacity: 0.5;
  }
  p {
    margin: var(--fl-space-2) var(--fl-space-1) 0;
    color: var(--fl-muted);
  }
</style>
