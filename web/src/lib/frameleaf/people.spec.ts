import { describe, expect, it } from 'vitest';
import {
  ageInYears,
  filterPeopleByName,
  isUnnamedPerson,
  matchesPersonSearch,
  normalizedFaceBox,
  sortMergeCandidates,
  sortPeopleForGrid,
  sortPeopleForManage,
} from './people';

describe('frameleaf people helpers', () => {
  describe('isUnnamedPerson', () => {
    it('treats an empty or whitespace-only name as unnamed', () => {
      expect(isUnnamedPerson({ name: '' })).toBe(true);
      expect(isUnnamedPerson({ name: ' '.repeat(3) })).toBe(true);
    });

    it('treats a real name as named', () => {
      expect(isUnnamedPerson({ name: 'Jamie' })).toBe(false);
    });
  });

  describe('matchesPersonSearch', () => {
    it('matches everyone when the query is empty', () => {
      expect(matchesPersonSearch({ name: 'Jamie' }, '')).toBe(true);
      expect(matchesPersonSearch({ name: 'Jamie' }, ' '.repeat(3))).toBe(true);
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

describe('frameleaf people grid helpers', () => {
  const alice = { id: 'a', name: 'Alice', assetCount: 2, lastSeenAt: '2024-01-01T00:00:00.000Z' };
  const bob = { id: 'b', name: 'Bob', assetCount: 9, lastSeenAt: '2023-01-01T00:00:00.000Z' };
  const unnamed = { id: 'u', name: '', assetCount: 9, lastSeenAt: '2025-01-01T00:00:00.000Z' };

  it('sorts by name with unnamed people last', () => {
    expect(sortPeopleForGrid([unnamed, bob, alice], 'name').map(({ id }) => id)).toEqual(['a', 'b', 'u']);
  });

  it('sorts by photo count, breaking ties by name', () => {
    expect(sortPeopleForGrid([alice, unnamed, bob], 'count').map(({ id }) => id)).toEqual(['b', 'u', 'a']);
  });

  it('sorts by the most recent capture', () => {
    expect(sortPeopleForGrid([bob, alice, unnamed], 'recent').map(({ id }) => id)).toEqual(['u', 'a', 'b']);
  });

  it('lists merge candidates without the person, named first, then by count', () => {
    expect(sortMergeCandidates([alice, unnamed, bob], 'a', '').map(({ id }) => id)).toEqual(['b', 'u']);
    expect(sortMergeCandidates([alice, unnamed, bob], 'u', 'ali').map(({ id }) => id)).toEqual(['a']);
  });

  it('computes an age in whole years', () => {
    const now = new Date(2026, 8, 24);
    expect(ageInYears('2000-09-24', now)).toBe(26);
    expect(ageInYears('2000-09-25', now)).toBe(25);
    expect(ageInYears('2027-01-01', now)).toBeNull();
    expect(ageInYears(null, now)).toBeNull();
  });
});

describe('normalizedFaceBox', () => {
  it('turns pixel bounds into fractions of the image', () => {
    expect(
      normalizedFaceBox({
        boundingBoxX1: 100,
        boundingBoxY1: 50,
        boundingBoxX2: 300,
        boundingBoxY2: 150,
        imageWidth: 1000,
        imageHeight: 500,
      }),
    ).toEqual({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 });
  });

  it('rejects an empty box or image', () => {
    const base = { boundingBoxX1: 0, boundingBoxY1: 0, boundingBoxX2: 10, boundingBoxY2: 10 };
    expect(normalizedFaceBox({ ...base, imageWidth: 0, imageHeight: 10 })).toBeNull();
    expect(normalizedFaceBox({ ...base, boundingBoxX2: 0, imageWidth: 10, imageHeight: 10 })).toBeNull();
  });
});
