<script lang="ts">
  /**
   * FL-58: marking a pet in a photo, with or without a region. The drawing stage reuses the face
   * tagger's geometry (`$lib/frameleaf/face-tags`, ported from the prototype's face-tags.mjs) and
   * the Frameleaf Dialog sheet (FaceTagger.jsx's dialog pattern): drag across the animal, or place
   * a region and move it with the arrow keys (Alt resizes, Shift takes larger steps), or type its
   * position in percent. "Whole photo" saves no region at all, the keyboard-only alternative.
   *
   * The write names the checksum of the photo the region was drawn on, so a region drawn on an
   * original that was replaced meanwhile is refused (409) instead of landing on the new photo.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    DEFAULT_FACE_BOX,
    adjustFaceBox,
    boxFromPoints,
    imageContentRect,
    imagePoint,
    keyboardFaceBox,
    toPercent,
    type FaceBox,
    type FaceBoxField,
    type Point,
    type Size,
  } from '$lib/frameleaf/face-tags';
  import { isSourceConflict, regionFromBox, speciesLabelKey } from '$lib/frameleaf/pets';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    createPetObservation,
    type AssetResponseDto,
    type PetObservationResponseDto,
    type PetResponseDto,
  } from '@immich/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  interface Props {
    asset: AssetResponseDto;
    pets: PetResponseDto[];
    /** The pet to preselect, when the caller knows it. */
    petId?: string;
    onClose: () => void;
    onSaved: (observation: PetObservationResponseDto, pet: PetResponseDto) => void;
  }

  let { asset, pets, petId = '', onClose, onSaved }: Props = $props();

  const FIELDS: FaceBoxField[] = ['x', 'y', 'width', 'height'];
  const fieldLabel: Record<
    FaceBoxField,
    'frameleaf_pet_tagger_x' | 'frameleaf_pet_tagger_y' | 'frameleaf_pet_tagger_width' | 'frameleaf_pet_tagger_height'
  > = {
    x: 'frameleaf_pet_tagger_x',
    y: 'frameleaf_pet_tagger_y',
    width: 'frameleaf_pet_tagger_width',
    height: 'frameleaf_pet_tagger_height',
  };
  const helpId = $props.id();

  let open = $state(true);
  let selectedPetId = $state(petId);
  let wholePhoto = $state(false);
  let box = $state<FaceBox | null>(null);
  let drag = $state<{ origin: Point; pointerId: number } | null>(null);
  let preview = $state<FaceBox | null>(null);
  let natural = $state<Size | null>(null);
  let viewport = $state<Size>({ width: 0, height: 0 });
  let stage = $state<HTMLDivElement>();
  let saving = $state(false);
  let error = $state('');
  let imageFailed = $state(false);

  const source = $derived(getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash }));
  const content = $derived(imageContentRect(viewport, natural));
  const shown = $derived(preview ?? box);
  const canSave = $derived(!!selectedPetId && !saving && (wholePhoto || (!!box && !!natural)));

  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  const measure = () => {
    const rect = stage?.getBoundingClientRect();
    if (rect && (rect.width !== viewport.width || rect.height !== viewport.height)) {
      viewport = { width: rect.width, height: rect.height };
    }
  };

  onMount(() => {
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (stage) {
      observer?.observe(stage);
    }
    return () => observer?.disconnect();
  });

  const point = (event: PointerEvent, clampToImage = false) =>
    stage ? imagePoint(event.clientX, event.clientY, stage.getBoundingClientRect(), content, { clampToImage }) : null;

  const start = (event: PointerEvent) => {
    if (event.button > 0 || !content || wholePhoto || saving) {
      return;
    }
    const origin = point(event);
    if (!origin) {
      return;
    }
    event.preventDefault();
    stage?.setPointerCapture?.(event.pointerId);
    drag = { origin, pointerId: event.pointerId };
    preview = null;
  };

  const move = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    preview = boxFromPoints(drag.origin, point(event, true));
  };

  const finish = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) {
      return;
    }
    const drawn = boxFromPoints(drag.origin, point(event, true));
    drag = null;
    preview = null;
    if (drawn) {
      box = drawn;
      error = '';
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (!box || wholePhoto) {
      return;
    }
    const next = keyboardFaceBox(box, event.key, { shiftKey: event.shiftKey, altKey: event.altKey });
    if (next) {
      event.preventDefault();
      box = next;
    }
  };

  const setField = (field: FaceBoxField, percent: string) => {
    const value = Number(percent) / 100;
    if (box && Number.isFinite(value)) {
      box = adjustFaceBox(box, field, value);
    }
  };

  const onImageLoad = (event: Event) => {
    const element = event.currentTarget as HTMLImageElement;
    if (element.naturalWidth > 0 && element.naturalHeight > 0) {
      natural = { width: element.naturalWidth, height: element.naturalHeight };
      measure();
    }
  };

  const save = async (event: Event) => {
    event.preventDefault();
    const pet = pets.find(({ id }) => id === selectedPetId);
    if (!pet || !canSave) {
      return;
    }
    saving = true;
    error = '';
    try {
      const observation = await createPetObservation({
        id: pet.id,
        petObservationCreateDto: {
          assetId: asset.id,
          expectedChecksum: asset.checksum,
          ...(!wholePhoto && box && natural && regionFromBox(box, natural)),
        },
      });
      onSaved(observation, pet);
      open = false;
    } catch (error_) {
      error = isSourceConflict(error_) ? $t('frameleaf_pets_photo_changed') : $t('frameleaf_viewer_pets_error');
    } finally {
      saving = false;
    }
  };
