<!--
  The server preview panel (FL-96, `STU-402`).

  One picture, honestly labelled: while the editor plays, the render worker's WebRTC stream of the
  stored revision; while it is paused, or when streaming is not available, the exact frame rendered
  for the playhead. The stream is shown only once the worker reports a frame of the newest seek, so
  a picture from before a seek or from an earlier revision is never passed off as current. It works
  without WebCodecs and without local HEVC decoding, because the browser's own media stack decodes
  the stream.

  The panel never fetches anything. The route owns both clients and hands them in as data; when the
  stream is revoked, closed or unavailable its `stream` is null and the video element is emptied.
-->
<script lang="ts">
  import type { StudioPreviewView } from '$lib/frameleaf/studio/preview';
  import { studioStreamMessageKey, type StudioStreamView } from '$lib/frameleaf/studio/preview-stream';
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
    data-stream-phase={stream.phase}
    data-preview-phase={preview.phase}
  >
    <header>
      <strong>{$t('frameleaf_studio_server_preview')}</strong>
      <button type="button" class="fl-server-preview-hide" onclick={() => (open = false)}>
        {$t('frameleaf_studio_server_preview_hide')}
      </button>
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
{:else if available}
  <button
    type="button"
    class="fl-server-preview fl-server-preview-show"
    data-testid="studio-server-preview-show"
    onclick={() => (open = true)}
  >
    {$t('frameleaf_studio_server_preview_show')}
  </button>
{/if}

<style>
  .fl-server-preview {
    position: absolute;
    right: 1rem;
    bottom: 1rem;
    z-index: 3;
    font-size: 0.75rem;
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card, 14px);
    box-shadow: var(--fl-shadow-2);
  }
  section.fl-server-preview {
    width: 20rem;
    max-width: calc(100% - 2rem);
    padding: 0.5rem;
  }
  .fl-server-preview-show {
    padding: 0.375rem 0.75rem;
    cursor: pointer;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 0.375rem;
  }
  .fl-server-preview-hide {
    color: inherit;
    cursor: pointer;
    background: none;
    border: 0;
  }
  .fl-server-preview-canvas {
    position: relative;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    background: var(--fl-viewer-canvas, #000);
    border-radius: 0.5rem;
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
  .fl-server-preview-canvas img.stale {
    opacity: 0.5;
  }
  p {
    margin: 0.375rem 0 0;
    color: var(--fl-muted);
  }
</style>
