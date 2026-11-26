<script lang="ts">
  /**
   * FL-955: the Repair & suggested colours card of a photo's Enhance panel. One operation at a time, previewed
   * first; saving makes a new version and the original is never changed. The server says where it can
   * run: with no worker that has a ready model the card says so and nothing can be queued.
   */
  import { canDecideRestoration, formatEstimateSeconds, isRestorationBusy } from '$lib/frameleaf/restoration';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetRestorationMode,
    AssetRestorationOperation,
    AssetRestorationStatus,
    MlDestinationKind,
    CloudMlJobPurpose,
    CloudMlJobStage,
    estimateCloudMlJob,
    getAssetRestorationOptions,
    requestAssetRestoration,
    type AssetRestorationDestinationDto,
    type AssetRestorationOptionsDto,
    type AssetRestorationResponseDto,
    type CloudMlJobEstimateRequestDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAutoFix, mdiCompare, mdiEyeOutline, mdiPaletteOutline, mdiServerOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type PhotoOperation = AssetRestorationOperation.Repair | AssetRestorationOperation.Colourise;

  type Props = {
    assetId: string;
    items: AssetRestorationResponseDto[];
    busyId: string | null;
    compareId: string | null;
    onCreated: (item: AssetRestorationResponseDto) => void;
    onSave: (item: AssetRestorationResponseDto) => Promise<void> | void;
    onDiscard: (item: AssetRestorationResponseDto) => Promise<void> | void;
    onCancel: (item: AssetRestorationResponseDto) => Promise<void> | void;
    onCompare: (item: AssetRestorationResponseDto) => void;
    /** Frameleaf Cloud answered with a price: the panel shows it for the owner to confirm. */
    onCloudPreview: (request: CloudMlJobEstimateRequestDto) => void;
  };

  let { assetId, items, busyId, compareId, onCreated, onSave, onDiscard, onCancel, onCompare, onCloudPreview }: Props =
    $props();

  /** The whole photo: a repair is judged on all of it, and the preview is already small. */
  const WHOLE_PHOTO = { x: 0, y: 0, w: 1, h: 1 };

  let operation = $state<PhotoOperation>(AssetRestorationOperation.Repair);
  let repairOptions = $state<AssetRestorationOptionsDto | null>(null);
  let colourOptions = $state<AssetRestorationOptionsDto | null>(null);
  let loadFailed = $state(false);
  let submitting = $state(false);
  /** The restoration this card started or saved, so an old failure is not shown as if it just happened. */
  let currentId = $state<string | null>(null);
  let savedId = $state<string | null>(null);

  const options = $derived(operation === AssetRestorationOperation.Repair ? repairOptions : colourOptions);
  /** "Suggest colours anyway": the owner's choice for a hand-tinted print. Choosing Repair takes it back. */
  let anyway = $state(false);
  const refusalReason = $derived(colourOptions?.colourRefusalReason ?? null);
  const handTinted = $derived(refusalReason === 'hand-tinted');
  const colourRefusal = $derived(
    colourOptions?.colourRefusal && !(handTinted && anyway) ? (refusalReason ?? 'colour-unknown') : null,
  );
  const refusalText = $derived.by(() => {
    if (refusalReason === 'hand-tinted') {
      return $t('frameleaf_repair_refused_hand_tinted');
    }
    return refusalReason === 'already-in-colour'
      ? $t('frameleaf_repair_refused_in_colour')
      : $t('frameleaf_repair_refused_unknown');
  });
  /** The first home destination that can take it, in the processing order the server answered with. */
  const homeDestination = (current: AssetRestorationOptionsDto | null): AssetRestorationDestinationDto | null =>
    current?.destinations.find((row) => row.available && row.kind !== MlDestinationKind.FrameleafCloud) ?? null;
  const destination = $derived(homeDestination(options));
  const nowhere = $derived(!!options && !destination);
  const cloudRow = $derived(
    options?.destinations.find((row) => row.available && row.kind === MlDestinationKind.FrameleafCloud) ?? null,
  );
  /** Frameleaf Cloud said it has no price or model for this yet; nothing was queued or charged. */
  let cloudRefused = $state(false);
  let askingCloud = $state(false);

  const isPhotoItem = (item: AssetRestorationResponseDto) =>
    item.operation === AssetRestorationOperation.Repair || item.operation === AssetRestorationOperation.Colourise;
  const current = $derived(
    items.find((item) => item.id === currentId) ??
      items.find(
        (item) => isPhotoItem(item) && (isRestorationBusy(item.status) || canDecideRestoration(item.status)),
      ) ??
      null,
  );
  const running = $derived(!!current && isRestorationBusy(current.status));
  const ready = $derived(!!current && canDecideRestoration(current.status));
  const failed = $derived(
    !!current &&
      (current.status === AssetRestorationStatus.PreviewFailed ||
        current.status === AssetRestorationStatus.RestoreFailed),
  );
  const saved = $derived(!!current && current.id === savedId && current.status === AssetRestorationStatus.Restored);
  const shownOperation = $derived((current?.operation as PhotoOperation | undefined) ?? operation);
  const isRepair = $derived(shownOperation === AssetRestorationOperation.Repair);
  const timeLeft = $derived(formatEstimateSeconds(current?.estimate?.previewSeconds ?? null, $locale));
  const blocked = $derived(operation === AssetRestorationOperation.Colourise && !!colourRefusal);
  const canPreview = $derived(!!destination && !blocked && !submitting && !running && !ready);

  onMount(async () => {
    try {
      [repairOptions, colourOptions] = await Promise.all([
        getAssetRestorationOptions({ id: assetId, operation: AssetRestorationOperation.Repair }),
        getAssetRestorationOptions({ id: assetId, operation: AssetRestorationOperation.Colourise }),
      ]);
    } catch (error) {
      loadFailed = true;
      handleError(error, $t('frameleaf_restoration_load_error'));
    }
  });

  const preview = async () => {
    if (!canPreview || !destination) {
      return;
    }
    submitting = true;
    savedId = null;
    try {
      const created = await requestAssetRestoration({
        id: assetId,
        assetRestorationRequestDto: {
          mode: AssetRestorationMode.Faithful,
          operation,
          upscale: 1,
          keepGrain: false,
          destinationId: destination.id,
          region: WHOLE_PHOTO,
          ...(operation === AssetRestorationOperation.Colourise && handTinted && anyway && { allowHandTinted: true }),
        },
      });
      currentId = created.id;
      onCreated(created);
    } catch (error) {
      handleError(error, $t('frameleaf_restoration_request_error'));
    } finally {
      submitting = false;
    }
  };

  const previewOnCloud = async () => {
    if (!cloudRow || askingCloud) {
      return;
    }
    const request: CloudMlJobEstimateRequestDto = {
      assetId,
      destinationId: cloudRow.id,
      purpose: CloudMlJobPurpose.Restoration,
      stage: CloudMlJobStage.Preview,
      operation,
      region: WHOLE_PHOTO,
    };
    askingCloud = true;
    try {
      await estimateCloudMlJob({ cloudMlJobEstimateRequestDto: request });
      onCloudPreview(request);
    } catch (error) {
      if ((error as { data?: { code?: string } }).data?.code === 'photo-operation-unavailable') {
        cloudRefused = true;
      } else {
        handleError(error, $t('frameleaf_restoration_request_error'));
      }
    } finally {
      askingCloud = false;
    }
  };

  const save = async (item: AssetRestorationResponseDto) => {
    currentId = item.id;
    await onSave(item);
    savedId = item.id;
  };

  const retry = () => {
    currentId = null;
    return preview();
  };

  const suggestAnyway = () => {
    anyway = true;
    operation = AssetRestorationOperation.Colourise;
  };
