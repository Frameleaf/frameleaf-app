/**
 * Render worker administration calls (FL-95). Each wraps one admin endpoint with the standard
 * toast on success and `handleError` on failure, so components only decide what to show next.
 * The enrolment secret returned by `handleCreateRenderWorker` is handed straight back to the
 * caller and never stored or logged here.
 */
import {
  createRenderWorker,
  deleteRenderWorkerUserLimit,
  revokeRenderWorker,
  updateRenderWorker,
  updateRenderWorkerLimits,
  type RenderWorkerCreateDto,
  type RenderWorkerLimitUpdateDto,
  type RenderWorkerUpdateDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const handleCreateRenderWorker = async (dto: RenderWorkerCreateDto) => {
  const $t = await getFormatter();
  try {
    const response = await createRenderWorker({ renderWorkerCreateDto: dto });
    toastManager.primary($t('frameleaf_render_workers_enrolled_toast', { values: { name: response.worker.name } }));
    return response;
  } catch (error) {
    handleError(error, $t('frameleaf_render_workers_unable_to_enrol'));
  }
};

export const handleUpdateRenderWorker = async (id: string, dto: RenderWorkerUpdateDto) => {
  const $t = await getFormatter();
  try {
    const worker = await updateRenderWorker({ id, renderWorkerUpdateDto: dto });
    toastManager.primary($t('frameleaf_render_workers_updated_toast', { values: { name: worker.name } }));
    return worker;
  } catch (error) {
    handleError(error, $t('frameleaf_render_workers_unable_to_update'));
  }
};

export const handleRevokeRenderWorker = async (id: string, name: string) => {
  const $t = await getFormatter();
  try {
    await revokeRenderWorker({ id });
    toastManager.primary($t('frameleaf_render_workers_revoked_toast', { values: { name } }));
    return true;
  } catch (error) {
    handleError(error, $t('frameleaf_render_workers_unable_to_revoke'));
    return false;
  }
};

export const handleUpdateRenderLimits = async (dto: RenderWorkerLimitUpdateDto) => {
  const $t = await getFormatter();
  try {
    const limit = await updateRenderWorkerLimits({ renderWorkerLimitUpdateDto: dto });
    toastManager.primary($t('frameleaf_render_workers_limits_saved_toast'));
    return limit;
  } catch (error) {
    handleError(error, $t('frameleaf_render_workers_unable_to_save_limits'));
  }
};

export const handleDeleteRenderUserLimit = async (userId: string) => {
  const $t = await getFormatter();
  try {
    await deleteRenderWorkerUserLimit({ id: userId });
    toastManager.primary($t('frameleaf_render_workers_limits_removed_toast'));
    return true;
  } catch (error) {
    handleError(error, $t('frameleaf_render_workers_unable_to_remove_limits'));
    return false;
  }
};
