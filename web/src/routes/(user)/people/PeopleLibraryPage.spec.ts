import { PersonMergeVerdict, PersonSplitVerdict, QueueName, type DurableQueueRun } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import type { ComponentProps } from 'svelte';
import { vi } from 'vitest';
import { getIntersectionObserverMock } from '$lib/__mocks__/intersection-observer.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { peopleListItemFactory } from '@test-data/factories/person-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import PeoplePage from './+page.svelte';
import { PEOPLE_CAP, PEOPLE_PAGE_SIZE } from './people-page';

// Small page and cap sizes keep the rendered grid cheap; the page reads both from this module.
vi.mock(import('./people-page'), () => ({ PEOPLE_PAGE_SIZE: 2, PEOPLE_CAP: 6, WAITING_REFRESH_MS: 25 }));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/people') } }));
const flags = vi.hoisted(() => ({ facialRecognition: true }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({ featureFlagsManager: { value: flags } }));
vi.mock('$lib/components/layouts/UserPageLayout.svelte', async () => {
  return await import('@test-data/mocks/UserPageLayout.mock.svelte');
});

type Data = ComponentProps<typeof PeoplePage>['data'];
const data = (people: ReturnType<typeof peopleListItemFactory.build>[], hasNextPage: boolean): Data => ({
  error: undefined,
  meta: { title: 'People' },
  asset: undefined,
  people: { people, total: people.length, hidden: 0, hasNextPage },
});
const page = (size: number, prefix: string) =>
  Array.from({ length: size }, (_, index) => peopleListItemFactory.build({ id: `${prefix}${index}`, isHidden: false }));

// FL-37: the People grid reads every page up front for its sorts, in the largest pages the API
// allows, stops at a cap and never keeps reading after the page is gone.
describe('People library page loading', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
  });

  it('reads the remaining pages in the largest page size and stops at the cap', async () => {
    sdkMock.getAllPeople.mockImplementation((options) => {
      return Promise.resolve({
        people: page(PEOPLE_PAGE_SIZE, `p${options?.page ?? 1}-`),
        total: 99_999,
        hidden: 0,
        hasNextPage: true,
      });
    });
    const { container } = render(PeoplePage, { data: data(page(PEOPLE_PAGE_SIZE, 'p1-'), true) });

    await waitFor(() => expect(container.textContent).toContain('frameleaf_people_truncated'), { timeout: 3000 });
    const calls = sdkMock.getAllPeople.mock.calls.map(([options]) => options);
    expect(calls).toEqual([
      { withHidden: true, page: 2, size: PEOPLE_PAGE_SIZE },
      { withHidden: true, page: 3, size: PEOPLE_PAGE_SIZE },
    ]);
    expect(container.querySelectorAll('.pl-card')).toHaveLength(PEOPLE_CAP);
  });

  it('stops reading pages once the page is destroyed', async () => {
    let resolveSecond: (value: never) => void = () => {};
    sdkMock.getAllPeople.mockImplementationOnce(() => new Promise((resolve) => (resolveSecond = resolve)));
    const { unmount } = render(PeoplePage, { data: data(page(3, 'a'), true) });
    unmount();
    resolveSecond({ people: page(3, 'b'), total: 9, hidden: 0, hasNextPage: true } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sdkMock.getAllPeople).toHaveBeenCalledOnce();
  });
});

// DISCOVERY-P1/P3: the title, summary and controls share the page's one-row header, and Show hidden
// is always offered, as in the prototype.
describe('People library header', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
  });

  it('offers Show hidden with nobody hidden, and reveals hidden people when pressed', async () => {
    const shown = peopleListItemFactory.build({ id: 'shown', name: 'Ada', isHidden: false });
    const { container } = render(PeoplePage, { data: data([shown], false) });

    const header = container.querySelector('.pl-header');
    expect(header?.querySelector('h1')?.textContent).toBe('people');
    const toggle = screen.getByRole('button', { name: 'frameleaf_people_show_hidden' });
    expect(header?.contains(toggle)).toBe(true);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');

    await fireEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'frameleaf_people_hide_hidden' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });
});

