<script lang="ts" module>
  import type { EditorSettings } from '$lib/frameleaf/editor-draft';

  /** Copy settings / Paste settings works across photos for the life of the page. */
  let settingsClipboard = $state<EditorSettings | null>(null);
</script>

<script lang="ts">
  /**
   * The full-screen, media-aware quick editor (FL-113).
   *
   * Ported from `design/frameleaf/template/src/Editor.jsx` (QuickEditor). Photos open on Adjust
   * with a histogram and the Light, Color, Effects and Detail groups, presets, and a draggable
   * crop with straighten, quarter turns and flips. Videos open the production video editor's
   * complete command set inside this frame.
   *
   * The stage shows the server's rendered preview of the current recipe as soon as it arrives
   * and says when it is still rendering; until then it shows the original with the prototype's
   * CSS approximation. Geometry is drawn on the stage so crop drags stay immediate and never
   * re-request a render. Save version stores the recipe as a new revision and renders an
   * edited master on the server; the original file is never changed.
   */
  import { goto } from '$app/navigation';
  import '$lib/frameleaf/tokens.css';
  import './editor.css';
  import { focusTrap } from '$lib/actions/focus-trap';
  import VideoEditorPanel, { type VideoEditorDraft } from '$lib/components/asset-viewer/editor/VideoEditorPanel.svelte';
  import CropOverlay from '$lib/components/frameleaf/editor/CropOverlay.svelte';
  import DevelopGroup from '$lib/components/frameleaf/editor/DevelopGroup.svelte';
  import EditorSlider from '$lib/components/frameleaf/editor/EditorSlider.svelte';
  import Histogram from '$lib/components/frameleaf/editor/Histogram.svelte';
  import MaskOverlay from '$lib/components/frameleaf/editor/MaskOverlay.svelte';
  import MaskPanel from '$lib/components/frameleaf/editor/MaskPanel.svelte';
  import PresetStrip from '$lib/components/frameleaf/editor/PresetStrip.svelte';
  import RestorationCompare from '$lib/components/frameleaf/editor/RestorationCompare.svelte';
  import RestorationPanel, {
    type RestorationCompareRequest,
  } from '$lib/components/frameleaf/editor/RestorationPanel.svelte';
  import RoundTripPanel from '$lib/components/frameleaf/editor/RoundTripPanel.svelte';
  import UserPresets from '$lib/components/frameleaf/editor/UserPresets.svelte';
  import VideoVersionsMenu from '$lib/components/frameleaf/editor/VideoVersionsMenu.svelte';
  import {
    ASPECTS,
    AUTO_TONE,
    DEVELOP_GROUPS,
    DEVELOP_KEYS,
    FULL_RECT,
    SOCIAL_PRESETS,
    aspectRatioValue,
    autoToneApplied,
    autoToneCleared,
    cssFilterFor,
    developDefaults,
    fitCropRect,
    presetFor,
    rotateAspect,
    rotateRect,
    straightenScale,
    toneKey,
    type AspectId,
    type CropRect,
    type DevelopGroupId,
    type DevelopValues,
  } from '$lib/frameleaf/develop';
  import {
    PREVIEW_DEBOUNCE_MS,
    developFileUrl,
    followDevelop,
    requestDevelopPreview,
  } from '$lib/frameleaf/develop-api';
  import {
    anyRevisionBusy,
    changeDraft,
    rebaseDraft,
    createDraft,
    geometryIsDefault,
    initialRecipe,
    isRevisionBusy,
    normalizeRecipe,
    openingRecipe,
    pickSettings,
    redoDraft,
    resetGeometry,
    sameRecipe,
    toServerRecipe,
    undoDraft,
    type EditorDraft,
    type EditorRecipe,
  } from '$lib/frameleaf/editor-draft';
  import {
    flipMask,
    maskIsActive,
    presetSettingsFrom,
    rotateMask,
    shortChecksum,
    tonePreviewRecipe,
    type EditorMask,
  } from '$lib/frameleaf/photo-tools';
  import { isVideoAsset } from '$lib/frameleaf/viewer-media';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetDevelopFileKind,
    AssetDevelopPreset,
    AssetDevelopRevisionKind,
    AssetDevelopRevisionStatus,
    AssetMediaSize,
    cancelAssetDevelopRender,
    getAssetDevelop,
    renderAssetDevelopRevision,
    revertAssetDevelop,
    saveAssetDevelop,
    type AssetDevelopResponseDto,
    type AssetDevelopRevisionResponseDto,
    type AssetResponseDto,
  } from '@immich/sdk';
  import { Icon, Theme as AppTheme, themeManager, toastManager } from '@immich/ui';
  import {
    mdiAutoFix,
    mdiCheck,
    mdiClose,
    mdiCloseCircleOutline,
    mdiCompare,
    mdiCompareHorizontal,
    mdiContentCopy,
    mdiContentPaste,
    mdiCropRotate,
    mdiFlipHorizontal,
    mdiFlipVertical,
    mdiHistory,
    mdiImageFilterVintage,
    mdiImageOutline,
    mdiOpenInApp,
    mdiPlay,
    mdiRedo,
    mdiRestore,
    mdiRotateLeft,
    mdiRotateRight,
    mdiTune,
    mdiUndo,
    mdiVectorEllipse,
  } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Tool = 'adjust' | 'crop' | 'masks' | 'presets' | 'restore' | 'versions';

  let {
    asset,
    onClose,
  }: {
    asset: AssetResponseDto;
    /** `refreshAsset` is true when a saved version changed what the viewer should show. */
    onClose: (refreshAsset?: boolean) => void;
  } = $props();

  const isVideo = isVideoAsset(asset);
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const originalPreviewUrl = getAssetMediaUrl({
    id: asset.id,
    size: AssetMediaSize.Preview,
    cacheKey: asset.thumbhash,
    edited: false,
  });
  const thumbnailUrl = getAssetMediaUrl({
    id: asset.id,
    size: AssetMediaSize.Thumbnail,
    cacheKey: asset.thumbhash,
    edited: false,
  });

  const tools: { id: Tool; label: Translations; icon: string }[] = [
    { id: 'adjust', label: 'frameleaf_editor_tool_adjust', icon: mdiTune },
    { id: 'crop', label: 'frameleaf_editor_tool_crop', icon: mdiCropRotate },
    { id: 'masks', label: 'frameleaf_editor_tool_masks', icon: mdiVectorEllipse },
    { id: 'presets', label: 'frameleaf_editor_tool_presets', icon: mdiImageFilterVintage },
    { id: 'restore', label: 'frameleaf_editor_tool_restore', icon: mdiAutoFix },
    { id: 'versions', label: 'frameleaf_editor_tool_versions', icon: mdiHistory },
  ];

  /* Draft --------------------------------------------------------------- */
  let draft = $state<EditorDraft>(createDraft());
  let opened = $state<EditorRecipe>(initialRecipe());
  const recipe = $derived(draft.recipe);
  const values = $derived(Object.fromEntries(DEVELOP_KEYS.map((key) => [key, recipe[key]])) as DevelopValues);
  const dirty = $derived(!sameRecipe(recipe, opened));
  const change = (patch: Partial<EditorRecipe>) => {
    draft = changeDraft(draft, patch);
  };

  /* Server state --------------------------------------------------------- */
  let develop = $state<AssetDevelopResponseDto | null>(null);
  let developError = $state<string | null>(null);
  let saving = $state(false);
  let stopFollowing: (() => void) | undefined;
  let saveChangedCurrent = false;

  const revisions = $derived(develop?.revisions ?? []);
  const busyRevision = $derived(revisions.find((revision) => isRevisionBusy(revision.status)));
  const currentRevision = $derived(revisions.find((revision) => revision.id === develop?.currentRevisionId));

  const follow = () => {
    stopFollowing?.();
    stopFollowing = followDevelop(
      asset.id,
      (next) => {
        const finished = develop?.revisions.filter(
          (before) =>
            isRevisionBusy(before.status) &&
            !isRevisionBusy(next.revisions.find((after) => after.id === before.id)?.status ?? before.status),
        );
        develop = next;
        for (const before of finished ?? []) {
          const after = next.revisions.find((revision) => revision.id === before.id);
          if (after?.status === AssetDevelopRevisionStatus.Rendered) {
            saveChangedCurrent = true;
            toastManager.primary($t('frameleaf_editor_version_rendered', { values: { revision: after.revision } }));
          } else if (after?.status === AssetDevelopRevisionStatus.Failed) {
            toastManager.danger(
              $t('frameleaf_editor_version_failed', { values: { revision: after.revision, error: after.error ?? '' } }),
            );
          }
        }
      },
      { onError: (error) => handleError(error, $t('frameleaf_editor_versions_error')) },
    );
  };

  onMount(async () => {
    if (isVideo) {
      return;
    }
    try {
      develop = await getAssetDevelop({ id: asset.id });
      const start = openingRecipe(develop);
      draft = rebaseDraft(draft, start);
      opened = start;
      if (anyRevisionBusy(develop.revisions)) {
        follow();
      }
    } catch (error) {
      const message = $t('frameleaf_editor_versions_error');
      developError = message;
      handleError(error, message);
    }
  });

  onDestroy(() => {
    stopFollowing?.();
    previewAbort?.abort();
    clearTimeout(previewTimer);
    serverPreview?.revoke();
  });

  /* Server preview ------------------------------------------------------- */
  let serverPreview = $state<{ url: string; key: string; revoke: () => void } | null>(null);
  let previewPending = $state(false);
  let previewFailed = $state(false);
  let previewAbort: AbortController | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const identityTone = $derived(
    DEVELOP_KEYS.every((key) => recipe[key] === 0) &&
      presetFor(recipe.preset).id === AssetDevelopPreset.Original &&
      recipe.masks.every((mask) => !maskIsActive(mask)),
  );
  const currentToneKey = $derived(toneKey(toServerRecipe(recipe)));
  const previewMatches = $derived(identityTone || serverPreview?.key === currentToneKey);

  $effect(() => {
    if (isVideo) {
      return;
    }
    const key = currentToneKey;
    const identity = identityTone;
    const request = tonePreviewRecipe(toServerRecipe(untrack(() => recipe)));
    clearTimeout(previewTimer);
    previewAbort?.abort();
    if (identity) {
      previewPending = false;
      previewFailed = false;
      return;
    }
    if (untrack(() => serverPreview?.key) === key) {
      previewPending = false;
      return;
    }
    previewPending = true;
    previewFailed = false;
    const controller = new AbortController();
    previewAbort = controller;
    previewTimer = setTimeout(
      () =>
        void (async () => {
          try {
            const result = await requestDevelopPreview(asset.id, request, 1280, controller.signal);
            if (!result || controller.signal.aborted) {
              return;
            }
            serverPreview?.revoke();
            serverPreview = { ...result, key };
            previewPending = false;
          } catch (error) {
            if (!controller.signal.aborted) {
              previewPending = false;
              previewFailed = true;
              handleError(error, $t('frameleaf_editor_preview_error'));
            }
          }
        })(),
      PREVIEW_DEBOUNCE_MS,
    );
  });

  /* Stage ---------------------------------------------------------------- */
  let tool = $state<Tool>('adjust');
  /* Restoration (FL-115) ------------------------------------------------- */
  // Videos have no adjust rail; the top bar swaps the video editor for the restoration panel.
  let videoTool = $state<'edit' | 'restore'>('edit');
  // FL-39: the Versions menu and Revert load recipes into the open video draft.
  let videoEditor = $state<VideoEditorDraft>();
  let videoHasUnsavedChanges = $state(false);
  let videoDraftKey = $state('[]');
  // The before-and-after the restoration panel asked the stage to show. Cleared with the tool.
  let restorationCompare = $state<RestorationCompareRequest | null>(null);
  // Prototype RestorePanel "Loupe" (Studio.jsx:1634) and the video playhead "Use current frame" reads.
  let restorationLoupe = $state(false);
  let restorationSourceVideo = $state<HTMLVideoElement>();
  const restoring = $derived(isVideo ? videoTool === 'restore' : tool === 'restore');
  $effect(() => {
    if (!restoring) {
      restorationCompare = null;
    }
  });

  let before = $state(false);
  let split = $state(false);
  let splitAt = $state(0.5);
  let dragRect = $state<CropRect | null>(null);
  let dragging = $state(false);
  let canvasEl = $state<HTMLDivElement>();
  let afterImage = $state<HTMLImageElement>();
  let imageTick = $state(0);
  let stage = $state({ w: 0, h: 0 });
  let openGroups = $state<Record<DevelopGroupId, boolean>>({ light: true, color: true, effects: false, detail: false });
  let announce = $state('');

  $effect(() => {
    const element = canvasEl;
    if (!element) {
      return;
    }
    const update = () => {
      const box = element.getBoundingClientRect();
      if (box.width !== stage.w || box.height !== stage.h) {
        stage = { w: box.width, h: box.height };
      }
    };
    update();
    // Every supported browser has ResizeObserver; without one the first measurement stands.
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });

  const filterInfo = $derived(cssFilterFor(recipe));
  const rect = $derived(dragRect ?? recipe.crop);
  const cropping = $derived(tool === 'crop');
  const source = $derived({ w: asset.width || 16, h: asset.height || 9 });
  const frame = $derived.by(() => {
    if (!stage.w || !stage.h) {
      return null;
    }
    const rotated = recipe.rotation % 180 !== 0;
    const ow = rotated ? source.h : source.w;
    const oh = rotated ? source.w : source.h;
    const view = cropping ? FULL_RECT : rect;
    const scale = Math.min(stage.w / (ow * view.w), stage.h / (oh * view.h));
    const fw = ow * scale;
    const fh = oh * scale;
    return { fw, fh, rotated, dx: (view.x + view.w / 2 - 0.5) * fw, dy: (view.y + view.h / 2 - 0.5) * fh };
  });

  const frameStyle = (kind: 'before' | 'after') => {
    if (!frame) {
      return '';
    }
    const { fw, fh, dx, dy } = frame;
    let top = 0;
    let right = 0;
    let bottom = 0;
    let left = 0;
    if (!cropping) {
      top = rect.y * fh;
      left = rect.x * fw;
      right = (1 - rect.x - rect.w) * fw;
      bottom = (1 - rect.y - rect.h) * fh;
    }
    if (split) {
      const frameLeft = stage.w / 2 - fw / 2 - dx;
      const splitX = Math.max(0, Math.min(fw, splitAt * stage.w - frameLeft));
      if (kind === 'after') {
        left = Math.max(left, splitX);
      } else {
        right = Math.max(right, fw - splitX);
      }
    }
    const clip = top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : 'none';
    return `width:${fw}px;height:${fh}px;margin-left:${-fw / 2}px;margin-top:${-fh / 2}px;transform:translate(${-dx}px, ${-dy}px);clip-path:${clip}`;
  };
  const mediaStyle = (plain: boolean) => {
    if (!frame) {
      return '';
    }
    const width = frame.rotated ? frame.fh : frame.fw;
    const height = frame.rotated ? frame.fw : frame.fh;
    const filter = plain || previewMatches ? 'none' : filterInfo.filter;
    return `width:${width}px;height:${height}px;transform:translate(-50%, -50%) scale(${recipe.flipHorizontal ? -1 : 1}, ${recipe.flipVertical ? -1 : 1}) rotate(${recipe.rotation}deg);filter:${filter}`;
  };
  const straightenStyle = $derived(
    frame
      ? `transform:rotate(${recipe.straighten}deg) scale(${straightenScale(frame.fw, frame.fh, recipe.straighten)})`
      : '',
  );
  const windowStyle = $derived(
    frame
      ? `left:${rect.x * frame.fw}px;top:${rect.y * frame.fh}px;width:${rect.w * frame.fw}px;height:${rect.h * frame.fh}px`
      : '',
  );
  const afterSrc = $derived(!identityTone && serverPreview && previewMatches ? serverPreview.url : originalPreviewUrl);
  const cropFrame = $derived(
    frame
      ? { width: frame.fw, height: frame.fh, left: stage.w / 2 - frame.fw / 2, top: stage.h / 2 - frame.fh / 2 }
      : null,
  );
  const aspectRatio = $derived(frame ? aspectRatioValue(recipe.aspect, frame.fw, frame.fh) : null);
  const orientedSource = $derived(frame?.rotated ? { w: source.h, h: source.w } : source);

  /* Crop, orientation and presets ------------------------------------------ */
  const chooseAspect = (id: AspectId) => {
    if (!frame) {
      return;
    }
    const ratio = aspectRatioValue(id, frame.fw, frame.fh);
    change({ aspect: id, crop: id === 'Free' ? recipe.crop : fitCropRect(ratio, frame.fw, frame.fh) });
  };
  // Masks turn and mirror with the frame, like the crop, so they stay on the same content (FL-64).
  // The frame is always turned before it is mirrored (stage and renderer alike), so with one
  // mirror applied a clockwise turn moves the drawn frame's content counter-clockwise.
  const rotate = (clockwise: boolean) => {
    const drawn = recipe.flipHorizontal === recipe.flipVertical ? clockwise : !clockwise;
    change({
      rotation: (recipe.rotation + (clockwise ? 90 : 270)) % 360,
      crop: rotateRect(recipe.crop, drawn),
      aspect: rotateAspect(recipe.aspect),
      masks: recipe.masks.map((mask) => rotateMask(mask, drawn)),
    });
  };
  const flip = (axis: 'h' | 'v') =>
    change(
      axis === 'h'
        ? {
            flipHorizontal: !recipe.flipHorizontal,
            crop: { ...recipe.crop, x: 1 - recipe.crop.x - recipe.crop.w },
            masks: recipe.masks.map((mask) => flipMask(mask, 'h')),
          }
        : {
            flipVertical: !recipe.flipVertical,
            crop: { ...recipe.crop, y: 1 - recipe.crop.y - recipe.crop.h },
            masks: recipe.masks.map((mask) => flipMask(mask, 'v')),
          },
    );

  /* Masks, presets and version comparison (FL-64) -------------------------- */
  let selectedMaskId = $state<string | null>(null);
  let dragMask = $state<EditorMask | null>(null);
  const selectedMask = $derived(dragMask ?? recipe.masks.find((mask) => mask.id === selectedMaskId) ?? null);
  $effect(() => {
    if (selectedMaskId && recipe.masks.every((mask) => mask.id !== selectedMaskId)) {
      selectedMaskId = recipe.masks[0]?.id ?? null;
    }
  });
  const commitMask = (next: EditorMask) =>
    change({ masks: recipe.masks.map((mask) => (mask.id === next.id ? next : mask)) });
  const currentSettings = $derived(presetSettingsFrom(pickSettings(recipe)));

  let versionCompare = $state<RestorationCompareRequest | null>(null);
  $effect(() => {
    if (tool !== 'versions') {
      versionCompare = null;
    }
  });
  const compareVersion = (revision: AssetDevelopRevisionResponseDto) => {
    versionCompare = versionCompare?.after.includes(revision.id)
      ? null
      : {
          before: originalPreviewUrl,
          after: developFileUrl(asset.id, revision.id, AssetDevelopFileKind.Preview, revision.renderedAt),
          isVideo: false,
          beforeLabel: $t('frameleaf_editor_version_original'),
          afterLabel:
            revision.label ?? $t('frameleaf_editor_version_number', { values: { revision: revision.revision } }),
        };
  };
  const onImported = (revision: AssetDevelopRevisionResponseDto) => {
    develop = {
      assetId: asset.id,
      currentRevisionId: develop?.currentRevisionId ?? null,
      revisions: [revision, ...(develop?.revisions ?? [])],
    };
    follow();
  };
  const allAdjustDefault = $derived(DEVELOP_KEYS.every((key) => recipe[key] === 0));
  const currentPreset = $derived(presetFor(recipe.preset));

  const beginSplit = (event: PointerEvent) => {
    event.preventDefault();
    const box = canvasEl?.getBoundingClientRect();
    if (!box) {
      return;
    }
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    const move = (e: PointerEvent) => {
      if (e.pointerId === pointerId) {
        splitAt = Math.max(0.04, Math.min(0.96, (e.clientX - box.left) / box.width));
      }
    };
    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) {
        return;
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
    };
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // best effort
    }
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };

  /* Top bar actions ------------------------------------------------------- */
  /** Cancel drops unsaved edits at once and says so, the way the prototype does; nothing was written. */
  const discardAndClose = () => {
    if (dirty) {
      toastManager.primary($t('frameleaf_editor_edits_discarded'));
    }
    onClose(saveChangedCurrent);
  };
  const cancel = () => discardAndClose();
  const openStudio = () => {
    discardAndClose();
    void goto(Route.studio({ assetIds: [asset.id] }));
  };
  const revertDraft = () => change(initialRecipe());
  const copySettings = () => {
    settingsClipboard = pickSettings(recipe);
    toastManager.primary($t('frameleaf_editor_settings_copied'));
  };
  const pasteSettings = () => {
    if (!settingsClipboard) {
      return;
    }
    change(settingsClipboard);
    toastManager.primary($t('frameleaf_editor_settings_pasted'));
  };
  const saveVersion = async () => {
    if (saving) {
      return;
    }
    saving = true;
    try {
      const revision = await saveAssetDevelop({
        id: asset.id,
        assetDevelopSaveDto: { recipe: toServerRecipe(recipe), render: true },
      });
      develop = {
        assetId: asset.id,
        currentRevisionId: develop?.currentRevisionId ?? null,
        revisions: [revision, ...(develop?.revisions ?? [])],
      };
      opened = normalizeRecipe(recipe);
      announce = $t('frameleaf_editor_version_queued', { values: { revision: revision.revision } });
      toastManager.primary(announce);
      followAfterClose(revision.id);
      onClose(saveChangedCurrent);
    } catch (error) {
      handleError(error, $t('frameleaf_editor_save_error'));
    } finally {
      saving = false;
    }
  };
  /**
   * Save version closes the editor (App.jsx `saveVersion`), so the render it queued is followed
   * outside the component: this poller is not stopped on destroy, and it only announces the
   * outcome of that one revision. The formatter is captured while still mounted.
   */
  const followAfterClose = (revisionId: string) => {
    const translate = $t;
    let stop = () => {};
    stop = followDevelop(
      asset.id,
      (next) => {
        const after = next.revisions.find((revision) => revision.id === revisionId);
        if (!after || isRevisionBusy(after.status)) {
          return;
        }
        stop();
        if (after.status === AssetDevelopRevisionStatus.Rendered) {
          toastManager.primary(
            translate('frameleaf_editor_version_rendered', { values: { revision: after.revision } }),
          );
        } else if (after.status === AssetDevelopRevisionStatus.Failed) {
          toastManager.danger(
            translate('frameleaf_editor_version_failed', {
              values: { revision: after.revision, error: after.error ?? '' },
            }),
          );
        }
      },
      { onError: (error) => handleError(error, translate('frameleaf_editor_versions_error')) },
    );
  };
  const cancelRender = async (revision: AssetDevelopRevisionResponseDto) => {
    try {
      const updated = await cancelAssetDevelopRender({ id: asset.id, revisionId: revision.id });
      replaceRevision(updated);
    } catch (error) {
      handleError(error, $t('frameleaf_editor_cancel_error'));
    }
  };
  const renderRevision = async (revision: AssetDevelopRevisionResponseDto) => {
    try {
      const updated = await renderAssetDevelopRevision({ id: asset.id, revisionId: revision.id });
      replaceRevision(updated);
      follow();
    } catch (error) {
      handleError(error, $t('frameleaf_editor_save_error'));
    }
  };
  const makeCurrent = async (revision: AssetDevelopRevisionResponseDto | null) => {
    try {
      develop = await revertAssetDevelop({ id: asset.id, assetDevelopRevertDto: { revisionId: revision?.id } });
      saveChangedCurrent = true;
      toastManager.primary(
        revision
          ? $t('frameleaf_editor_version_made_current', { values: { revision: revision.revision } })
          : $t('frameleaf_editor_reverted_to_original'),
      );
    } catch (error) {
      handleError(error, $t('frameleaf_editor_revert_error'));
    }
  };
  const loadRevision = (revision: AssetDevelopRevisionResponseDto | null) => {
    change(revision ? normalizeRecipe(revision.recipe) : initialRecipe());
    tool = 'adjust';
  };
  const replaceRevision = (updated: AssetDevelopRevisionResponseDto) => {
    if (!develop) {
      return;
    }
    develop = {
      ...develop,
      revisions: develop.revisions.map((revision) => (revision.id === updated.id ? updated : revision)),
    };
  };

  /* Keyboard -------------------------------------------------------------- */
  const isEditable = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);
  const onKeyDown = (event: KeyboardEvent) => {
    if (isVideo) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      void cancel();
      return;
    }
    if (isEditable(event.target)) {
      return;
    }
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (key === 'y' && !mod) {
      event.preventDefault();
      if (!event.repeat) {
        before = true;
      }
    } else if (key === 'z' && mod && event.shiftKey) {
      event.preventDefault();
      draft = redoDraft(draft);
    } else if (key === 'z' && mod) {
      event.preventDefault();
      draft = undoDraft(draft);
    }
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === 'y') {
      before = false;
    }
  };
  const railKey = (event: KeyboardEvent) => {
    const index = tools.findIndex((item) => item.id === tool);
    let next: number;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowRight': {
        next = index + 1;
        break;
      }
      case 'ArrowUp':
      case 'ArrowLeft': {
        next = index - 1;
        break;
      }
      case 'Home': {
        next = 0;
        break;
      }
      case 'End': {
        next = tools.length - 1;
        break;
      }
      default: {
        return;
      }
    }
    event.preventDefault();
    const target = tools[(next + tools.length) % tools.length];
    tool = target.id;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tool="${CSS.escape(target.id)}"]`)?.focus();
  };

  const dimensions = $derived(asset.width && asset.height ? `${asset.width} × ${asset.height}` : '');
  const statusLabel = (revision: AssetDevelopRevisionResponseDto) => {
    switch (revision.status) {
      case AssetDevelopRevisionStatus.Rendered: {
        return $t('frameleaf_editor_status_rendered');
      }
      case AssetDevelopRevisionStatus.Rendering: {
        return $t('frameleaf_editor_status_rendering', { values: { progress: revision.progress } });
      }
      case AssetDevelopRevisionStatus.Queued: {
        return $t('frameleaf_editor_status_queued');
      }
      case AssetDevelopRevisionStatus.Failed: {
        return $t('frameleaf_editor_status_failed');
      }
      case AssetDevelopRevisionStatus.Cancelled: {
        return $t('frameleaf_editor_status_cancelled');
      }
      default: {
        return $t('frameleaf_editor_status_saved');
      }
    }
  };
</script>

<div
  class="frameleaf fl-editor"
  data-theme={appTheme}
  role="dialog"
  tabindex="-1"
  aria-modal="true"
  aria-label={$t('frameleaf_editor_dialog_label', { values: { name: asset.originalFileName } })}
  use:focusTrap
  onkeydown={onKeyDown}
  onkeyup={onKeyUp}
>
  <div class={['ed-shell', isVideo && 'video', isVideo && videoTool === 'restore' && 'restoring']}>
    <header class="ed-top">
      {#if isVideo}
        <button
          type="button"
          class="ed-tool labelled"
          onclick={() => onClose(saveChangedCurrent)}
          title={$t('frameleaf_editor_cancel_title')}
        >
          <Icon icon={mdiClose} size="20" />
          <span>{$t('close')}</span>
        </button>
        <div class="ed-title">
          <strong>{asset.originalFileName}</strong>
          <span>{$t('frameleaf_editor_kind_video')}{dimensions ? ` · ${dimensions}` : ''}</span>
        </div>
        <button
          type="button"
          class="ed-tool labelled"
          aria-pressed={videoTool === 'restore'}
          title={$t('frameleaf_editor_tool_restore')}
          onclick={() => (videoTool = videoTool === 'restore' ? 'edit' : 'restore')}
        >
          <Icon icon={mdiAutoFix} size="20" />
          <span>{$t('frameleaf_editor_tool_restore')}</span>
        </button>
        {#if videoTool === 'edit'}
          {#key asset.id}
            <VideoVersionsMenu
              {asset}
              draftKey={videoDraftKey}
              hasUnsavedChanges={videoHasUnsavedChanges}
              onApply={(edits) => videoEditor?.applyRecipe(edits)}
            />
          {/key}
        {/if}
      {:else}
        <button type="button" class="ed-tool labelled" onclick={cancel} title={$t('frameleaf_editor_cancel_title')}>
          <Icon icon={mdiClose} size="20" />
          <span>{$t('cancel')}</span>
        </button>
        <div class="ed-title">
          <strong>{asset.originalFileName}</strong>
          <span>
            {$t('frameleaf_editor_kind_photo')}{dimensions ? ` · ${dimensions}` : ''}{dirty
              ? ` · ${$t('frameleaf_editor_edited')}`
              : ''}{currentRevision
              ? ` · ${$t('frameleaf_editor_showing_version', { values: { revision: currentRevision.revision } })}`
              : ''}
          </span>
        </div>
        <button
          type="button"
          class="ed-tool"
          aria-label={$t('undo')}
          title={$t('undo')}
          disabled={draft.undo.length === 0}
          onclick={() => (draft = undoDraft(draft))}
        >
          <Icon icon={mdiUndo} size="20" />
        </button>
        <button
          type="button"
          class="ed-tool"
          aria-label={$t('frameleaf_editor_redo')}
          title={$t('frameleaf_editor_redo')}
          disabled={draft.redo.length === 0}
          onclick={() => (draft = redoDraft(draft))}
        >
          <Icon icon={mdiRedo} size="20" />
        </button>
        <span class="ed-sep" aria-hidden="true"></span>
        <button
          type="button"
          class="ed-tool"
          aria-label={$t('frameleaf_editor_hold_before')}
          title={$t('frameleaf_editor_hold_before')}
          aria-pressed={before}
          onpointerdown={(event) => {
            if (event.pointerType !== 'mouse' || event.button === 0) {
              before = true;
            }
          }}
          onpointerup={() => (before = false)}
          onpointerleave={() => (before = false)}
          onpointercancel={() => (before = false)}
          onkeydown={(event) => {
            if (!(event.key === ' ' || event.key === 'Enter')) {
              return;
            }

            event.preventDefault();
            before = true;
          }}
          onkeyup={(event) => {
            if (event.key === ' ' || event.key === 'Enter') {
              before = false;
            }
          }}
          onclick={(event) => event.preventDefault()}
        >
          <Icon icon={mdiCompare} size="20" />
        </button>
        <button
          type="button"
          class="ed-tool"
          aria-label={$t('frameleaf_editor_split_view')}
          title={$t('frameleaf_editor_split_view')}
          aria-pressed={split}
          onclick={() => (split = !split)}
        >
          <Icon icon={mdiCompareHorizontal} size="20" />
        </button>
        <span class="ed-sep" aria-hidden="true"></span>
        <button
          type="button"
          class="ed-tool labelled"
          title={$t('frameleaf_editor_copy_settings')}
          onclick={copySettings}
        >
          <Icon icon={mdiContentCopy} size="20" />
          <span>{$t('frameleaf_editor_copy')}</span>
        </button>
        <button
          type="button"
          class="ed-tool labelled"
          title={$t('frameleaf_editor_paste_settings')}
          disabled={!settingsClipboard}
          onclick={pasteSettings}
        >
          <Icon icon={mdiContentPaste} size="20" />
          <span>{$t('frameleaf_editor_paste')}</span>
        </button>
        <button
          type="button"
          class="ed-tool labelled"
          title={$t('frameleaf_editor_revert_draft')}
          disabled={sameRecipe(recipe, initialRecipe())}
          onclick={revertDraft}
        >
          <Icon icon={mdiRestore} size="20" />
          <span>{$t('frameleaf_editor_revert')}</span>
        </button>
        <button
          type="button"
          class="ed-tool labelled"
          aria-pressed={tool === 'versions'}
          title={$t('frameleaf_editor_tool_versions')}
          onclick={() => (tool = tool === 'versions' ? 'adjust' : 'versions')}
        >
          <Icon icon={mdiHistory} size="20" />
          <span>{$t('frameleaf_editor_tool_versions')}</span>
        </button>
        <button
          type="button"
          class="ed-tool labelled"
          onclick={openStudio}
          title={$t('frameleaf_editor_open_in_studio')}
        >
          <Icon icon={mdiOpenInApp} size="20" />
          <span>{$t('frameleaf_editor_open_in_studio')}</span>
        </button>
        {#if busyRevision}
          <span class="ed-progress" role="status">
            <progress max="100" value={busyRevision.progress}></progress>
            {statusLabel(busyRevision)}
            <button
              type="button"
              class="ed-icon"
              aria-label={$t('frameleaf_editor_cancel_render')}
              title={$t('frameleaf_editor_cancel_render')}
              onclick={() => cancelRender(busyRevision)}
            >
              <Icon icon={mdiCloseCircleOutline} size="18" />
            </button>
          </span>
        {/if}
        <button
          type="button"
          class="ed-tool primary labelled"
          disabled={saving || !!developError}
          onclick={saveVersion}
          title={$t('frameleaf_editor_save_version_title')}
        >
          <span>{saving ? $t('frameleaf_editor_saving') : $t('frameleaf_editor_save_version')}</span>
        </button>
      {/if}
    </header>

    {#if isVideo && videoTool === 'edit'}
      <div class="ed-video-host">
        <VideoEditorPanel
          {asset}
          onReady={(editor) => (videoEditor = editor)}
          {onClose}
          onUnsavedChange={(value) => (videoHasUnsavedChanges = value)}
          onDraftChange={(key) => (videoDraftKey = key)}
        />
      </div>
    {:else if isVideo}
      <div class="ed-stage-wrap">
        <div class="ed-stage" aria-label={$t('frameleaf_restoration_compare_stage')}>
          {#if restorationCompare}
            <div class="ed-restore-stage">
              <RestorationCompare {...restorationCompare} alt={asset.originalFileName} loupe={restorationLoupe} />
            </div>
          {:else}
            <!-- The video itself, so "Use current frame" has a playhead to read (Studio.jsx:2565). -->
            <div class="ed-restore-stage">
              <!-- svelte-ignore a11y_media_has_caption (the owner's own video; no caption track exists) -->
              <video
                class="ed-restore-source"
                bind:this={restorationSourceVideo}
                src={getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash })}
                controls
                playsinline
                preload="metadata"
                aria-label={asset.originalFileName}
              ></video>
            </div>
            <p class="ed-restore-hint">{$t('frameleaf_restoration_compare_empty')}</p>
          {/if}
        </div>
      </div>
      <section class="ed-panel" aria-label={$t('frameleaf_editor_tool_restore')}>
        <RestorationPanel
          {asset}
          onCompare={(compare) => (restorationCompare = compare)}
          onCurrentChanged={() => (saveChangedCurrent = true)}
          loupe={restorationLoupe}
          onLoupeChange={(value) => (restorationLoupe = value)}
          currentFrameSeconds={() => (restorationCompare ? null : (restorationSourceVideo?.currentTime ?? null))}
        />
      </section>
    {:else}
      <div class="ed-stage-wrap">
        <div
          class={['ed-stage', cropping && 'cropping', dragging && 'dragging']}
          aria-label={$t('frameleaf_editor_preview')}
        >
          <div class="ed-canvas" bind:this={canvasEl}>
            {#if restoring && restorationCompare}
              <div class="ed-restore-stage">
                <RestorationCompare {...restorationCompare} alt={asset.originalFileName} loupe={restorationLoupe} />
              </div>
            {:else if tool === 'versions' && versionCompare}
              <div class="ed-restore-stage" aria-label={$t('frameleaf_editor_version_compare_stage')}>
                <RestorationCompare {...versionCompare} alt={asset.originalFileName} />
              </div>
            {:else if frame}
              {#if split}
                <div class="ed-frame before" style={frameStyle('before')} aria-hidden="true">
                  <div class="ed-media" style={straightenStyle}>
                    <img src={originalPreviewUrl} alt="" draggable="false" style={mediaStyle(true)} />
                  </div>
                </div>
              {/if}
              <div class="ed-frame after" style={frameStyle('after')}>
                <div class="ed-media" style={straightenStyle}>
                  <img
                    bind:this={afterImage}
                    src={before ? originalPreviewUrl : afterSrc}
                    alt={asset.originalFileName}
                    draggable="false"
                    style={mediaStyle(before)}
                    onload={() => (imageTick += 1)}
                  />
                  {#if tool === 'masks' && selectedMask && !before && !split}
                    <MaskOverlay mask={selectedMask} onPreview={(next) => (dragMask = next)} onCommit={commitMask} />
                  {/if}
                </div>
                {#if !before && !previewMatches}
                  <div class="ed-window" style={windowStyle}>
                    {#each filterInfo.layers as layer (layer.id)}
                      <div class="ed-layer" style={layer.style}></div>
                    {/each}
                  </div>
                {/if}
              </div>
              {#if cropping && cropFrame}
                <CropOverlay
                  {rect}
                  frame={cropFrame}
                  ratio={aspectRatio}
                  sourceWidth={orientedSource.w}
                  sourceHeight={orientedSource.h}
                  aspectLabel={recipe.aspect === 'Free' ? undefined : recipe.aspect}
                  onPreview={(next) => (dragRect = next)}
                  onCommit={(next) => change({ crop: next })}
                  onDragging={(value) => (dragging = value)}
                />
              {/if}
              {#if split}
                <button
                  type="button"
                  class="ed-divider"
                  role="slider"
                  aria-label={$t('frameleaf_editor_split_divider')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(splitAt * 100)}
                  style="left:{splitAt * 100}%"
                  onpointerdown={beginSplit}
                  onkeydown={(event) => {
                    if (event.key === 'ArrowLeft') {
                      splitAt = Math.max(0.04, splitAt - 0.02);
                    } else if (event.key === 'ArrowRight') {
                      splitAt = Math.min(0.96, splitAt + 0.02);
                    }
                  }}
                ></button>
              {/if}
            {:else}
              <div class="ed-unavailable"><strong>{$t('frameleaf_editor_preparing_preview')}</strong></div>
            {/if}
          </div>
          {#if split}
            <span class="ed-badge">{$t('frameleaf_editor_before')}</span>
            <span class="ed-badge right">{$t('frameleaf_editor_after')}</span>
          {:else if before}
            <span class="ed-badge">{$t('frameleaf_editor_before')}</span>
          {/if}
          {#if !before && !identityTone && previewPending}
            <span class="ed-badge centre busy" role="status">{$t('frameleaf_editor_preview_rendering')}</span>
          {:else if !before && !identityTone && previewFailed}
            <span class="ed-badge centre" role="status">{$t('frameleaf_editor_preview_approximate')}</span>
          {/if}
        </div>
      </div>

      <div
        class="ed-rail"
        role="tablist"
        tabindex="-1"
        aria-label={$t('frameleaf_editor_tools_label')}
        aria-orientation="vertical"
        onkeydown={railKey}
      >
        {#each tools as item (item.id)}
          <button
            type="button"
            role="tab"
            data-tool={item.id}
            class="ed-rail-tool"
            aria-selected={tool === item.id}
            aria-controls="fl-editor-panel"
            tabindex={tool === item.id ? 0 : -1}
            title={$t(item.label)}
            onclick={() => (tool = item.id)}
          >
            <Icon icon={item.icon} size="22" />
            <span>{$t(item.label)}</span>
          </button>
        {/each}
      </div>

      <div
        class="ed-panel"
        id="fl-editor-panel"
        role="tabpanel"
        aria-label={$t(tools.find((item) => item.id === tool)!.label)}
      >
        {#if tool === 'adjust'}
          <div class="ed-panel-body">
            <div class="ed-panel-head">
              <h2>{$t('frameleaf_editor_tool_adjust')}</h2>
              <button
                type="button"
                class="ed-icon"
                aria-label={$t('frameleaf_editor_reset_adjustments')}
                title={$t('frameleaf_editor_reset_adjustments')}
                disabled={allAdjustDefault}
                onclick={() => change(developDefaults())}
              >
                <Icon icon={mdiRestore} size="18" />
              </button>
            </div>
            <Histogram source={afterImage} approximation={filterInfo} fromServer={previewMatches} tick={imageTick} />
            <div class="ed-row spread">
              <button
                type="button"
                class="ed-button"
                aria-pressed={autoToneApplied(values)}
                onclick={() => change(autoToneApplied(values) ? autoToneCleared() : AUTO_TONE)}
              >
                <Icon icon={mdiAutoFix} size="18" />
                {$t('frameleaf_editor_auto')}
              </button>
              <span class="muted" style="font-size: 11px">{$t('frameleaf_editor_double_click_reset')}</span>
            </div>
            {#each DEVELOP_GROUPS as group (group.id)}
              <DevelopGroup
                group={group.id}
                label={$t(group.label)}
                {values}
                bind:open={openGroups[group.id]}
                onChange={(patch) => change(patch)}
              />
            {/each}
          </div>
        {:else if tool === 'crop'}
          <div class="ed-panel-body">
            <div class="ed-panel-head">
              <h2>{$t('frameleaf_editor_crop_heading')}</h2>
              <button
                type="button"
                class="ed-icon"
                aria-label={$t('frameleaf_editor_reset_crop')}
                title={$t('frameleaf_editor_reset_crop')}
                disabled={geometryIsDefault(recipe)}
                onclick={() => change(resetGeometry())}
              >
                <Icon icon={mdiRestore} size="18" />
              </button>
            </div>
            <h3>{$t('frameleaf_editor_aspect')}</h3>
            <div class="ed-row" role="radiogroup" aria-label={$t('frameleaf_editor_aspect')}>
              {#each ASPECTS as aspect (aspect.id)}
                <button
                  type="button"
                  role="radio"
                  class="ed-chip"
                  aria-checked={recipe.aspect === aspect.id}
                  onclick={() => chooseAspect(aspect.id)}
                >
                  {aspect.label.startsWith('frameleaf_') ? $t(aspect.label as Translations) : aspect.label}
                </button>
              {/each}
            </div>
            <h3>{$t('frameleaf_editor_straighten')}</h3>
            <div class="ed-dial" style="--dial-x: {recipe.straighten * 8}px">
              <output aria-hidden="true">{recipe.straighten > 0 ? '+' : ''}{recipe.straighten.toFixed(1)}°</output>
              <input
                type="range"
                aria-label={$t('frameleaf_editor_straighten')}
                title={$t('frameleaf_editor_double_click_reset')}
                min="-45"
                max="45"
                step="0.5"
                value={recipe.straighten}
                aria-valuetext={$t('frameleaf_editor_degrees', { values: { degrees: recipe.straighten.toFixed(1) } })}
                oninput={(event) => change({ straighten: Number(event.currentTarget.value) })}
                ondblclick={() => change({ straighten: 0 })}
              />
            </div>
            <h3>{$t('editor_orientation')}</h3>
            <div class="ed-grid-2">
              <button type="button" class="ed-button" onclick={() => rotate(false)}>
                <Icon icon={mdiRotateLeft} size="18" />
                {$t('frameleaf_editor_rotate_left')}
              </button>
              <button type="button" class="ed-button" onclick={() => rotate(true)}>
                <Icon icon={mdiRotateRight} size="18" />
                {$t('frameleaf_editor_rotate_right')}
              </button>
              <button type="button" class="ed-button" aria-pressed={recipe.flipHorizontal} onclick={() => flip('h')}>
                <Icon icon={mdiFlipHorizontal} size="18" />
                {$t('editor_flip_horizontal')}
              </button>
              <button type="button" class="ed-button" aria-pressed={recipe.flipVertical} onclick={() => flip('v')}>
                <Icon icon={mdiFlipVertical} size="18" />
                {$t('editor_flip_vertical')}
              </button>
            </div>
            <p class="ed-note">{$t('frameleaf_editor_crop_help')}</p>
          </div>
        {:else if tool === 'masks'}
          <MaskPanel masks={recipe.masks} bind:selectedId={selectedMaskId} onChange={(masks) => change({ masks })} />
        {:else if tool === 'restore'}
          <RestorationPanel
            {asset}
            crop={recipe.crop}
            onCompare={(compare) => (restorationCompare = compare)}
            onCurrentChanged={() => (saveChangedCurrent = true)}
            loupe={restorationLoupe}
            onLoupeChange={(value) => (restorationLoupe = value)}
          />
        {:else if tool === 'presets'}
          <div class="ed-panel-body">
            <div class="ed-panel-head">
              <h2>{$t('frameleaf_editor_tool_presets')}</h2>
            </div>
            <PresetStrip
              {thumbnailUrl}
              {values}
              preset={recipe.preset}
              onSelect={(preset) =>
                change({ preset, presetStrength: recipe.preset === preset ? recipe.presetStrength : 100 })}
            />
            <EditorSlider
              id="presetStrength"
              label={$t('frameleaf_editor_preset_strength', { values: { preset: $t(currentPreset.label) } })}
              value={recipe.presetStrength}
              min={0}
              max={100}
              step={1}
              defaultValue={100}
              disabled={recipe.preset === AssetDevelopPreset.Original}
              format={(value) => `${value}%`}
              onChange={(value) => change({ presetStrength: value })}
            />
            <h3>{$t('frameleaf_editor_social_formats')}</h3>
            <div class="ed-row">
              {#each SOCIAL_PRESETS as item (item.id)}
                <button
                  type="button"
                  class="ed-chip"
                  aria-pressed={recipe.aspect === item.aspect}
                  onclick={() => chooseAspect(item.aspect)}
                >
                  {$t(item.label)}
                  <small>{$t(item.note)}</small>
                </button>
              {/each}
            </div>
            <p>{$t('frameleaf_editor_social_help')}</p>
            <UserPresets current={currentSettings} onApply={(settings) => change(settings)} />
          </div>
        {:else}
          <div class="ed-panel-body">
            <div class="ed-panel-head">
              <h2>{$t('frameleaf_editor_tool_versions')}</h2>
            </div>
            <p>{$t('frameleaf_editor_versions_help')}</p>
            {#if developError}
              <p class="ed-empty">{developError}</p>
            {:else}
              <div class={['ed-version', !develop?.currentRevisionId && 'current']}>
                <strong><Icon icon={mdiImageOutline} size="16" /> {$t('frameleaf_editor_version_original')}</strong>
                {#if !develop?.currentRevisionId}
                  <span class="ed-status">{$t('frameleaf_editor_current')}</span>
                {/if}
                <small>{$t('frameleaf_editor_version_original_help')}</small>
                <div class="ed-row">
                  <button type="button" class="ed-chip" onclick={() => loadRevision(null)}>
                    {$t('frameleaf_editor_load_settings')}
                  </button>
                  {#if develop?.currentRevisionId}
                    <button type="button" class="ed-chip" onclick={() => makeCurrent(null)}>
                      <Icon icon={mdiCheck} size="16" />
                      {$t('frameleaf_editor_make_current')}
                    </button>
                  {/if}
                </div>
              </div>
              {#each revisions as revision (revision.id)}
                <div class={['ed-version', revision.isCurrent && 'current']}>
                  <strong>
                    {revision.label ??
                      $t('frameleaf_editor_version_number', { values: { revision: revision.revision } })}
                  </strong>
                  <span
                    class={[
                      'ed-status',
                      isRevisionBusy(revision.status) && 'busy',
                      revision.status === AssetDevelopRevisionStatus.Failed && 'failed',
                    ]}
                  >
                    {revision.isCurrent ? $t('frameleaf_editor_current') : statusLabel(revision)}
                  </span>
                  <small>
                    {new Date(revision.createdAt).toLocaleString()}{revision.rendererVersion
                      ? ` · ${revision.rendererVersion}`
                      : ''}{revision.width && revision.height ? ` · ${revision.width} × ${revision.height}` : ''}
                  </small>
                  {#if revision.kind === AssetDevelopRevisionKind.External}
                    <small>
                      {$t('frameleaf_editor_version_external', {
                        values: { file: revision.fileName ?? '' },
                      })}{revision.software ? ` · ${revision.software}` : ''}
                    </small>
                  {/if}
                  {#if revision.sourceChecksum}
                    <small>
                      {$t('frameleaf_editor_version_lineage', {
                        values: {
                          original: shortChecksum(revision.sourceChecksum),
                          master: shortChecksum(revision.renditionChecksum),
                        },
                      })}
                    </small>
                  {/if}
                  {#if revision.error}
                    <small>
                      {revision.status === AssetDevelopRevisionStatus.Queued && revision.attempts > 0
                        ? $t('frameleaf_editor_version_retrying', { values: { error: revision.error } })
                        : revision.error}
                    </small>
                  {/if}
                  <div class="ed-row">
                    {#if revision.kind !== AssetDevelopRevisionKind.External}
                      <button type="button" class="ed-chip" onclick={() => loadRevision(revision)}>
                        {$t('frameleaf_editor_load_settings')}
                      </button>
                    {/if}
                    {#if revision.hasPreview}
                      <button
                        type="button"
                        class="ed-chip"
                        aria-pressed={!!versionCompare?.after.includes(revision.id)}
                        onclick={() => compareVersion(revision)}
                      >
                        <Icon icon={mdiCompareHorizontal} size="16" />
                        {$t('frameleaf_editor_compare_with_original')}
                      </button>
                    {/if}
                    {#if revision.status === AssetDevelopRevisionStatus.Rendered && !revision.isCurrent}
                      <button type="button" class="ed-chip" onclick={() => makeCurrent(revision)}>
                        <Icon icon={mdiCheck} size="16" />
                        {$t('frameleaf_editor_make_current')}
                      </button>
                    {/if}
                    {#if revision.hasMaster}
                      <a
                        class="ed-chip"
                        href={developFileUrl(asset.id, revision.id, AssetDevelopFileKind.Master, revision.renderedAt)}
                        download
                      >
                        {$t('frameleaf_editor_download_master')}
                      </a>
                    {/if}
                    {#if isRevisionBusy(revision.status)}
                      <button type="button" class="ed-chip" onclick={() => cancelRender(revision)}>
                        <Icon icon={mdiCloseCircleOutline} size="16" />
                        {$t('frameleaf_editor_cancel_render')}
                      </button>
                    {:else if revision.status !== AssetDevelopRevisionStatus.Rendered}
                      <button type="button" class="ed-chip" onclick={() => renderRevision(revision)}>
                        <Icon icon={mdiPlay} size="16" />
                        {$t('frameleaf_editor_render')}
                      </button>
                    {/if}
                  </div>
                </div>
              {/each}
              {#if revisions.length === 0}
                <p class="ed-empty">{$t('frameleaf_editor_no_versions')}</p>
              {/if}
              <RoundTripPanel {asset} {onImported} />
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
  <div class="ed-live" role="status" aria-live="polite">{announce}</div>
</div>
