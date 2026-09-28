import { setMaintenanceMode, type SetMaintenanceModeDto } from '@immich/sdk';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

export const handleSetMaintenanceMode = async (dto: SetMaintenanceModeDto) => {
  const $t = await getFormatter();

  try {
    await setMaintenanceMode({
      setMaintenanceModeDto: dto,
    });
  } catch (error) {
    handleError(error, $t('admin.maintenance_start_error'));
  }
};