// FL-57: the banner's answers go to the server as verdicts; "ignore" is about the reviewed person
// alone, so every suggestion naming them leaves the queue.
describe('People library merge suggestions', () => {
  const [ada, eve, bob] = [
    peopleListItemFactory.build({ id: 'ada', name: 'Ada', isHidden: false }),
    peopleListItemFactory.build({ id: 'eve', name: 'Eve', isHidden: false }),
    peopleListItemFactory.build({ id: 'bob', name: 'Bob', isHidden: false }),
  ];
  const suggestion = (person: typeof ada, other: typeof ada) => ({
    person,
    suggestion: other,
    distance: 0.2,
    personEvidence: null,
    suggestionEvidence: null,
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
    sdkMock.getAllPeople.mockResolvedValue({ people: [ada, eve, bob], total: 3, hidden: 0, hasNextPage: false });
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getMergeSuggestions.mockResolvedValue({
      suggestions: [suggestion(ada, eve), suggestion(ada, bob), suggestion(eve, bob)],
    });
  });

  it('stops suggesting the reviewed person with anyone', async () => {
    sdkMock.setMergeVerdict.mockResolvedValue({
      personId: 'ada',
      suggestionId: 'ada',
      verdict: PersonMergeVerdict.Ignore,
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    render(PeoplePage, { data: data([ada, eve, bob], false) });

    // the quiet answers are in the banner's "More answers" menu
    await fireEvent.click(
      await screen.findByRole('button', { name: 'frameleaf_people_merge_suggestion_more_answers' }),
    );
    await fireEvent.click(await screen.findByText('frameleaf_people_merge_suggestion_ignore'));
    await waitFor(() =>
      expect(sdkMock.setMergeVerdict).toHaveBeenCalledWith({
        personMergeVerdictCreateDto: { personId: 'ada', suggestionId: 'ada', verdict: PersonMergeVerdict.Ignore },
      }),
    );
    // only the pair without Ada is left to review
    await waitFor(() => expect(screen.queryByText('frameleaf_people_merge_suggestion_more')).toBeNull());
    expect(screen.getByText('frameleaf_people_merge_suggestion_question')).toBeTruthy();
  });

  it('merges on "Yes, merge" through the same verdict', async () => {
    const emit = vi.spyOn(eventManager, 'emit');
    sdkMock.setMergeVerdict.mockResolvedValue({
      personId: 'ada',
      suggestionId: 'eve',
      verdict: PersonMergeVerdict.Same,
      createdAt: '2026-09-25T00:00:00.000Z',
    });
    render(PeoplePage, { data: data([ada, eve, bob], false) });

    await fireEvent.click(await screen.findByText('frameleaf_people_merge_suggestion_accept'));
    await waitFor(() =>
      expect(sdkMock.setMergeVerdict).toHaveBeenCalledWith({
        personMergeVerdictCreateDto: { personId: 'ada', suggestionId: 'eve', verdict: PersonMergeVerdict.Same },
      }),
    );
    expect(sdkMock.mergePeople).not.toHaveBeenCalled();
    // open viewers, search chips and person pages follow the merge
    await waitFor(() =>
      expect(emit).toHaveBeenCalledWith('PersonFacesChange', { personIds: ['ada', 'eve'], removedPersonIds: ['eve'] }),
    );
  });
});

// FL-1385: "Is this all one person?" waits behind the merge suggestions; "No, split them" moves the
// faces on the server and the toast's Undo merges the new person back.
describe('People library mixed-person question', () => {
  const jamie = peopleListItemFactory.build({ id: 'jamie', name: 'Jamie', isHidden: false });
  const split = {
    person: jamie,
    faceCount: 4,
    totalFaceCount: 12,
    distance: 0.9,
    personEvidence: [],
    otherEvidence: [],
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 0, videos: 0, total: 0 });
    sdkMock.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [split] });
    sdkMock.getAllPeople.mockResolvedValue({ people: [jamie], total: 1, hidden: 0, hasNextPage: false });
  });

  it('splits on "No, split them" and tells everything showing the person', async () => {
    sdkMock.setSplitVerdict.mockResolvedValue({
      personId: 'jamie',
      verdict: PersonSplitVerdict.Split,
      newPersonId: 'someone-new',
      movedFaceCount: 4,
    });
    const changed = vi.fn();
    const off = eventManager.on({ PersonFacesChange: changed });
    render(PeoplePage, { data: data([jamie], false) });

    await fireEvent.click(await screen.findByText('frameleaf_people_split_suggestion_split'));

    await waitFor(() =>
      expect(sdkMock.setSplitVerdict).toHaveBeenCalledWith({
        personSplitVerdictCreateDto: { personId: 'jamie', verdict: PersonSplitVerdict.Split },
      }),
    );
    await waitFor(() => expect(screen.queryByText('frameleaf_people_split_suggestion_question')).toBeNull());
    expect(changed).toHaveBeenCalledWith({ personIds: ['jamie', 'someone-new'], removedPersonIds: [] });
    off();
  });

  it('stores "Yes, all Jamie" and stops asking', async () => {
    sdkMock.setSplitVerdict.mockResolvedValue({
      personId: 'jamie',
      verdict: PersonSplitVerdict.Same,
      newPersonId: null,
      movedFaceCount: 0,
    });
    render(PeoplePage, { data: data([jamie], false) });

    await fireEvent.click(await screen.findByText('frameleaf_people_split_suggestion_same'));

    await waitFor(() =>
      expect(sdkMock.setSplitVerdict).toHaveBeenCalledWith({
        personSplitVerdictCreateDto: { personId: 'jamie', verdict: PersonSplitVerdict.Same },
      }),
    );
    await waitFor(() => expect(screen.queryByText('frameleaf_people_split_suggestion_question')).toBeNull());
    expect(sdkMock.mergePeople).not.toHaveBeenCalled();
  });

  it('reads the suggestions again when an answer fails, so a stale one does not block the rest', async () => {
    sdkMock.setSplitVerdict.mockRejectedValue(new Error('Split suggestion not found'));
    render(PeoplePage, { data: data([jamie], false) });
    const button = await screen.findByText('frameleaf_people_split_suggestion_same');
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [] });

    await fireEvent.click(button);

    await waitFor(() => expect(sdkMock.getSplitSuggestions).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('frameleaf_people_split_suggestion_question')).toBeNull());
  });

  it('waits behind a merge suggestion', async () => {
    const other = peopleListItemFactory.build({ id: 'other', name: 'Jay', isHidden: false });
    sdkMock.getMergeSuggestions.mockResolvedValue({
      suggestions: [
        { person: jamie, suggestion: other, distance: 0.2, personEvidence: null, suggestionEvidence: null },
      ],
    });
    render(PeoplePage, { data: data([jamie, other], false) });

    expect(await screen.findByText('frameleaf_people_merge_suggestion_question')).toBeTruthy();
    expect(screen.queryByText('frameleaf_people_split_suggestion_question')).toBeNull();
  });
});

