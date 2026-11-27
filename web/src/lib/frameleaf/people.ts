/**
 * Frameleaf People pages (FL-37): small pure helpers shared by the People grid and the
 * manage-visibility page. These never call a network endpoint themselves; the pages own
 * every mutation through the existing `@frameleaf/sdk` person services
 * (`updatePerson`, `updatePeople`, `searchPerson`, `mergePerson`).
 */
import type { Translations } from 'svelte-i18n';

export interface NamedPerson {
  name: string;
}

/** Matches production's own "no name" convention: an empty or whitespace-only name. */
export const isUnnamedPerson = (person: NamedPerson): boolean => !person.name?.trim();

/** Case-insensitive substring match against a person's name, empty query matches everyone. */
export const matchesPersonSearch = (person: NamedPerson, query: string): boolean => {
  const trimmed = query.trim().toLocaleLowerCase();
  if (!trimmed) {
    return true;
  }
  return person.name.toLocaleLowerCase().includes(trimmed);
};

export const filterPeopleByName = <T extends NamedPerson>(people: T[], query: string): T[] =>
  people.filter((person) => matchesPersonSearch(person, query));

/** Unnamed people last, named people alphabetically, matching the manage page's grouping. */
export const sortPeopleForManage = <T extends NamedPerson>(people: T[]): T[] =>
  [...people].sort((a, b) => Number(isUnnamedPerson(a)) - Number(isUnnamedPerson(b)) || a.name.localeCompare(b.name));

export interface GridPerson extends NamedPerson {
  assetCount?: number;
  lastSeenAt?: string | null;
}

export type PeopleGridSort = 'name' | 'count' | 'recent';

const byName = (a: NamedPerson, b: NamedPerson) =>
  Number(isUnnamedPerson(a)) - Number(isUnnamedPerson(b)) || a.name.localeCompare(b.name);

/**
 * The People grid's three sorts (template/src/People.jsx:690-707): Name keeps unnamed people
 * last; Photo count and Recently seen fall back to that order on a tie.
 */
export const sortPeopleForGrid = <T extends GridPerson>(people: T[], sort: PeopleGridSort): T[] =>
  [...people].sort((a, b) => {
    if (sort === 'count') {
      return (b.assetCount ?? 0) - (a.assetCount ?? 0) || byName(a, b);
    }
    if (sort === 'recent') {
      return (b.lastSeenAt ?? '').localeCompare(a.lastSeenAt ?? '') || byName(a, b);
    }
    return byName(a, b);
  });

/** Whole years between an ISO `YYYY-MM-DD` birth date and `now`, or null when unset or in the future. */
export const ageInYears = (birthDate: string | null | undefined, now = new Date()): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate ?? '');
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  let age = now.getFullYear() - year;
  if (now.getMonth() + 1 < month || (now.getMonth() + 1 === month && now.getDate() < day)) {
    age--;
  }
  return age >= 0 ? age : null;
};

/** A date problem as a message key, or null. Either date may be empty; `today` is an ISO day. */
export const datesProblem = (birthDate: string, deathDate: string, today: string): Translations | null => {
  const real = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today;
  if (birthDate && !real(birthDate)) {
    return 'frameleaf_people_birthday_future';
  }
  if (deathDate && !real(deathDate)) {
    return 'frameleaf_people_passing_future';
  }
  return birthDate && deathDate && deathDate < birthDate ? 'frameleaf_people_passing_before_birth' : null;
};

/** "1938 – 2021" once someone has passed (FL-864), the year alone without a birth date; null otherwise. */
export const lifespan = (
  birthDate: string | null | undefined,
  deathDate: string | null | undefined,
): { years: string; born: boolean } | null => {
  const died = /^\d{4}/.exec(deathDate ?? '')?.[0];
  if (!died) {
    return null;
  }
  const born = /^\d{4}/.exec(birthDate ?? '')?.[0];
  return { years: born ? `${born} – ${died}` : died, born: !!born };
};

export interface FaceBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface FaceBounds {
  boundingBoxX1: number;
  boundingBoxY1: number;
  boundingBoxX2: number;
  boundingBoxY2: number;
  imageWidth: number;
  imageHeight: number;
}

/** A detected face's bounding box as fractions of the image, or null when it is unusable. */
export const normalizedFaceBox = (face: FaceBounds): FaceBox | null => {
  const { boundingBoxX1: x1, boundingBoxY1: y1, boundingBoxX2: x2, boundingBoxY2: y2, imageWidth, imageHeight } = face;
  if (!(imageWidth > 0 && imageHeight > 0 && x2 > x1 && y2 > y1)) {
    return null;
  }
  return { x: x1 / imageWidth, y: y1 / imageHeight, width: (x2 - x1) / imageWidth, height: (y2 - y1) / imageHeight };
};