</script>

<Dialog bind:open title={$t('frameleaf_pet_tagger_title')} closeLabel={$t('close')} wide>
  <form class="pet-tagger" onsubmit={save}>
    <div class="controls">
      <label>
        {$t('frameleaf_pet_tagger_pet')}
        <select bind:value={selectedPetId} data-initial-focus>
          <option value="">{$t('frameleaf_pet_tagger_choose')}</option>
          {#each pets as pet (pet.id)}
            <option value={pet.id}
              >{pet.name || $t('frameleaf_pets_unnamed')} · {$t(speciesLabelKey(pet.species))}</option
            >
          {/each}
        </select>
      </label>
      <label class="check">
        <input type="checkbox" bind:checked={wholePhoto} />
        {$t('frameleaf_pet_tagger_whole_photo')}
      </label>
      <Button disabled={wholePhoto || !natural} onclick={() => (box ??= DEFAULT_FACE_BOX)}>
        {$t('frameleaf_pet_tagger_place')}
      </Button>
    </div>

    <p id={helpId} class="help">{$t('frameleaf_pet_tagger_help')}</p>

    <!-- The stage takes focus so the region's arrow-key moves are reachable (FaceTagger.jsx:450-460). -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      bind:this={stage}
      class="stage"
      class:disabled={wholePhoto}
      role="application"
      tabindex="0"
      aria-label={$t('frameleaf_pet_tagger_stage')}
      aria-describedby={helpId}
      onpointerdown={start}
      onpointermove={move}
      onpointerup={finish}
      onpointercancel={() => {
        drag = null;
        preview = null;
      }}
      onkeydown={onKeydown}
    >
      {#if imageFailed}
        <p class="image-error">{$t('frameleaf_pet_tagger_image_unavailable')}</p>
      {:else}
        <img
          src={source}
          alt={asset.originalFileName}
          draggable="false"
          onload={onImageLoad}
          onerror={() => (imageFailed = true)}
        />
      {/if}
      {#if content && shown && !wholePhoto}
        <div
          class="region fl-squircle"
          data-testid="pet-tagger-region"
          style:left="{content.left + shown.x * content.width}px"
          style:top="{content.top + shown.y * content.height}px"
          style:width="{shown.width * content.width}px"
          style:height="{shown.height * content.height}px"
        ></div>
      {/if}
    </div>

    {#if box && !wholePhoto}
      <fieldset class="fields">
        <legend>{$t('frameleaf_pet_tagger_region')}</legend>
        {#each FIELDS as field (field)}
          <label>
            {$t(fieldLabel[field])}
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              value={toPercent(box[field])}
              onchange={(event) => setField(field, event.currentTarget.value)}
            />
          </label>
        {/each}
      </fieldset>
    {/if}

    {#if error}
      <p class="error" role="alert">{error}</p>
    {/if}

    <div class="actions">
      <Button variant="quiet" onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" type="submit" disabled={!canSave}>{$t('frameleaf_pet_tagger_save')}</Button>
    </div>
  </form>
</Dialog>

<style>
  .pet-tagger {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: flex-end;
  }
  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  label.check {
    flex-direction: row;
    align-items: center;
    min-height: 44px;
  }
  select,
  input[type='number'] {
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .help {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .stage {
    position: relative;
    height: min(60vh, 520px);
    overflow: hidden;
    cursor: crosshair;
    touch-action: none;
    background: var(--fl-canvas);
    border-radius: var(--fl-radius-card);
  }
  .stage.disabled {
    cursor: default;
    opacity: 0.6;
  }
  .stage:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .stage img {
    width: 100%;
    height: 100%;
    object-fit: contain;
    user-select: none;
    pointer-events: none;
  }
  .region {
    position: absolute;
    border: 2px solid var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 16%, transparent);
    pointer-events: none;
  }
  .image-error,
  .error {
    margin: 0;
    color: var(--fl-danger);
  }
  .image-error {
    padding: 1rem;
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .fields legend {
    margin-bottom: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fields input {
    width: 6rem;
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
