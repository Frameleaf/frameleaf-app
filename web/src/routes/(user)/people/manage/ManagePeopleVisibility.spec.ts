import { render, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { goto } from '$app/navigation';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { peopleListItemFactory } from '@test-data/factories/person-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import ManagePeoplePage from './+page.svelte';
import ManagePeoplePageTestWrapper from './ManagePeopleVisibility.test-wrapper.svelte';

vi.mock('$app/navigation', async () => ({
  ...(await vi.importActual<typeof import('$app/navigation')>('$app/navigation')),
  goto: vi.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), function () {
  return {
    featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: {} } as never,
  };
});

vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

const getData = (
  people: ReturnType<typeof peopleListItemFactory.build>[],
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
      peopleListItemFactory.build({ id: 'a', name: 'Alice', isHidden: false }),
      peopleListItemFactory.build({ id: 'b', name: 'Bruno', isHidden: false }),
      peopleListItemFactory.build({ id: 'c', name: 'Carmen', isHidden: true }),
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
      peopleListItemFactory.build({ id: 'a', name: 'Alice', isHidden: false }),
      peopleListItemFactory.build({ id: 'b', name: 'Bruno', isHidden: false }),
      peopleListItemFactory.build({ id: 'c', name: 'Carmen', isHidden: true }),
    ];

    const { container, rerender } = render(ManagePeoplePageTestWrapper, { data: getData([personA, personB], true) });

    await rerender({ data: getData([personA, personB, personC], false) });

    const personButtons = container.querySelectorAll('button[aria-pressed]');
    expect(personButtons).toHaveLength(3);
    expect(personButtons[2].getAttribute('aria-pressed')).toBe('false');
  });
});

describe('People visibility recovery', () => {
  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.mocked(goto).mockClear();
    sdkMock.updatePeople.mockReset();
  });

  it('keeps a draft until the prototype discard dialog is confirmed', async () => {
    const person = peopleListItemFactory.build({ isHidden: false });
    const view = render(ManagePeoplePageTestWrapper, { data: getData([person]) });
    const user = userEvent.setup();
    await user.click(view.container.querySelector('button[aria-pressed]')!);
    await user.click(view.getByRole('button', { name: 'cancel' }));
    expect(view.getByRole('dialog')).toBeInTheDocument();
    expect(goto).not.toHaveBeenCalled();
    await user.click(view.getByRole('button', { name: 'frameleaf_settings_draft_keep_editing' }));
    expect(view.container.querySelector('button[aria-pressed]')).toHaveAttribute('aria-pressed', 'false');
    await user.click(view.getByRole('button', { name: 'cancel' }));
    await user.click(view.getByRole('button', { name: 'frameleaf_settings_draft_discard' }));
    expect(goto).toHaveBeenCalledWith('/people');
    expect(sdkMock.updatePeople).not.toHaveBeenCalled();
    expect(person.isHidden).toBe(false);
  });

  it('retains failed unnamed-person changes and retries only unconfirmed IDs', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const b = peopleListItemFactory.build({ id: 'b', name: '', isHidden: false });
    sdkMock.updatePeople.mockResolvedValueOnce([
      { id: a.id, success: true },
      { id: b.id, success: false },
    ]);
    sdkMock.updatePeople.mockResolvedValueOnce([{ id: b.id, success: true }]);
    const view = render(ManagePeoplePageTestWrapper, { data: getData([a, b]) });
    const user = userEvent.setup();
    const cards = view.container.querySelectorAll('button[aria-pressed]');
    await user.click(cards[0]);
    await user.click(cards[1]);
    await user.click(view.getByRole('button', { name: 'frameleaf_people_save_changes_count' }));
    await waitFor(() => expect(sdkMock.updatePeople).toHaveBeenCalledOnce());
    expect(goto).not.toHaveBeenCalled();
    expect(a.isHidden).toBe(true);
    expect(b.isHidden).toBe(false);
    expect(view.getByRole('alert')).toBeInTheDocument();
    await user.click(view.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(sdkMock.updatePeople).toHaveBeenCalledTimes(2));
    expect(sdkMock.updatePeople.mock.calls[1][0]).toEqual({
      peopleUpdateDto: { people: [{ id: b.id, isHidden: true }] },
    });
    await waitFor(() => expect(goto).toHaveBeenCalledWith('/people'));
  });

  it.each(['restricted', 'account', 'logout', 'dispose'])(
    'does not republish or navigate after %s while a bulk save is pending',
    async (boundary) => {
      const person = peopleListItemFactory.build({ isHidden: false });
      let complete!: (result: { id: string; success: boolean }[]) => void;
      sdkMock.updatePeople.mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
      const view = render(ManagePeoplePageTestWrapper, { data: getData([person]) });
      const user = userEvent.setup();
      await user.click(view.container.querySelector('button[aria-pressed]')!);
      await user.click(view.getByRole('button', { name: 'frameleaf_people_save_changes_count' }));
      switch (boundary) {
        case 'dispose': {
          view.unmount();

          break;
        }
        case 'restricted': {
          eventManager.emit('SessionAccessChanged', { isElevated: false });

          break;
        }
        case 'logout': {
          eventManager.emit('AuthLogout');

          break;
        }
        default: {
          eventManager.emit('AuthUserLoaded', userAdminFactory.build({ id: 'other-account' }));
        }
      }
      complete([{ id: person.id, success: true }]);
      await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(0));
      expect(person.isHidden).toBe(false);
      expect(goto).not.toHaveBeenCalled();
      expect(sdkMock.updatePeople.mock.calls[0][1]?.signal?.aborted).toBe(true);
    },
  );
});

