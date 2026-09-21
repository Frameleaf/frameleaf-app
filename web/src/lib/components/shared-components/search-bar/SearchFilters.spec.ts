import { getAllPeople, type PersonResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import PeopleFiltersHarness from '$lib/../test-data/frameleaf/PeopleFiltersHarness.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { searchManager } from '$lib/managers/search-manager.svelte';

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    authenticated: true,
    user: { id: 'owner-a' },
    preferences: { tags: { enabled: false }, ratings: { enabled: false } },
  },
}));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<object>()),
  getAllPeople: vi.fn(),
  getSearchSuggestions: vi.fn().mockResolvedValue([]),
  getAllTags: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: {} } }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

const person = {
  id: 'person-a',
  name: 'Private face',
  updatedAt: '2026-09-21',
  thumbnailPath: 'face.jpg',
} as PersonResponseDto;
const response = (people = [person], hasNextPage = false) => ({ people, total: people.length, hidden: 0, hasNextPage });
const setup = () => render(PeopleFiltersHarness);

beforeEach(() => {
  vi.stubGlobal('visualViewport', null);
  vi.mocked(getAllPeople).mockReset().mockResolvedValue(response());
  authManager.user.id = 'owner-a';
  searchManager.reset();
  searchManager.filter.personIds.add(person.id);
});

it('renders a real selected face chip and removes the production query filter', async () => {
  setup();
  const remove = await screen.findByRole('button', { name: 'remove_person: Private face' });
  expect(document.querySelector(`img[src*="${CSS.escape(person.id)}"]`)).not.toBeNull();
  expect(remove.closest('[role="listbox"]')).toBeNull();
  expect(screen.getByRole('listbox', { name: 'recent_searches' })).toHaveAttribute('id', 'filters');
  remove.focus();
  const focusOut = vi.fn();
  remove.addEventListener('focusout', focusOut);
  await fireEvent.click(remove);
  expect(searchManager.toQuery().personIds).toBeUndefined();
  expect(screen.queryByRole('button', { name: 'remove_person: Private face' })).toBeNull();
  expect(document.activeElement?.id).toBe('filters-people');
  expect(focusOut).toHaveBeenCalledOnce();
  expect(focusOut.mock.calls[0][0].relatedTarget).toBe(document.querySelector('#filters-people'));
});

it('discards a response begun before session lock, including names, counts and selected IDs', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(getAllPeople).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  setup();
  await waitFor(() => expect(getAllPeople).toHaveBeenCalledOnce());
  flushSync(() => eventManager.emit('SessionLocked'));
  finish(response());
  await tick();
  expect(searchManager.filter.personIds.size).toBe(0);
  expect(document.body.textContent).not.toContain('Private face');
  expect(document.querySelector(`img[src*="${CSS.escape(person.id)}"]`)).toBeNull();
});

it('clears loaded evidence on logout', async () => {
  const view = setup();
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  flushSync(() => eventManager.emit('AuthLogout'));
  await tick();
  expect(document.body.textContent).not.toContain('Private face');
  expect(searchManager.filter.personIds.size).toBe(0);
  view.unmount();
});

it('offers retry after a failed people request without silently clearing a valid query', async () => {
  vi.mocked(getAllPeople).mockRejectedValueOnce(new Error('offline'));
  setup();
  await fireEvent.click(await screen.findByRole('button', { name: 'retry' }));
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  expect(searchManager.filter.personIds.has(person.id)).toBe(true);
});

it('loads beyond the first page and preserves selected-first ordering', async () => {
  vi.mocked(getAllPeople)
    .mockResolvedValueOnce(response([{ ...person, id: 'other', name: 'Other' }], true))
    .mockResolvedValueOnce(response());
  setup();
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  expect(getAllPeople).toHaveBeenNthCalledWith(
    2,
    { withHidden: false, page: 2 },
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('ignores in-flight results from a previous account', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(getAllPeople).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  setup();
  await waitFor(() => expect(getAllPeople).toHaveBeenCalledOnce());
  authManager.user.id = 'owner-b';
  flushSync(() => eventManager.emit('AuthUserLoaded', authManager.user));
  finish(response());
  await tick();
  expect(document.body.textContent).not.toContain('Private face');
  expect(searchManager.filter.personIds.size).toBe(0);
});

it('clears an unavailable thumbnail together with its chip and selected filter', async () => {
  setup();
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  await fireEvent.error(document.querySelector('img')!);
  expect(screen.queryByRole('button', { name: 'remove_person: Private face' })).toBeNull();
  expect(searchManager.filter.personIds.size).toBe(0);
  expect(screen.getByRole('button', { name: 'retry' })).toBeVisible();
});

it('guards the full search modal and exposes selected state to assistive technology', async () => {
  render(PeopleFiltersHarness, { modal: true });
  const selected = await screen.findByRole('button', { name: 'Private face' });
  expect(selected).toHaveAttribute('aria-pressed', 'true');
  vi.mocked(getAllPeople).mockResolvedValue(response([]));
  flushSync(() => eventManager.emit('SessionAccessChanged', { isElevated: false }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Private face' })).toBeNull());
  expect(searchManager.filter.personIds.size).toBe(0);
});

it('does not disclose stale selected IDs missing from the complete authorized list', async () => {
  vi.mocked(getAllPeople).mockResolvedValue(response([]));
  setup();
  await waitFor(() => expect(searchManager.filter.personIds.size).toBe(0));
  expect(document.body.textContent).not.toContain('people_count');
});

it('aborts a pending people request when its consumer unmounts', async () => {
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(getAllPeople).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const view = setup();
  await waitFor(() => expect(getAllPeople).toHaveBeenCalledOnce());
  const signal = vi.mocked(getAllPeople).mock.calls[0][1]?.signal;
  view.unmount();
  expect(signal?.aborted).toBe(true);
  finish(response());
  await tick();
  expect(document.body.textContent).not.toContain('Private face');
});

it('preserves the People query during an unrelated background thumbnail refresh', async () => {
  setup();
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  let finish!: (value: ReturnType<typeof response>) => void;
  vi.mocked(getAllPeople).mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  flushSync(() => eventManager.emit('PersonThumbnailReady', { id: 'unrelated-person-b' }));
  expect(searchManager.toQuery().personIds).toEqual([person.id]);
  expect(document.body.textContent).not.toContain('Private face');
  await waitFor(() => expect(getAllPeople).toHaveBeenCalledTimes(2));
  finish(response());
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  expect(searchManager.toQuery().personIds).toEqual([person.id]);
});

it('prunes a selected person only after routine refresh proves it inaccessible', async () => {
  setup();
  await screen.findByRole('button', { name: 'remove_person: Private face' });
  vi.mocked(getAllPeople).mockResolvedValueOnce(response([]));
  flushSync(() => eventManager.emit('PersonUpdate', { ...person, isHidden: true }));
  expect(searchManager.toQuery().personIds).toEqual([person.id]);
  await waitFor(() => expect(searchManager.filter.personIds.size).toBe(0));
  expect(document.body.textContent).not.toContain('Private face');
});
