<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';
  import { searchGallerySelfie } from '$lib/frameleaf/photography/workflow-api';
  import { PhotographyError } from '$lib/frameleaf/photography/errors';
  import Button from './Button.svelte';
  import Dialog from './Dialog.svelte';
  import { photographyErrorKey } from './PhotographyStatus.svelte';

  let {
    open = $bindable(false),
    galleryId,
    session,
    onResults,
    onAccessEnded,
  }: {
    open?: boolean;
    galleryId: string;
    session: string;
    onResults: (ids: string[]) => void;
    onAccessEnded: () => void;
  } = $props();
  let phase = $state<'choose' | 'searching' | 'empty' | 'error'>('choose');
  let selected = $state<File>();
  let consent = $state(false);
  let failure = $state<unknown>();
  let camera = $state<MediaStream>();
  let cameraError = $state(false);
  let cameraReady = $state(false);
  let cameraStarting = $state(false);
  let video = $state<HTMLVideoElement>();
  let retryAt = $state(0);
  let now = $state(Date.now());
  const remaining = $derived(Math.max(0, Math.ceil((retryAt - now) / 1000)));
  let request: AbortController | undefined;
  let cameraRequest = 0;
  let disposed = false;

  function stopCamera() {
    cameraRequest++;
    camera?.getTracks().forEach((track) => track.stop());
    camera = undefined;
    cameraReady = false;
    cameraStarting = false;
    if (video) {
      video.srcObject = null;
    }
  }
  function clearInput() {
    selected = undefined;
    consent = false;
    stopCamera();
  }
  $effect(() => {
    if (!open) {
      request?.abort();
      request = undefined;
      clearInput();
      phase = 'choose';
      failure = undefined;
      cameraError = false;
    }
  });
  $effect(() => {
    if (!retryAt) {
      return;
    }
    const timer = setInterval(() => {
      now = Date.now();
      if (now >= retryAt) {
        retryAt = 0;
      }
    }, 1000);
    return () => clearInterval(timer);
  });
  onDestroy(() => {
    disposed = true;
    request?.abort();
    clearInput();
  });

  function choose(file?: File) {
    clearInput();
    failure = undefined;
    if (!file) {
      return;
    }
    if (!file.type.startsWith('image/') || file.size > 10 * 1024 * 1024 || file.size === 0) {
      failure = new PhotographyError('selfie_invalid_image');
      phase = 'error';
      return;
    }
    selected = file;
    phase = 'choose';
  }
  async function startCamera() {
    stopCamera();
    const current = ++cameraRequest;
    cameraStarting = true;
    cameraError = false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      if (disposed || !open || current !== cameraRequest) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      camera = stream;
      selected = undefined;
      consent = false;
      await tick();
      if (disposed || !open || current !== cameraRequest) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      if (video) {
        video.srcObject = stream;
        await video.play();
      }
    } catch {
      if (!disposed && open && current === cameraRequest) {
        stopCamera();
        cameraError = true;
      }
    } finally {
      if (current === cameraRequest) {
        cameraStarting = false;
      }
    }
  }
  async function capture() {
    if (!video?.videoWidth || !video.videoHeight) {
      return;
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1600 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d')?.drawImage(video, 0, 0, canvas.width, canvas.height);
    const current = cameraRequest;
    const image = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!disposed && open && current === cameraRequest && image) {
      choose(new File([image], 'selfie.jpg', { type: 'image/jpeg' }));
    }
    canvas.width = canvas.height = 0;
  }
  async function search() {
    if (!selected || !consent || request || remaining > 0) {
      return;
    }
    const controller = new AbortController();
    request = controller;
    phase = 'searching';
    failure = undefined;
    try {
      const pending = searchGallerySelfie(galleryId, session, selected, controller.signal);
      clearInput();
      const result = await pending;
      if (disposed || !open || request !== controller) {
        return;
      }
      if (result.captureIds.length === 0) {
        phase = 'empty';
      } else {
        onResults(result.captureIds);
        open = false;
      }
    } catch (error) {
      if (disposed || !open || request !== controller) {
        return;
      }
      if (error instanceof PhotographyError && error.code === 'access_ended') {
        open = false;
        onAccessEnded();
        return;
      }
      failure = error instanceof PhotographyError ? error : new PhotographyError('selfie_unavailable');
      if (error instanceof PhotographyError && error.retryAfter) {
        now = Date.now();
        retryAt = now + error.retryAfter * 1000;
      }
      phase = 'error';
    } finally {
      if (request === controller) {
        request = undefined;
      }
    }
  }