it.each(['restricted', 'account', 'logout', 'dispose'])(
  'retires a pending page after %s and rejects duplicate observer loads',
  async (boundary) => {
    const a = peopleListItemFactory.build({ id: 'a' });
    const b = peopleListItemFactory.build({ id: 'b' });
    let observerCallback!: IntersectionObserverCallback;
    let sentinel!: Element;
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(callback: IntersectionObserverCallback) {
          observerCallback = callback;
        }
        observe(target: Element) {
          sentinel = target;
        }
        disconnect = disconnect;
      },
    );
    let complete!: (result: ComponentProps<typeof ManagePeoplePage>['data']['people']) => void;
    sdkMock.getAllPeople.mockReset().mockReturnValueOnce(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    const view = render(ManagePeoplePageTestWrapper, { data: getData([a], true) });
    const intersect = () =>
      observerCallback(
        [{ target: sentinel, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      );
    intersect();
    intersect();
    expect(sdkMock.getAllPeople).toHaveBeenCalledTimes(1);
    switch (boundary) {
      case 'dispose': {
        view.unmount();
        break;
      }
      case 'restricted': {
        eventManager.emit('SessionAccessChanged', { isElevated: false });
        break;
      }
      case 'logout': {
        eventManager.emit('AuthLogout');
        break;
      }
      default: {
        eventManager.emit('AuthUserLoaded', userAdminFactory.build({ id: 'other-account' }));
      }
    }
    complete(getData([b]).people);
    await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(0));
    expect(sdkMock.getAllPeople.mock.calls[0][1]?.signal?.aborted).toBe(true);
    expect(disconnect).toHaveBeenCalled();
  },
);

