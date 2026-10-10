import { createJob, type JobCreateDto } from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const handleCreateJob = async (dto: JobCreateDto) => {
  const $t = await getFormatter();

  try {
    await createJob({ jobCreateDto: dto });
    eventManager.emit('JobCreate', { dto });
    toastManager.primary($t('admin.job_created'));
    return true;
  } catch (error) {
    handleError(error, $t('errors.unable_to_submit_job'));
  }
};
