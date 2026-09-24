import type { PersonResponseDto } from '@immich/sdk';
import { normalizeSearchString } from './string-utils';

export const searchNameLocal = (
  name: string,
  people: PersonResponseDto[],
  slice: number,
  personId?: string,
): PersonResponseDto[] => {
  const normalizedName = normalizeSearchString(name);
  return name.includes(' ')
    ? people
        .filter((person: PersonResponseDto) => {
          return personId
            ? normalizeSearchString(person.name).startsWith(normalizedName) && person.id !== personId
            : normalizeSearchString(person.name).startsWith(normalizedName);
        })
        .slice(0, slice)
    : people
        .filter((person: PersonResponseDto) => {
          const nameParts = person.name.split(' ');
          return personId
            ? nameParts.some((splitName) => normalizeSearchString(splitName).startsWith(normalizedName)) &&
                person.id !== personId
            : nameParts.some((splitName) => normalizeSearchString(splitName).startsWith(normalizedName));
        })
        .slice(0, slice);
};
