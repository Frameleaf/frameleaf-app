// FL-1742: what a Noodle Gallery import brings across and leaves behind, in the words of the FL-894 design.
// Before the import the numbers are counted in the running source (Manager's review); afterwards they are
// what the importer reported carrying.

export type GalleryCounts = {
  spaces: number | null;
  /** People who are in at least one Space. */
  members: number | null;
  memberships: number | null;
  spacePhotos: number | null;
  people: number | null;
  favourites: number | null;
  pets: number | null;
};
export type GalleryData = {
  /** False when the importer refuses this release; only the review sets it. */
  readable?: boolean;
  counts: GalleryCounts;
  spaces?: { name: string; members: number; photos: number }[];
  /** The importer's names for Gallery data that holds rows and is not carried. */
  notImported: string[];
};

export type CarriedKind = 'spaces' | 'people' | 'pets' | 'favourites';
export type Carried = { kind: CarriedKind; icon: string; name: string; value: number; detail: string };
export type Behind = { name: string; detail: string };
export type LeftOut = { kind: CarriedKind; title: string; detail: string };
export type GalleryReview =
  | { state: 'unreadable'; title: string; detail: string }
  | { state: 'plain'; title: string; detail: string }
  | {
      state: 'full';
      carried: Carried[];
      spacesTitle: string;
      spaces: { name: string; detail: string }[];
      /** Spaces beyond the ones listed by name. */
      moreSpaces: number;
      leftOut: LeftOut[];
      behind: Behind[];
    };

export const GALLERY_INTRO =
  'On top of your accounts, albums and settings. Importing from Noodle Gallery is new: your photos and albums always arrive, and Manager tells you if anything else could not be read.';
export const GALLERY_SPACES_NOTE = 'Each Space becomes a shared space in Frameleaf, with the same members and photos.';
export const GALLERY_KEPT =
  'Nothing is deleted at the source. Your Noodle Gallery database is kept exactly as it is, so what stays behind is still there.';
export const GALLERY_KEPT_DONE = 'Nothing was deleted at the source. Your Noodle Gallery database is kept, stopped, for recovery.';

const number = (value: number) => value.toLocaleString('en-CA');
const counted = (value: number, one: string, many: string) => `${number(value)} ${value === 1 ? one : many}`;

const CARRIED: Record<CarriedKind, { icon: string; name: string; one: string; count: keyof GalleryCounts; detail: string }> = {
  spaces: { icon: 'group', name: 'Spaces', one: 'Space', count: 'spaces', detail: '' },
  people: {
    icon: 'face',
    name: 'People named in Spaces',
    one: 'Person named in Spaces',
    count: 'people',
    detail: 'Their names stay on each Space’s photos',
  },
  pets: { icon: 'paw', name: 'Pets', one: 'Pet', count: 'pets', detail: 'Named pets, with the photos they are in' },
  favourites: {
    icon: 'heart',
    name: 'Favourites',
    one: 'Favourite',
    count: 'favourites',
    detail: 'Everyone keeps their own, on shared photos too',
  },
};

// The importer's names (server/src/immich-import/source.ts) for data it could have carried but cannot read here.
const UNREAD: Record<string, CarriedKind> = {
  Spaces: 'spaces',
  'people named in Spaces': 'people',
  pets: 'pets',
  'favourites set by other people': 'favourites',
};
const LEFT_OUT: Record<CarriedKind, { name: string; after: string }> = {
  spaces: { name: 'Spaces', after: 'Their photos are in your library; make the Spaces again in Frameleaf.' },
  people: { name: 'People named in Spaces', after: 'Each account keeps its own people.' },
  pets: { name: 'Pets', after: 'Their photos are in your library; name the pets again in Frameleaf.' },
  favourites: {
    name: 'Favourites on other people’s photos',
    after: 'Favourites on each person’s own photos are kept.',
  },
};
// Its names for Gallery data Frameleaf has no place for, grouped as the review words them.
const BEHIND: { names: string[]; name: string; detail: string }[] = [
  {
    names: ['libraries linked to Spaces', 'albums linked to Spaces'],
    name: 'Albums and libraries linked to a Space',
    detail:
      'The Space and its photos come across. The link that kept adding an album’s or a library’s new photos does not, so add those again in Frameleaf.',
  },
  {
    names: ['people shared between accounts'],
    name: 'People shared between accounts',
    detail: 'Each account keeps its own people. A person one account shared with another is separate again.',
  },
  {
    names: ['user groups'],
    name: 'User groups',
    detail: 'Frameleaf has no groups. The members of each Space come across one by one.',
  },
  {
    names: ['exposure, contrast, saturation and invert adjustments', 'video trims'],
    name: 'Edits made in Gallery',
    detail:
      'Trims and other changes made in Gallery’s own editor are not carried. Your original photos and videos are untouched.',
  },
  {
    names: ['clean-up review decisions'],
    name: 'Clean-up decisions',
    detail: 'What you chose to keep or skip in Gallery’s clean-up tools is not carried.',
  },
];

