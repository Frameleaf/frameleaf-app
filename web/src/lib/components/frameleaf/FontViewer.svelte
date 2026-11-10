<script lang="ts">
  /**
   * The font viewer (FL-1359, approved prototype `FontViewer`): opening a font item in Boards. The
   * font file is loaded from this server so you can type your own words in it, set a variable
   * font's weight and width, and switch its features on. A font a browser cannot read (a collection,
   * Type 1), or one whose file may not be sent (a shared link with downloads off), shows the
   * specimen picture made on the server instead. Details sit in the same panel other Boards items use.
   */
  import LibraryWorkInspector from '$lib/components/frameleaf/LibraryWorkInspector.svelte';
  import { portal } from '$lib/elements/Portal.svelte';
  import {
    featureCss,
    fontFileTitle,
    fontKind,
    loadBoardsFont,
    offeredFeatures,
    sampleGlyphs,
    sampleText,
    variationCss,
  } from '$lib/frameleaf/boards-fonts';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { getAssetMediaUrl } from '$lib/utils';
  import { downloadAssetFile } from '$lib/utils/asset-utils';
  import { AssetMediaSize, getAssetFont, type AssetFontResponseDto, type ColorFilter } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowLeft, mdiDownload, mdiImageOutline, mdiRestore } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: TimelineAsset;
    onClose: () => void;
    onTrash?: (asset: TimelineAsset) => void;
    onChooseColor?: (color: ColorFilter) => void;
  };

  let { asset, onClose, onTrash, onChooseColor }: Props = $props();
  const headingId = $props.id();

  const SIZE = { min: 12, max: 160, start: 56 };
  const LEADING = { min: 0.9, max: 2, step: 0.05, start: 1.25 };

  let font = $state<AssetFontResponseDto | null>(null);
  /** The CSS family once the file is loaded; `false` when it could not be. */
  let family = $state<string | false | null>(null);
  let text = $state('');
  let size = $state(SIZE.start);
  let leading = $state(LEADING.start);
  let axes = $state<Record<string, number>>({});
  let features = $state<Record<string, boolean>>({});
  let closeButton = $state<HTMLButtonElement>();

  const name = $derived(font?.family || fontFileTitle(asset.originalFileName));
  const reset = () => {
    // A phone starts smaller so a line of the sample still fits across the screen.
    const narrow = typeof matchMedia === 'function' && !!matchMedia('(max-width: 760px)')?.matches;
    text = sampleText(font?.scripts ?? [], $t('frameleaf_boards_font_sample'));
    size = narrow ? 34 : SIZE.start;
    leading = LEADING.start;
    axes = Object.fromEntries((font?.axes ?? []).map((axis) => [axis.tag, axis.default]));
    features = Object.fromEntries(offeredFeatures(font?.features ?? []).map((tag) => [tag, tag === 'liga']));
  };

  $effect(() => {
    const id = asset.id;
    let current = true;
    font = null;
    family = null;
    const load = async () => {
      try {
        const facts = await getAssetFont({ ...authManager.params, id });
        if (!current) {
          return;
        }
        font = facts;
        reset();
        const loaded = facts.browserLoadable ? await loadBoardsFont(id) : false;
        if (current) {
          family = loaded;
        }
      } catch {
        if (current) {
          family = false;
        }
      }
    };
    void load();
    return () => {
      current = false;
    };
  });

  const kind = $derived(font ? fontKind(font) : 'font');
  /** Why there is a picture instead of the live tester. */
  const pictureReason = $derived(
    font && !font.browserLoadable ? (font.faces.length > 1 ? 'collection' : 'old') : 'unavailable',
  );
  const instance = $derived(
    font?.instances.find((candidate) =>
      font!.axes.every((axis) => (candidate.coordinates[axis.tag] ?? axis.default) === axes[axis.tag]),
    ) ?? null,
  );
  const glyphs = $derived(sampleGlyphs(font?.scripts ?? []));
  const fontCss = $derived(
    family
      ? `font-family: "${family}"; font-variation-settings: ${variationCss(axes)}; font-feature-settings: ${featureCss(features)}; font-variant-caps: ${features.smcp ? 'small-caps' : 'normal'};`
      : '',
  );
  const step = (axis: { min: number; max: number }) => (axis.max - axis.min > 20 ? 1 : 0.01);

  const onKey = (event: KeyboardEvent) => {
    // Modal: the workspace behind never acts on a key. Escape leaves a field first, then closes.
    event.stopPropagation();
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea, select')) {
      target.blur();
    } else {
      onClose();
    }
  };

  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    addEventListener('keydown', onKey, { capture: true });
    closeButton?.focus();
    return () => {
      removeEventListener('keydown', onKey, { capture: true });
      opener?.focus?.();
    };
  });
</script>