</script>

<section class="ed-toggle rc-card" data-testid="repair-colourise" aria-labelledby="repair-colourise-title">
  <strong id="repair-colourise-title">
    <Icon icon={mdiAutoFix} size="16" />
    {$t('frameleaf_repair_title')}
  </strong>
  <p class="rs-lead">{$t('frameleaf_repair_lead')}</p>

  <div class="rc-choices" role="radiogroup" aria-label={$t('frameleaf_repair_title')}>
    <label class="rc-choice" class:is-on={operation === AssetRestorationOperation.Repair}>
      <input
        type="radio"
        name="repair-operation"
        value="repair"
        bind:group={operation}
        disabled={running || ready}
        onchange={() => (anyway = false)}
      />
      <Icon icon={mdiAutoFix} size="18" />
      <span><b>{$t('frameleaf_repair_repair')}</b><small>{$t('frameleaf_repair_repair_help')}</small></span>
    </label>
    <label
      class="rc-choice"
      class:is-on={operation === AssetRestorationOperation.Colourise}
      class:is-off={!!colourRefusal}
    >
      <input
        type="radio"
        name="repair-operation"
        value="colourise"
        bind:group={operation}
        disabled={running || ready || !!colourRefusal}
      />
      <Icon icon={mdiPaletteOutline} size="18" />
      <span>
        <b>{$t('frameleaf_repair_colourise')}</b>
        <small>
          {#if colourRefusal}
            {refusalText}
          {:else if handTinted && anyway}
            {$t('frameleaf_repair_anyway_help')}
          {:else}
            {$t('frameleaf_repair_colourise_help')}
          {/if}
        </small>
      </span>
    </label>
    {#if handTinted && !anyway}
      <button type="button" class="ed-button" disabled={running || ready} onclick={suggestAnyway}>
        {$t('frameleaf_repair_anyway')}
      </button>
    {/if}
  </div>

  {#if loadFailed}
    <p class="ed-empty">{$t('frameleaf_restoration_load_error')}</p>
  {:else if !options}
    <p class="rs-help" aria-busy="true">{$t('loading')}</p>
  {:else if running && current}
    <p class="rs-help" role="status">
      {isRepair ? $t('frameleaf_repair_running_repair') : $t('frameleaf_repair_running_colourise')}
      {#if timeLeft}{$t('frameleaf_repair_time_left', { values: { time: timeLeft } })}{/if}
    </p>
    <div class="rc-actions">
      <button type="button" class="ed-button" disabled={busyId === current.id} onclick={() => onCancel(current)}>
        {$t('cancel')}
      </button>
    </div>
  {:else if ready && current}
    <p class="rs-help" role="status">
      {isRepair ? $t('frameleaf_repair_ready') : $t('frameleaf_repair_ready_colourise')}
    </p>
    <div class="rc-actions">
      <button type="button" class="ed-chip" aria-pressed={compareId === current.id} onclick={() => onCompare(current)}>
        <Icon icon={mdiCompare} size="16" />
        {$t('frameleaf_repair_compare')}
      </button>
      <button type="button" class="ed-button primary" disabled={busyId === current.id} onclick={() => save(current)}>
        {$t('frameleaf_repair_save')}
      </button>
      <button type="button" class="ed-button" disabled={busyId === current.id} onclick={() => onDiscard(current)}>
        {$t('frameleaf_repair_discard')}
      </button>
    </div>
  {:else}
    {#if failed && current}
      <div class="rs-warning" role="alert">
        <b>{isRepair ? $t('frameleaf_repair_failed_repair') : $t('frameleaf_repair_failed_colourise')}</b>
        {$t('frameleaf_repair_failed_body', { values: { name: current.destinationName } })}
      </div>
    {:else if saved}
      <p class="rs-help" role="status">
        {isRepair ? $t('frameleaf_repair_saved_repair') : $t('frameleaf_repair_saved_colourise')}
      </p>
    {/if}
    {#if nowhere}
      <div class="rs-warning" role="status" data-testid="repair-nowhere">
        <b>
          {operation === AssetRestorationOperation.Repair
            ? $t('frameleaf_repair_nowhere_repair')
            : $t('frameleaf_repair_nowhere_colourise')}
        </b>
        {$t('frameleaf_repair_nowhere_body')}
        {#if !cloudRow || cloudRefused}
          {$t('frameleaf_repair_cloud_unavailable')}
        {/if}
      </div>
      {#if cloudRow && !cloudRefused && !(handTinted && anyway)}
        <div class="rc-actions">
          <button type="button" class="ed-button" disabled={askingCloud || blocked} onclick={previewOnCloud}>
            {$t('frameleaf_repair_try_cloud')}
          </button>
        </div>
      {/if}
      <a class="rs-link" href={commandCenterUrl('processing', 'computers')}>{$t('frameleaf_repair_set_up_computer')}</a>
    {:else}
      <div class="rc-actions">
        <button type="button" class="ed-button primary" disabled={!canPreview} onclick={failed ? retry : preview}>
          <Icon icon={mdiEyeOutline} size="18" />
          {failed ? $t('frameleaf_repair_try_again') : $t('frameleaf_repair_preview')}
        </button>
      </div>
      {#if destination}
        <p class="rs-help rc-where">
          <Icon icon={mdiServerOutline} size="16" />
          {destination.kind === MlDestinationKind.Local
            ? $t('frameleaf_repair_runs_here')
            : $t('frameleaf_repair_runs_on', { values: { name: destination.name } })}
        </p>
      {/if}
      <a class="rs-link" href={commandCenterUrl('processing', 'computers')}>{$t('frameleaf_repair_change_where')}</a>
    {/if}
  {/if}
</section>

<style>
  .rc-card {
    display: grid;
    gap: var(--fl-space-3);
  }
  .rc-choices {
    display: grid;
    gap: var(--fl-space-2);
  }
  .rc-choice {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    cursor: pointer;
  }
  .rc-choice.is-on {
    border-color: var(--fl-accent);
  }
  .rc-choice.is-off {
    opacity: 0.6;
    cursor: default;
  }
  .rc-choice span {
    display: grid;
    gap: 2px;
  }
  .rc-choice small {
    color: var(--fl-muted);
  }
  .rc-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .rc-where {
    display: flex;
    align-items: center;
    gap: var(--fl-space-1);
  }
</style>
