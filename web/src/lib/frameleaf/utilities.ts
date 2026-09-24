import {
  mdiCloudOutline,
  mdiCompare,
  mdiDevices,
  mdiDownload,
  mdiFolderSearchOutline,
  mdiHarddisk,
  mdiMapMarker,
  mdiMovieOpenOutline,
  mdiShieldCheckOutline,
  mdiTuneVariant,
} from '@mdi/js';
import type { Translations } from 'svelte-i18n';

export type UtilityGroup = 'organize' | 'repair' | 'import' | 'automate' | 'connect';
export const UTILITY_GROUPS: UtilityGroup[] = ['organize', 'repair', 'import', 'automate', 'connect'];
export type UtilityId =
  | 'duplicates'
  | 'large-files'
  | 'live-photos'
  | 'geolocation'
  | 'icloud'
  | 'missing-media'
  | 'corrupt-media'
  | 'workflows'
  | 'downloads'
  | 'obtainium';
export type UtilityTool = {
  id: UtilityId;
  group: UtilityGroup;
  icon: string;
  titleKey: Translations;
  descriptionKey: Translations;
  adminOnly?: boolean;
};
export const UTILITY_TOOLS: UtilityTool[] = [
  {
    id: 'duplicates',
    group: 'organize',
    icon: mdiCompare,
    titleKey: 'library_care_tool_duplicates',
    descriptionKey: 'library_care_tool_duplicates_description',
  },
  {
    id: 'large-files',
    group: 'organize',
    icon: mdiHarddisk,
    titleKey: 'library_care_tool_large_files',
    descriptionKey: 'library_care_tool_large_files_description',
  },
  {
    id: 'geolocation',
    group: 'organize',
    icon: mdiMapMarker,
    titleKey: 'library_care_tool_geolocation',
    descriptionKey: 'library_care_tool_geolocation_description',
  },
  {
    id: 'live-photos',
    group: 'repair',
    icon: mdiMovieOpenOutline,
    titleKey: 'library_care_tool_live_photos',
    descriptionKey: 'library_care_tool_live_photos_description',
  },
  {
    id: 'missing-media',
    group: 'repair',
    icon: mdiFolderSearchOutline,
    titleKey: 'library_care_tool_missing',
    descriptionKey: 'library_care_tool_missing_description',
    adminOnly: true,
  },
  {
    id: 'corrupt-media',
    group: 'repair',
    icon: mdiShieldCheckOutline,
    titleKey: 'library_care_tool_damaged',
    descriptionKey: 'library_care_tool_damaged_description',
    adminOnly: true,
  },
  {
    id: 'icloud',
    group: 'import',
    icon: mdiCloudOutline,
    titleKey: 'library_care_tool_icloud',
    descriptionKey: 'library_care_tool_icloud_description',
  },

  {
    id: 'workflows',
    group: 'automate',
    icon: mdiTuneVariant,
    titleKey: 'library_care_tool_workflows',
    descriptionKey: 'library_care_tool_workflows_description',
  },
  {
    id: 'downloads',
    group: 'connect',
    icon: mdiDevices,
    titleKey: 'library_care_tool_downloads',
    descriptionKey: 'library_care_tool_downloads_description',
  },
  {
    id: 'obtainium',
    group: 'connect',
    icon: mdiDownload,
    titleKey: 'library_care_tool_obtainium',
    descriptionKey: 'library_care_tool_obtainium_description',
  },
];

export const utilityToolsFor = (isAdmin: boolean) => UTILITY_TOOLS.filter((tool) => isAdmin || !tool.adminOnly);
/**
 * The repair tools the Library care area lists beside health, repairs and duplicates
 * (`CARE_TOOLS` in CommandCenter.jsx): Library Care is the hub for fixing things. Listed in the
 * Utilities order, as the template filters its utilities list.
 */
export const LIBRARY_CARE_TOOLS: readonly UtilityId[] = Object.freeze([
  'duplicates',
  'missing-media',
  'corrupt-media',
  'live-photos',
]);
export const libraryCareToolsFor = (isAdmin: boolean) =>
  utilityToolsFor(isAdmin).filter((tool) => LIBRARY_CARE_TOOLS.includes(tool.id));
export const utilityTool = (id: string | null) => UTILITY_TOOLS.find((tool) => tool.id === id);
export const utilitiesUrl = (section?: UtilityId, params: Record<string, string | number | undefined> = {}) => {
  const search = new URLSearchParams({ area: 'utilities' });
  if (section) {
    search.set('section', section);
  }
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  return `/user-settings?${search}`;
};
