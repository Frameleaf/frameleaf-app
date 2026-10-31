import { railMoreStep, railSectionsBelow } from '$lib/frameleaf/rail-more';

describe('railSectionsBelow (FL-707 B2)', () => {
  const headings = [
    { top: 0, label: 'Explore' },
    { top: 400, label: 'Albums' },
    { top: 700, label: 'Shared spaces' },
    { top: 900, label: 'Tools' },
  ];

  it('names the sections whose headings are out of sight', () => {
    expect(railSectionsBelow({ scrollTop: 0, clientHeight: 600, scrollHeight: 1100 }, headings)).toEqual([
      'Shared spaces',
      'Tools',
    ]);
  });

  it('counts a heading just past the edge as hidden', () => {
    expect(railSectionsBelow({ scrollTop: 0, clientHeight: 705, scrollHeight: 1100 }, headings)).toEqual([
      'Shared spaces',
      'Tools',
    ]);
  });

  it('still says there is more when only rows are hidden', () => {
    expect(railSectionsBelow({ scrollTop: 400, clientHeight: 600, scrollHeight: 1100 }, headings)).toEqual(['']);
  });

  it('goes away at the end of the list, and when nothing scrolls', () => {
    expect(railSectionsBelow({ scrollTop: 500, clientHeight: 600, scrollHeight: 1100 }, headings)).toEqual([]);
    expect(railSectionsBelow({ scrollTop: 497, clientHeight: 600, scrollHeight: 1100 }, headings)).toEqual([]);
    expect(railSectionsBelow({ scrollTop: 0, clientHeight: 900, scrollHeight: 900 }, headings)).toEqual([]);
  });

  it('scrolls most of a screen per press', () => {
    expect(railMoreStep(500)).toBe(400);
  });
});
