/**
 * The words of the editor's media bin (FL-1822): Add files and its menu, the web address dialog, the Library, Project and
 * Scenes switch, search, the type filter and sort, the view toggles and the group headings.
 * Translated by the host, as for the timeline strings (`timeline-strings.ts`): the engine speaks
 * fewer languages than the host, so the host sends its translation in `context.strings` and the
 * adapter writes it over the engine key. Several engine keys can share one host message.
 */
export const BIN_STRINGS = {
  binAdd: { host: 'frameleaf_studio_bin_add', engine: 'media.library.import' },
  binAddTooltip: { host: 'frameleaf_studio_bin_add_tooltip', engine: 'media.library.importMediaFiles' },
  binMoreWays: { host: 'frameleaf_studio_bin_more_ways', engine: 'media.library.importMoreOptions' },
  binAddSubtitles: { host: 'frameleaf_studio_bin_add_subtitles', engine: 'media.library.importSubtitles' },
  binAddFromUrl: { host: 'frameleaf_studio_bin_add_from_url', engine: 'media.library.importMediaFromUrl' },
  binSource: { host: 'frameleaf_studio_bin_source', engine: 'media.library.libraryView' },
  binProject: { host: 'frameleaf_studio_bin_project', engine: 'media.library.mediaTab' },
  binProjectTooltip: { host: 'frameleaf_studio_bin_project_tooltip', engine: 'media.library.showMediaLibrary' },
  binScenes: { host: 'frameleaf_studio_bin_scenes', engine: 'media.library.scenesTab' },
  binScenesTooltip: { host: 'frameleaf_studio_bin_scenes_tooltip', engine: 'media.library.searchScenes' },
  binSearch: { host: 'frameleaf_studio_bin_search', engine: 'media.searchMedia' },
  binClearSearch: { host: 'frameleaf_studio_bin_clear_search', engine: 'media.library.clearSearch' },
  binAllTypes: { host: 'frameleaf_studio_bin_all_types', engine: 'media.library.allShort' },
  binAllTypesMenu: { host: 'frameleaf_studio_bin_all_types', engine: 'media.library.allTypes' },
  binVideos: { host: 'frameleaf_studio_bin_videos', engine: 'media.library.typeShort.video' },
  binGroupVideos: { host: 'frameleaf_studio_bin_videos', engine: 'media.library.groupVideos' },
  binSound: { host: 'frameleaf_studio_bin_sound', engine: 'media.library.typeShort.audio' },
  binGroupSound: { host: 'frameleaf_studio_bin_sound', engine: 'media.library.groupAudio' },
  binPhotos: { host: 'frameleaf_studio_bin_photos', engine: 'media.library.typeShort.image' },
  binGroupPhotos: { host: 'frameleaf_studio_bin_photos', engine: 'media.library.groupImages' },
  binAnimations: { host: 'frameleaf_studio_bin_animations', engine: 'media.library.typeShort.lottie' },
  binGroupAnimations: { host: 'frameleaf_studio_bin_animations', engine: 'media.library.groupLottie' },
  binSortByDate: { host: 'frameleaf_studio_bin_sort_by_date', engine: 'media.library.sortDate' },
  binSortByName: { host: 'frameleaf_studio_bin_sort_by_name', engine: 'media.library.sortName' },
  binSortBySize: { host: 'frameleaf_studio_bin_sort_by_size', engine: 'media.library.sortSize' },
  binSortDate: { host: 'frameleaf_studio_bin_sort_date', engine: 'media.library.sortShort.date' },
  binSortName: { host: 'frameleaf_studio_bin_sort_name', engine: 'media.library.sortShort.name' },
  binSortSize: { host: 'frameleaf_studio_bin_sort_size', engine: 'media.library.sortShort.size' },
  binThumbSize: { host: 'frameleaf_studio_bin_thumb_size', engine: 'media.library.gridItemSize' },
  binGrid: { host: 'frameleaf_studio_bin_grid', engine: 'media.library.gridView' },
  binList: { host: 'frameleaf_studio_bin_list', engine: 'media.library.listView' },
  binUrlTitle: { host: 'frameleaf_studio_bin_add_from_url', engine: 'media.library.importFromUrlTitle' },
  binUrlDescription: { host: 'frameleaf_studio_bin_url_description', engine: 'media.library.importFromUrlDescription' },
  binUrlHint: { host: 'frameleaf_studio_bin_url_hint', engine: 'media.library.importFromUrlHint' },
  binUrlSubmit: { host: 'frameleaf_studio_bin_url_submit', engine: 'media.library.importUrlSubmit' },
  binTypeLabel: { host: 'frameleaf_studio_bin_type_label', engine: 'media.library.filterByType' },
  binSortLabel: { host: 'frameleaf_studio_bin_sort_label', engine: 'media.library.sortBy' },
  binDropFiles: { host: 'frameleaf_studio_bin_drop_files', engine: 'media.library.dropFilesHere' },
} as const satisfies Record<string, { host: string; engine: string }>;

export type BinString = keyof typeof BIN_STRINGS;

type BinHostKey = (typeof BIN_STRINGS)[BinString]['host'];

/** The host's translation of every bin string. */
export function binStrings(translate: (key: BinHostKey) => string): Record<BinString, string> {
  return Object.fromEntries(
    Object.entries(BIN_STRINGS).map(([name, entry]) => [name, translate(entry.host)]),
  ) as Record<BinString, string>;
}
