import type { LibraryEntry } from '$lib/frameleaf/eagle/eagle-library-reader';

/**
 * A small synthetic Eagle library for the tests: "Fixture.library" with nested, coloured folders,
 * a smart folder and tag group, and items that cover every path through the check: filed in two
 * folders, unfiled, rated, with notes and web addresses, an area comment on a picture and one on a
 * video, a font, a sound, one in the trash, one whose file is missing and one whose metadata is
 * broken. It holds 11 items: 6 come over and 5 can't.
 */
export const FIXTURE_LIBRARY_NAME = 'Fixture.library';

export const FIXTURE_FOLDERS = [
  {
    id: 'F1',
    name: 'Brand identity',
    description: 'Marks we keep coming back to',
    iconColor: 'green',
    children: [
      { id: 'F2', name: 'Logos', icon: 'star', children: [] },
      { id: 'F3', name: 'Type', children: [] },
    ],
  },
  {
    id: 'F4',
    name: 'Web',
    iconColor: 'blue',
    children: [
      {
        id: 'F5',
        name: 'Landing pages',
        children: [{ id: 'F6', name: 'Hero sections', iconColor: 'orange', children: [] }],
      },
    ],
  },
  { id: 'F7', name: 'Inspiration', iconColor: 'yellow', icon: 'bulb', children: [] },
];

interface FixtureItem {
  id: string;
  name: string;
  ext: string;
  folders?: string[];
  tags?: string[];
  star?: number;
  url?: string;
  annotation?: string;
  width?: number;
  height?: number;
  isDeleted?: boolean;
  comments?: { id: string; x: number; y: number; width: number; height: number; annotation: string }[];
  /** Leave the file out of its folder. */
  noFile?: boolean;
  /** Write a broken metadata.json. */
  broken?: boolean;
}

export const FIXTURE_ITEMS: FixtureItem[] = [
  {
    id: 'I1',
    name: 'hero',
    ext: 'jpg',
    folders: ['F6', 'F7'],
    tags: ['hero', 'warm'],
    star: 5,
    url: 'https://gallery.example.test/shot/1',
    annotation: 'Keep for the lodge refresh.',
    width: 1000,
    height: 500,
    comments: [{ id: 'C1', x: 100, y: 50, width: 200, height: 100, annotation: 'This corner' }],
  },
  { id: 'I2', name: 'logo', ext: 'png', folders: ['F2'], tags: ['logo'], width: 400, height: 400 },
  { id: 'I3', name: 'display', ext: 'svg', folders: ['F3'], star: 3, width: 800, height: 600 },
  {
    id: 'I4',
    name: 'loop',
    ext: 'mp4',
    folders: ['F4'],
    url: 'https://gallery.example.test/clip',
    width: 1920,
    height: 1080,
    comments: [{ id: 'C2', x: 0, y: 0, width: 100, height: 100, annotation: 'On a video' }],
  },
  { id: 'I5', name: 'loose', ext: 'webp', tags: ['warm'], url: 'https://gallery.example.test/loose' },
  { id: 'I6', name: 'already', ext: 'png', folders: ['F2', 'GONE'], annotation: 'From Eagle', star: 2 },
  { id: 'I7', name: 'Lodge Serif', ext: 'otf', folders: ['F3'], tags: ['typography'] },
  { id: 'I8', name: 'fire-crackle', ext: 'mp3' },
  { id: 'I9', name: 'old-draft', ext: 'png', isDeleted: true },
  { id: 'I10', name: 'missing', ext: 'jpg', folders: ['F7'], noFile: true },
  { id: 'I11', name: 'broken', ext: 'jpg', broken: true },
];

const json = (value: unknown, path: string) =>
  new File([JSON.stringify(value)], path.split('/').pop()!, { type: 'application/json' });

/** The library's files, as the reader is given them (paths below the `.library` folder). */
export function fixtureLibraryEntries(): LibraryEntry[] {
  const entries: LibraryEntry[] = [
    {
      path: 'metadata.json',
      file: json(
        {
          folders: FIXTURE_FOLDERS,
          smartFolders: [{ id: 'S1', name: 'Blue tones' }],
          tagsGroups: [{ id: 'G1', name: 'Clients', tags: ['lodge'] }],
          modificationTime: 1_790_000_000_000,
          applicationVersion: '4.0.0',
        },
        'metadata.json',
      ),
    },
    { path: 'tags.json', file: json({ historyTags: ['hero', 'warm', 'logo'], starredTags: [] }, 'tags.json') },
    { path: 'backup/backup-1.json', file: json({}, 'backup-1.json') },
  ];
  for (const item of FIXTURE_ITEMS) {
    const folder = `images/${item.id}.info`;
    entries.push({
      path: `${folder}/metadata.json`,
      file: item.broken
        ? new File(['{ not json'], 'metadata.json')
        : json(
            {
              id: item.id,
              name: item.name,
              ext: item.ext,
              size: 1000,
              width: item.width ?? 0,
              height: item.height ?? 0,
              url: item.url ?? '',
              annotation: item.annotation ?? '',
              tags: item.tags ?? [],
              folders: item.folders ?? [],
              star: item.star,
              isDeleted: item.isDeleted ?? false,
              modificationTime: 1_789_000_000_000,
              palettes: [{ color: [69, 134, 156], ratio: 38 }],
              ...(item.comments && { comments: item.comments }),
            },
            'metadata.json',
          ),
    });
    if (!item.noFile && !item.broken) {
      entries.push(
        {
          path: `${folder}/${item.name}.${item.ext}`,
          file: new File([`bytes of ${item.id}`], `${item.name}.${item.ext}`),
        },
        {
          path: `${folder}/${item.name}_thumbnail.png`,
          file: new File(['thumb'], `${item.name}_thumbnail.png`),
        },
      );
    }
  }
  return entries;
}