/** What comes across, in the review's order. A read this release does not offer has no entry. */
export function galleryCarried({ counts }: GalleryData): Carried[] {
  return (Object.keys(CARRIED) as CarriedKind[]).flatMap((kind) => {
    const { icon, name, one, count, detail } = CARRIED[kind];
    const value = counts[count];
    if (value === null || value === undefined) return [];
    return [
      {
        kind,
        icon,
        name: value === 1 ? one : name,
        value,
        detail:
          kind === 'spaces'
            ? `${counted(counts.members ?? 0, 'member', 'members')} · ${counted(counts.spacePhotos ?? 0, 'photo', 'photos')}`
            : detail,
      },
    ];
  });
}

/** What stays behind, grouped; a name the importer adds later is shown as it is. */
export function galleryBehind({ notImported }: GalleryData): Behind[] {
  const known = new Set([...Object.keys(UNREAD), ...BEHIND.flatMap((group) => group.names)]);
  return [
    ...BEHIND.filter((group) => group.names.some((name) => notImported.includes(name))).map(({ name, detail }) => ({
      name,
      detail,
    })),
    ...notImported
      .filter((name) => !known.has(name))
      .map((name) => ({ name: name.charAt(0).toUpperCase() + name.slice(1), detail: 'Not carried into Frameleaf.' })),
  ];
}

/** Data the import would carry, but this release keeps in a way that cannot be read. */
export function galleryLeftOut({ notImported }: GalleryData, done = false): LeftOut[] {
  return (Object.keys(LEFT_OUT) as CarriedKind[])
    .filter((kind) => notImported.some((name) => UNREAD[name] === kind))
    .map((kind) => ({
      kind,
      title: done
        ? `${LEFT_OUT[kind].name} could not be read, so they were left out.`
        : `${LEFT_OUT[kind].name} can’t be read from this release, so they will be left out.`,
      detail: `${done ? 'Everything else came across.' : 'Everything else comes across.'} ${LEFT_OUT[kind].after}`,
    }));
}

/** The review under the installation's facts: what Noodle Gallery adds, nothing extra, or a release that cannot be read. */
export function galleryReview(gallery: GalleryData, version: string): GalleryReview {
  if (gallery.readable === false)
    return {
      state: 'unreadable',
      title: 'Manager can’t read this Noodle Gallery release yet',
      detail: `Release ${version} keeps favourites in a way Manager doesn’t know. Update Noodle Gallery to its newest release, then check again. Nothing has been changed, and your Gallery keeps running as it is.`,
    };
  const carried = galleryCarried(gallery);
  const leftOut = galleryLeftOut(gallery);
  const behind = galleryBehind(gallery);
  if (carried.every((item) => item.value === 0) && leftOut.length === 0 && behind.length === 0)
    return {
      state: 'plain',
      title: 'Nothing extra to bring',
      detail:
        'This Noodle Gallery has no Spaces, named pets or favourites on other people’s photos. Your accounts, albums, people and settings come across as listed above.',
    };
  const listed = gallery.spaces ?? [];
  const total = gallery.counts.spaces ?? 0;
  return {
    state: 'full',
    carried,
    spacesTitle: total === 1 ? 'The Space' : `The ${number(total)} Spaces`,
    spaces: listed.map((space) => ({
      name: space.name,
      detail: `${counted(space.members, 'member', 'members')} · ${counted(space.photos, 'photo', 'photos')}`,
    })),
    moreSpaces: Math.max(0, total - listed.length),
    leftOut,
    behind,
  };
}

/** The short reminder on "Ready to switch" and the result on "Your server is ready"; null when there is nothing to say. */
export function gallerySummary(gallery: GalleryData | null | undefined, done = false) {
  if (!gallery || gallery.readable === false) return null;
  const carried = galleryCarried(gallery).filter((item) => item.value > 0);
  const leftOut = galleryLeftOut(gallery, done);
  const behind = galleryBehind(gallery);
  if (carried.length === 0 && leftOut.length === 0 && behind.length === 0) return null;
  return {
    carriedTitle: done ? 'Came across from Noodle Gallery' : 'Also from Noodle Gallery',
    carried: carried.map(({ kind, icon, name, value }) => ({ kind, icon, name, value: number(value) })),
    leftOut,
    behindTitle: done ? 'Stayed behind' : 'Stays behind',
    behind: behind.map((item) => item.name).join(' · '),
    kept: done ? GALLERY_KEPT_DONE : null,
  };
}

export const galleryNumber = number;
