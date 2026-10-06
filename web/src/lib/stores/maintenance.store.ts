import { type MaintenanceAuthDto, type MaintenanceStatusResponseDto } from '@frameleaf/sdk';
import { writable } from 'svelte/store';

export const maintenanceStore = {
  auth: writable<MaintenanceAuthDto>(),
  status: writable<MaintenanceStatusResponseDto | undefined>(),
};
