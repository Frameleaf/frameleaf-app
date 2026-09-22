/**
 * Frameleaf People pages (FL-37): small pure helpers shared by the People grid and the
 * manage-visibility page. These never call a network endpoint themselves; the pages own
 * every mutation through the existing `@immich/sdk` person services
 * (`updatePerson`, `updatePeople`, `searchPerson`, `mergePerson`).
 */

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