it('keeps pending controls immutable and preserves harmless unlock drafts', async () => {
  vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  const person = peopleListItemFactory.build({ isHidden: false });
  let complete!: (result: { id: string; success: boolean }[]) => void;
  sdkMock.updatePeople.mockReset().mockReturnValueOnce(
    new Promise((resolve) => {
      complete = resolve;
    }),
  );
  const view = render(ManagePeoplePageTestWrapper, { data: getData([person]) });
  const user = userEvent.setup();
  const card = view.container.querySelector('button[aria-pressed]')!;
  await user.click(card);
  eventManager.emit('SessionAccessChanged', { isElevated: true });
  expect(card).toHaveAttribute('aria-pressed', 'false');
  await user.click(view.getByRole('button', { name: 'frameleaf_people_save_changes_count' }));
  expect(card).toBeDisabled();
  expect(view.getByRole('button', { name: 'reset_people_visibility' })).toBeDisabled();
  complete([]);
  await waitFor(() => expect(card).not.toBeDisabled());
  expect(view.getByRole('alert')).toBeInTheDocument();
  expect(person.isHidden).toBe(false);
});

it('retries a failed page without dropping earlier visibility drafts or duplicating loaded people', async () => {
  const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
  const b = peopleListItemFactory.build({ id: 'b', name: '', isHidden: true });
  let observerCallback!: IntersectionObserverCallback;
  let sentinel!: Element;
  vi.stubGlobal(
    'IntersectionObserver',
    class {
      constructor(callback: IntersectionObserverCallback) {
        observerCallback = callback;
      }
      observe(target: Element) {
        sentinel = target;
      }
      disconnect() {}
    },
  );
  sdkMock.getAllPeople
    .mockReset()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(getData([a, b]).people);
  const view = render(ManagePeoplePageTestWrapper, { data: getData([a], true) });
  const user = userEvent.setup();
  await user.click(view.container.querySelector('button[aria-pressed]')!);
  observerCallback(
    [{ target: sentinel, isIntersecting: true } as IntersectionObserverEntry],
    {} as IntersectionObserver,
  );
  await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
  await user.click(view.getByRole('button', { name: 'retry' }));
  await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(2));
  const cards = view.container.querySelectorAll('button[aria-pressed]');
  expect(cards[0]).toHaveAttribute('aria-pressed', 'false');
  expect(cards[1]).toHaveAttribute('aria-pressed', 'false');
  expect(a.isHidden).toBe(false);
  expect(sdkMock.getAllPeople.mock.calls.map(([request]) => request?.page)).toEqual([2, 2]);
});