// FL-1408 (M9): with nobody to show, the page says why instead of "No people yet".
describe('People library with nobody found', () => {
  const nobody = (scanning?: boolean): Data => ({
    ...data([], false),
    people: { people: [], total: 0, hidden: 0, hasNextPage: false, scanning },
  });

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal('IntersectionObserver', getIntersectionObserverMock());
    sdkMock.getSplitSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getMergeSuggestions.mockResolvedValue({ suggestions: [] });
    sdkMock.getAssetStatistics.mockResolvedValue({ images: 12, videos: 0, total: 12 });
    // the waiting page re-reads People; by default it still finds nobody and photos still wait
    sdkMock.getAllPeople.mockResolvedValue({ people: [], total: 0, hidden: 0, hasNextPage: false, scanning: true });
    flags.facialRecognition = true;
    authManager.setUser(userAdminFactory.build({ isAdmin: true }));
  });

  afterEach(() => {
    flags.facialRecognition = true;
  });

  it('says face recognition is turned off, offers the setting, and asks for no merges', async () => {
    flags.facialRecognition = false;
    render(PeoplePage, { data: nobody() });

    expect(screen.getByRole('heading', { name: 'frameleaf_people_faces_off_title' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_people_faces_off_description')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'frameleaf_people_faces_off_action' })).toHaveAttribute(
      'href',
      expect.stringContaining('intelligence'),
    );
    expect(screen.queryByText('frameleaf_people_empty_title')).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sdkMock.getMergeSuggestions).not.toHaveBeenCalled();
    expect(sdkMock.getSplitSuggestions).not.toHaveBeenCalled();
  });

  it('tells someone who cannot change the setting who can, with no button', () => {
    flags.facialRecognition = false;
    authManager.setUser(userAdminFactory.build({ isAdmin: false }));
    render(PeoplePage, { data: nobody() });

    expect(screen.getByText('frameleaf_people_faces_off_description_member')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'frameleaf_people_faces_off_action' })).not.toBeInTheDocument();
  });

  // The wording follows the queue state Activity and Background work show, so they never disagree.
  const faceQueue = (patch: Partial<DurableQueueRun>): DurableQueueRun => ({
    name: QueueName.FaceDetection,
    isPaused: false,
    canPause: true,
    active: 0,
    waiting: 0,
    processed: 0,
    total: 0,
    startedAt: null,
    ...patch,
  });
  const work = (queues: DurableQueueRun[], canManageQueues = true) =>
    sdkMock.getRunningJobs.mockResolvedValue({ operations: [], memoryExports: [], queues, canManageQueues } as never);

  it('says face recognition is working through the library while its queue runs', async () => {
    work([faceQueue({ active: 2, waiting: 40, total: 42 })]);
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_scanning_title' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_people_scanning_description')).toBeInTheDocument();
    expect(screen.queryByText('frameleaf_people_empty_title')).not.toBeInTheDocument();
  });

  it('says paused, not working, while Background work says Paused, and offers its settings', async () => {
    work([faceQueue({ isPaused: true, waiting: 40, total: 40 })]);
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_scan_paused_title' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'frameleaf_people_scanning_title' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'frameleaf_activity_work_settings' })).toHaveAttribute(
      'href',
      expect.stringContaining('processing'),
    );
  });

  it('says the work is saved for the night while quiet hours hold it', async () => {
    work([faceQueue({ heldForNight: true, resumesAt: '2026-10-31T06:00:00.000Z', state: 'paused', waiting: 40 })]);
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_scan_tonight_title' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'frameleaf_activity_work_settings' })).not.toBeInTheDocument();
  });

  it('says it has not started yet while the work waits its turn', async () => {
    work([faceQueue({ waiting: 40, total: 40 })]);
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_scan_waiting_title' })).toBeInTheDocument();
  });

  it('claims no state for someone the server sends no queues to', async () => {
    work([], false);
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_scan_pending_title' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_people_scan_pending_description')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'frameleaf_people_scanning_title' })).not.toBeInTheDocument();
    expect(screen.queryByText('frameleaf_people_empty_title')).not.toBeInTheDocument();
  });

  // FL-1419: the waiting page updates by itself, with or without queue state
  it('shows the first people as soon as they are found, without a reload', async () => {
    work([], false);
    const ada = peopleListItemFactory.build({ id: 'ada', name: 'Ada', isHidden: false });
    sdkMock.getAllPeople.mockResolvedValue({ people: [ada], total: 1, hidden: 0, hasNextPage: false });
    const { container } = render(PeoplePage, { data: nobody(true) });

    expect(screen.getByTestId('frameleaf-empty-state')).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('.pl-card')).toHaveLength(1));
    expect(screen.queryByTestId('frameleaf-empty-state')).not.toBeInTheDocument();

    // nothing waits any more, so it stops asking
    const asked = sdkMock.getAllPeople.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sdkMock.getAllPeople.mock.calls.length).toBe(asked);
  });

  it('says "No people yet" once everything has been looked through and nobody was found', async () => {
    work([], false);
    sdkMock.getAllPeople.mockResolvedValue({ people: [], total: 0, hidden: 0, hasNextPage: false });
    render(PeoplePage, { data: nobody(true) });

    expect(await screen.findByRole('heading', { name: 'frameleaf_people_empty_title' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_people_empty_description')).toBeInTheDocument();
  });

  it('keeps the notice, and says nothing, when a re-read fails', async () => {
    work([], false);
    sdkMock.getAllPeople.mockRejectedValue(new Error('offline'));
    render(PeoplePage, { data: nobody(true) });

    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole('heading', { name: 'frameleaf_people_scan_pending_title' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('waits for a slow answer instead of asking again and discarding it', async () => {
    work([], false);
    const ada = peopleListItemFactory.build({ id: 'ada', name: 'Ada', isHidden: false });
    let answer: (value: never) => void = () => {};
    sdkMock.getAllPeople.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { container } = render(PeoplePage, { data: nobody(true) });

    await waitFor(() => expect(sdkMock.getAllPeople).toHaveBeenCalledOnce());
    // several turns pass while the server is still thinking
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(sdkMock.getAllPeople).toHaveBeenCalledOnce();
    // a background read gives up by itself, so a stalled one cannot block the page for good
    expect(sdkMock.getAllPeople.mock.calls[0][1]).toEqual({ signal: expect.any(AbortSignal) });

    answer({ people: [ada], total: 1, hidden: 0, hasNextPage: false } as never);
    await waitFor(() => expect(container.querySelectorAll('.pl-card')).toHaveLength(1));
  });

  it('does not re-read a page that is not waiting', async () => {
    render(PeoplePage, { data: nobody(false) });

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(sdkMock.getAllPeople).not.toHaveBeenCalled();
  });

  it('says "No people yet" in the one empty-page pattern, with no controls and no action (FL-1412)', () => {
    render(PeoplePage, { data: nobody(false) });

    const empty = screen.getByTestId('frameleaf-empty-state');
    expect(within(empty).getByRole('heading', { name: 'frameleaf_people_empty_title' })).toBeInTheDocument();
    expect(empty).toHaveTextContent('frameleaf_people_empty_description');
    expect(within(empty).queryByRole('button')).toBeNull();
    expect(within(empty).queryByRole('link')).toBeNull();
    // Nobody to find, sort, show or hide.
    expect(screen.queryByRole('searchbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByRole('button', { name: 'frameleaf_people_show_hidden' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'frameleaf_people_choose_who_appears' })).toBeNull();
  });

  it('keeps the people it has when face recognition is turned off later', () => {
    flags.facialRecognition = false;
    const ada = peopleListItemFactory.build({ id: 'ada', name: 'Ada', isHidden: false });
    const { container } = render(PeoplePage, { data: data([ada], false) });

    expect(container.querySelectorAll('.pl-card')).toHaveLength(1);
    expect(screen.queryByTestId('frameleaf-empty-state')).not.toBeInTheDocument();
  });
});