</script>

<Dialog bind:open title={$t('frameleaf_clients_selfie_title')} closeLabel={$t('close')}>
  <div class="selfie">
    {#if phase === 'choose'}
      <p>{$t('frameleaf_clients_selfie_intro')}</p>
      <div class="sources">
        <Button disabled={cameraStarting} onclick={startCamera}>{$t('frameleaf_clients_selfie_camera')}</Button>
        <label class="upload">
          {$t('frameleaf_clients_selfie_upload')}
          <input
            type="file"
            accept="image/*"
            onchange={(event) => {
              choose(event.currentTarget.files?.[0]);
              event.currentTarget.value = '';
            }}
          />
        </label>
      </div>
      {#if cameraError}<p role="status">{$t('frameleaf_clients_selfie_camera_denied')}</p>{/if}
      {#if camera}
        <video
          bind:this={video}
          autoplay
          muted
          playsinline
          aria-label={$t('frameleaf_clients_selfie_camera_preview')}
          onloadedmetadata={() => (cameraReady = true)}
        ></video>
        <div class="actions">
          <Button disabled={!cameraReady} onclick={capture}>{$t('frameleaf_clients_selfie_capture')}</Button>
          <Button onclick={stopCamera}>{$t('cancel')}</Button>
        </div>
      {/if}
      {#if selected}<p role="status">
          {$t('frameleaf_clients_selfie_selected', { values: { name: selected.name } })}
        </p>{/if}
      <label class="consent"
        ><input type="checkbox" bind:checked={consent} />{$t('frameleaf_clients_selfie_consent')}</label
      >
    {:else if phase === 'searching'}
      <div role="status" aria-live="polite">
        <h3>{$t('frameleaf_clients_selfie_searching')}</h3>
        <p>{$t('frameleaf_clients_selfie_searching_body')}</p>
      </div>
    {:else if phase === 'empty'}
      <div role="status">
        <h3>{$t('frameleaf_clients_selfie_empty')}</h3>
        <p>{$t('frameleaf_clients_selfie_empty_body')}</p>
      </div>
    {:else}
      <p role="alert">
        {failure instanceof PhotographyError && failure.code === 'wait'
          ? $t('frameleaf_clients_selfie_wait', { values: { seconds: remaining } })
          : $t(photographyErrorKey(failure))}
      </p>
    {/if}
    {#if phase === 'choose' && remaining > 0}<p role="status">
        {$t('frameleaf_clients_selfie_wait', { values: { seconds: remaining } })}
      </p>{/if}
  </div>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    {#if phase === 'choose'}
      <Button variant="primary" disabled={!selected || !consent || remaining > 0} onclick={search}
        >{$t('frameleaf_clients_selfie_title')}</Button
      >
    {:else if phase !== 'searching'}
      <Button
        variant="primary"
        onclick={() => {
          clearInput();
          phase = 'choose';
          failure = undefined;
        }}>{$t('frameleaf_clients_selfie_again')}</Button
      >
    {/if}
  {/snippet}
</Dialog>

<style>
  .selfie {
    display: grid;
    gap: 20px;
    padding: 8px 0;
  }
  .selfie p,
  .selfie h3 {
    margin: 0;
  }
  .sources {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .upload {
    display: grid;
    gap: 12px;
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 14px;
  }
  .upload input {
    max-width: 100%;
    font: inherit;
  }
  .consent {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    line-height: 1.5;
  }
  .consent input {
    flex: none;
    margin-top: 5px;
  }
  .actions {
    display: flex;
    gap: 12px;
  }
  video {
    width: 100%;
    max-height: 340px;
    border-radius: 16px;
    background: #111;
  }
  @media (max-width: 540px) {
    .sources {
      grid-template-columns: 1fr;
    }
  }
</style>
