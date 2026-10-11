/** How each place a backup is kept is named and drawn, on every Backup page (FL-362). */
import { mdiCloudOutline, mdiHandshakeOutline, mdiHarddisk } from '@mdi/js';
import type { Translations } from 'svelte-i18n';
import type { BackupPlaceId } from '$lib/frameleaf/backup-overview';

export const BACKUP_PLACE_COPY: Readonly<Record<BackupPlaceId, { name: Translations; icon: string }>> = Object.freeze({
  cloud: { name: 'frameleaf_buddy_cloud_backup', icon: mdiCloudOutline },
  buddy: { name: 'frameleaf_buddy_buddy_backup', icon: mdiHandshakeOutline },
  local: { name: 'frameleaf_backup_place_local', icon: mdiHarddisk },
});
