<script lang="ts" module>
  import type { VideoSettings } from '$lib/frameleaf/video-edit';

  /** Copy adjustments / Paste adjustments works across clips for the life of the page. */
  let videoSettingsClipboard = $state<VideoSettings | null>(null);
</script>

<script lang="ts">
  /**
   * The video quick editor (FL-113, VE-1 … VE-12), ported from the video half of
   * `design/frameleaf/template/src/Editor.jsx` (QuickEditor, lines 466-2160) and its `editor.css`.
   *
   * The stage plays the unedited clip (`edited=false`, owner only) with the edit drawn over it the
   * way the prototype previews it: turns, flips, straighten and crop as geometry, the develop
   * sliders and looks as the CSS approximation, and the text overlays on their 3 × 3 grid. Under
   * the stage sit the transport and a filmstrip of real frames with trim handles, speed-range bands
   * and the playhead. The rail offers Trim, Speed, Adjust, Crop, Audio, Text, Enhance and Presets,
   * plus Restore (E-9, owner decision pending). Save version stores the recipe against the original
   * and the server renders a new version; the original file is never changed.
   */
  import { goto } from '$app/navigation';
  import CropOverlay from '$lib/components/frameleaf/editor/CropOverlay.svelte';
  import DevelopGroup from '$lib/components/frameleaf/editor/DevelopGroup.svelte';
  import EditorMenu, { type EditorMenuItem } from '$lib/components/frameleaf/editor/EditorMenu.svelte';
  import EditorSlider from '$lib/components/frameleaf/editor/EditorSlider.svelte';
  import Histogram from '$lib/components/frameleaf/editor/Histogram.svelte';
  import PresetStrip from '$lib/components/frameleaf/editor/PresetStrip.svelte';
  import RestorationCompare from '$lib/components/frameleaf/editor/RestorationCompare.svelte';
  import RestorationPanel, {
    type RestorationCompareRequest,
  } from '$lib/components/frameleaf/editor/RestorationPanel.svelte';
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
    isCompareKey,
    isFullRect,
    rotateAspect,
    rotateRect,
    straightenScale,
    type AspectId,
    type CropRect,
    type DevelopGroupId,
    type DevelopValues,
  } from '$lib/frameleaf/develop';
  import {
    MAX_SPEED_RANGES,
    MAX_TEXT_OVERLAYS,
    MIN_SPAN,
    SPEEDS,
    TEXT_POSITIONS,
    TEXT_SWATCHES,
    changeVideoDraft,
    createVideoDraft,
    fastTrimBounds,
    filmstripTimes,
    fromVideoEdits,
    initialVideoEdit,
    lookLabel,
    pickVideoSettings,
    preciseTime,
    renderedDuration,
    rulerTime,
    sameVideoEdit,
    speedAt,
    toVideoEdits,
    travelVideoDraft,
    type VideoDraft,
    type VideoEdit,
    type VideoSource,
  } from '$lib/frameleaf/video-edit';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { Route } from '$lib/route';
  import { getAssetMediaUrl, getAssetPlaybackUrl } from '$lib/utils';
  import { fileUploadHandler } from '$lib/utils/file-uploader';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    AssetVisibility,
    TextOverlayPosition,
    VideoDevelopPreset,
    editAsset,
    getAssetEditKeyframes,
    getAssetEdits,
    removeAssetEdits,
    type AssetResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import {
    mdiAutoFix,
    mdiCameraIris,
    mdiClose,
    mdiCompare,
    mdiCompareHorizontal,
    mdiContentCopy,
    mdiContentCut,
    mdiContentDuplicate,
    mdiCropRotate,
    mdiDotsVertical,
    mdiFlipHorizontal,
    mdiFlipVertical,
    mdiFormatText,
    mdiImageFilterVintage,
    mdiOpenInApp,
    mdiPause,
    mdiPlay,
    mdiPlus,
    mdiRedo,
    mdiRestore,
    mdiRotateLeft,
    mdiRotateRight,
    mdiShimmer,
    mdiSpeedometer,
    mdiTune,
    mdiUndo,
    mdiVideoStabilization,
    mdiVolumeHigh,
  } from '@mdi/js';
  import { onDestroy, onMount, untrack } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  type Tool = 'trim' | 'speed' | 'adjust' | 'crop' | 'audio' | 'text' | 'enhance' | 'presets' | 'restore';

  let {
    asset,
    onClose,
  }: {
    asset: AssetResponseDto;
    /** `refreshAsset` is true when a saved version changed what the viewer should show. */
    onClose: (refreshAsset?: boolean) => void;
  } = $props();

  // Editor.jsx TOOLS (lines 46-55), in the prototype's order; Restore follows as on photos (E-9).
  const tools: { id: Tool; label: Translations; icon: string }[] = [
    { id: 'trim', label: 'frameleaf_video_editor_tool_trim', icon: mdiContentCut },
    { id: 'speed', label: 'frameleaf_video_editor_tool_speed', icon: mdiSpeedometer },
    { id: 'adjust', label: 'frameleaf_editor_tool_adjust', icon: mdiTune },
    { id: 'crop', label: 'frameleaf_editor_tool_crop', icon: mdiCropRotate },
    { id: 'audio', label: 'frameleaf_video_editor_tool_audio', icon: mdiVolumeHigh },
    { id: 'text', label: 'frameleaf_video_editor_tool_text', icon: mdiFormatText },
    { id: 'enhance', label: 'frameleaf_video_editor_tool_enhance', icon: mdiAutoFix },
    { id: 'presets', label: 'frameleaf_editor_tool_presets', icon: mdiImageFilterVintage },
    { id: 'restore', label: 'frameleaf_editor_tool_restore', icon: mdiAutoFix },
  ];

  const POSITION_LABELS: Record<TextOverlayPosition, Translations> = {
    [TextOverlayPosition.TopLeft]: 'frameleaf_video_editor_position_top_left',
    [TextOverlayPosition.Top]: 'frameleaf_video_editor_position_top',
    [TextOverlayPosition.TopRight]: 'frameleaf_video_editor_position_top_right',
    [TextOverlayPosition.Left]: 'frameleaf_video_editor_position_left',
    [TextOverlayPosition.Center]: 'frameleaf_video_editor_position_center',
    [TextOverlayPosition.Right]: 'frameleaf_video_editor_position_right',
    [TextOverlayPosition.BottomLeft]: 'frameleaf_video_editor_position_bottom_left',
    [TextOverlayPosition.Bottom]: 'frameleaf_video_editor_position_bottom',
    [TextOverlayPosition.BottomRight]: 'frameleaf_video_editor_position_bottom_right',
  };

  const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
  const round = (value: number, places = 2) => Math.round(value * 10 ** places) / 10 ** places;
  const newId = () => crypto.randomUUID().slice(0, 8);

  /* Source and draft ------------------------------------------------------- */
  const playbackUrl = getAssetPlaybackUrl({ id: asset.id, cacheKey: asset.thumbhash, edited: false });
  const posterUrl = getAssetMediaUrl({
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

  let source = $state<VideoSource | null>(null);
  let loadFailed = $state(false);
  const duration = $derived(source ? Math.max(MIN_SPAN, source.durationMs / 1000) : 0);
  let draft = $state<VideoDraft>(createVideoDraft(initialVideoEdit(0)));
  let opened = $state<VideoEdit>(initialVideoEdit(0));
  const edit = $derived(draft.edit);
  const values = $derived(Object.fromEntries(DEVELOP_KEYS.map((key) => [key, edit[key]])) as DevelopValues);
  const dirty = $derived(!!source && !sameVideoEdit(edit, opened));
  const change = (patch: Partial<VideoEdit>) => {
    if (duration > 0) {
      draft = changeVideoDraft(draft, patch, duration);
    }
  };
  const recipeKey = $derived(source ? JSON.stringify(toVideoEdits(edit, source)) : '[]');

  onMount(async () => {
    try {
      const { edits, originalVideo } = await getAssetEdits({ id: asset.id });
      if (
        !originalVideo ||
        [originalVideo.width, originalVideo.height, originalVideo.durationMs].some(
          (value) => !(Number.isFinite(value) && value > 0),
        )
      ) {
        throw new Error('Original video metadata unavailable');
      }
      source = originalVideo;
      const start = fromVideoEdits(edits, originalVideo);
      draft = createVideoDraft(start);
      opened = start;
    } catch (error) {
      loadFailed = true;
      handleError(error, $t('frameleaf_video_editor_load_error'));
    }
  });

  /* Stage ------------------------------------------------------------------ */
  let tool = $state<Tool>('trim');
  let playing = $state(false);
  let before = $state(false);
  let split = $state(false);
  let splitAt = $state(0.5);
  let time = $state(0);
  let natural = $state<{ w: number; h: number } | null>(null);
  let videoError = $state(false);
  let dragRect = $state<CropRect | null>(null);
  let dragTrim = $state<{ key: 'start' | 'end'; value: number } | null>(null);
  let dragging = $state(false);
  let tick = $state(0);
  let announce = $state('');
  let openGroups = $state<Record<DevelopGroupId, boolean>>({ light: true, color: true, effects: false, detail: false });
  let restorationCompare = $state<RestorationCompareRequest | null>(null);
  // Prototype RestorePanel "Loupe" (Studio.jsx:1634).
  let restorationLoupe = $state(false);
  let saving = $state(false);
  let saveChangedCurrent = false;

  let canvasEl = $state<HTMLDivElement>();
  let videoEl = $state<HTMLVideoElement>();
  let mirrorEl = $state<HTMLCanvasElement>();
  let stripEl = $state<HTMLDivElement>();
  let stage = $state({ w: 0, h: 0 });

  $effect(() => {
    if (tool !== 'restore') {
      restorationCompare = null;
    }
  });

  // A held compare key or pointer can lose its release when the window loses focus (Editor.jsx:627-637).
  $effect(() => {
    if (!before) {
      return;
    }
    const release = () => (before = false);
    addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);
    return () => {
      removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
    };
  });

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
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  });

  /* Playback (Editor.jsx:570-626) --------------------------------------------- */
  $effect(() => {
    const element = videoEl;
    const wantPlaying = playing;
    if (!element || videoError) {
      return;
    }
    untrack(() => {
      if (wantPlaying) {
        if (element.currentTime < edit.start || element.currentTime >= edit.end - 0.02) {
          element.currentTime = edit.start;
        }
        element.play().catch(() => (playing = false));
      } else {
        element.pause();
      }
    });
  });
  $effect(() => {
    const element = videoEl;
    const volume = edit.volume;
    if (!element) {
      return;
    }
    element.volume = clamp(volume / 100, 0, 1);
    element.muted = volume === 0;
    element.playbackRate = clamp(speedAt(edit, element.currentTime), 0.0625, 16);
  });
  // A still preview (no playable clip) advances the playhead on a timer, as the prototype does.
  $effect(() => {
    if (!playing || !videoError) {
      return;
    }
    const timer = setInterval(() => {
      const next = time + 0.2 * edit.speed;
      time = next >= edit.end ? edit.start : round(next);
    }, 200);
    return () => clearInterval(timer);
  });
  // Split view mirrors the live video into the "before" canvas.
  $effect(() => {
    if (!split || videoError) {
      return;
    }
    let frame = 0;
    const draw = () => {
      const from = videoEl;
      const target = mirrorEl;
      if (from && target && from.readyState >= 2) {
        if (target.width !== from.videoWidth) {
          target.width = from.videoWidth;
          target.height = from.videoHeight;
        }
        target.getContext('2d')?.drawImage(from, 0, 0);
      }
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  });

  const seek = (next: number) => {
    const value = round(clamp(next, 0, duration));
    time = value;
    const element = videoEl;
    if (element && !videoError && Math.abs(element.currentTime - value) > 0.02) {
      element.currentTime = value;
    }
  };
  const onTimeUpdate = () => {
    const element = videoEl;
    if (!element) {
      return;
    }
    if (playing && element.currentTime >= edit.end - 0.02) {
      element.currentTime = edit.start;
    }
    element.playbackRate = clamp(speedAt(edit, element.currentTime), 0.0625, 16);
    time = round(element.currentTime);
    tick += 1;
  };

  /* Filmstrip (Editor.jsx useFilmstrip, lines 149-228) ------------------------- */
  let frames = $state<string[]>([]);
  let stripLoading = $state(false);
  $effect(() => {
    const length = duration;
    if (!(length > 0)) {
      return;
    }
    const times = filmstripTimes(length, 12);
    const fallback = times.map(() => thumbnailUrl);
    frames = fallback;
    let cancelled = false;
    const probe = document.createElement('video');
    probe.muted = true;
    probe.preload = 'auto';
    probe.setAttribute('playsinline', '');
    probe.src = playbackUrl;
    const canvas = document.createElement('canvas');
    const captured: string[] = [];
    const seekTo = (at: number) =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timeout')), 2500);
        const done = () => {
          clearTimeout(timer);
          probe.removeEventListener('seeked', done);
          resolve();
        };
        probe.addEventListener('seeked', done);
        probe.currentTime = Math.min(at, Math.max(0, (probe.duration || length) - 0.05));
      });
    const run = async () => {
      stripLoading = true;
      try {
        await new Promise<void>((resolve, reject) => {
          if (probe.readyState >= 1) {
            resolve();
            return;
          }
          probe.addEventListener('loadedmetadata', () => resolve(), { once: true });
          probe.addEventListener('error', () => reject(new Error('load')), { once: true });
        });
        const width = 96;
        canvas.width = width;
        canvas.height = Math.max(1, Math.round((width * (probe.videoHeight || 9)) / (probe.videoWidth || 16)));
        const context = canvas.getContext('2d');
        for (const at of times) {
          if (cancelled || !context) {
            return;
          }
          await seekTo(at);
          context.drawImage(probe, 0, 0, canvas.width, canvas.height);
          captured.push(canvas.toDataURL('image/jpeg', 0.72));
          if (!cancelled) {
            frames = [...captured, ...fallback.slice(captured.length)];
          }
        }
      } catch {
        // The poster stands in for any frame that could not be read.
      } finally {
        if (!cancelled) {
          stripLoading = false;
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
      probe.removeAttribute('src');
      try {
        probe.load();
      } catch {
        // best effort
      }
    };
  });

  /* Geometry (Editor.jsx:650-712) ------------------------------------------ */
  const filterInfo = $derived(cssFilterFor(edit));
  const rect = $derived(dragRect ?? edit.cropRect);
  const cropping = $derived(tool === 'crop');
  const frame = $derived.by(() => {
    if (!stage.w || !stage.h) {
      return null;
    }
    const base = natural ?? { w: source?.width || asset.width || 16, h: source?.height || asset.height || 9 };
    const rotated = edit.rotation % 180 !== 0;
    const ow = rotated ? base.h : base.w;
    const oh = rotated ? base.w : base.h;
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
      const splitX = clamp(splitAt * stage.w - frameLeft, 0, fw);
      if (kind === 'after') {
        left = Math.max(left, splitX);
      } else {
        right = Math.max(right, fw - splitX);
      }
    }
    const clip = top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : 'none';
    return `width:${fw}px;height:${fh}px;margin-left:${-fw / 2}px;margin-top:${-fh / 2}px;transform:translate(${-dx}px, ${-dy}px);clip-path:${clip}`;
  };
  // Video keeps the edited framing while comparing (Editor.jsx:658-660); only the look is dropped.
  const mediaStyle = (plain: boolean) => {
    if (!frame) {
      return '';
    }
    const width = frame.rotated ? frame.fh : frame.fw;
    const height = frame.rotated ? frame.fw : frame.fh;
    const transform = `translate(-50%, -50%) scale(${edit.flipH ? -1 : 1}, ${edit.flipV ? -1 : 1}) rotate(${edit.rotation}deg)`;
    return `width:${width}px;height:${height}px;transform:${transform};filter:${plain ? 'none' : filterInfo.filter}`;
  };
  const straightenStyle = $derived(
    frame
      ? `transform:rotate(${edit.straighten}deg) scale(${edit.straightenFill ? straightenScale(frame.fw, frame.fh, edit.straighten) : 1})`
      : '',
  );
  const windowStyle = $derived(
    frame
      ? `left:${rect.x * frame.fw}px;top:${rect.y * frame.fh}px;width:${rect.w * frame.fw}px;height:${rect.h * frame.fh}px`
      : '',
  );
  const textScale = $derived(frame ? (rect.w * frame.fw) / 1280 : 1);
  const visibleTexts = $derived(
    edit.textOverlays.filter((item) => item.text && time >= item.start && time <= item.end),
  );
  const cropFrame = $derived(
    frame
      ? { width: frame.fw, height: frame.fh, left: stage.w / 2 - frame.fw / 2, top: stage.h / 2 - frame.fh / 2 }
      : null,
  );
  const aspectRatio = $derived(frame ? aspectRatioValue(edit.crop, frame.fw, frame.fh) : null);
  const orientedSource = $derived.by(() => {
    const base = natural ?? { w: source?.width ?? 0, h: source?.height ?? 0 };
    return frame?.rotated ? { w: base.h, h: base.w } : base;
  });

  const chooseAspect = (id: AspectId) => {
    if (!frame) {
      return;
    }
    const ratio = aspectRatioValue(id, frame.fw, frame.fh);
    change({ crop: id, cropRect: id === 'Free' ? edit.cropRect : fitCropRect(ratio, frame.fw, frame.fh) });
  };
  // The frame is turned before it is mirrored (stage and renderer alike), so with one mirror a
  // clockwise turn moves the drawn content the other way, as on photos.
  const rotate = (clockwise: boolean) => {
    const drawn = edit.flipH === edit.flipV ? clockwise : !clockwise;
    change({
      rotation: ((edit.rotation + (clockwise ? 90 : 270)) % 360) as VideoEdit['rotation'],
      cropRect: rotateRect(edit.cropRect, drawn),
      crop: rotateAspect(edit.crop),
    });
  };
  const flip = (axis: 'h' | 'v') =>
    change(
      axis === 'h'
        ? { flipH: !edit.flipH, cropRect: { ...edit.cropRect, x: round(1 - edit.cropRect.x - edit.cropRect.w, 4) } }
        : { flipV: !edit.flipV, cropRect: { ...edit.cropRect, y: round(1 - edit.cropRect.y - edit.cropRect.h, 4) } },
    );
  const geometryDefault = $derived(
    edit.crop === 'Original' &&
      isFullRect(edit.cropRect) &&
      !edit.straighten &&
      !edit.rotation &&
      !edit.flipH &&
      !edit.flipV,
  );
  const resetCrop = () =>
    change({ crop: 'Original', cropRect: { ...FULL_RECT }, straighten: 0, rotation: 0, flipH: false, flipV: false });

  /* Trim (Editor.jsx:885-972) ------------------------------------------------ */
  const trimStart = $derived(dragTrim?.key === 'start' ? dragTrim.value : edit.start);
  const trimEnd = $derived(dragTrim?.key === 'end' ? dragTrim.value : edit.end);
  const percent = (value: number) => (duration > 0 ? (value / duration) * 100 : 0);

  const startDrag = (event: PointerEvent, onMove: (event: PointerEvent) => void, onEnd?: () => void) => {
    const target = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    try {
      target.setPointerCapture(pointerId);
    } catch {
      // best effort
    }
    const move = (next: PointerEvent) => {
      if (next.pointerId === pointerId) {
        onMove(next);
      }
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) {
        return;
      }
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', end);
      target.removeEventListener('pointercancel', end);
      onEnd?.();
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', end);
    target.addEventListener('pointercancel', end);
  };
  const timeFromPointer = (event: PointerEvent) => {
    const box = stripEl?.getBoundingClientRect();
    return box ? round(clamp(((event.clientX - box.left) / box.width) * duration, 0, duration)) : 0;
  };
  const beginTrim = (key: 'start' | 'end') => (event: PointerEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const initial = edit[key];
    let latest = initial;
    startDrag(
      event,
      (next) => {
        const at = timeFromPointer(next);
        latest =
          key === 'start'
            ? clamp(at, 0, round(edit.end - MIN_SPAN))
            : clamp(at, round(edit.start + MIN_SPAN), duration);
        dragTrim = { key, value: latest };
        seek(latest);
      },
      () => {
        dragTrim = null;
        if (latest !== initial) {
          change({ [key]: latest });
        }
      },
    );
  };
  const trimKey = (key: 'start' | 'end') => (event: KeyboardEvent) => {
    const step = event.shiftKey ? 1 : 0.1;
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowLeft':
      case 'ArrowDown': {
        next = edit[key] - step;

        break;
      }
      case 'ArrowRight':
      case 'ArrowUp': {
        next = edit[key] + step;

        break;
      }
      case 'Home': {
        next = key === 'start' ? 0 : edit.start + MIN_SPAN;

        break;
      }
      case 'End': {
        next = key === 'start' ? edit.end - MIN_SPAN : duration;

        break;
      }
      // No default
    }
    if (next === null) {
      return;
    }
    event.preventDefault();
    const value =
      key === 'start'
        ? clamp(round(next), 0, round(edit.end - MIN_SPAN))
        : clamp(round(next), round(edit.start + MIN_SPAN), duration);
    change({ [key]: value });
    seek(value);
  };
  const scrubStrip = (event: PointerEvent) => {
    if (event.pointerType === 'mouse' && event.button !== 0) {
      return;
    }
    playing = false;
    seek(timeFromPointer(event));
    startDrag(event, (next) => seek(timeFromPointer(next)));
  };
  // Scrubbing the filmstrip is a pointer gesture over the frames; the playhead range above is its
  // keyboard equivalent, so the strip itself is not a focusable control.
  $effect(() => {
    const element = stripEl;
    if (!element) {
      return;
    }
    element.addEventListener('pointerdown', scrubStrip);
    return () => element.removeEventListener('pointerdown', scrubStrip);
  });
  const setIn = (at: number) => {
    const value = clamp(round(at), 0, round(edit.end - MIN_SPAN));
    change({ start: value });
    announce = $t('frameleaf_video_editor_in_point', { values: { time: preciseTime(value) } });
  };
  const setOut = (at: number) => {
    const value = clamp(round(at), round(edit.start + MIN_SPAN), duration);
    change({ end: value });
    announce = $t('frameleaf_video_editor_out_point', { values: { time: preciseTime(value) } });
  };
  const outputLength = $derived(renderedDuration(edit));
  const trimmedLength = $derived(round(edit.end - edit.start, 3));
  const otherEdits = $derived(!!source && toVideoEdits({ ...edit, start: 0, end: duration }, source).length > 0);
  // The original's keyframes, read once the fast trim is chosen, so the panel shows where it cuts.
  let keyframesMs = $state<number[] | null>(null);
  let keyframesRequested = false;
  $effect(() => {
    if (edit.trim !== 'fast' || keyframesRequested || !source) {
      return;
    }
    keyframesRequested = true;
    getAssetEditKeyframes({ id: asset.id })
      .then((result) => (keyframesMs = result.keyframesMs))
      .catch(() => (keyframesMs = null));
  });
  const fastBounds = $derived(fastTrimBounds(keyframesMs, edit, duration));

  const beginSplit = (event: PointerEvent) => {
    event.preventDefault();
    const box = canvasEl?.getBoundingClientRect();
    if (!box) {
      return;
    }
    startDrag(event, (next) => (splitAt = clamp((next.clientX - box.left) / box.width, 0.04, 0.96)));
  };

  /* Speed (Editor.jsx:1152-1167) --------------------------------------------- */
  const addRange = () => {
    const span = Math.max(0.5, (edit.end - edit.start) / 5);
    const from = time >= edit.end - 0.2 ? edit.start : Math.max(edit.start, time);
    change({
      speedSegments: [
        ...edit.speedSegments,
        { start: round(from), end: round(Math.min(edit.end, from + span)), speed: 2 },
      ],
    });
  };
  const updateRange = (index: number, patch: Partial<VideoEdit['speedSegments'][number]>) =>
    change({ speedSegments: edit.speedSegments.map((item, i) => (i === index ? { ...item, ...patch } : item)) });

  /* Text (Editor.jsx:1131-1150) ---------------------------------------------- */
  const addOverlay = () =>
    change({
      textOverlays: [
        ...edit.textOverlays,
        {
          id: newId(),
          text: $t('frameleaf_video_editor_text_default'),
          position: TextOverlayPosition.Bottom,
          start: round(time),
          end: round(Math.min(duration, time + 4)),
          fontSize: 32,
          color: '#ffffff',
          shadow: true,
        },
      ],
    });
  const updateOverlay = (id: string, patch: Partial<VideoEdit['textOverlays'][number]>) =>
    change({ textOverlays: edit.textOverlays.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  const textCell = (position: TextOverlayPosition) => {
    const index = TEXT_POSITIONS.indexOf(position);
    const column = (index % 3) + 1;
    const row = Math.floor(index / 3) + 1;
    const align = ['flex-start', 'center', 'flex-end'];
    return `grid-column:${column};grid-row:${row};justify-content:${align[column - 1]};align-items:${align[row - 1]};text-align:${['left', 'center', 'right'][column - 1]}`;
  };

  /* Top bar actions (Editor.jsx:976-1077) ------------------------------------ */
  const cancel = () => {
    if (dirty) {
      toastManager.primary($t('frameleaf_editor_edits_discarded'));
    }
    onClose(saveChangedCurrent);
  };
  const openStudio = () => {
    cancel();
    void goto(Route.studio({ assetIds: [asset.id] }));
  };
  const revert = () => change({ ...initialVideoEdit(duration), legacy: [] });
  const copySettings = () => {
    videoSettingsClipboard = pickVideoSettings(edit);
    toastManager.primary($t('frameleaf_editor_settings_copied'));
  };
  const pasteSettings = () => {
    if (!videoSettingsClipboard) {
      return;
    }
    change(videoSettingsClipboard);
    toastManager.primary($t('frameleaf_editor_settings_pasted'));
  };
  const applyVersion = (edits: Array<{ action: string; parameters: unknown }>) => {
    if (source) {
      change(fromVideoEdits(edits, source));
    }
  };

  /**
   * The frame at the playhead as a new photo (`Editor.jsx` exportFrame), drawn with the edit's
   * turns, flips, crop and look, uploaded beside the clip. A clip in Locked stays in Locked.
   */
  const exportFrame = () => {
    const element = videoEl;
    if (!element || videoError || !element.videoWidth || !element.videoHeight) {
      toastManager.danger($t('frameleaf_video_editor_frame_error'));
      return;
    }
    const at = time;
    const rotated = edit.rotation % 180 !== 0;
    const shownW = rotated ? element.videoHeight : element.videoWidth;
    const shownH = rotated ? element.videoWidth : element.videoHeight;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(edit.cropRect.w * shownW));
    canvas.height = Math.max(1, Math.round(edit.cropRect.h * shownH));
    const context = canvas.getContext('2d');
    if (!context) {
      toastManager.danger($t('frameleaf_video_editor_frame_error'));
      return;
    }
    // The look is drawn where the canvas supports filters; Safari before 18 draws the frame without it.
    Reflect.set(context, 'filter', filterInfo.filter);
    context.translate(-edit.cropRect.x * shownW, -edit.cropRect.y * shownH);
    context.translate(shownW / 2, shownH / 2);
    context.rotate((edit.straighten * Math.PI) / 180);
    const cover = edit.straightenFill ? straightenScale(shownW, shownH, edit.straighten) : 1;
    context.scale(cover * (edit.flipH ? -1 : 1), cover * (edit.flipV ? -1 : 1));
    context.rotate((edit.rotation * Math.PI) / 180);
    context.drawImage(element, -element.videoWidth / 2, -element.videoHeight / 2);
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          toastManager.danger($t('frameleaf_video_editor_frame_error'));
          return;
        }
        const base = asset.originalFileName.replace(/\.[^.]+$/, '');
        const file = new File([blob], `${base} ${preciseTime(at).replace(':', '.')}.jpg`, { type: 'image/jpeg' });
        void fileUploadHandler({ files: [file], isLockedAssets: asset.visibility === AssetVisibility.Locked })
          .then(() =>
            toastManager.primary($t('frameleaf_video_editor_frame_saved', { values: { time: preciseTime(at) } })),
          )
          .catch((error: unknown) => handleError(error, $t('frameleaf_video_editor_frame_error')));
      },
      'image/jpeg',
      0.92,
    );
  };

  const saveVersion = async () => {
    if (saving || !source) {
      return;
    }
    const edits = toVideoEdits(edit, source);
    // Saving the original over the original would only add an empty version.
    if (edits.length === 0 && !asset.isEdited) {
      onClose(saveChangedCurrent);
      return;
    }
    saving = true;
    try {
      await (edits.length === 0
        ? removeAssetEdits({ id: asset.id })
        : editAsset({ id: asset.id, assetEditsCreateDto: { edits } }));
      eventManager.emit('AssetEditsApplied', asset.id);
      opened = edit;
      toastManager.primary($t('frameleaf_video_editor_saved'));
      onClose(true);
    } catch (error) {
      handleError(error, $t('frameleaf_editor_save_error'));
    } finally {
      saving = false;
    }
  };

  const moreItems = $derived.by((): EditorMenuItem[] => [
    { id: 'copy', label: $t('frameleaf_editor_copy_settings'), icon: mdiContentCopy, onSelect: copySettings },
    {
      id: 'paste',
      label: $t('frameleaf_editor_paste_settings'),
      icon: mdiContentDuplicate,
      disabled: !videoSettingsClipboard,
      onSelect: pasteSettings,
    },
    { id: 'revert', label: $t('frameleaf_editor_revert_draft'), icon: mdiRestore, onSelect: revert },
    { id: 'frame', label: $t('frameleaf_video_editor_export_frame_title'), icon: mdiCameraIris, onSelect: exportFrame },
    { id: 'studio', label: $t('frameleaf_editor_open_in_studio'), icon: mdiOpenInApp, onSelect: openStudio },
  ]);

  /* Keyboard (Editor.jsx:1080-1117), called by the hosting dialog -------------------- */
  const isEditable = (target: EventTarget | null) =>
    target instanceof HTMLElement &&
    (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable);

  export function keyDown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
      return;
    }
    // Compare also works while an adjustment slider has focus.
    const typing = isEditable(event.target) && (event.target as HTMLInputElement).type !== 'range';
    if (!typing && isCompareKey(event)) {
      event.preventDefault();
      if (!event.repeat) {
        before = true;
      }
      return;
    }
    if (isEditable(event.target)) {
      return;
    }
    const target = event.target as HTMLElement | null;
    const key = event.key.toLowerCase();
    const mod = event.metaKey || event.ctrlKey;
    if (key === 'z' && mod) {
      event.preventDefault();
      draft = travelVideoDraft(draft, event.shiftKey ? 'redo' : 'undo');
    } else if (key === ' ' && target?.tagName !== 'BUTTON' && target?.getAttribute('role') !== 'slider') {
      event.preventDefault();
      playing = !playing;
    } else if (key === 'i' && !mod) {
      setIn(time);
    } else if (key === 'o' && !mod) {
      setOut(time);
    }
  }

  export function keyUp(event: KeyboardEvent) {
    if (isCompareKey(event, { release: true })) {
      before = false;
    }
  }

  const railKey = (event: KeyboardEvent) => {
    const index = tools.findIndex((item) => item.id === tool);
    const step = new Map([
      ['ArrowDown', index + 1],
      ['ArrowRight', index + 1],
      ['ArrowUp', index - 1],
      ['ArrowLeft', index - 1],
      ['Home', 0],
      ['End', tools.length - 1],
    ]).get(event.key);
    if (step === undefined) {
      return;
    }
    event.preventDefault();
    const next = tools[(step + tools.length) % tools.length];
    tool = next.id;
    (event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tool="${CSS.escape(next.id)}"]`)?.focus();
  };

  onDestroy(() => {
    videoEl?.pause();
  });

  const dimensions = $derived(
    natural ? `${natural.w} × ${natural.h}` : source ? `${source.width} × ${source.height}` : '',
  );
  const peopleNames = $derived(
    (asset.people ?? []).map((person) => person.name).filter((name): name is string => !!name),
  );
  const allAdjustDefault = $derived(DEVELOP_KEYS.every((key) => edit[key] === 0));
  const activeTool = $derived(tools.find((item) => item.id === tool) ?? tools[0]);
  const formatSpeed = (value: number) => `${value}×`;
  // Editor.jsx:1768-1812. The prototype's simulated "Analyzing…" status is not shown: the work
  // happens when the version renders, and the status says exactly that.
  const enhanceItems: { key: 'stabilize' | 'autoEnhance'; label: Translations; icon: string; help: Translations }[] = [
    {
      key: 'stabilize',
      label: 'frameleaf_video_editor_stabilize',
      icon: mdiVideoStabilization,
      help: 'frameleaf_video_editor_stabilize_help',
    },
    {
      key: 'autoEnhance',
      label: 'frameleaf_video_editor_auto_enhance',
      icon: mdiShimmer,
      help: 'frameleaf_video_editor_auto_enhance_help',
    },
  ];
</script>

<div class="ed-shell">
  <header class="ed-top">
    <button type="button" class="ed-tool labelled compact" onclick={cancel} title={$t('frameleaf_editor_cancel_title')}>
      <Icon icon={mdiClose} size="20" />
      <span>{$t('cancel')}</span>
    </button>
    <div class="ed-title">
      <strong>{asset.originalFileName}</strong>
      <span>
        {$t('frameleaf_editor_kind_video')}{dimensions ? ` · ${dimensions}` : ''}{duration
          ? ` · ${rulerTime(duration)}`
          : ''}{dirty ? ` · ${$t('frameleaf_editor_edited')}` : ''}
        {#if peopleNames.length > 0}
          <span class="people"
            >· {$t('frameleaf_editor_with_people', { values: { names: peopleNames.join(', ') } })}</span
          >
        {/if}
      </span>
    </div>
    <button
      type="button"
      class="ed-tool"
      aria-label={$t('undo')}
      title={$t('undo')}
      disabled={draft.undo.length === 0}
      onclick={() => (draft = travelVideoDraft(draft, 'undo'))}
    >
      <Icon icon={mdiUndo} size="20" />
    </button>
    <button
      type="button"
      class="ed-tool"
      aria-label={$t('frameleaf_editor_redo')}
      title={$t('frameleaf_editor_redo')}
      disabled={draft.redo.length === 0}
      onclick={() => (draft = travelVideoDraft(draft, 'redo'))}
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
        event.stopPropagation();
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
    <span class="ed-sep ed-wide" aria-hidden="true"></span>
    <button
      type="button"
      class="ed-tool labelled ed-wide"
      title={$t('frameleaf_editor_copy_settings')}
      onclick={copySettings}
    >
      <Icon icon={mdiContentCopy} size="20" />
      <span>{$t('frameleaf_editor_copy')}</span>
    </button>
    <button
      type="button"
      class="ed-tool labelled ed-wide"
      title={$t('frameleaf_editor_paste_settings')}
      disabled={!videoSettingsClipboard}
      onclick={pasteSettings}
    >
      <Icon icon={mdiContentDuplicate} size="20" />
      <span>{$t('frameleaf_editor_paste')}</span>
    </button>
    <button type="button" class="ed-tool labelled ed-wide" title={$t('frameleaf_editor_revert_draft')} onclick={revert}>
      <Icon icon={mdiRestore} size="20" />
      <span>{$t('frameleaf_editor_revert')}</span>
    </button>
    {#key asset.id}
      <VideoVersionsMenu {asset} draftKey={recipeKey} hasUnsavedChanges={dirty} onApply={applyVersion} />
    {/key}
    <EditorMenu
      label={$t('frameleaf_editor_more_actions')}
      icon={mdiDotsVertical}
      class="ed-narrow"
      items={moreItems}
    />
    <button
      type="button"
      class="ed-tool labelled ed-wide"
      onclick={openStudio}
      title={$t('frameleaf_editor_open_in_studio')}
    >
      <Icon icon={mdiOpenInApp} size="20" />
      <span>{$t('frameleaf_editor_open_in_studio')}</span>
    </button>
    <button
      type="button"
      class="ed-tool primary labelled"
      disabled={saving || !source}
      onclick={saveVersion}
      title={$t('frameleaf_video_editor_save_title')}
    >
      <span>{saving ? $t('frameleaf_editor_saving') : $t('frameleaf_editor_save_version')}</span>
    </button>
  </header>

  <div class="ed-stage-wrap">
    <div
      class={['ed-stage', cropping && 'cropping', dragging && 'dragging', before && !split && 'comparing']}
      aria-label={$t('frameleaf_editor_preview')}
    >
      <div class="ed-canvas" bind:this={canvasEl}>
        {#if tool === 'restore' && restorationCompare}
          <div class="ed-restore-stage">
            <RestorationCompare {...restorationCompare} alt={asset.originalFileName} loupe={restorationLoupe} />
          </div>
        {:else if loadFailed}
          <div class="ed-unavailable"><strong>{$t('frameleaf_video_editor_load_error')}</strong></div>
        {:else if frame}
          {#if split}
            <div class="ed-frame before" style={frameStyle('before')} aria-hidden="true">
              <div class="ed-media" style={straightenStyle}>
                {#if videoError}
                  <img src={posterUrl} alt="" draggable="false" style={mediaStyle(true)} />
                {:else}
                  <canvas bind:this={mirrorEl} style={mediaStyle(true)}></canvas>
                {/if}
              </div>
            </div>
          {/if}
          <div class="ed-frame after" style={frameStyle('after')}>
            <div class="ed-media" style={straightenStyle}>
              {#if videoError}
                <img src={posterUrl} alt={asset.originalFileName} draggable="false" style={mediaStyle(before)} />
              {:else}
                <!-- The clip's own audio is the soundtrack being edited; there is no caption track to offer. -->
                <!-- svelte-ignore a11y_media_has_caption -->
                <video
                  bind:this={videoEl}
                  src={playbackUrl}
                  poster={posterUrl}
                  playsinline
                  preload="auto"
                  style={mediaStyle(before)}
                  onloadedmetadata={(event) => {
                    natural = { w: event.currentTarget.videoWidth, h: event.currentTarget.videoHeight };
                    if (Math.abs(event.currentTarget.currentTime - time) > 0.05) {
                      event.currentTarget.currentTime = time;
                    }
                    tick += 1;
                  }}
                  onloadeddata={() => (tick += 1)}
                  onseeked={() => (tick += 1)}
                  ontimeupdate={onTimeUpdate}
                  onended={() => (playing = false)}
                  onerror={() => (videoError = true)}
                ></video>
              {/if}
            </div>
            {#if !before}
              <div class="ed-window" style={windowStyle}>
                {#each filterInfo.layers as layer (layer.id)}
                  <div class="ed-layer" style={layer.style}></div>
                {/each}
                {#if visibleTexts.length > 0}
                  <div class="ed-text-layer">
                    {#each visibleTexts as item (item.id)}
                      <div
                        class={['ed-overlay-text', item.shadow && 'with-shadow']}
                        style="{textCell(item.position)};color:{item.color};font-size:{Math.max(
                          9,
                          item.fontSize * textScale,
                        )}px"
                      >
                        <span>{item.text}</span>
                      </div>
                    {/each}
                  </div>
                {/if}
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
              aspectLabel={edit.crop === 'Free' ? undefined : edit.crop}
              onPreview={(next) => (dragRect = next)}
              onCommit={(next) => change({ cropRect: next })}
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
        <span class="ed-badge ed-original">{$t('frameleaf_editor_version_original')}</span>
      {/if}
      {#if videoError && !loadFailed}
        <span class="ed-badge centre">{$t('frameleaf_video_editor_preview_still')}</span>
      {/if}
    </div>

    {#if duration > 0}
      <div class="ed-transport">
        <div class="ed-transport-row">
          <button
            type="button"
            class="ed-tool"
            aria-label={playing ? $t('pause') : $t('play')}
            title={playing ? $t('pause') : $t('play')}
            onclick={() => (playing = !playing)}
          >
            <Icon icon={playing ? mdiPause : mdiPlay} size="20" />
          </button>
          <span class="ed-timecode">{preciseTime(time)} / {preciseTime(duration)}</span>
          <input
            class="ed-scrub"
            type="range"
            aria-label={$t('frameleaf_video_editor_playhead')}
            min="0"
            max={duration}
            step="0.01"
            value={time}
            oninput={(event) => seek(Number(event.currentTarget.value))}
          />
          <span class="ed-rate" aria-label={$t('frameleaf_video_editor_playback_rate')}>
            {formatSpeed(speedAt(edit, time))}
          </span>
          <button
            type="button"
            class="ed-tool labelled compact"
            title={$t('frameleaf_video_editor_export_frame_title')}
            onclick={exportFrame}
          >
            <Icon icon={mdiCameraIris} size="20" />
            <span>{$t('frameleaf_video_editor_export_frame')}</span>
          </button>
        </div>
        <div class="ed-strip" bind:this={stripEl}>
          <div class={['ed-frames', stripLoading && 'loading']} aria-hidden="true">
            {#each frames as frameSrc, index (index)}
              <img src={frameSrc} alt="" draggable="false" />
            {/each}
          </div>
          <div class="ed-dim" style="left:0;width:{percent(trimStart)}%"></div>
          <div class="ed-dim" style="left:{percent(trimEnd)}%;right:0"></div>
          <div class="ed-range" style="left:{percent(trimStart)}%;width:{percent(trimEnd - trimStart)}%"></div>
          {#each edit.speedSegments as range, index (index)}
            <div class="ed-segment" style="left:{percent(range.start)}%;width:{percent(range.end - range.start)}%">
              <span>{formatSpeed(range.speed)}</span>
            </div>
          {/each}
          <button
            type="button"
            class="ed-trim-handle in"
            role="slider"
            aria-label={$t('frameleaf_video_editor_trim_in')}
            aria-valuemin={0}
            aria-valuemax={round(edit.end - MIN_SPAN)}
            aria-valuenow={trimStart}
            aria-valuetext={preciseTime(trimStart)}
            style="left:{percent(trimStart)}%"
            onpointerdown={beginTrim('start')}
            onkeydown={trimKey('start')}
          ></button>
          <button
            type="button"
            class="ed-trim-handle out"
            role="slider"
            aria-label={$t('frameleaf_video_editor_trim_out')}
            aria-valuemin={round(edit.start + MIN_SPAN)}
            aria-valuemax={duration}
            aria-valuenow={trimEnd}
            aria-valuetext={preciseTime(trimEnd)}
            style="left:{percent(trimEnd)}%"
            onpointerdown={beginTrim('end')}
            onkeydown={trimKey('end')}
          ></button>
          <div class="ed-playhead" style="left:{percent(time)}%"></div>
        </div>
        <div class="ed-ruler" aria-hidden="true">
          {#each Array.from({ length: 7 }, (_, i) => (duration * i) / 6) as mark (mark)}
            <span>{rulerTime(mark)}</span>
          {/each}
        </div>
      </div>
    {/if}
  </div>

  <div class="ed-side">
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
          aria-controls="fl-video-editor-panel"
          tabindex={tool === item.id ? 0 : -1}
          title={$t(item.label)}
          onclick={() => (tool = item.id)}
        >
          <Icon icon={item.icon} size="22" />
          <span>{$t(item.label)}</span>
        </button>
      {/each}
    </div>

    <div class="ed-panel" id="fl-video-editor-panel" role="tabpanel" aria-label={$t(activeTool.label)}>
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
          <Histogram source={videoEl} approximation={filterInfo} fromServer={false} {tick} />
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
          {#if edit.legacy.length > 0}
            <p class="ed-note" role="note">{$t('frameleaf_video_editor_legacy_adjustments')}</p>
          {/if}
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
              disabled={geometryDefault}
              onclick={resetCrop}
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
                aria-checked={edit.crop === aspect.id}
                onclick={() => chooseAspect(aspect.id)}
              >
                {aspect.label.startsWith('frameleaf_') ? $t(aspect.label as Translations) : aspect.label}
              </button>
            {/each}
          </div>
          <h3>{$t('frameleaf_editor_straighten')}</h3>
          <div class="ed-dial" style="--dial-x: {edit.straighten * 8}px">
            <output aria-hidden="true">{edit.straighten > 0 ? '+' : ''}{edit.straighten.toFixed(1)}°</output>
            <input
              type="range"
              aria-label={$t('frameleaf_editor_straighten')}
              title={$t('frameleaf_editor_double_click_reset')}
              min="-45"
              max="45"
              step="0.5"
              value={edit.straighten}
              aria-valuetext={$t('frameleaf_editor_degrees', { values: { degrees: edit.straighten.toFixed(1) } })}
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
            <button type="button" class="ed-button" aria-pressed={edit.flipH} onclick={() => flip('h')}>
              <Icon icon={mdiFlipHorizontal} size="18" />
              {$t('editor_flip_horizontal')}
            </button>
            <button type="button" class="ed-button" aria-pressed={edit.flipV} onclick={() => flip('v')}>
              <Icon icon={mdiFlipVertical} size="18" />
              {$t('editor_flip_vertical')}
            </button>
          </div>
          <p class="ed-note">{$t('frameleaf_editor_crop_help')}</p>
        </div>
      {:else if tool === 'presets'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_editor_tool_presets')}</h2>
          </div>
          <PresetStrip
            {thumbnailUrl}
            {values}
            kind="video"
            preset={edit.preset}
            onSelect={(preset) =>
              change({ preset, presetStrength: edit.preset === preset ? edit.presetStrength : 100 })}
          />
          <EditorSlider
            id="presetStrength"
            label={$t('frameleaf_editor_preset_strength', { values: { preset: $t(lookLabel(edit.preset)) } })}
            value={edit.presetStrength}
            min={0}
            max={100}
            step={1}
            defaultValue={100}
            disabled={edit.preset === VideoDevelopPreset.Original}
            format={(value) => `${value}%`}
            onChange={(value) => change({ presetStrength: value })}
          />
          <h3>{$t('frameleaf_editor_social_formats')}</h3>
          <div class="ed-row">
            {#each SOCIAL_PRESETS as item (item.id)}
              <button
                type="button"
                class="ed-chip"
                aria-pressed={edit.crop === item.aspect}
                onclick={() => chooseAspect(item.aspect)}
              >
                {$t(item.label)}
                <small>{$t(item.note)}</small>
              </button>
            {/each}
          </div>
          <p>{$t('frameleaf_editor_social_help')}</p>
        </div>
      {:else if tool === 'trim'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_video_editor_tool_trim')}</h2>
            <button
              type="button"
              class="ed-icon"
              aria-label={$t('frameleaf_video_editor_reset_trim')}
              title={$t('frameleaf_video_editor_reset_trim')}
              disabled={edit.start === 0 && edit.end === round(duration, 3)}
              onclick={() => change({ start: 0, end: duration })}
            >
              <Icon icon={mdiRestore} size="18" />
            </button>
          </div>
          <div class="ed-row" role="radiogroup" aria-label={$t('frameleaf_video_editor_trim_mode')}>
            <button
              type="button"
              role="radio"
              class="ed-chip"
              aria-checked={edit.trim === 'precise'}
              onclick={() => change({ trim: 'precise' })}
            >
              {$t('frameleaf_video_editor_trim_precise')}
            </button>
            <button
              type="button"
              role="radio"
              class="ed-chip"
              aria-checked={edit.trim === 'fast'}
              onclick={() => change({ trim: 'fast' })}
            >
              {$t('frameleaf_video_editor_trim_fast')}
            </button>
          </div>
          <p>
            {#if edit.trim === 'fast'}
              {#if otherEdits}
                {$t('frameleaf_video_editor_trim_fast_help', {
                  values: {
                    from: Math.floor(edit.start / 2) * 2,
                    to: Math.min(Math.ceil(duration), Math.ceil(edit.end / 2) * 2),
                  },
                })}
              {:else if fastBounds}
                {$t('frameleaf_video_editor_trim_fast_actual', {
                  values: { from: preciseTime(fastBounds.start), to: preciseTime(fastBounds.end) },
                })}
              {:else}
                {$t('frameleaf_video_editor_trim_fast_help', {
                  values: {
                    from: Math.floor(edit.start / 2) * 2,
                    to: Math.min(Math.ceil(duration), Math.ceil(edit.end / 2) * 2),
                  },
                })}
              {/if}
              {#if otherEdits}
                {$t('frameleaf_video_editor_trim_fast_reencode')}
              {/if}
            {:else}
              {$t('frameleaf_video_editor_trim_precise_help')}
            {/if}
          </p>
          <div class="ed-grid-2">
            <label class="ed-field">
              {$t('frameleaf_video_editor_in_seconds')}
              <input
                type="number"
                min="0"
                max={round(edit.end - MIN_SPAN)}
                step="0.1"
                value={edit.start}
                onchange={(event) => setIn(Number(event.currentTarget.value))}
              />
            </label>
            <label class="ed-field">
              {$t('frameleaf_video_editor_out_seconds')}
              <input
                type="number"
                min={round(edit.start + MIN_SPAN)}
                max={duration}
                step="0.1"
                value={edit.end}
                onchange={(event) => setOut(Number(event.currentTarget.value))}
              />
            </label>
            <button type="button" class="ed-button" onclick={() => setIn(time)}>
              {$t('frameleaf_video_editor_set_in')}
            </button>
            <button type="button" class="ed-button" onclick={() => setOut(time)}>
              {$t('frameleaf_video_editor_set_out')}
            </button>
          </div>
          <p>
            {$t('frameleaf_video_editor_trim_summary', {
              values: {
                start: preciseTime(edit.start),
                end: preciseTime(edit.end),
                length: preciseTime(trimmedLength),
              },
            })}{#if outputLength !== trimmedLength}{$t('frameleaf_video_editor_trim_after_speed', {
                values: { length: preciseTime(outputLength) },
              })}{/if}.
            {$t('frameleaf_video_editor_mark_hint')}
          </p>
        </div>
      {:else if tool === 'speed'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_video_editor_tool_speed')}</h2>
            <button
              type="button"
              class="ed-icon"
              aria-label={$t('frameleaf_video_editor_reset_speed')}
              title={$t('frameleaf_video_editor_reset_speed')}
              disabled={edit.speed === 1 && edit.speedSegments.length === 0}
              onclick={() => change({ speed: 1, speedSegments: [] })}
            >
              <Icon icon={mdiRestore} size="18" />
            </button>
          </div>
          <h3>{$t('frameleaf_video_editor_whole_clip')}</h3>
          <div class="ed-row" role="radiogroup" aria-label={$t('frameleaf_video_editor_clip_speed')}>
            {#each SPEEDS as value (value)}
              <button
                type="button"
                role="radio"
                class="ed-chip"
                aria-checked={edit.speed === value}
                onclick={() => change({ speed: value })}
              >
                {formatSpeed(value)}
              </button>
            {/each}
          </div>
          <div class="ed-row spread ed-ranges-head">
            <h3>{$t('frameleaf_video_editor_ranges')}</h3>
            <button
              type="button"
              class="ed-button"
              disabled={edit.speedSegments.length >= MAX_SPEED_RANGES}
              onclick={addRange}
            >
              <Icon icon={mdiPlus} size="18" />
              {$t('frameleaf_video_editor_add_range')}
            </button>
          </div>
          {#if edit.speedSegments.length === 0}
            <p class="ed-empty">{$t('frameleaf_video_editor_ranges_empty')}</p>
          {/if}
          {#each edit.speedSegments as range, index (`${index}-${range.start}`)}
            {@const number = index + 1}
            <div class="ed-card">
              <div class="ed-card-head">
                <strong>{$t('frameleaf_video_editor_range', { values: { number } })}</strong>
                <button
                  type="button"
                  class="ed-icon"
                  aria-label={$t('frameleaf_video_editor_remove_range', { values: { number } })}
                  onclick={() => change({ speedSegments: edit.speedSegments.filter((_, i) => i !== index) })}
                >
                  <Icon icon={mdiClose} size="18" />
                </button>
              </div>
              <div class="ed-grid-2">
                <label class="ed-field">
                  {$t('frameleaf_video_editor_start')}
                  <input
                    type="number"
                    step="0.1"
                    min={edit.start}
                    max={round(range.end - MIN_SPAN)}
                    value={range.start}
                    onchange={(event) =>
                      updateRange(index, {
                        start: clamp(Number(event.currentTarget.value), edit.start, range.end - MIN_SPAN),
                      })}
                  />
                </label>
                <label class="ed-field">
                  {$t('frameleaf_video_editor_end')}
                  <input
                    type="number"
                    step="0.1"
                    min={round(range.start + MIN_SPAN)}
                    max={edit.end}
                    value={range.end}
                    onchange={(event) =>
                      updateRange(index, {
                        end: clamp(Number(event.currentTarget.value), range.start + MIN_SPAN, edit.end),
                      })}
                  />
                </label>
              </div>
              <div
                class="ed-row"
                role="radiogroup"
                aria-label={$t('frameleaf_video_editor_range_speed', { values: { number } })}
              >
                {#each SPEEDS as value (value)}
                  <button
                    type="button"
                    role="radio"
                    class="ed-chip"
                    aria-checked={range.speed === value}
                    onclick={() => updateRange(index, { speed: value })}
                  >
                    {formatSpeed(value)}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
          <p>
            {$t('frameleaf_video_editor_speed_summary', {
              values: { length: preciseTime(outputLength), rate: speedAt(edit, time) },
            })}
          </p>
        </div>
      {:else if tool === 'audio'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_video_editor_tool_audio')}</h2>
            <button
              type="button"
              class="ed-icon"
              aria-label={$t('frameleaf_video_editor_reset_audio')}
              title={$t('frameleaf_video_editor_reset_audio')}
              disabled={edit.volume === 100}
              onclick={() => change({ volume: 100 })}
            >
              <Icon icon={mdiRestore} size="18" />
            </button>
          </div>
          <EditorSlider
            id="volume"
            label={$t('frameleaf_video_editor_clip_gain')}
            value={edit.volume}
            min={0}
            max={150}
            step={1}
            defaultValue={100}
            format={(value) => `${value}%`}
            onChange={(value) => change({ volume: value })}
          />
          <div class="ed-toggle">
            <strong>{$t('frameleaf_video_editor_mute')}</strong>
            <button
              type="button"
              role="switch"
              class="ed-switch"
              aria-checked={edit.volume === 0}
              aria-label={$t('frameleaf_video_editor_mute')}
              onclick={() => change({ volume: edit.volume ? 0 : 100 })}
            ></button>
            <p>{$t('frameleaf_video_editor_mute_help')}</p>
          </div>
          <p>{$t('frameleaf_video_editor_channels_help')}</p>
        </div>
      {:else if tool === 'text'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_video_editor_tool_text')}</h2>
            <button
              type="button"
              class="ed-button"
              disabled={edit.textOverlays.length >= MAX_TEXT_OVERLAYS}
              onclick={addOverlay}
            >
              <Icon icon={mdiPlus} size="18" />
              {$t('frameleaf_video_editor_add_text')}
            </button>
          </div>
          {#if edit.textOverlays.length === 0}
            <p class="ed-empty">{$t('frameleaf_video_editor_text_empty')}</p>
          {/if}
          {#each edit.textOverlays as item, index (item.id)}
            {@const number = index + 1}
            <div class="ed-card">
              <div class="ed-card-head">
                <strong>{$t('frameleaf_video_editor_text_number', { values: { number } })}</strong>
                <button
                  type="button"
                  class="ed-icon"
                  aria-label={$t('frameleaf_video_editor_remove_text', { values: { number } })}
                  onclick={() => change({ textOverlays: edit.textOverlays.filter((other) => other.id !== item.id) })}
                >
                  <Icon icon={mdiClose} size="18" />
                </button>
              </div>
              <label class="ed-field">
                {$t('frameleaf_video_editor_text_content')}
                <input
                  value={item.text}
                  maxlength="200"
                  oninput={(event) => updateOverlay(item.id, { text: event.currentTarget.value })}
                />
              </label>
              <div class="ed-row spread">
                <div
                  class="ed-nine"
                  role="radiogroup"
                  aria-label={$t('frameleaf_video_editor_text_position', { values: { number } })}
                >
                  {#each TEXT_POSITIONS as position (position)}
                    <button
                      type="button"
                      role="radio"
                      aria-checked={item.position === position}
                      aria-label={$t(POSITION_LABELS[position])}
                      title={$t(POSITION_LABELS[position])}
                      onclick={() => updateOverlay(item.id, { position })}
                    ></button>
                  {/each}
                </div>
                <div class="ed-grid-2 ed-grow">
                  <label class="ed-field">
                    {$t('frameleaf_video_editor_start')}
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      max={item.end}
                      value={item.start}
                      onchange={(event) =>
                        updateOverlay(item.id, { start: clamp(Number(event.currentTarget.value), 0, item.end) })}
                    />
                  </label>
                  <label class="ed-field">
                    {$t('frameleaf_video_editor_end')}
                    <input
                      type="number"
                      step="0.1"
                      min={item.start}
                      max={duration}
                      value={item.end}
                      onchange={(event) =>
                        updateOverlay(item.id, { end: clamp(Number(event.currentTarget.value), item.start, duration) })}
                    />
                  </label>
                </div>
              </div>
              <EditorSlider
                id="size-{item.id}"
                label={$t('frameleaf_video_editor_text_size')}
                value={item.fontSize}
                min={12}
                max={96}
                step={1}
                defaultValue={32}
                format={(value) => $t('frameleaf_video_editor_points', { values: { size: value } })}
                onChange={(value) => updateOverlay(item.id, { fontSize: value })}
              />
              <div class="ed-row spread">
                <div
                  class="ed-swatches"
                  role="radiogroup"
                  aria-label={$t('frameleaf_video_editor_text_colour', { values: { number } })}
                >
                  {#each TEXT_SWATCHES as color (color)}
                    <button
                      type="button"
                      role="radio"
                      class="ed-swatch"
                      style="background:{color}"
                      aria-checked={item.color === color}
                      aria-label={color}
                      onclick={() => updateOverlay(item.id, { color })}
                    ></button>
                  {/each}
                  <input
                    type="color"
                    aria-label={$t('frameleaf_video_editor_text_custom_colour', { values: { number } })}
                    value={item.color}
                    oninput={(event) => updateOverlay(item.id, { color: event.currentTarget.value })}
                  />
                </div>
                <label class="ed-check">
                  <input
                    type="checkbox"
                    checked={item.shadow}
                    onchange={(event) => updateOverlay(item.id, { shadow: event.currentTarget.checked })}
                  />
                  {$t('frameleaf_video_editor_text_shadow')}
                </label>
              </div>
            </div>
          {/each}
        </div>
      {:else if tool === 'enhance'}
        <div class="ed-panel-body">
          <div class="ed-panel-head">
            <h2>{$t('frameleaf_video_editor_tool_enhance')}</h2>
          </div>
          {#each enhanceItems as item (item.key)}
            <div class="ed-toggle">
              <strong><Icon icon={item.icon} size="16" /> {$t(item.label)}</strong>
              <button
                type="button"
                role="switch"
                class="ed-switch"
                aria-checked={edit[item.key]}
                aria-label={$t(item.label)}
                onclick={() => change({ [item.key]: !edit[item.key] })}
              ></button>
              <p>{$t(item.help)}</p>
              {#if edit[item.key]}
                <span class="ed-status" role="status">{$t('frameleaf_video_editor_enhance_on_save')}</span>
              {/if}
            </div>
          {/each}
        </div>
      {:else}
        <RestorationPanel
          {asset}
          onCompare={(compare) => (restorationCompare = compare)}
          onCurrentChanged={() => (saveChangedCurrent = true)}
          loupe={restorationLoupe}
          onLoupeChange={(value) => (restorationLoupe = value)}
          currentFrameSeconds={() => (restorationCompare || videoError ? null : (videoEl?.currentTime ?? null))}
        />
      {/if}
    </div>
  </div>
</div>
<div class="ed-live" role="status" aria-live="polite">{announce}</div>
