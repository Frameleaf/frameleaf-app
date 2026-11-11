<script lang="ts">
  /**
   * The information panel's capture date and timezone row (FL-36).
   *
   * Ported from the "Captured" row in `design/frameleaf/template/src/MediaViewer.jsx`. The
   * edit opens the template's "Edit date and time" dialog (`ViewerDateDialog`, audit V-23), which
   * writes `dateTimeOriginal` through `updateAsset`; the panel adds the failure handling the
   * prototype's dialog only simulated.
   *
   * Retry here means reopening the picker, because the attempted value lives in the modal:
   * replaying a date the panel never saw would be a guess. A stale asset is reloaded instead.
   */
  import ViewerInlineEditError from '$lib/components/frameleaf/ViewerInlineEditError.svelte';
  import { formatLuxon } from '$lib/frameleaf/date-format';
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { captureDateTime } from '$lib/frameleaf/viewer-headline';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import ViewerDateDialog from '$lib/components/frameleaf/ViewerDateDialog.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { getAssetInfo, type AssetResponseDto } from '@frameleaf/sdk';
  import { Icon, modalManager } from '@frameleaf/ui';
  import { mdiCalendar, mdiPencil } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  };

  const { asset, onAssetRefresh }: Props = $props();

  const timeZone = $derived(asset.exifInfo?.timeZone ?? undefined);
  const dateTime = $derived(captureDateTime(asset));
  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);
  /**
   * The prototype's two lines (MediaViewer.jsx "Captured"; UI review 2026-11-10, A5): the day, then
   * the time with the zone's name after it when the photo has one. No seconds and no GMT offset.
   * Both follow the person's date and time format (FL-783).
   */
  const dateLine = $derived(
    dateTime && formatLuxon(dateTime, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }, $locale),
  );
  const timeLine = $derived(
    [dateTime && formatLuxon(dateTime, { hour: 'numeric', minute: '2-digit' }, $locale), timeZone?.replaceAll('_', ' ')]
      .filter(Boolean)
      .join(' · '),
  );

  let failure = $state<InlineEditFailure | null>(null);

  let alive = true;
  let generation = 0;
  let previousAssetId: string | undefined;
  onDestroy(() => {
    alive = false;
  });
  $effect.pre(() => {
    if (asset.id === previousAssetId) {
      return;
    }
    previousAssetId = asset.id;
    generation++;
    failure = null;
  });
  const captureView = () => {
    const owner = generation;
    const isCurrentSession = authManager.captureSession();
    return () => alive && owner === generation && isCurrentSession();
  };

  const handleChangeDate = async () => {
    if (!isOwner) {
      return;
    }

    const isCurrent = captureView();
    const succeeded = await modalManager.show(ViewerDateDialog, {
      asset,
      initialDate: dateTime ?? undefined,
      initialTimeZone: timeZone,
      onError: (error: unknown) => {
        if (isCurrent()) {
          failure = classifyInlineEditError(error);
        }
      },
    });

    if (succeeded && isCurrent()) {
      failure = null;
      // LIB-02: show the saved date and zone at once, not after the next edit or a reload
      await reload();
    }
  };

  const reload = async () => {
    const isCurrent = captureView();
    try {
      const updated = await getAssetInfo({ id: asset.id });
      if (!isCurrent()) {
        return;
      }
      failure = null;
      onAssetRefresh?.(updated);
    } catch (error) {
      if (isCurrent()) {
        handleError(error, $t('frameleaf_info_error_reload_failed'));
      }
    }
  };
</script>

{#if dateTime}
  <button
    type="button"
    class="flex w-full place-items-start justify-between gap-4 py-4 text-start"
    onclick={handleChangeDate}
    title={isOwner ? $t('edit_date') : ''}
    class:hover:text-primary={isOwner}
    data-testid="detail-panel-edit-date-button"
  >
    <div class="flex gap-4">
      <Icon icon={mdiCalendar} size="24" />

      <div>
        <p data-testid="detail-panel-date">{dateLine}</p>
        <p class="text-sm text-gray-500 dark:text-gray-400" data-testid="detail-panel-time">{timeLine}</p>
        {#if asset.exifInfo?.dateEstimated}
          <p class="text-sm text-gray-500 dark:text-gray-400">{$t('frameleaf_info_date_estimated')}</p>
        {/if}
      </div>
    </div>

    {#if isOwner}
      <div class="p-1">
        <Icon icon={mdiPencil} size="20" />
      </div>
    {/if}
  </button>
{:else if !dateTime && isOwner}
  <button
    type="button"
    class="flex w-full place-items-start justify-between gap-4 py-4 text-start"
    onclick={handleChangeDate}
    title={$t('edit_date')}
    data-testid="detail-panel-edit-date-button"
  >
    <div class="flex gap-4">
      <Icon icon={mdiCalendar} size="24" />
      <p>{$t('frameleaf_info_add_capture_time')}</p>
    </div>
    <div class="p-1">
      <Icon icon={mdiPencil} size="20" />
    </div>
  </button>
{/if}

{#if failure}
  <ViewerInlineEditError
    {failure}
    onRetry={inlineEditRecovery(failure) === 'retry' ? () => handlePromiseError(handleChangeDate()) : undefined}
    onReload={inlineEditRecovery(failure) === 'reload' ? () => handlePromiseError(reload()) : undefined}
  />
{/if}
