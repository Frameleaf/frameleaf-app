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
  import { classifyInlineEditError, inlineEditRecovery, type InlineEditFailure } from '$lib/frameleaf/inline-edit';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import ViewerDateDialog from '$lib/components/frameleaf/ViewerDateDialog.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handlePromiseError } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import { getAssetInfo, type AssetResponseDto } from '@immich/sdk';
  import { Icon, modalManager } from '@immich/ui';
  import { mdiCalendar, mdiPencil } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    onAssetRefresh?: (asset: AssetResponseDto) => void;
  };

  const { asset, onAssetRefresh }: Props = $props();

  const timeZone = $derived(asset.exifInfo?.timeZone ?? undefined);
  const dateTime = $derived(
    timeZone && asset.exifInfo?.dateTimeOriginal
      ? fromISODateTime(asset.exifInfo.dateTimeOriginal, timeZone)
      : fromISODateTimeUTC(asset.localDateTime),
  );
  const isOwner = $derived(authManager.authenticated && asset.ownerId === authManager.user.id);

  let failure = $state<InlineEditFailure | null>(null);

  const handleChangeDate = async () => {
    if (!isOwner) {
      return;
    }

    const succeeded = await modalManager.show(ViewerDateDialog, {
      asset,
      initialDate: dateTime,
      initialTimeZone: timeZone,
      onError: (error: unknown) => {
        failure = classifyInlineEditError(error);
      },
    });

    if (succeeded) {
      failure = null;
    }
  };

  const reload = async () => {
    try {
      const updated = await getAssetInfo({ id: asset.id });
      failure = null;
      onAssetRefresh?.(updated);
    } catch (error) {
      handleError(error, $t('frameleaf_info_error_reload_failed'));
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
        <p>
          {dateTime.toLocaleString({ month: 'short', day: 'numeric', year: 'numeric' }, { locale: $locale })}
        </p>
        <div class="flex gap-2 text-sm">
          <p>
            {dateTime.toLocaleString(
              {
                weekday: 'short',
                hour: 'numeric',
                minute: '2-digit',
                second: '2-digit',
                timeZoneName: timeZone ? 'longOffset' : undefined,
              },
              { locale: $locale },
            )}
          </p>
        </div>
        {#if timeZone}
          <p class="text-sm text-gray-500 dark:text-gray-400">{timeZone.replaceAll('_', ' ')}</p>
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