// FL-37: ManagePeople.jsx:56-84 applies Hide all / Hide unnamed / Show all to everyone, not only the
// people loaded so far; the page reads the remaining pages first and keeps every existing draft.
describe('visibility shortcuts cover everyone', () => {
  const pageOf = (people: ReturnType<typeof peopleListItemFactory.build>[], hasNextPage = false) => ({
    people,
    total: 3,
    hidden: 1,
    hasNextPage,
  });

  beforeEach(() => {
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    vi.mocked(goto).mockClear();
    sdkMock.getAllPeople.mockReset();
    sdkMock.updatePeople.mockReset();
  });

  it('Hide all reads the remaining pages, then hides every person', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const b = peopleListItemFactory.build({ id: 'b', name: 'Bruno', isHidden: false });
    const c = peopleListItemFactory.build({ id: 'c', name: '', isHidden: true });
    sdkMock.getAllPeople.mockResolvedValueOnce(pageOf([b], true)).mockResolvedValueOnce(pageOf([c]));
    sdkMock.updatePeople.mockResolvedValueOnce([
      { id: 'a', success: true },
      { id: 'b', success: true },
    ]);
    const view = render(ManagePeoplePageTestWrapper, { data: { ...getData([a], true), people: pageOf([a], true) } });
    const user = userEvent.setup();

    await user.click(view.getByRole('button', { name: 'frameleaf_people_hide_all' }));

    await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(3));
    expect(sdkMock.getAllPeople.mock.calls.map(([request]) => request?.page)).toEqual([2, 3]);
    for (const card of view.container.querySelectorAll('button[aria-pressed]')) {
      expect(card).toHaveAttribute('aria-pressed', 'false');
    }
    expect(view.container.querySelector('.pm-pending')?.textContent).toBe('frameleaf_people_hidden_draft');
    await user.click(view.getByRole('button', { name: 'frameleaf_people_save_changes_count' }));
    await waitFor(() => expect(sdkMock.updatePeople).toHaveBeenCalledOnce());
    // the person already hidden on a later page is not sent again
    expect(sdkMock.updatePeople.mock.calls[0][0]).toEqual({
      peopleUpdateDto: {
        people: [
          { id: 'a', isHidden: true },
          { id: 'b', isHidden: true },
        ],
      },
    });
  });

  it('Hide unnamed reaches unnamed people on later pages and keeps earlier drafts', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const b = peopleListItemFactory.build({ id: 'b', name: '', isHidden: false });
    sdkMock.getAllPeople.mockResolvedValueOnce(pageOf([b]));
    const view = render(ManagePeoplePageTestWrapper, { data: { ...getData([a], true), people: pageOf([a], true) } });
    const user = userEvent.setup();
    await user.click(view.container.querySelector('button[aria-pressed]')!);

    await user.click(view.getByRole('button', { name: 'frameleaf_people_hide_unnamed' }));

    await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(2));
    const cards = view.container.querySelectorAll('button[aria-pressed]');
    expect(cards[0]).toHaveAttribute('aria-pressed', 'false');
    expect(cards[1]).toHaveAttribute('aria-pressed', 'false');
    expect(view.getByRole('button', { name: 'frameleaf_people_save_changes_count' })).not.toBeDisabled();
  });

  it('drafts nothing when a remaining page cannot be read, and Retry picks the load up again', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const b = peopleListItemFactory.build({ id: 'b', name: 'Bruno', isHidden: false });
    sdkMock.getAllPeople.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(pageOf([b]));
    const view = render(ManagePeoplePageTestWrapper, { data: { ...getData([a], true), people: pageOf([a], true) } });
    const user = userEvent.setup();

    await user.click(view.getByRole('button', { name: 'frameleaf_people_hide_all' }));

    await waitFor(() => expect(view.getByRole('alert')).toBeInTheDocument());
    expect(view.container.querySelector('button[aria-pressed]')).toHaveAttribute('aria-pressed', 'true');
    expect(view.getByRole('button', { name: 'frameleaf_settings_draft_save' })).toBeDisabled();

    await user.click(view.getByRole('button', { name: 'retry' }));
    await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(2));
    await user.click(view.getByRole('button', { name: 'frameleaf_people_hide_all' }));
    await waitFor(() =>
      expect(
        [...view.container.querySelectorAll('button[aria-pressed]')].map((card) => card.getAttribute('aria-pressed')),
      ).toEqual(['false', 'false']),
    );
  });

  it('searches everyone by reading the remaining pages', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const z = peopleListItemFactory.build({ id: 'z', name: 'Zora', isHidden: false });
    sdkMock.getAllPeople.mockResolvedValueOnce(pageOf([z]));
    const view = render(ManagePeoplePageTestWrapper, { data: { ...getData([a], true), people: pageOf([a], true) } });
    const user = userEvent.setup();

    await user.type(view.getByRole('searchbox'), 'zor');

    await waitFor(() => expect(view.container.querySelectorAll('button[aria-pressed]')).toHaveLength(1));
    expect(view.container.querySelector('button[aria-pressed]')?.textContent).toContain('Zora');
    expect(sdkMock.getAllPeople).toHaveBeenCalledOnce();
  });

  it('says what a single card change will do once saved', async () => {
    const a = peopleListItemFactory.build({ id: 'a', name: 'Alex', isHidden: false });
    const view = render(ManagePeoplePageTestWrapper, { data: getData([a]) });
    const user = userEvent.setup();

    await user.click(view.container.querySelector('button[aria-pressed]')!);

    expect(view.container.querySelector('.pm-pending')?.textContent).toBe('frameleaf_people_will_be_hidden');
  });
});
