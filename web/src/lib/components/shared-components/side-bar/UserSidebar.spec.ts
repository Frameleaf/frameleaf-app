import { get } from 'svelte/store';

describe('album sidebar preferences', () => {
  beforeEach(() => {
    // persisted(...) reads localStorage when the module is first evaluated, so
    // reset the module registry and storage to assert the true defaults.
    vi.resetModules();
    localStorage.clear();
  });

  it('starts the nested Albums tree collapsed', async () => {
    const { albumTreeDropdown } = await import('$lib/stores/preferences.store');

    expect(get(albumTreeDropdown)).toBe(false);
  });
});
