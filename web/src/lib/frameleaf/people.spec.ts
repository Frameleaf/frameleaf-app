import { describe, expect, it } from 'vitest';
import { filterPeopleByName, isUnnamedPerson, matchesPersonSearch, sortPeopleForManage } from './people';

describe('frameleaf people helpers', () => {
  describe('isUnnamedPerson', () => {
    it('treats an empty or whitespace-only name as unnamed', () => {
      expect(isUnnamedPerson({ name: '' })).toBe(true);
      expect(isUnnamedPerson({ name: '   ' })).toBe(true);
    });

    it('treats a real name as named', () => {
      expect(isUnnamedPerson({ name: 'Jamie' })).toBe(false);
    });
  });

  describe('matchesPersonSearch', () => {
    it('matches everyone when the query is empty', () => {
      expect(matchesPersonSearch({ name: 'Jamie' }, '')).toBe(true);
      expect(matchesPersonSearch({ name: 'Jamie' }, '   ')).toBe(true);
    });

    it('matches case-insensitively as a substring', () => {
      expect(matchesPersonSearch({ name: 'Jamie Rivera' }, 'rive')).toBe(true);
      expect(matchesPersonSearch({ name: 'Jamie Rivera' }, 'RIVERA')).toBe(true);
      expect(matchesPersonSearch({ name: 'Jamie Rivera' }, 'zzz')).toBe(false);
    });
  });

  describe('filterPeopleByName', () => {
    it('keeps only the people whose name matches', () => {
      const people = [{ name: 'Jamie' }, { name: 'Alex' }, { name: 'Jamal' }];
      expect(filterPeopleByName(people, 'ja')).toEqual([{ name: 'Jamie' }, { name: 'Jamal' }]);
    });
  });

  describe('sortPeopleForManage', () => {
    it('sorts named people alphabetically and pushes unnamed people to the end', () => {
      const people = [{ name: 'Zoe' }, { name: '' }, { name: 'Amir' }, { name: '  ' }];
      expect(sortPeopleForManage(people)).toEqual([{ name: 'Amir' }, { name: 'Zoe' }, { name: '' }, { name: '  ' }]);
    });

    it('does not mutate the input array', () => {
      const people = [{ name: 'Zoe' }, { name: 'Amir' }];
      const copy = [...people];
      sortPeopleForManage(people);
      expect(people).toEqual(copy);
    });
  });
});
