import { nameMatchesFind } from '$lib/frameleaf/discovery-find';

describe('Find by name', () => {
  it('matches anywhere in the name, ignoring case and surrounding spaces', () => {
    expect(nameMatchesFind('Rockies 2026', ' rock ')).toBe(true);
    expect(nameMatchesFind('Coast', 'rock')).toBe(false);
  });

  it('never matches an empty search', () => {
    expect(nameMatchesFind('Trips', '  ')).toBe(false);
  });
});
