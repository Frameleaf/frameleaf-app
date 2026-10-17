<script lang="ts">
  /**
   * The RAW develop editor (FL-420, prototype PhotographyEditor.jsx). A shoot's RAW photographs in a
   * filmstrip, the Darkroom column (file, histogram, the shoot, sync and the render queue), the photo
   * and the inspector (Develop, Masks, Presets, Versions).
   *
   * Every adjustment is a native version 2 recipe the server develops from the sensor data with its
   * pinned darktable engine (FL-282): previews render on the server as the sliders move, and Save
   * version stores a version that the server renders at full resolution. The original is never
   * changed. The viewer opens it for a single photo (`NativeRawEditor`).
   */
  import { AssetMediaSize, getAssetInfo } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArrowLeft,
    mdiCameraIris,
    mdiCheck,
    mdiCompare,
    mdiContentDuplicate,
    mdiCropRotate,
    mdiExportVariant,
    mdiImageMultipleOutline,
    mdiRedo,
    mdiRotateLeft,
    mdiRotateRight,
    mdiSelectAll,
    mdiShieldCheckOutline,
    mdiSync,
    mdiTune,
    mdiUndo,
  } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PhotographyThumb from '$lib/components/frameleaf/PhotographyThumb.svelte';
  import DevelopHistogram from '$lib/components/frameleaf/develop/DevelopHistogram.svelte';
  import DevelopPanel from '$lib/components/frameleaf/develop/DevelopPanel.svelte';
  import DevelopSlider from '$lib/components/frameleaf/develop/DevelopSlider.svelte';
  import DevelopStage from '$lib/components/frameleaf/develop/DevelopStage.svelte';
  import DevelopStars from '$lib/components/frameleaf/develop/DevelopStars.svelte';
  import MasksPanel from '$lib/components/frameleaf/develop/MasksPanel.svelte';
  import PresetsPanel from '$lib/components/frameleaf/develop/PresetsPanel.svelte';
  import VersionsPanel from '$lib/components/frameleaf/develop/VersionsPanel.svelte';
  import '$lib/frameleaf/develop/develop-editor.css';
  import {
    ASPECTS,
    SYNC_FIELDS,
    SYNC_GROUPS,
    aspectCrop,
    extensionOf,
    originalFraming,
    sendable,
    syncSource,
    turn,
    type Aspect,
    type Histogram,
    type SyncGroup,
  } from '$lib/frameleaf/raw-develop';
  import { DevelopPreviewLoader } from '$lib/frameleaf/raw-develop-preview.svelte';
  import {
    DevelopTools,
    RawDevelopSession,
    type DevelopPhoto,
    type DevelopTab,
  } from '$lib/frameleaf/raw-develop-session.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { downloadArchive, downloadAssetFile, ignoreCancelledDownload } from '$lib/utils/asset-utils';

  let {
    photos,
    initialId,
    shoot = null,
    onBack,
    onProof,
    onRendered,
    onLegacy,
    rate,
  }: {
    photos: DevelopPhoto[];
    initialId?: string;
    /** The shoot the photos belong to; without one the editor works on a single photo from the viewer. */
    shoot?: { id: string; name: string } | null;
    /** Leaves the editor, once unsaved changes were saved or discarded. */
    onBack: () => void;
    /** Proof: back to the shoot's galleries with the selected photos. */
    onProof?: (selectedIds: string[]) => void;
    /** A saved version is now the one the library shows. */
    onRendered?: (assetId: string) => void;
    /** The viewer's way back to the quick editor. */
    onLegacy?: () => void;
    rate?: (assetId: string, rating: number | null) => Promise<void>;
  } = $props();

  // svelte-ignore state_referenced_locally
  const session = new RawDevelopSession(photos, initialId, {
    onPublished: (id) => onRendered?.(id),
  });
  const tools = new DevelopTools();
  const loader = new DevelopPreviewLoader();
  const TABS: [DevelopTab, Translations][] = [
    ['develop', 'frameleaf_develop_tab_develop'],
    ['masks', 'frameleaf_develop_tab_masks'],
    ['presets', 'frameleaf_develop_tab_presets'],
    ['versions', 'frameleaf_develop_tab_versions'],
  ];
  const SYNC_LABELS: Record<SyncGroup, Translations> = {
    tone: 'frameleaf_develop_sync_tone',
    colour: 'frameleaf_develop_sync_colour',
    detail: 'frameleaf_develop_sync_detail',
    geometry: 'frameleaf_develop_sync_geometry',
    masks: 'frameleaf_develop_sync_masks',
  };

  let bins = $state<Histogram | null>(null);
  let message = $state('');
  let messageTimer: ReturnType<typeof setTimeout> | undefined;
  let dialog = $state<'version' | 'sync' | 'export' | 'leave' | null>(null);
  let dialogOpen = $state(false);
  let leaving = $state<'back' | 'proof'>('back');
  let versionName = $state('');
  let syncGroups = $state<SyncGroup[]>(['tone', 'colour', 'detail']);
  let working = $state(false);
  let info = $state<Record<string, { camera: string; width: number | null; height: number | null }>>({});

  const multi = $derived(session.photos.length > 1);
  const photo = $derived(session.active);
  const id = $derived(photo?.id ?? '');
  const record = $derived(session.record(id));
  const recipe = $derived(record.recipe);
  const mode = $derived(tools.cropOpen ? 'crop' : tools.tab === 'masks' ? 'masks' : 'develop');
  const selected = $derived(session.photos.filter((item) => session.selected.includes(item.id)));
  const targets = $derived(selected.filter((item) => item.id !== id));
  const placeholder = $derived(id ? getAssetMediaUrl({ id, size: AssetMediaSize.Preview }) : '');
  const dims = $derived(info[id]);
  const busyRevision = $derived(record.revisions.find((item) => item.status === 'queued' || item.status === 'rendering'));
  const latest = $derived(record.revisions[0]);
  const queue = $derived(
    session.photos.flatMap((item) => {
      const revision = session.record(item.id).revisions[0];
      return revision && ['queued', 'rendering', 'failed'].includes(revision.status) ? [{ photo: item, revision }] : [];
    }),
  );
  const shootWindow = $derived.by(() => {
    const start = Math.max(0, Math.min(session.activeIndex - 2, session.photos.length - 6));
    return session.photos.slice(start, start + 6);
  });

  const saveStatus = $derived.by((): { text: string; warning?: boolean } => {
    if (record.status === 'loading') {
      return { text: $t('frameleaf_develop_status_loading') };
    }
    if (session.saving.includes(id)) {
      return { text: $t('frameleaf_develop_status_saving') };
    }
    if (busyRevision) {
      return {
        text:
          busyRevision.status === 'rendering'
            ? $t('frameleaf_develop_status_rendering', { values: { progress: busyRevision.progress } })
            : $t('frameleaf_develop_status_queued'),
      };
    }
    if (latest?.status === 'failed') {
      return { text: $t('frameleaf_develop_status_failed'), warning: true };
    }
    if (session.isDirty(id)) {
      return { text: $t('frameleaf_develop_status_unsaved') };
    }
    return { text: $t('frameleaf_develop_status_saved') };
  });

  const say = (text: string) => {
    message = text;
    clearTimeout(messageTimer);
    messageTimer = setTimeout(() => (message = ''), 5000);
  };
  const show = (kind: NonNullable<typeof dialog>) => {
    dialog = kind;
    dialogOpen = true;
  };
  const hide = () => (dialogOpen = false);

  // The server develops what the stage shows: the original framing while comparing, the whole frame
  // while cropping, the whole sensor image while drawing masks.
  $effect(() => {
    if (!id || record.status !== 'ready') {
      return;
    }
    const base = tools.compare ? originalFraming(recipe) : recipe;
    const request = sendable(mode === 'crop' ? { ...base, crop: undefined } : base);
    if (mode === 'masks') {
      request.sensorCanvas = true;
    }
    loader.request(id, request, tools.zoom === 'fit' ? 1280 : 2048);
  });

  // Another photo: its own preview, camera details and tools.
  $effect(() => {
    const current = id;
    if (!current) {
      return;
    }
    untrack(() => loader.forget(current));
    bins = null;
    if (!untrack(() => info[current])) {
      void getAssetInfo({ id: current })
        .then((asset) => {
          const exif = asset.exifInfo;
          const make = exif?.make?.trim() ?? '';
          const model = exif?.model?.trim() ?? '';
          info[current] = {
            camera: model.toLowerCase().startsWith(make.toLowerCase()) ? model : `${make} ${model}`.trim(),
            width: exif?.exifImageWidth ?? null,
            height: exif?.exifImageHeight ?? null,
          };
        })
        .catch(() => {});
    }
  });

  onMount(() => {
    if (id) {
      void session.open(id);
    }
    session.loadPresets().catch(() => {});
  });
  onDestroy(() => {
    clearTimeout(messageTimer);
    session.dispose();
    loader.dispose();
  });

  function select(next: string) {
    tools.reset();
    void session.open(next);
  }

  async function changeRating(target: DevelopPhoto, rating: number) {
    if (!rate) {
      return;
    }
    const before = target.rating;
    target.rating = rating || null;
    try {
      await rate(target.id, rating || null);
    } catch {
      target.rating = before;
      say($t('frameleaf_develop_rating_not_saved'));
    }
  }

  async function saveVersion(label?: string) {
    try {
      const saved = await session.save(id, label);
      if (saved) {
        say($t('frameleaf_develop_version_saved'));
      }
      return !!saved;
    } catch {
      say($t('frameleaf_develop_version_not_saved'));
      return false;
    }
  }

  function leave(target: 'back' | 'proof') {
    leaving = target;
    if (session.dirtyIds.length > 0) {
      show('leave');
      return;
    }
    proceed();
  }

  function proceed() {
    if (leaving === 'proof') {
      onProof?.(session.selected.length > 0 ? session.selected : session.photos.map((item) => item.id));
    } else {
      onBack();
    }
  }

  async function saveAllAndLeave() {
    working = true;
    try {
      for (const dirty of session.dirtyIds) {
        await session.save(dirty);
      }
      hide();
      proceed();
    } catch {
      say($t('frameleaf_develop_version_not_saved'));
    } finally {
      working = false;
    }
  }

  async function sync() {
    working = true;
    try {
      const fields = syncGroups.flatMap((group) => SYNC_FIELDS[group]);
      const results = await session.sync(
        targets.map((item) => item.id),
        fields,
        syncSource(recipe),
      );
      const done = results.filter((result) => result.status === 'queued').length;
      const failed = results.length - done;
      hide();
      say(
        failed > 0
          ? $t('frameleaf_develop_sync_partial', { values: { done, failed } })
          : $t('frameleaf_develop_sync_done', { values: { count: done } }),
      );
    } catch {
      say($t('frameleaf_develop_sync_failed'));
    } finally {
      working = false;
    }
  }

  function setAspect(aspect: Aspect) {
    session.setAspect(id, aspect);
    if (aspect === 'Free') {
      return;
    }
    const turned = recipe.rotation === 90 || recipe.rotation === 270;
    const width = dims?.width ?? 3;
    const height = dims?.height ?? 2;
    session.patch(id, { crop: aspectCrop(aspect, turned ? height : width, turned ? width : height) });
  }

  const typing = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

  function keyDown(event: KeyboardEvent) {
    if (dialogOpen || typing(event.target) || (event.target as HTMLElement | null)?.closest?.('[role="tablist"]')) {
      return;
    }
    const mod = event.metaKey || event.ctrlKey;
    if (event.key === '\\' && !mod && !event.altKey) {
      event.preventDefault();
      tools.compare = true;
    } else if (multi && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && !mod) {
      event.preventDefault();
      tools.reset();
      session.step(event.key === 'ArrowRight' ? 1 : -1);
    } else if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) {
        session.redo(id);
      } else {
        session.undo(id);
      }
    } else if (mod && event.key.toLowerCase() === 's') {
      event.preventDefault();
      void saveVersion();
    } else if (event.key === 'Escape' && !shoot) {
      event.preventDefault();
      leave('back');
    }
  }

  function tabKey(event: KeyboardEvent, index: number) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? TABS.length - 1
          : (index + (event.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    tools.tab = TABS[next][0];
    tools.cropOpen = false;
    ((event.currentTarget as HTMLElement).parentElement?.children[next] as HTMLElement | undefined)?.focus();
  }
</script>

<svelte:window
  onkeydown={keyDown}
  onkeyup={(event) => {
    if (event.key === '\\' || event.code === 'Backslash') {
      tools.compare = false;
    }
  }}
  onblur={() => (tools.compare = false)}
/>

<main class="rde-workspace" aria-label={$t('frameleaf_develop_editor')}>
  <header class="rde-header">
    <button type="button" class="rde-button rde-back" onclick={() => leave('back')}
      ><Icon icon={mdiArrowLeft} size="16" aria-hidden={true} />{shoot
        ? $t('frameleaf_develop_back_to_shoot')
        : $t('close')}</button
    >
    <div class="rde-heading">
      <strong>{shoot?.name ?? photo?.fileName ?? ''}</strong><span
        >{shoot ? $t('frameleaf_develop_editor') : $t('frameleaf_develop_raw_editor')}</span
      >
    </div>
    <span class="rde-save-status" class:warning={saveStatus.warning} role="status">{saveStatus.text}</span>
    {#if onLegacy}<button type="button" class="rde-button rde-quiet" onclick={onLegacy}
        >{$t('frameleaf_raw_quick_edits')}</button
      >{/if}
    <button
      type="button"
      class="rde-button"
      disabled={record.status !== 'ready' || session.saving.includes(id)}
      onclick={() => {
        versionName = $t('frameleaf_editor_version_number', { values: { revision: record.revisions.length + 1 } });
        show('version');
      }}><Icon icon={mdiContentDuplicate} size="15" aria-hidden={true} />{$t('frameleaf_editor_save_version')}</button
    >
    {#if shoot && onProof}<button type="button" class="rde-button" onclick={() => leave('proof')}
        ><Icon icon={mdiImageMultipleOutline} size="15" aria-hidden={true} />{$t('frameleaf_develop_proof')}</button
      >{/if}
    <button type="button" class="rde-button primary" onclick={() => show('export')}
      ><Icon icon={mdiExportVariant} size="15" aria-hidden={true} />{$t('frameleaf_develop_export')}</button
    >
  </header>

  <aside class="rde-left" aria-label={$t('frameleaf_develop_darkroom_label')}>
    <div class="rde-left-title">
      <Icon icon={mdiCameraIris} size="18" aria-hidden={true} /><strong>{$t('frameleaf_develop_darkroom')}</strong>
    </div>
    {#if photo}
      <div class="rde-file-block">
        <span class="rde-file-type">RAW / {extensionOf(photo.fileName)}</span>
        <h2>{photo.fileName}</h2>
        {#if dims?.camera}<p>{dims.camera}</p>{/if}
        <span class="rde-local"><span></span>{$t('frameleaf_develop_rendered_here')}</span>
      </div>
    {/if}
    <div class="rde-left-section">
      <DevelopHistogram {bins} />
      <div class="rde-hist-caption">
        <span>{$t('frameleaf_develop_histogram')}</span>{#if dims?.width && dims.height}<span
            >{dims.width} × {dims.height}</span
          >{/if}
      </div>
    </div>
    {#if multi}
      <div class="rde-left-section">
        <div class="rde-section-heading">
          <strong>{$t('frameleaf_develop_this_shoot')}</strong><span
            >{$t('frameleaf_develop_photo_count', { values: { count: session.photos.length } })}</span
          >
        </div>
        <div class="rde-shoot-list">
          {#each shootWindow as item (item.id)}
            <button
              type="button"
              class:active={item.id === id}
              aria-current={item.id === id ? 'true' : undefined}
              onclick={() => select(item.id)}
            >
              <span class="rde-thumb"
                ><PhotographyThumb src={getAssetMediaUrl({ id: item.id, size: AssetMediaSize.Thumbnail })} /></span
              >
              <span
                ><strong>{item.fileName}</strong><small
                  >{(item.rating ?? 0) > 0
                    ? $t('frameleaf_develop_stars', { values: { count: item.rating } })
                    : $t('frameleaf_develop_unrated')}{session.isEdited(item.id)
                    ? ` · ${$t('frameleaf_develop_edited')}`
                    : ''}</small
                ></span
              >
              {#if item.id === id}<Icon icon={mdiCheck} size="15" aria-hidden={true} />{/if}
            </button>
          {/each}
        </div>
      </div>
      <div class="rde-left-section">
        <div class="rde-section-heading">
          <strong>{$t('frameleaf_develop_selected_for_sync')}</strong><span>{selected.length}</span>
        </div>
        <p class="rde-muted">{$t('frameleaf_develop_sync_hint')}</p>
        <button type="button" class="rde-button" disabled={targets.length === 0} onclick={() => show('sync')}
          ><Icon icon={mdiSync} size="15" aria-hidden={true} />{$t('frameleaf_develop_sync_to', {
            values: { count: targets.length },
          })}</button
        >
        <button type="button" class="rde-button" onclick={() => session.selectAll()}
          ><Icon icon={mdiSelectAll} size="15" aria-hidden={true} />{$t('frameleaf_develop_select_shoot')}</button
        >
      </div>
    {/if}
    <div class="rde-left-section rde-queue">
      <div class="rde-section-heading">
        <strong>{$t('frameleaf_develop_render_queue')}</strong>
        {#if queue.some((entry) => entry.revision.status !== 'failed')}<button
            type="button"
            class="rde-link"
            onclick={() => {
              for (const entry of queue.filter((item) => item.revision.status !== 'failed')) {
                void session.cancel(entry.photo.id, entry.revision.id).catch(() => {});
              }
            }}>{$t('frameleaf_develop_cancel_queue')}</button
          >{/if}
      </div>
      {#if queue.length === 0}<p class="rde-muted">{$t('frameleaf_develop_render_queue_empty')}</p>{/if}
      {#each queue as entry (entry.revision.id)}
        <div class="rde-queue-item">
          <div>
            <span>{entry.photo.fileName}</span><small
              >{entry.revision.status === 'rendering'
                ? $t('frameleaf_develop_status_rendering', { values: { progress: entry.revision.progress } })
                : entry.revision.status === 'queued'
                  ? $t('frameleaf_develop_status_queued')
                  : $t('frameleaf_develop_status_failed')}</small
            >
          </div>
          <progress
            max="100"
            value={entry.revision.progress}
            aria-label={$t('frameleaf_develop_render_progress', { values: { name: entry.photo.fileName } })}
          ></progress>
          {#if entry.revision.error}<p role="status">{entry.revision.error}</p>{/if}
          {#if entry.revision.status === 'failed'}<button
              type="button"
              class="rde-link"
              onclick={() =>
                session
                  .render(entry.photo.id, entry.revision.id)
                  .catch(() => say($t('frameleaf_develop_action_failed')))}>{$t('frameleaf_develop_render_again')}</button
            >{/if}
        </div>
      {/each}
    </div>
  </aside>

  <section class="rde-centre" aria-label={$t('frameleaf_develop_photo_and_filmstrip')}>
    <div class="rde-preview-toolbar">
      <div>
        <button
          type="button"
          class="rde-button icon-only"
          aria-label={$t('frameleaf_develop_undo')}
          disabled={!record.undo.length}
          onclick={() => session.undo(id)}><Icon icon={mdiUndo} size="16" aria-hidden={true} /></button
        >
        <button
          type="button"
          class="rde-button icon-only"
          aria-label={$t('frameleaf_develop_redo')}
          disabled={!record.redo.length}
          onclick={() => session.redo(id)}><Icon icon={mdiRedo} size="16" aria-hidden={true} /></button
        >
        <span class="rde-toolbar-divider"></span>
        <button
          type="button"
          class="rde-button"
          class:active={tools.cropOpen}
          aria-pressed={tools.cropOpen}
          disabled={record.status !== 'ready'}
          onclick={() => {
            tools.cropOpen = !tools.cropOpen;
            tools.zoom = 'fit';
          }}><Icon icon={mdiCropRotate} size="16" aria-hidden={true} />{$t('frameleaf_develop_crop')}</button
        >
      </div>
      <div>
        <button
          type="button"
          class="rde-button rde-hold"
          aria-label={$t('frameleaf_develop_hold_original_label')}
          aria-pressed={tools.compare}
          onpointerdown={(event) => {
            (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
            tools.compare = true;
          }}
          onpointerup={() => (tools.compare = false)}
          onpointercancel={() => (tools.compare = false)}
          onlostpointercapture={() => (tools.compare = false)}
          onkeydown={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              event.preventDefault();
              tools.compare = true;
            }
          }}
          onkeyup={() => (tools.compare = false)}
          onblur={() => (tools.compare = false)}
          ><Icon icon={mdiCompare} size="16" aria-hidden={true} />{$t('frameleaf_develop_hold_original')}
          <kbd>\</kbd></button
        >
        <select aria-label={$t('frameleaf_develop_zoom')} bind:value={tools.zoom}>
          <option value="fit">{$t('frameleaf_develop_zoom_fit')}</option>
          <option value="100">100%</option>
          <option value="150">150%</option>
          <option value="200">200%</option>
        </select>
        <button
          type="button"
          class="rde-button rde-inspector-toggle"
          aria-expanded={tools.inspectorOpen}
          onclick={() => (tools.inspectorOpen = !tools.inspectorOpen)}
          ><Icon icon={mdiTune} size="16" aria-hidden={true} />{$t('frameleaf_develop_inspector')}</button
        >
      </div>
    </div>

    {#if record.status === 'failed'}
      <div class="rde-stage">
        <div class="rde-stage-message" role="alert">
          <p>{$t('frameleaf_develop_open_failed')}</p>
          <button type="button" class="rde-button" onclick={() => void session.load(id)}
            >{$t('frameleaf_error_retry')}</button
          >
        </div>
      </div>
    {:else}
      <DevelopStage
        src={loader.url}
        {placeholder}
        alt={photo
          ? tools.compare
            ? $t('frameleaf_develop_photo_original', { values: { name: photo.fileName } })
            : $t('frameleaf_develop_photo_developed', { values: { name: photo.fileName } })
          : ''}
        busy={loader.busy || record.status === 'loading'}
        {mode}
        crop={recipe.crop}
        masks={recipe.masks ?? []}
        {tools}
        onCrop={(rect) => {
          session.setAspect(id, 'Free');
          session.patch(id, { crop: rect });
        }}
        onMask={(mask) =>
          session.change(id, {
            ...recipe,
            masks: (recipe.masks ?? []).map((item) => (item.id === mask.id ? mask : item)),
          })}
        onHistogram={(next) => {
          if (!tools.compare) {
            bins = next;
          }
        }}
      />
    {/if}
    {#if loader.error && record.status === 'ready'}<p class="rde-muted rde-image-status" role="alert">
        {$t('frameleaf_develop_preview_failed')}
      </p>{/if}

    {#if tools.cropOpen}
      <div class="rde-crop-bar">
        <label
          >{$t('frameleaf_develop_aspect')}<select
            value={record.aspect}
            onchange={(event) => setAspect(event.currentTarget.value as Aspect)}
            >{#each ASPECTS as aspect (aspect)}<option value={aspect}
                >{aspect === 'Original'
                  ? $t('frameleaf_develop_aspect_original')
                  : aspect === 'Free'
                    ? $t('frameleaf_develop_aspect_free')
                    : aspect}</option
              >{/each}</select
          ></label
        >
        <button
          type="button"
          class="rde-button icon-only"
          aria-label={$t('frameleaf_develop_rotate_left')}
          onclick={() => session.patch(id, { rotation: turn(recipe.rotation, -90) || undefined })}
          ><Icon icon={mdiRotateLeft} size="16" aria-hidden={true} /></button
        >
        <button
          type="button"
          class="rde-button icon-only"
          aria-label={$t('frameleaf_develop_rotate_right')}
          onclick={() => session.patch(id, { rotation: turn(recipe.rotation, 90) || undefined })}
          ><Icon icon={mdiRotateRight} size="16" aria-hidden={true} /></button
        >
        <DevelopSlider
          label={$t('frameleaf_develop_straighten')}
          value={recipe.straighten ?? 0}
          min={-20}
          max={20}
          step={0.1}
          format={(value) => `${value.toFixed(1)}°`}
          onChange={(value) => session.patch(id, { straighten: value === 0 ? undefined : value }, 'straighten')}
        />
        <button
          type="button"
          class="rde-button"
          onclick={() => {
            session.setAspect(id, 'Original');
            session.patch(id, { crop: undefined, rotation: undefined, straighten: undefined });
          }}>{$t('reset')}</button
        >
        <button type="button" class="rde-button active" onclick={() => (tools.cropOpen = false)}
          >{$t('done')}</button
        >
      </div>
    {/if}

    {#if photo}
      <div class="rde-image-status">
        <span>{photo.fileName}</span>
        {#if rate}<DevelopStars
            rating={Math.max(0, photo.rating ?? 0)}
            name={photo.fileName}
            disabled={!photo.canRate}
            onChange={(rating) => void changeRating(photo, rating)}
          />{/if}
        {#if multi}<button type="button" class="rde-button" disabled={targets.length === 0} onclick={() => show('sync')}
            ><Icon icon={mdiSync} size="14" aria-hidden={true} />{$t('frameleaf_develop_sync_short', {
              values: { count: targets.length },
            })}</button
          >{/if}
        <span>{$t('frameleaf_develop_position', { values: { index: session.activeIndex + 1, total: session.photos.length } })}</span>
      </div>
    {/if}

    {#if multi}
      <div class="rde-filmstrip" aria-label={$t('frameleaf_develop_filmstrip')}>
        {#each session.photos as item, index (item.id)}
          <div class="rde-film-frame" class:current={item.id === id} class:selected={session.selected.includes(item.id)}>
            <button
              type="button"
              class="rde-film-photo"
              aria-label={$t('frameleaf_develop_open_photo', { values: { name: item.fileName } })}
              aria-current={item.id === id ? 'true' : undefined}
              onclick={() => select(item.id)}
            >
              <span class="rde-thumb"
                ><PhotographyThumb src={getAssetMediaUrl({ id: item.id, size: AssetMediaSize.Thumbnail })} /></span
              >
              <span>{String(index + 1).padStart(2, '0')}</span>
              {#if session.isEdited(item.id)}<i title={$t('frameleaf_develop_edited')}
                  ><Icon icon={mdiTune} size="13" aria-hidden={true} /></i
                >{/if}
            </button>
            <label class="rde-film-select"
              ><input
                type="checkbox"
                aria-label={$t('frameleaf_develop_select_photo', { values: { name: item.fileName } })}
                checked={session.selected.includes(item.id)}
                onchange={() => session.toggleSelected(item.id)}
              /><span>{extensionOf(item.fileName)}</span></label
            >
            {#if rate}<DevelopStars
                compact
                rating={Math.max(0, item.rating ?? 0)}
                name={item.fileName}
                disabled={!item.canRate}
                onChange={(rating) => void changeRating(item, rating)}
              />{/if}
          </div>
        {/each}
      </div>
    {/if}
  </section>

  <aside class="rde-inspector" class:open={tools.inspectorOpen} aria-label={$t('frameleaf_develop_inspector_label')}>
    <div class="rde-inspector-tabs" role="tablist" aria-label={$t('frameleaf_develop_tools')}>
      {#each TABS as [tab, label], index (tab)}
        <button
          type="button"
          role="tab"
          id={`rde-tab-${tab}`}
          aria-controls="rde-panel"
          aria-selected={tools.tab === tab}
          tabindex={tools.tab === tab ? 0 : -1}
          onclick={() => {
            tools.tab = tab;
            tools.cropOpen = false;
          }}
          onkeydown={(event) => tabKey(event, index)}>{$t(label)}</button
        >
      {/each}
    </div>
    <div class="rde-inspector-body" role="tabpanel" id="rde-panel" aria-labelledby={`rde-tab-${tools.tab}`}>
      {#if record.status === 'ready'}
        {#if tools.tab === 'develop'}
          <DevelopPanel
            {session}
            {id}
            {say}
            onCrop={() => {
              tools.cropOpen = true;
              tools.zoom = 'fit';
            }}
          />
        {:else if tools.tab === 'masks'}
          <MasksPanel {session} {tools} {id} {say} />
        {:else if tools.tab === 'presets'}
          <PresetsPanel {session} {id} {say} image={loader.url ?? placeholder} />
        {:else}
          <VersionsPanel
            {session}
            {id}
            {say}
            onSaveVersion={() => {
              versionName = $t('frameleaf_editor_version_number', { values: { revision: record.revisions.length + 1 } });
              show('version');
            }}
          />
        {/if}
      {:else}
        <p class="rde-muted" role="status">{$t('frameleaf_develop_status_loading')}</p>
      {/if}
    </div>
    <div class="rde-inspector-footer">
      <Icon icon={mdiShieldCheckOutline} size="15" aria-hidden={true} /><span>{$t('frameleaf_develop_original_kept')}</span>
    </div>
  </aside>
</main>

{#if message}<div class="rde-toast" role="status">{message}</div>{/if}

{#if dialog === 'version'}
  <Dialog
    title={$t('frameleaf_develop_save_named_version')}
    closeLabel={$t('close')}
    bind:open={dialogOpen}
    onClosed={() => (dialog = null)}
  >
    <form
      id="rde-save-version"
      class="rde-dialog-content"
      onsubmit={async (event) => {
        event.preventDefault();
        if (!versionName.trim()) {
          return;
        }
        if (await saveVersion(versionName)) {
          hide();
        }
      }}
    >
      <label class="rde-dialog-field"
        >{$t('frameleaf_raw_version_name')}<input required maxlength="120" bind:value={versionName} /></label
      >
      <p class="rde-muted">{$t('frameleaf_develop_version_note')}</p>
    </form>
    {#snippet actions()}
      <button type="button" class="rde-button" onclick={hide}>{$t('cancel')}</button>
      <button
        type="submit"
        form="rde-save-version"
        class="rde-button primary"
        disabled={!versionName.trim() || session.saving.includes(id)}>{$t('frameleaf_editor_save_version')}</button
      >
    {/snippet}
  </Dialog>
{:else if dialog === 'sync' && photo}
  <Dialog
    title={$t('frameleaf_develop_sync_from', { values: { name: photo.fileName } })}
    closeLabel={$t('close')}
    bind:open={dialogOpen}
    onClosed={() => (dialog = null)}
  >
    <div class="rde-dialog-content">
      <p>{$t('frameleaf_develop_sync_body')}</p>
      {#each SYNC_GROUPS as group (group)}
        <label class="rde-check"
          ><input
            type="checkbox"
            checked={syncGroups.includes(group)}
            onchange={(event) =>
              (syncGroups = event.currentTarget.checked
                ? [...syncGroups, group]
                : syncGroups.filter((item) => item !== group))}
          />{$t(SYNC_LABELS[group])}</label
        >
      {/each}
      {#if syncGroups.includes('masks')}<p class="rde-muted">{$t('frameleaf_develop_sync_masks_note')}</p>{/if}
      <p class="rde-muted">{targets.map((item) => item.fileName).join(', ')}</p>
      {#if targets.some((item) => session.isDirty(item.id))}<p class="rde-muted">
          {$t('frameleaf_develop_sync_replaces_unsaved')}
        </p>{/if}
    </div>
    {#snippet actions()}
      <button type="button" class="rde-button" onclick={hide}>{$t('cancel')}</button>
      <button
        type="button"
        class="rde-button primary"
        disabled={syncGroups.length === 0 || targets.length === 0 || working}
        onclick={() => void sync()}>{$t('frameleaf_develop_sync_to', { values: { count: targets.length } })}</button
      >
    {/snippet}
  </Dialog>
{:else if dialog === 'export' && photo}
  <Dialog title={$t('frameleaf_develop_export_title')} closeLabel={$t('close')} bind:open={dialogOpen} onClosed={() => (dialog = null)}>
    <div class="rde-dialog-content">
      <p>{$t('frameleaf_develop_export_format')}</p>
      <p class="rde-muted">{$t('frameleaf_develop_export_note')}</p>
      <button
        type="button"
        class="rde-button"
        disabled={!record.currentRevisionId}
        onclick={() => {
          downloadAssetFile({ id, filename: photo.fileName, edited: true });
          hide();
        }}>{$t('frameleaf_develop_export_current')}</button
      >
      {#if !record.currentRevisionId}<p class="rde-export-status">{$t('frameleaf_develop_export_save_first')}</p>
      {:else if session.isDirty(id)}<p class="rde-export-status">{$t('frameleaf_develop_export_unsaved')}</p>{/if}
      {#if multi}
        <hr />
        <h3>{$t('frameleaf_develop_export_batch')}</h3>
        <p>{$t('frameleaf_develop_export_selected', { values: { count: selected.length } })}</p>
        {#if selected.some((item) => session.isDirty(item.id))}<p class="rde-muted">
            {$t('frameleaf_develop_export_selected_unsaved')}
          </p>{/if}
      {/if}
    </div>
    {#snippet actions()}
      <button type="button" class="rde-button" onclick={hide}>{$t('close')}</button>
      {#if multi}<button
          type="button"
          class="rde-button primary"
          disabled={selected.length === 0}
          onclick={() => {
            downloadArchive(shoot?.name ?? 'photos', { assetIds: selected.map((item) => item.id) }).catch(
              ignoreCancelledDownload,
            );
            hide();
            say($t('frameleaf_develop_export_started', { values: { count: selected.length } }));
          }}>{$t('frameleaf_develop_export_download', { values: { count: selected.length } })}</button
        >{/if}
    {/snippet}
  </Dialog>
{:else if dialog === 'leave'}
  <Dialog
    title={$t('frameleaf_develop_leave_title')}
    closeLabel={$t('close')}
    bind:open={dialogOpen}
    onClosed={() => (dialog = null)}
  >
    <p>{$t('frameleaf_develop_leave_body', { values: { count: session.dirtyIds.length } })}</p>
    {#snippet actions()}
      <button type="button" class="rde-button" onclick={hide}>{$t('cancel')}</button>
      <button
        type="button"
        class="rde-button"
        disabled={working}
        onclick={() => {
          hide();
          proceed();
        }}>{$t('frameleaf_develop_leave_discard')}</button
      >
      <button type="button" class="rde-button primary" disabled={working} onclick={() => void saveAllAndLeave()}
        >{$t('frameleaf_develop_leave_save')}</button
      >
    {/snippet}
  </Dialog>
{/if}
