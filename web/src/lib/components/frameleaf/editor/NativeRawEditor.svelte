<script lang="ts">
  import EditorSlider from './EditorSlider.svelte';
  import { nativePublicationState, nativeStrokeOverlay } from '$lib/frameleaf/native-editor-state';
  import {
    requestDevelopPreview,
    developFileUrl,
    followDevelop,
    PREVIEW_DEBOUNCE_MS,
  } from '$lib/frameleaf/develop-api';
  import {
    initialNativeRecipe,
    isNativeRecipe,
    nativePreset,
    newNativeMask,
    proposeNativeMask,
    type NativeRecipe,
    type NativeMask,
  } from '$lib/frameleaf/native-develop';
  import {
    getAssetDevelop,
    saveAssetDevelop,
    cancelAssetDevelopRender,
    renderAssetDevelopRevision,
    revertAssetDevelop,
    createDevelopPreset,
    getDevelopPresets,
    type AssetResponseDto,
    type AssetDevelopRevisionResponseDto,
    type DevelopPresetResponseDto,
  } from '@frameleaf/sdk';
  import { onMount, onDestroy } from 'svelte';

  let {
    asset,
    onClose,
    onLegacy,
    onRendered,
  }: {
    asset: AssetResponseDto;
    onClose: (refresh?: boolean) => void;
    onLegacy: () => void;
    onRendered?: (id: string) => void;
  } = $props();
  let recipe = $state<NativeRecipe>(initialNativeRecipe());
  let revisions = $state<AssetDevelopRevisionResponseDto[]>([]);
  let presets = $state<DevelopPresetResponseDto[]>([]);
  let label = $state('');
  let presetName = $state('');
  let error = $state('');
  let busy = $state(false);
  let preview = $state<string | null>(null);
  let sensorCanvas = $state(false);
  let selectedMask = $state<string | null>(null);
  let proposalBusy = $state(false);
  let previewCanvas = $state<boolean | null>(null);
  let previewDimensions = $state({ width: 1, height: 1 });
  let brushRadius = $state(0.025);
  let before = $state(false);
  let zoom = $state(1);
  let loaded = $state(false);
  let revisionId = $state<string | undefined>();
  let undo = $state<NativeRecipe[]>([]);
  let redo = $state<NativeRecipe[]>([]);
  let activeStroke = $state<{ points: [number, number][]; radius: number; erase: boolean } | undefined>();
  let strokeStart: NativeRecipe | undefined;
  let alive = true;
  let proposalAbort: AbortController | undefined;
  let stop: (() => void) | undefined;
  let revoke: (() => void) | undefined;
  const selected = $derived(recipe.masks?.find((mask) => mask.id === selectedMask));
  const clone = <T,>(value: T): T => structuredClone($state.snapshot(value)) as T;
  const change = (next: NativeRecipe) => {
    undo = [...undo, clone(recipe)].slice(-200);
    redo = [];
    recipe = next;
  };
  const patch = (value: Partial<NativeRecipe>) => change({ ...recipe, ...value });
  const maskPatch = (value: Partial<NativeMask>) =>
    change({
      ...recipe,
      masks: recipe.masks?.map((mask) => (mask.id === selectedMask ? { ...mask, ...value } : mask)),
    });
  const failed = (failure: unknown) => {
    error = failure instanceof Error ? failure.message : 'RAW development failed';
  };
  const watch = (targetRevision?: string) => {
    stop?.();
    let renderedBeforeCurrent = 0;
    stop = followDevelop(
      asset.id,
      (develop) => {
        revisions = develop.revisions;
        const state = nativePublicationState(develop, targetRevision);
        if (state.awaitingPublication) {
          if (++renderedBeforeCurrent >= 10) {
            stop?.();
            error = 'Rendered version did not become current; reload versions and retry.';
          }
          return;
        }
        if (state.published || state.terminal) {
          stop?.();
          if (state.published) {
            onRendered?.(asset.id);
          }
        }
      },
      {
        onError: failed,
        continueWhile: (develop) =>
          nativePublicationState(develop, targetRevision).awaitingPublication && renderedBeforeCurrent < 10,
      },
    );
  };
  onMount(async () => {
    try {
      const [develop, savedPresets] = await Promise.all([getAssetDevelop({ id: asset.id }), getDevelopPresets()]);
      if (!alive) {
        return;
      }
      revisions = develop.revisions;
      presets = savedPresets;
      const current = develop.revisions.find((item) => item.isCurrent && isNativeRecipe(item.recipe));
      if (current && isNativeRecipe(current.recipe)) {
        recipe = clone(current.recipe);
        revisionId = current.id;
      }
      loaded = true;
      const pending = revisions.find((item) => item.status === 'queued' || item.status === 'rendering');
      if (pending) {
        watch(pending.id);
      }
    } catch (error_) {
      failed(error_);
    }
  });
  onDestroy(() => {
    alive = false;
    proposalAbort?.abort();
    stop?.();
    revoke?.();
  });
  $effect(() => {
    const candidate = before
      ? {
          ...initialNativeRecipe(),
          crop: recipe.crop,
          straighten: recipe.straighten,
          rotation: recipe.rotation,
          flipHorizontal: recipe.flipHorizontal,
          flipVertical: recipe.flipVertical,
        }
      : clone(recipe);
    const canvas = sensorCanvas;
    const ready = loaded;
    const previewSize = zoom > 1 ? 2048 : 1280;
    if (!ready) {
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void (async () => {
        busy = true;
        error = '';
        try {
          const result = await requestDevelopPreview(
            asset.id,
            { ...candidate, sensorCanvas: canvas },
            previewSize,
            controller.signal,
          );
          if (result && !controller.signal.aborted) {
            revoke?.();
            revoke = result.revoke;
            preview = result.url;
            previewCanvas = canvas;
          }
        } catch (error_) {
          if (!controller.signal.aborted) {
            failed(error_);
          }
        } finally {
          if (!controller.signal.aborted) {
            busy = false;
          }
        }
      })();
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  });
  const save = async () => {
    if (!loaded || busy || proposalBusy) {
      return;
    }
    error = '';
    try {
      const final = clone(recipe);
      delete final.sensorCanvas;
      const result = await saveAssetDevelop({
        id: asset.id,
        assetDevelopSaveDto: {
          recipe: final,
          ...(revisionId && { sourceRevisionId: revisionId }),
          replaceRecipe: true,
          ...(label.trim() && { label: label.trim() }),
          render: true,
        },
      });
      revisionId = result.id;
      revisions = [result, ...revisions];
      undo = [];
      redo = [];
      watch(result.id);
    } catch (error_) {
      failed(error_);
    }
  };
  const keyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
      return;
    }
    const typing =
      event.target instanceof HTMLElement &&
      (['INPUT', 'TEXTAREA', 'SELECT'].includes(event.target.tagName) || event.target.isContentEditable);
    if (typing || !(event.metaKey || event.ctrlKey)) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      void save();
    } else if (key === 'z' && event.shiftKey && redo.length > 0) {
      event.preventDefault();
      undo = [...undo, clone(recipe)];
      recipe = redo.at(-1)!;
      redo = redo.slice(0, -1);
    } else if (key === 'z' && undo.length > 0) {
      event.preventDefault();
      redo = [...redo, clone(recipe)];
      recipe = undo.at(-1)!;
      undo = undo.slice(0, -1);
    }
  };
  const addMask = (kind: NativeMask['kind'], artifact?: string) => {
    if ((recipe.masks?.length ?? 0) >= 8) {
      return;
    }
    const mask = newNativeMask(kind, artifact);
    selectedMask = mask.id;
    sensorCanvas = true;
    // Empty brushes are kept in the UI only until the first stroke is committed.
    if (kind === 'brush') {
      change({ ...recipe, masks: [...(recipe.masks ?? []), { ...mask, enabled: false }] });
    } else {
      change({ ...recipe, masks: [...(recipe.masks ?? []), mask] });
    }
  };
  const suggest = async (target: 'subject' | 'sky') => {
    if ((recipe.masks?.length ?? 0) >= 8) {
      return;
    }
    proposalBusy = true;
    error = '';
    proposalAbort?.abort();
    proposalAbort = new AbortController();
    try {
      const artifact = await proposeNativeMask(asset.id, target, proposalAbort.signal);
      if (!alive) {
        return;
      }
      addMask(target, artifact.id);
    } catch (error_) {
      failed(error_);
    } finally {
      proposalBusy = false;
    }
  };
  const point = (event: PointerEvent): [number, number] => {
    const rect =
      event.currentTarget instanceof Element
        ? event.currentTarget.getBoundingClientRect()
        : { x: 0, y: 0, width: 1, height: 1 };
    return [
      Math.min(1, Math.max(0, (event.clientX - rect.x) / rect.width)),
      Math.min(1, Math.max(0, (event.clientY - rect.y) / rect.height)),
    ];
  };
  const startStroke = (event: PointerEvent) => {
    if (
      !sensorCanvas ||
      previewCanvas !== true ||
      !selected ||
      !['brush', 'subject', 'sky', 'background'].includes(selected.kind) ||
      !preview ||
      event.button !== 0
    ) {
      return;
    }
    const canvas = event.currentTarget as HTMLElement;
    canvas.setPointerCapture(event.pointerId);
    strokeStart = clone(recipe);
    activeStroke = { points: [point(event)], radius: brushRadius, erase: event.altKey };
  };
  const continueStroke = (event: PointerEvent) => {
    if (!activeStroke || !strokeStart || !selected) {
      return;
    }
    if (activeStroke.points.length < 512) {
      activeStroke.points.push(point(event));
    }
  };
  const finishStroke = () => {
    if (!activeStroke || !strokeStart || !selected) {
      return;
    }
    if ((selected.strokes?.length ?? 0) < 64) {
      maskPatch({ enabled: true, strokes: [...(selected.strokes ?? []), activeStroke] });
    }
    activeStroke = undefined;
    strokeStart = undefined;
  };
  const addCurvePoint = () => {
    const curve = recipe.curve ?? [
      { x: 0, y: 0 },
      { x: 0.5, y: 0.5 },
      { x: 1, y: 1 },
    ];
    if (curve.length >= 20) {
      return;
    }
    let gap = 0;
    for (let i = 1; i < curve.length - 1; i++) {
      if (curve[i + 1].x - curve[i].x > curve[gap + 1].x - curve[gap].x) {
        gap = i;
      }
    }
    const left = curve[gap],
      right = curve[gap + 1];
    const next = clone(curve);
    next.splice(gap + 1, 0, { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
    patch({ curve: next });
  };
  const savePreset = async () => {
    if (!presetName.trim()) {
      return;
    }
    try {
      const result = await createDevelopPreset({
        developPresetCreateDto: { name: presetName.trim(), settings: { native: nativePreset(recipe) } as never },
      });
      presets = [...presets, result];
      presetName = '';
    } catch (error_) {
      failed(error_);
    }
  };
  const applyPreset = (preset: DevelopPresetResponseDto) => {
    const native = (preset.settings as unknown as { native?: NativeRecipe }).native;
    if (native) {
      change({
        ...recipe,
        ...clone(native),
        crop: recipe.crop,
        rotation: recipe.rotation,
        straighten: recipe.straighten,
        flipHorizontal: recipe.flipHorizontal,
        flipVertical: recipe.flipVertical,
      });
    }
  };
</script>

<svelte:window onkeydown={keyDown} />

<div class="raw-editor">
  <header>
    <strong>{asset.originalFileName} · RAW development</strong>
    <button
      type="button"
      aria-pressed={before}
      onclick={() => {
        before = !before;
      }}>Before / after</button
    ><label
      >Zoom<select bind:value={zoom}
        ><option value={1}>Fit</option><option value={2}>2×</option><option value={4}>4×</option></select
      ></label
    >
    <button type="button" onclick={onLegacy}>Quick edits / external versions</button>
    <button type="button" onclick={() => onClose()}>Close</button>
    <button
      type="button"
      disabled={undo.length === 0}
      onclick={() => {
        redo = [...redo, clone(recipe)];
        recipe = undo.at(-1)!;
        undo = undo.slice(0, -1);
      }}>Undo</button
    >
    <button
      type="button"
      disabled={redo.length === 0}
      onclick={() => {
        undo = [...undo, clone(recipe)];
        recipe = redo.at(-1)!;
        redo = redo.slice(0, -1);
      }}>Redo</button
    >
    <label>Version name <input maxlength="120" bind:value={label} /></label>
    <button type="button" disabled={!loaded || busy || proposalBusy} onclick={save}>Save version</button>
  </header>
  {#if error}<p role="alert">{error}</p>{/if}
  <main>
    <section class="raw-stage" aria-label="RAW preview">
      {#if preview && previewCanvas === sensorCanvas}
        <div
          class="raw-canvas"
          role="img"
          aria-label={sensorCanvas ? 'Mask drawing canvas' : 'Developed RAW preview'}
          onpointerdown={startStroke}
          onpointermove={continueStroke}
          onpointerup={finishStroke}
          onpointercancel={() => {
            activeStroke = undefined;
            strokeStart = undefined;
          }}
          style:width={`min(100%, calc((100vh - 210px) * ${previewDimensions.width / previewDimensions.height}))`}
          style:transform={`scale(${zoom})`}
          style:touch-action={sensorCanvas ? 'none' : 'auto'}
        >
          <img
            src={preview}
            alt={asset.originalFileName}
            draggable="false"
            onload={(event) => {
              const image = event.currentTarget;
              if (image instanceof HTMLImageElement) {
                previewDimensions = { width: image.naturalWidth, height: image.naturalHeight };
              }
            }}
          />
          {#if sensorCanvas && selected?.kind === 'radial'}<div
              class="mask-shape radial"
              style:left={`${(selected.x - selected.radiusX) * 100}%`}
              style:top={`${(selected.y - selected.radiusY) * 100}%`}
              style:width={`${selected.radiusX * 200}%`}
              style:height={`${selected.radiusY * 200}%`}
            ></div>{/if}
          {#if sensorCanvas && selected && ['brush', 'subject', 'sky', 'background'].includes(selected.kind)}<svg
              class="mask-line"
              viewBox={`0 0 ${previewDimensions.width} ${previewDimensions.height}`}
              preserveAspectRatio="xMidYMid meet"
              aria-hidden="true"
              >{#each [...(selected.strokes ?? []), ...(activeStroke ? [activeStroke] : [])] as stroke (stroke)}
                {@const overlay = nativeStrokeOverlay(stroke, previewDimensions.width, previewDimensions.height)}
                {#if stroke.points.length === 1}
                  <circle
                    cx={overlay.first.x}
                    cy={overlay.first.y}
                    r={overlay.radius}
                    fill={stroke.erase ? '#f87171' : '#fff8'}
                  />
                {:else}
                  <polyline
                    points={overlay.points}
                    fill="none"
                    stroke={stroke.erase ? '#f87171' : '#fff8'}
                    stroke-width={overlay.radius * 2}
                    stroke-linecap="round"
                    stroke-linejoin="round"
                  />
                {/if}
              {/each}</svg
            >{/if}
          {#if sensorCanvas && selected?.kind === 'linear'}<svg
              class="mask-line"
              viewBox="0 0 100 100"
              preserveAspectRatio="none"
              aria-hidden="true"
              ><line
                x1={selected.x * 100}
                y1={selected.y * 100}
                x2={selected.endX * 100}
                y2={selected.endY * 100}
                stroke="white"
                stroke-width="0.5"
              /></svg
            >{/if}
        </div>
      {:else}<p>{loaded ? 'Rendering RAW preview…' : 'Loading RAW development…'}</p>{/if}
      <p aria-live="polite">
        {proposalBusy
          ? 'Finding a mask…'
          : busy
            ? 'Rendering…'
            : sensorCanvas
              ? 'Draw on the full photo before lens correction, rotation and crop. Alt-drag erases brush strokes.'
              : 'Developed preview'}
      </p>
      <label><input type="checkbox" bind:checked={sensorCanvas} /> Draw masks on the full photo</label>
    </section>
    <aside>
      <details open>
        <summary>Light and colour</summary>
        {#each [['exposureEV', 'Exposure EV', -18, 18, 0.1, 0], ['shadows', 'Shadows', -100, 100, 1, 0], ['highlights', 'Highlights', -100, 100, 1, 0], ['saturation', 'Saturation', 0, 2, 0.01, 1], ['contrast', 'Contrast', 0.01, 1.99, 0.01, 1]] as [key, text, min, max, step, fallback] (key)}
          <EditorSlider
            id={`native-${key}`}
            label={String(text)}
            value={Number(recipe[key as keyof NativeRecipe] ?? fallback)}
            min={Number(min)}
            max={Number(max)}
            step={Number(step)}
            defaultValue={Number(fallback)}
            onChange={(value) => patch({ [key]: value })}
          />
        {/each}
        <p>White balance</p>
        {#each ['red', 'green', 'blue'] as channel (channel)}<EditorSlider
            id={`wb-${channel}`}
            label={`${channel} gain`}
            value={recipe.whiteBalance?.[channel as 'red'] ?? 1}
            min={0.1}
            max={3}
            step={0.01}
            defaultValue={1}
            onChange={(value) =>
              patch({ whiteBalance: { red: 1, green: 1, blue: 1, ...recipe.whiteBalance, [channel]: value } })}
          />{/each}
        <p>Tone curve</p>
        <button type="button" disabled={(recipe.curve?.length ?? 3) >= 20} onclick={addCurvePoint}
          >Add curve point</button
        ><button type="button" onclick={() => patch({ curve: undefined })}>Reset curve</button>
        {#each recipe.curve ?? [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 1, y: 1 }] as point, index (index)}<EditorSlider
            id={`curve-${index}`}
            label={`Output at ${Math.round(point.x * 100)}%`}
            value={point.y}
            min={0}
            max={1}
            step={0.01}
            defaultValue={point.x}
            onChange={(value) =>
              patch({
                curve: (
                  recipe.curve ?? [
                    { x: 0, y: 0 },
                    { x: 0.5, y: 0.5 },
                    { x: 1, y: 1 },
                  ]
                ).map((p, i) => (i === index ? { ...p, y: value } : p)),
              })}
          />{/each}
      </details>
      <details>
        <summary>Lens and detail</summary>
        <label
          ><input
            type="checkbox"
            checked={recipe.lensCorrection ?? false}
            onchange={(event) => patch({ lensCorrection: event.currentTarget.checked })}
          /> Automatic lens correction</label
        >
        <EditorSlider
          id="noise"
          label="RAW noise threshold"
          value={recipe.noiseThreshold ?? 0}
          min={0}
          max={0.1}
          step={0.001}
          onChange={(value) => patch({ noiseThreshold: value })}
        />
        {#each [['radius', 0, 12, 2], ['amount', 0, 2, 0], ['threshold', 0, 10, 0.5]] as [key, min, max, fallback] (key)}<EditorSlider
            id={`sharp-${key}`}
            label={`Sharpen ${key}`}
            value={recipe.sharpen?.[key as 'radius'] ?? Number(fallback)}
            min={Number(min)}
            max={Number(max)}
            step={0.1}
            defaultValue={Number(fallback)}
            onChange={(value) =>
              patch({ sharpen: { radius: 2, amount: 0, threshold: 0.5, ...recipe.sharpen, [key]: value } })}
          />{/each}
      </details>
      <details>
        <summary>Crop and straighten</summary>
        <EditorSlider
          id="straighten-native"
          label="Straighten degrees"
          value={recipe.straighten ?? 0}
          min={-45}
          max={45}
          step={0.1}
          onChange={(value) => patch({ straighten: value })}
        />
        <button
          type="button"
          onclick={() => patch({ rotation: (((recipe.rotation ?? 0) + 90) % 360) as NativeRecipe['rotation'] })}
          >Rotate 90°</button
        >
        {#each ['flipHorizontal', 'flipVertical'] as flip (flip)}<label
            ><input
              type="checkbox"
              checked={recipe[flip as 'flipHorizontal'] ?? false}
              onchange={(event) => patch({ [flip]: event.currentTarget.checked })}
            />{flip === 'flipHorizontal' ? 'Flip horizontally' : 'Flip vertically'}</label
          >{/each}
        {#each ['x', 'y', 'w', 'h'] as key (key)}<label
            >Crop {key}<input
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={recipe.crop?.[key as 'x'] ?? (key === 'w' || key === 'h' ? 1 : 0)}
              onchange={(event) =>
                patch({ crop: { x: 0, y: 0, w: 1, h: 1, ...recipe.crop, [key]: Number(event.currentTarget.value) } })}
            /></label
          >{/each}
      </details>
      <details>
        <summary>Masks</summary>
        {#each ['radial', 'linear', 'brush'] as kind (kind)}<button
            type="button"
            disabled={(recipe.masks?.length ?? 0) >= 8}
            onclick={() => addMask(kind as NativeMask['kind'])}>{kind === 'linear' ? 'Gradient' : kind}</button
          >{/each}
        <button type="button" disabled={busy || proposalBusy} onclick={() => suggest('subject')}>Suggest subject</button
        ><button type="button" disabled={busy || proposalBusy} onclick={() => suggest('sky')}>Suggest sky</button>
        {#each recipe.masks ?? [] as mask (mask.id)}<button
            type="button"
            aria-pressed={selectedMask === mask.id}
            onclick={() => {
              selectedMask = mask.id;
              sensorCanvas = true;
            }}>{mask.name ?? mask.kind}</button
          >{/each}
        {#if selected}
          {#if ['brush', 'subject', 'sky', 'background'].includes(selected.kind)}<EditorSlider
              id="native-brush-radius"
              label="Brush radius"
              value={brushRadius}
              min={0.002}
              max={0.25}
              step={0.002}
              defaultValue={0.025}
              onChange={(value) => {
                brushRadius = value;
              }}
            />{/if}
          <label
            >Mask name<input
              maxlength="60"
              value={selected.name ?? ''}
              onchange={(event) => maskPatch({ name: event.currentTarget.value.trim() || null })}
            /></label
          >
          <label
            ><input
              type="checkbox"
              checked={selected.invert}
              onchange={(event) => maskPatch({ invert: event.currentTarget.checked })}
            /> Invert</label
          >
          <label
            ><input
              type="checkbox"
              checked={selected.enabled}
              onchange={(event) => maskPatch({ enabled: event.currentTarget.checked })}
            /> Enabled</label
          >
          <EditorSlider
            id="native-mask-amount"
            label="Mask amount"
            value={selected.amount}
            min={0}
            max={100}
            defaultValue={100}
            onChange={(value) => maskPatch({ amount: value })}
          />
          {#each [['exposureEV', 'Exposure EV', -18, 18, 0.1, 0], ['shadows', 'Shadows', -100, 100, 1, 0], ['highlights', 'Highlights', -100, 100, 1, 0], ['saturation', 'Saturation', 0, 2, 0.01, 1], ['contrast', 'Contrast', 0.01, 1.99, 0.01, 1]] as [key, text, min, max, step, fallback] (key)}<EditorSlider
              id={`mask-${key}`}
              label={String(text)}
              value={Number(selected.adjustments[key as keyof typeof selected.adjustments] ?? fallback)}
              min={Number(min)}
              max={Number(max)}
              step={Number(step)}
              defaultValue={Number(fallback)}
              onChange={(value) => maskPatch({ adjustments: { ...selected!.adjustments, [key]: value } })}
            />{/each}
          {#each selected.kind === 'radial' ? ['x', 'y', 'radiusX', 'radiusY'] : selected.kind === 'linear' ? ['x', 'y', 'endX', 'endY'] : [] as key (key)}<EditorSlider
              id={`mask-${key}`}
              label={key}
              value={Number(selected[key as keyof NativeMask])}
              min={key.startsWith('radius') ? 0.01 : 0}
              max={1}
              step={0.01}
              onChange={(value) => maskPatch({ [key]: value })}
            />{/each}
          <EditorSlider
            id="mask-feather"
            label="Feather"
            value={selected.feather}
            min={0}
            max={100}
            defaultValue={50}
            onChange={(value) => maskPatch({ feather: value })}
          />
          <button
            type="button"
            onclick={() => {
              change({ ...recipe, masks: recipe.masks?.filter((mask) => mask.id !== selectedMask) });
              selectedMask = null;
            }}>Delete mask</button
          >
        {/if}
      </details>
      <details>
        <summary>Presets</summary><label>Preset name<input maxlength="80" bind:value={presetName} /></label><button
          type="button"
          onclick={savePreset}>Save preset</button
        >
        {#each presets.filter((item) => !!(item.settings as unknown as { native?: NativeRecipe }).native) as preset (preset.id)}<button
            type="button"
            onclick={() => applyPreset(preset)}>{preset.name}</button
          >{/each}
      </details>
      <details>
        <summary>Versions</summary>
        {#each revisions as version (version.id)}<div class="native-version">
            <span>{version.label ?? `Version ${version.revision}`} · {version.status} {version.progress}%</span>
            {#if version.error}<p>{version.error}</p>{/if}
            {#if isNativeRecipe(version.recipe)}<button
                type="button"
                onclick={() => {
                  change(clone(version.recipe as NativeRecipe));
                  revisionId = version.id;
                }}>Edit settings</button
              >{/if}
            {#if version.status === 'rendered'}<button
                type="button"
                onclick={async () => {
                  try {
                    await revertAssetDevelop({ id: asset.id, assetDevelopRevertDto: { revisionId: version.id } });
                    watch(version.id);
                  } catch (error_) {
                    failed(error_);
                  }
                }}>Make current</button
              ><a href={developFileUrl(asset.id, version.id)} target="_blank" rel="noreferrer">Preview</a>{/if}
            {#if ['failed', 'saved', 'cancelled'].includes(version.status)}<button
                type="button"
                onclick={async () => {
                  try {
                    await renderAssetDevelopRevision({ id: asset.id, revisionId: version.id });
                    watch(version.id);
                  } catch (error_) {
                    failed(error_);
                  }
                }}>Render / retry</button
              >{/if}
            {#if version.status === 'queued' || version.status === 'rendering'}<button
                type="button"
                onclick={async () => {
                  try {
                    await cancelAssetDevelopRender({ id: asset.id, revisionId: version.id });
                    watch();
                  } catch (error_) {
                    failed(error_);
                  }
                }}>Cancel render</button
              >{/if}
          </div>{/each}
      </details>
    </aside>
  </main>
</div>

<style>
  .raw-editor {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    padding: 1rem;
    gap: 0.75rem;
  }
  header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  header strong {
    margin-inline-end: auto;
  }
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 320px;
    min-height: 0;
    flex: 1;
    gap: 1rem;
  }
  aside {
    overflow-y: auto;
    padding: 0 0.5rem;
  }
  details {
    border-bottom: 1px solid #8885;
    padding: 0.75rem 0;
  }
  summary {
    cursor: pointer;
    font-weight: 600;
    margin-bottom: 0.5rem;
  }
  label {
    display: flex;
    gap: 0.4rem;
    margin: 0.4rem 0;
    align-items: center;
  }
  input:not([type='checkbox']) {
    max-width: 10rem;
    border: 1px solid #8888;
    padding: 0.2rem;
    background: transparent;
  }
  button,
  a {
    border: 1px solid #8888;
    padding: 0.4rem 0.65rem;
    border-radius: 4px;
    margin: 0.2rem;
  }
  button:disabled {
    opacity: 0.45;
  }
  .raw-stage {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-width: 0;
    overflow: auto;
  }
  .raw-canvas {
    position: relative;
    max-width: 100%;
    user-select: none;
  }
  .raw-canvas img {
    display: block;
    width: 100%;
    max-width: 100%;
    max-height: calc(100vh - 210px);
    object-fit: contain;
  }
  .mask-shape,
  .mask-line {
    position: absolute;
    pointer-events: none;
  }
  .radial {
    border: 1px solid white;
    border-radius: 50%;
    background: #ffffff18;
  }
  .mask-line {
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .native-version {
    padding: 0.5rem 0;
    border-top: 1px solid #8884;
  }
  @media (max-width: 800px) {
    main {
      grid-template-columns: 1fr;
      overflow-y: auto;
    }
    aside {
      overflow: visible;
    }
    .raw-canvas img {
      max-height: 50vh;
    }
  }
</style>
