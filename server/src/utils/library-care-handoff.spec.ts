import { noteHandedToCare, takeHandedToCare } from 'src/utils/library-care-handoff.js';

describe('the Library care hand-off note (FL-1337)', () => {
  const id = '6f1c2d3e-4b5a-4c6d-8e7f-90a1b2c3d4e5';

  it('is taken once', () => {
    noteHandedToCare(id);
    expect(takeHandedToCare(id)).toBe(true);
    expect(takeHandedToCare(id)).toBe(false);
  });

  it('is taken whatever the case of the id the job was queued with', () => {
    // the media service notes the id the database returns; the job may have been queued in upper case
    noteHandedToCare(id);
    expect(takeHandedToCare(id.toUpperCase())).toBe(true);
    expect(takeHandedToCare(id)).toBe(false);

    noteHandedToCare(id.toUpperCase());
    expect(takeHandedToCare(id)).toBe(true);
  });
});
