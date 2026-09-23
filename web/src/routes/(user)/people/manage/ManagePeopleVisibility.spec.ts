import { render } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { personFactory } from '@test-data/factories/person-factory';
import ManagePeoplePage from './+page.svelte';
import ManagePeoplePageTestWrapper from './ManagePeopleVisibility.test-wrapper.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

const getData = (
  people: ReturnType<typeof personFactory.build>[],
  hasNextPage = false,
): ComponentProps<typeof ManagePeoplePage>['data'] => ({
  error: undefined,
  meta: { title: 'Manage people visibility' },
  asset: undefined,
  people: {
    people,
    total: people.length,
    hidden: people.filter((person) => person.isHidden).length,
    hasNextPage,
  },
});

// Cards follow the prototype's `pm-card` (ManagePeople.jsx): `aria-pressed` means the person is
// shown, so a hidden person's card is not pressed. People are sorted by name, so the fixtures are
// named in the order the assertions read them.
describe('People manage page', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  });

  it('keeps toggled hidden state when loading more people', async () => {
    const [personA, personB, personC] = [
      personFactory.build({ id: 'a', name: 'Alice', isHidden: false }),
      personFactory.build({ id: 'b', name: 'Bruno', isHidden: false }),
      personFactory.build({ id: 'c', name: 'Carmen', isHidden: true }),
    ];

    const { container, rerender } = render(ManagePeoplePageTestWrapper, { data: getData([personA, personB], true) });
    const user = userEvent.setup();

    let personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(2);

    expect(personButtons[0].getAttribute('aria-pressed')).toBe('true');
    await user.click(personButtons[0]);
    expect(personButtons[0].getAttribute('aria-pressed')).toBe('false');

    await rerender({ data: getData([personA, personB, personC], false) });

    personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(3);
    expect(personButtons[0].getAttribute('aria-pressed')).toBe('false');
    expect(personButtons[1].getAttribute('aria-pressed')).toBe('true');
    expect(personButtons[2].getAttribute('aria-pressed')).toBe('false');
  });

  it('shows newly loaded hidden people as hidden', async () => {
    const [personA, personB, personC] = [
      personFactory.build({ id: 'a', name: 'Alice', isHidden: false }),
      personFactory.build({ id: 'b', name: 'Bruno', isHidden: false }),
      personFactory.build({ id: 'c', name: 'Carmen', isHidden: true }),
    ];

    const { container, rerender } = render(ManagePeoplePageTestWrapper, { data: getData([personA, personB], true) });

    await rerender({ data: getData([personA, personB, personC], false) });

    const personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(3);
    expect(personButtons[2].getAttribute('aria-pressed')).toBe('false');
  });
});