{#snippet slider(
  label: string,
  value: number,
  shown: string,
  range: { min: number; max: number; step?: number },
  set: (value: number) => void,
)}
  <label class="slider">
    <span class="slider-head"><span>{label}</span><output>{shown}</output></span>
    <input
      type="range"
      min={range.min}
      max={range.max}
      step={range.step ?? 1}
      {value}
      oninput={(event) => set(Number(event.currentTarget.value))}
    />
  </label>
{/snippet}

<div
  class="viewer"
  role="dialog"
  aria-modal="true"
  aria-label={$t('frameleaf_boards_font_viewer', { values: { name } })}
  use:portal
  data-testid="boards-font-viewer"
>
  <header class="bar">
    <button
      bind:this={closeButton}
      type="button"
      class="fl-control icon"
      aria-label={$t('frameleaf_boards_font_close')}
      onclick={onClose}
    >
      <Icon icon={mdiArrowLeft} size="20" aria-hidden />
    </button>
    <strong class="name">{name}</strong>
    <span class="badge">{$t('frameleaf_boards_font_kind', { values: { kind } })}</span>
    <span class="spacer"></span>
    <button
      type="button"
      class="fl-control"
      onclick={() => void downloadAssetFile({ id: asset.id, filename: asset.originalFileName ?? name, edited: false })}
    >
      <Icon icon={mdiDownload} size="18" aria-hidden />
      <span class="wide">{$t('frameleaf_boards_font_download')}</span>
    </button>
  </header>

  <div class="stage">
    <div class="column">
      {#if family === null}
        <p class="muted" role="status">{$t('loading')}</p>
      {:else if family && font}
        <section class="card" aria-labelledby="{headingId}-try">
          <div class="card-row">
            <h3 id="{headingId}-try">{$t('frameleaf_boards_font_try')}</h3>
            <button type="button" class="link" onclick={reset}>
              <Icon icon={mdiRestore} size="16" aria-hidden />{$t('reset')}
            </button>
          </div>
          <div class="controls">
            {@render slider($t('size'), size, `${size} px`, SIZE, (value) => (size = value))}
            {@render slider(
              $t('frameleaf_boards_font_leading'),
              leading,
              leading.toFixed(2),
              LEADING,
              (value) => (leading = value),
            )}
          </div>
          <div class="sample-box">
            <textarea
              class="sample"
              aria-label={$t('frameleaf_boards_font_sample_label', { values: { name } })}
              spellcheck="false"
              rows="3"
              bind:value={text}
              style="{fontCss} font-size: {size}px; line-height: {leading};"></textarea>
          </div>
          <p class="muted">{$t('frameleaf_boards_font_sample_hint')}</p>
        </section>

        {#if font.axes.length > 0}
          <section class="card" aria-labelledby="{headingId}-axes">
            <div class="card-head">
              <h3 id="{headingId}-axes">{$t('frameleaf_boards_font_axes')}</h3>
              <p class="muted">{$t('frameleaf_boards_font_axes_help')}</p>
            </div>
            {#if font.instances.length > 0}
              <div class="chips" role="group" aria-label={$t('frameleaf_boards_font_instances')}>
                {#each font.instances as option (option.name)}
                  <button
                    type="button"
                    class="chip"
                    aria-pressed={instance === option}
                    onclick={() =>
                      (axes = Object.fromEntries(
                        font!.axes.map((axis) => [axis.tag, option.coordinates[axis.tag] ?? axis.default]),
                      ))}>{option.name}</button
                  >
                {/each}
                {#if !instance}<span class="custom">{$t('frameleaf_boards_font_custom')}</span>{/if}
              </div>
            {/if}
            <div class="controls">
              {#each font.axes as axis (axis.tag)}
                {@render slider(
                  axis.tag === 'wght'
                    ? $t('frameleaf_boards_font_weight')
                    : axis.tag === 'wdth'
                      ? $t('frameleaf_boards_font_width')
                      : axis.name,
                  axes[axis.tag] ?? axis.default,
                  String(Math.round((axes[axis.tag] ?? axis.default) * 100) / 100),
                  { min: axis.min, max: axis.max, step: step(axis) },
                  (value) => (axes = { ...axes, [axis.tag]: value }),
                )}
              {/each}
            </div>
          </section>
        {/if}

        {#if Object.keys(features).length > 0}
          <section class="card" aria-labelledby="{headingId}-features">
            <div class="card-head">
              <h3 id="{headingId}-features">{$t('frameleaf_boards_font_features')}</h3>
              <p class="muted">{$t('frameleaf_boards_font_features_help')}</p>
            </div>
            <div class="features">
              {#each Object.keys(features) as tag (tag)}
                <label class="feature">
                  <span>
                    <strong
                      >{tag.startsWith('ss')
                        ? $t('frameleaf_boards_font_feature_set', { values: { number: Number(tag.slice(2)) } })
                        : $t('frameleaf_boards_font_feature', { values: { tag } })}</strong
                    >
                    <small>{tag}</small>
                  </span>
                  <input type="checkbox" role="switch" bind:checked={features[tag]} />
                </label>
              {/each}
            </div>
          </section>
        {/if}

        {#if glyphs.length > 0}
          <section class="card" aria-labelledby="{headingId}-glyphs">
            <div class="card-head">
              <h3 id="{headingId}-glyphs">{$t('frameleaf_boards_font_glyphs')}</h3>
              <p class="muted">
                {$t('frameleaf_boards_font_glyphs_help', { values: { shown: glyphs.length, count: font.glyphCount } })}
              </p>
            </div>
            <ul class="glyphs" style={fontCss} aria-label={$t('frameleaf_boards_font_glyphs_in', { values: { name } })}>
              {#each glyphs as glyph, index (index)}<li>{glyph}</li>{/each}
            </ul>
          </section>
        {/if}
      {:else}
        <section class="card" aria-labelledby="{headingId}-picture">
          <h3 id="{headingId}-picture">{$t('frameleaf_boards_font_picture_only')}</h3>
          <p class="note">
            <Icon icon={mdiImageOutline} size="18" aria-hidden />
            <span
              >{$t('frameleaf_boards_font_picture_reason', {
                values: { reason: pictureReason, count: font?.faces.length ?? 0 },
              })}</span
            >
          </p>
          <img
            class="specimen"
            src={getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash })}
            alt={$t('frameleaf_boards_font_specimen_of', { values: { name } })}
          />
        </section>
      {/if}
    </div>
  </div>

  <aside class="side">
    <LibraryWorkInspector {asset} boards {font} onOpen={() => {}} {onClose} {onTrash} {onChooseColor} />
  </aside>
</div>

<style>
  .viewer {
    position: fixed;
    inset: var(--fl-topbar-height, 56px) 0 0 0;
    z-index: 45;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 360px;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--fl-canvas);
    color: var(--fl-text);
    font-size: 13px;
  }
  .bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 24px 12px 12px;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .bar > button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    white-space: nowrap;
  }
  .bar > button.icon {
    padding: 0 10px;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
  }
  .badge {
    flex: none;
    padding: 2px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    white-space: nowrap;
  }
  .spacer {
    flex: 1;
  }
  .stage {
    min-height: 0;
    overflow: auto;
    padding: 32px;
  }
  .column {
    display: flex;
    flex-direction: column;
    gap: 24px;
    max-width: 880px;
    margin: 0 auto;
  }
  .card {
    display: flex;
    flex-direction: column;
    gap: 16px;
    padding: 24px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .card-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }
  .card-head {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  h3 {
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 0 8px;
    border: 0;
    background: none;
    color: var(--fl-accent);
    cursor: pointer;
  }
  .controls {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 16px 32px;
  }
  .slider {
    display: flex;
    flex-direction: column;
    gap: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .slider-head {
    display: flex;
    justify-content: space-between;
  }
  .slider output {
    color: var(--fl-text);
    font-variant-numeric: tabular-nums;
  }
  input[type='range'] {
    width: 100%;
    accent-color: var(--fl-accent);
  }
  .sample-box {
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
  }
  .sample {
    display: block;
    width: 100%;
    min-height: 180px;
    padding: 24px;
    border: 0;
    background: none;
    color: var(--fl-text);
    resize: vertical;
  }
  .chips {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .chip {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-text);
    cursor: pointer;
  }
  .chip[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .custom {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .features {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 12px 32px;
  }
  .feature {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 44px;
  }
  .feature span {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .feature small {
    color: var(--fl-muted);
    font-family: ui-monospace, monospace;
    font-size: var(--fl-font-micro);
  }
  .feature input {
    width: 20px;
    height: 20px;
    accent-color: var(--fl-accent);
  }
  .glyphs {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(48px, 1fr));
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
    font-size: 24px;
  }
  .glyphs li {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .note {
    display: flex;
    gap: 12px;
    margin: 0;
    padding: 12px 16px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    line-height: 1.5;
  }
  .note > :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--fl-muted);
  }
  .specimen {
    display: block;
    width: 100%;
    border-radius: var(--fl-radius-control);
  }
  .side {
    min-height: 0;
    overflow: auto;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  button:focus-visible,
  input:focus-visible,
  textarea:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  @media (max-width: 760px) {
    .viewer {
      display: block;
      overflow: auto;
    }
    .stage {
      overflow: visible;
      padding: 16px;
    }
    .card {
      padding: 16px;
    }
    .wide {
      display: none;
    }
    .side {
      overflow: visible;
      border-inline-start: 0;
      border-top: 1px solid var(--fl-border);
    }
  }
</style>
