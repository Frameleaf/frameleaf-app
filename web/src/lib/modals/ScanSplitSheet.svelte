<script lang="ts">
  /**
   * FL-923: review a flatbed scan before it is split. The scan with a numbered outline per print, draggable corner
   * handles (pointer, touch or arrow keys), rotate and remove per print, and a new outline to drag into place.
   * Nothing is split until the owner confirms. Closes with the number of photos queued, or nothing.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    ARROW_STEPS,
    SCAN_MAX_PRINTS,
    isTooSmall,
    moveCorner,
    moveQuad,
    newQuad,
    nudgeStep,
    sameAsExisting,
    thumbStyle,
    toCrops,
    turn,
    type ScanPoint,
    type ScanPrint,
    type ScanSize,
  } from '$lib/frameleaf/scan-split';
  import { getAssetMediaUrl } from '$lib/utils';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    detectScanPrints,
    splitScan,
    type AssetResponseDto,
    type ScanSplitInfoResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertOutline, mdiArchiveOutline, mdiClose, mdiPlus, mdiRotateRight } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  const CORNER_KEYS: Translations[] = [
    'frameleaf_scan_split_corner_top_left',
    'frameleaf_scan_split_corner_top_right',
    'frameleaf_scan_split_corner_bottom_right',
    'frameleaf_scan_split_corner_bottom_left',
  ];

  type Props = {
    asset: Pick<AssetResponseDto, 'id' | 'originalFileName' | 'thumbhash'>;
    info: ScanSplitInfoResponseDto;
    onClose: (count?: number) => void;
  };

  const { asset, info, onClose }: Props = $props();

  let open = $state(true);
  let closeWith = $state<number>();
  let loading = $state(true);
  let submitting = $state(false);
  let unavailable = $state(false);
  let errorText = $state<string>();
  let size = $state<ScanSize | undefined>(
    info.width && info.height ? { width: info.width, height: info.height } : undefined,
  );
  let prints = $state<ScanPrint[]>([]);
  let selected = $state<string>();
  let stage = $state<HTMLDivElement>();
  let nextId = 1;
  let drag: { id: string; corner?: number; last?: ScanPoint } | undefined;

  const resplit = $derived(info.cropCount > 0);
  const count = $derived(prints.length);
  const imageUrl = $derived(
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, edited: false, cacheKey: asset.thumbhash }),
  );
  const tooSmall = $derived(prints.some(({ quad }) => isTooSmall(quad)));
  const unchanged = $derived(resplit && sameAsExisting(prints, info.crops, info.cropCount));
  const canConfirm = $derived(count > 0 && count <= SCAN_MAX_PRINTS && !tooSmall && !unchanged && !submitting);

  const close = (result?: number) => {
    closeWith = result;
    open = false;
  };

  onMount(async () => {
    // A scan split before opens on the outlines it was cut with, so a small fix does not depend on the ML worker.
    if (info.crops.length > 0 && size) {
      prints = info.crops.map(({ assetId, quad, rotation }) => ({ id: assetId, quad, rotation }));
      selected = prints[0]?.id;
      loading = false;
      return;
    }
    try {
      const found = await detectScanPrints({ id: asset.id });
      size = { width: found.width, height: found.height };
      prints = found.prints.map(({ quad, rotation }) => ({ id: `found-${nextId++}`, quad, rotation }));
      selected = prints[0]?.id;
    } catch (error) {
      if ((error as { status?: number })?.status === 503) {
        unavailable = true;
      } else {
        errorText = $t('frameleaf_scan_split_detect_failed');
      }
    } finally {
      loading = false;
    }
  });

  const update = (id: string, change: (print: ScanPrint) => ScanPrint) => {
    prints = prints.map((print) => (print.id === id ? change(print) : print));
  };

  const toScan = (event: PointerEvent): ScanPoint | undefined => {
    if (!stage || !size) {
      return;
    }
    const box = stage.getBoundingClientRect();
    return {
      x: ((event.clientX - box.left) / box.width) * size.width,
      y: ((event.clientY - box.top) / box.height) * size.height,
    };
  };

  const startCorner = (event: PointerEvent, id: string, corner: number) => {
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    drag = { id, corner };
  };

  const startMove = (event: PointerEvent, id: string) => {
    selected = id;
    event.preventDefault();
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    drag = { id, last: toScan(event) };
  };

  const onDrag = (event: PointerEvent) => {
    const point = toScan(event);
    if (!drag || !point || !size) {
      return;
    }
    const { id, corner, last } = drag;
    const scan = size;
    if (corner !== undefined) {
      update(id, (print) => ({ ...print, quad: moveCorner(print.quad, corner, point, scan) }));
    } else if (last) {
      update(id, (print) => ({ ...print, quad: moveQuad(print.quad, point.x - last.x, point.y - last.y, scan) }));
      drag = { id, last: point };
    }
  };

  const endDrag = () => {
    drag = undefined;
  };

  const onCornerKey = (event: KeyboardEvent, id: string, corner: number) => {
    const step = ARROW_STEPS[event.key];
    if (!step || !size) {
      return;
    }
    event.preventDefault();
    // the sheet's dialog must not hand arrows to the viewer behind it
    event.stopPropagation();
    const scan = size;
    const by = nudgeStep(scan);
    update(id, (print) => {
      const { x, y } = print.quad[corner];
      return { ...print, quad: moveCorner(print.quad, corner, { x: x + step[0] * by, y: y + step[1] * by }, scan) };
    });
  };

  const add = () => {
    if (!size || count >= SCAN_MAX_PRINTS) {
      return;
    }
    const id = `added-${nextId++}`;
    prints = [...prints, { id, quad: newQuad(size), rotation: 0, added: true }];
    selected = id;
  };

  const remove = (id: string) => {
    prints = prints.filter((print) => print.id !== id);
    if (selected === id) {
      selected = prints[0]?.id;
    }
  };

  const confirm = async () => {
    if (!canConfirm) {
      return;
    }
    submitting = true;
    errorText = undefined;
    try {
      await splitScan({ id: asset.id, scanSplitDto: { crops: toCrops(prints) } });
      close(count);
    } catch (error) {
      const message = getServerErrorMessage(error) ?? '';
      errorText = message.includes('Quota') ? $t('frameleaf_scan_split_quota') : $t('frameleaf_scan_split_failed');
    } finally {
      submitting = false;
    }
  };

  const subtitle = (print: ScanPrint) => {
    if (print.added) {
      return $t('frameleaf_scan_split_added_by_you');
    }
    return print.rotation
      ? $t('frameleaf_scan_split_turned', { values: { degrees: print.rotation } })
      : $t('frameleaf_scan_split_found_in_scan');
  };
</script>

<Dialog
  title={resplit ? $t('frameleaf_scan_split_title_again') : $t('frameleaf_scan_split_title')}
  closeLabel={$t('close')}
  size="wide"
  bind:open
  onClosed={() => onClose(closeWith)}
>
  <div class="split">
    {#if resplit}
      <p class="notice" role="note">
        <Icon icon={mdiAlertOutline} size="18" aria-hidden="true" />
        <span>
          <strong>{$t('frameleaf_scan_split_again_title', { values: { count: info.cropCount } })}</strong>
          {#if info.editedCount > 0}
            {$t('frameleaf_scan_split_again_edited', { values: { edited: info.editedCount, count: info.cropCount } })}
          {/if}
          {$t('frameleaf_scan_split_again_trash')}
        </span>
      </p>
    {/if}
    {#if unavailable}
      <p class="notice" role="alert">
        <Icon icon={mdiAlertOutline} size="18" aria-hidden="true" />
        <span>{$t('frameleaf_scan_split_unavailable')}</span>
      </p>
    {/if}
    {#if errorText}
      <p class="notice danger" role="alert">
        <Icon icon={mdiAlertOutline} size="18" aria-hidden="true" />
        <span>{errorText}</span>
      </p>
    {/if}

    <div class="main">
      <div
        class="stage"
        bind:this={stage}
        style={size
          ? `aspect-ratio: ${size.width} / ${size.height}; max-width: calc(70vh * ${size.width / size.height})`
          : 'aspect-ratio: 3 / 2'}
      >
        <img
          src={imageUrl}
          alt={$t('frameleaf_scan_split_whole_scan', { values: { name: asset.originalFileName } })}
          draggable="false"
        />
        {#if size}
          <svg viewBox={`0 0 ${size.width} ${size.height}`} preserveAspectRatio="none" aria-hidden="true">
            {#each prints as print (print.id)}
              <!-- Pointer-only shortcut: the numbered and corner buttons do the same from the keyboard. -->
              <polygon
                role="presentation"
                class:selected={print.id === selected}
                points={print.quad.map(({ x, y }) => `${x},${y}`).join(' ')}
                onpointerdown={(event) => startMove(event, print.id)}
                onpointermove={onDrag}
                onpointerup={endDrag}
                onpointercancel={endDrag}
              />
            {/each}
          </svg>
          {#each prints as print, index (print.id)}
            <button
              type="button"
              class="number"
              class:selected={print.id === selected}
              style={`left: ${(print.quad[0].x / size.width) * 100}%; top: ${(print.quad[0].y / size.height) * 100}%`}
              aria-label={$t('frameleaf_scan_split_select', { values: { number: index + 1 } })}
              aria-pressed={print.id === selected}
              onclick={() => (selected = print.id)}
            >
              {index + 1}
            </button>
            {#if print.id === selected}
              {#each print.quad as point, corner (corner)}
                <button
                  type="button"
                  class="handle"
                  style={`left: ${(point.x / size.width) * 100}%; top: ${(point.y / size.height) * 100}%`}
                  aria-label={$t('frameleaf_scan_split_corner', {
                    values: { number: index + 1, corner: $t(CORNER_KEYS[corner]) },
                  })}
                  onpointerdown={(event) => startCorner(event, print.id, corner)}
                  onpointermove={onDrag}
                  onpointerup={endDrag}
                  onpointercancel={endDrag}
                  onkeydown={(event) => onCornerKey(event, print.id, corner)}
                ></button>
              {/each}
            {/if}
          {/each}
        {/if}
      </div>

      <aside class="side" aria-label={$t('frameleaf_scan_split_list_label')}>
        <header>
          {#if loading}
            <strong aria-live="polite">{$t('frameleaf_scan_split_looking')}</strong>
          {:else if count > 0}
            <strong aria-live="polite">{$t('frameleaf_scan_split_found', { values: { count } })}</strong>
            <span>{tooSmall ? $t('frameleaf_scan_split_too_small') : $t('frameleaf_scan_split_hint')}</span>
          {:else}
            <strong aria-live="polite">{$t('frameleaf_scan_split_none_title')}</strong>
            <span>{$t('frameleaf_scan_split_none_body')}</span>
          {/if}
        </header>
        {#if count > 0}
          <ul>
            {#each prints as print, index (print.id)}
              <li class:selected={print.id === selected}>
                <button
                  type="button"
                  class="pick"
                  aria-pressed={print.id === selected}
                  onclick={() => (selected = print.id)}
                >
                  <span class="thumb">
                    {#if size}
                      <span style={`${thumbStyle(imageUrl, print.quad, size)}; transform: rotate(${print.rotation}deg)`}
                      ></span>
                    {/if}
                  </span>
                  <span class="copy">
                    <strong>{$t('frameleaf_scan_split_photo', { values: { number: index + 1 } })}</strong>
                    <small>{subtitle(print)}</small>
                  </span>
                </button>
                <button
                  type="button"
                  class="icon"
                  aria-label={$t('frameleaf_scan_split_rotate', { values: { number: index + 1 } })}
                  title={$t('frameleaf_scan_split_rotate_title')}
                  onclick={() => update(print.id, (item) => ({ ...item, rotation: turn(item.rotation) }))}
                >
                  <Icon icon={mdiRotateRight} size="18" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  class="icon"
                  aria-label={$t('frameleaf_scan_split_remove', { values: { number: index + 1 } })}
                  title={$t('frameleaf_scan_split_remove_title')}
                  onclick={() => remove(print.id)}
                >
                  <Icon icon={mdiClose} size="18" aria-hidden="true" />
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if !loading && size}
          <button type="button" class="add" disabled={count >= SCAN_MAX_PRINTS} onclick={add}>
            <Icon icon={mdiPlus} size="18" aria-hidden="true" />
            {count > 0 ? $t('frameleaf_scan_split_add') : $t('frameleaf_scan_split_draw')}
          </button>
        {/if}
      </aside>
    </div>
  </div>

  {#snippet actions()}
    {#if !loading && count === 0}
      <Button variant="primary" onclick={() => close()}>{$t('frameleaf_scan_split_keep')}</Button>
    {:else}
      <span class="note">
        <Icon icon={mdiArchiveOutline} size="16" aria-hidden="true" />
        {$t('frameleaf_scan_split_source_note', { values: { name: asset.originalFileName } })}
      </span>
      <Button onclick={() => close()}>{$t('cancel')}</Button>
      <Button variant="primary" disabled={!canConfirm} onclick={() => void confirm()}>
        {resplit
          ? $t('frameleaf_scan_split_confirm_again', { values: { count } })
          : $t('frameleaf_scan_split_confirm', { values: { count } })}
      </Button>
    {/if}
  {/snippet}
</Dialog>

<style>
  .split {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .notice {
    display: flex;
    gap: 0.625rem;
    margin: 0;
    padding: 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    font-size: 0.8125rem;
  }
  .notice strong {
    display: block;
  }
  .notice.danger {
    border-color: var(--fl-danger);
  }
  .main {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19.5rem;
    gap: 1.5rem;
    align-items: start;
  }
  .stage {
    position: relative;
    width: 100%;
    margin-inline: auto;
    overflow: visible;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .stage img,
  .stage svg {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    border-radius: var(--fl-radius-card);
  }
  .stage img {
    object-fit: fill;
    user-select: none;
  }
  polygon {
    fill: transparent;
    stroke: var(--fl-text);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
    cursor: move;
    touch-action: none;
  }
  polygon.selected {
    fill: color-mix(in srgb, var(--fl-accent) 18%, transparent);
    stroke: var(--fl-accent);
    stroke-width: 3;
  }
  .number {
    position: absolute;
    display: grid;
    place-items: center;
    inline-size: 1.75rem;
    block-size: 1.75rem;
    margin: 0.5rem 0 0 0.5rem;
    color: #fff;
    background: rgb(0 0 0 / 80%);
    border: 0;
    border-radius: 50%;
    font-size: 0.75rem;
    font-weight: 600;
  }
  .number.selected {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
  }
  .handle {
    position: absolute;
    inline-size: 2.75rem;
    block-size: 2.75rem;
    padding: 0;
    background: transparent;
    border: 0;
    transform: translate(-50%, -50%);
    cursor: grab;
    touch-action: none;
  }
  .handle::after {
    content: '';
    position: absolute;
    inset: calc(50% - 0.5rem);
    background: #fff;
    border: 3px solid var(--fl-accent);
    border-radius: 50%;
  }
  .handle:focus-visible {
    outline: none;
  }
  .handle:focus-visible::after {
    box-shadow: 0 0 0 3px var(--fl-focus, var(--fl-accent));
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    min-width: 0;
  }
  .side header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .side header span {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  .side ul {
    display: grid;
    gap: 0.5rem;
    max-height: 26rem;
    margin: 0;
    padding: 0;
    overflow-y: auto;
    list-style: none;
  }
  .side li {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.5rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .side li.selected {
    border-color: var(--fl-accent);
  }
  .pick {
    display: flex;
    flex: 1;
    align-items: center;
    gap: 0.75rem;
    min-width: 0;
    padding: 0;
    color: inherit;
    text-align: start;
    background: transparent;
    border: 0;
  }
  .thumb {
    display: grid;
    flex-shrink: 0;
    place-items: center;
    inline-size: 3.5rem;
    block-size: 3.5rem;
    overflow: hidden;
    background: #000;
    border-radius: var(--fl-radius-control);
  }
  .thumb span {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    background-repeat: no-repeat;
  }
  .copy {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .copy strong {
    font-size: 0.875rem;
  }
  .copy small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .icon {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    inline-size: 2.25rem;
    block-size: 2.25rem;
    color: var(--fl-text);
    background: transparent;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .add {
    display: inline-flex;
    align-items: center;
    align-self: flex-start;
    gap: 0.5rem;
    min-height: var(--fl-control-height);
    padding: 0 0.875rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: 0.875rem;
  }
  .note {
    display: inline-flex;
    flex: 1;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  @media (max-width: 760px) {
    .main {
      grid-template-columns: minmax(0, 1fr);
      gap: 1rem;
    }
    .side ul {
      max-height: none;
    }
    .note {
      flex-basis: 100%;
    }
  }
</style>
