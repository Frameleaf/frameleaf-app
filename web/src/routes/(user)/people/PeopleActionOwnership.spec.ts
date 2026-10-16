import { PersonMergeVerdict } from '@frameleaf/sdk';
import { render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { toastAction, toastUndo } from '$lib/frameleaf/toast';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { handleError } from '$lib/utils/handle-error';
import { deferredPromise } from '@test-data/deferred';
import { peopleListItemFactory } from '@test-data/factories/person-factory';
import PeoplePage from './+page.svelte';

const actions = vi.hoisted(() => ({
  rename: undefined as ((name: string) => Promise<void>) | undefined,
  banner: undefined as { onAccept: () => Promise<void>; onReject: () => Promise<void> } | undefined,
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/people') } }));
vi.mock(
  '$lib/components/layouts/UserPageLayout.svelte',
  async () => import('@test-data/mocks/UserPageLayout.mock.svelte'),
);
vi.mock('$lib/components/frameleaf/people/PersonCard.svelte', () => ({
  default: (_anchor: unknown, props: { onCommitRename: (name: string) => Promise<void> }) => {
    actions.rename = props.onCommitRename;
  },
}));
vi.mock('$lib/components/frameleaf/people/MergeSuggestionBanner.svelte', () => ({
  default: (_anchor: unknown, props: NonNullable<typeof actions.banner>) => {
    actions.banner = props;
  },
}));
vi.mock('$lib/frameleaf/toast', () => ({ toastUndo: vi.fn(), toastAction: vi.fn() }));
vi.mock('$lib/utils/handle-error', async (original) => ({ ...(await original<object>()), handleError: vi.fn() }));
const person = peopleListItemFactory.build({ id: 'person', name: 'Ada', isHidden: false });
const other = peopleListItemFactory.build({ id: 'other', name: 'Eve', isHidden: false });
const verdict = {
  personId: person.id,
  suggestionId: other.id,
  verdict: PersonMergeVerdict.Same,
  createdAt: new Date().toISOString(),
};
const data = {
  error: undefined,
  meta: { title: 'People' },
  asset: undefined,
  people: { people: [person], total: 1, hidden: 0, hasNextPage: false },
};
beforeEach(() => {
  vi.resetAllMocks();
  authManager.reset();
  vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
  actions.rename = undefined;
  actions.banner = undefined;
  sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
  sdkMock.getMergeSuggestions.mockResolvedValue({
    suggestions: [{ person, suggestion: other, distance: 0.2, personEvidence: null, suggestionEvidence: null }],
  });
  sdkMock.getAllPeople.mockResolvedValue(data.people);
  sdkMock.searchPerson.mockResolvedValue([]);
});

it.each(['accept', 'reject'] as const)('ignores a late merge %s response in another session', async (kind) => {
  const pending = deferredPromise<typeof verdict>();
  sdkMock.setMergeVerdict.mockReturnValue(pending.promise);
  const emit = vi.spyOn(eventManager, 'emit');
  render(PeoplePage, { data });
  await waitFor(() => expect(actions.banner).toBeDefined());
  const done = kind === 'accept' ? actions.banner!.onAccept() : actions.banner!.onReject();
  authManager.reset();
  pending.resolve(verdict);
  await done;
  expect(emit).not.toHaveBeenCalledWith('PersonFacesChange', expect.anything());
  expect(toastUndo).not.toHaveBeenCalled();
  expect(toastAction).not.toHaveBeenCalled();
  expect(sdkMock.getAllPeople).not.toHaveBeenCalled();
  emit.mockRestore();
});

it.each(['session', 'navigation'] as const)('does not start a rename follow-up read after %s', async (change) => {
  const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.updatePerson>>>();
  sdkMock.updatePerson.mockReturnValue(pending.promise);
  const view = render(PeoplePage, { data });
  const done = actions.rename!('New name');
  if (change === 'session') {
    authManager.reset();
  } else {
    view.unmount();
  }
  pending.resolve({ ...person, name: 'New name' } as Awaited<ReturnType<typeof sdkMock.updatePerson>>);
  await done;
  expect(sdkMock.searchPerson).not.toHaveBeenCalled();
  expect(toastUndo).toHaveBeenCalledTimes(change === 'navigation' ? 1 : 0);
});

it('keeps same-account rename Undo usable after ordinary navigation', async () => {
  sdkMock.updatePerson.mockResolvedValue({ ...person, name: 'New name' } as Awaited<
    ReturnType<typeof sdkMock.updatePerson>
  >);
  const view = render(PeoplePage, { data });
  await actions.rename!('New name');
  const undo = vi.mocked(toastUndo).mock.calls[0][1];
  view.unmount();
  undo();
  await waitFor(() =>
    expect(sdkMock.updatePerson).toHaveBeenLastCalledWith({ id: person.id, personUpdateDto: { name: 'Ada' } }),
  );
  expect(sdkMock.searchPerson).toHaveBeenCalledOnce();
});

it('does not report an old mutation failure in a replacement session', async () => {
  const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.updatePerson>>>();
  sdkMock.updatePerson.mockReturnValue(pending.promise);
  render(PeoplePage, { data });
  const done = actions.rename!('New name');
  authManager.reset();
  pending.reject(new Error('Offline'));
  await done;
  expect(handleError).not.toHaveBeenCalled();
});

it('ignores late suggestion reads after the session changes', async () => {
  const pending = deferredPromise<Awaited<ReturnType<typeof sdkMock.getMergeSuggestions>>>();
  sdkMock.getMergeSuggestions.mockReturnValue(pending.promise);
  render(PeoplePage, { data });
  authManager.reset();
  pending.resolve({
    suggestions: [{ person, suggestion: other, distance: 0.2, personEvidence: null, suggestionEvidence: null }],
  });
  await pending.promise;
  await tick();
  expect(actions.banner).toBeUndefined();
});
