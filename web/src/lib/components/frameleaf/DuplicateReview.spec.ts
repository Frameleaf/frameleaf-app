import {
  DuplicateDecisionKind,
  DuplicateGroupBlock,
  DuplicateGroupKind,
  MediaOperationBulkAction,
} from '@frameleaf/sdk';
import { mdiChevronLeft, mdiChevronRight } from '@mdi/js';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { tick } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { get } from 'svelte/store';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DuplicateReview from '$lib/components/frameleaf/DuplicateReview.svelte';
import type { ReviewGroup } from '$lib/frameleaf/duplicate-review';
import type { DuplicateReviewGateway } from '$lib/frameleaf/duplicate-review-session.svelte';
import { locale } from '$lib/stores/preferences.store';
import en from '../../../../../i18n/en.json';
import DuplicateCompare from './DuplicateCompare.svelte';
import DuplicateContactSheet from './DuplicateContactSheet.svelte';

const group = (id: string, members: string[]): ReviewGroup => ({
  duplicateId: id,
  assets: members.map((assetId) => ({
    id: assetId,
    ownerId: 'owner',
    originalFileName: `${assetId}.jpg`,
    originalPath: `/upload/${assetId}.jpg`,
    exifInfo: {},
  })) as ReviewGroup['assets'],
  suggestedKeepAssetIds: [members[0]],
  kind: DuplicateGroupKind.Duplicates,
  editable: true,
  blockedReason: null,
  hiddenMemberCount: 0,
  totalBytes: 0,
  qualities: [],
  albums: [],
  lookAlike: false,
});

const setup = (blocked: Partial<ReviewGroup> = {}) => {
  const lake = { ...group('lake', ['a', 'b']), ...blocked };
  const forest = { ...group('forest', ['c', 'd']), ...blocked };
  const gateway = {
    getReview: vi.fn().mockResolvedValue([lake, forest]),
    getHistory: vi.fn().mockResolvedValue({ recent: [], active: [] }),
    submit: vi.fn(),
    getOperation: vi.fn(),
  } as unknown as DuplicateReviewGateway;
  return render(DuplicateReview, {
    groups: [lake, forest],
    history: { recent: [], active: [] },
    gateway,
    trashEnabled: true,
    onOpen: vi.fn(),
    onOpenTrash: vi.fn(),
  });
};

/** A review of a library with no duplicate groups. */
const empty = (onRunDetection?: () => void) =>
  render(DuplicateReview, {
    groups: [],
    history: { recent: [], active: [] },
    gateway: {
      getReview: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ recent: [], active: [] }),
      submit: vi.fn(),
      getOperation: vi.fn(),
    } as unknown as DuplicateReviewGateway,
    trashEnabled: true,
    onOpen: vi.fn(),
    onOpenTrash: vi.fn(),
    onRunDetection,
  });

describe('DuplicateReview', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    expect(sdkMock).toBeDefined();
  });
  afterEach(() => {
    for (const element of document.querySelectorAll('[data-test-dialog]')) {
      element.remove();
    }
  });

  // Design review finding 75: previous and next are a matching pair (the prototype mixed a double and a single chevron).
  it('uses a matching pair of group navigation icons', () => {
    setup();
    const previous = screen.getByRole('button', { name: 'Previous duplicate group' });
    const next = screen.getByRole('button', { name: 'Next duplicate group' });
    expect(previous.querySelector('path')?.getAttribute('d')).toBe(mdiChevronLeft);
    expect(next.querySelector('path')?.getAttribute('d')).toBe(mdiChevronRight);
  });

  describe('when no group is in front (design review finding 75)', () => {
    it('says the library has no duplicates, and offers detection only to an account that may run it', async () => {
      const { unmount } = empty();
      expect(screen.getByRole('heading', { name: 'No duplicates found' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Open duplicate detection' })).toBeNull();
      unmount();

      const onRunDetection = vi.fn();
      empty(onRunDetection);
      await userEvent.click(screen.getByRole('button', { name: 'Open duplicate detection' }));
      expect(onRunDetection).toHaveBeenCalled();
    });

    it('says a search matched nothing and clears it', async () => {
      setup();
      const search = screen.getByRole('searchbox');
      await userEvent.type(search, 'zzzz');
      expect(screen.getByRole('heading', { name: 'No groups match' })).toBeInTheDocument();
      await userEvent.click(screen.getByRole('button', { name: 'Clear search' }));
      expect(search).toHaveValue('');
      expect(screen.getByText(/Group 1 of 2/)).toBeInTheDocument();
    });
  });

  it('shows how far the review has come as a progress bar', () => {
    setup();
    expect(screen.getByRole('progressbar', { name: 'Duplicate groups reviewed' })).toHaveAttribute(
      'aria-valuenow',
      '0',
    );
  });

  it('moves between groups with the arrow keys', async () => {
    setup();
    expect(screen.getByText(/Group 1 of 2/)).toBeInTheDocument();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText(/Group 2 of 2/)).toBeInTheDocument();
  });

  it('ignores review shortcuts while a role="dialog" is open (UT-22)', async () => {
    setup();
    const overlay = document.createElement('div');
    overlay.setAttribute('role', 'dialog');
    overlay.dataset.testDialog = '';
    document.body.append(overlay);
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText(/Group 1 of 2/)).toBeInTheDocument();
    overlay.remove();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByText(/Group 2 of 2/)).toBeInTheDocument();
  });

  it('names the owners who can decide a group blocked by another account (UT-20)', () => {
    setup({ editable: false, blockedReason: DuplicateGroupBlock.OtherOwner, otherOwnerNames: ['Emma', 'Jamie'] });
    expect(screen.getByText('Only Emma and Jamie can decide what to keep in this group.')).toBeInTheDocument();
  });

  it('keeps the generic line when no owner names came with the group', () => {
    setup({ editable: false, blockedReason: DuplicateGroupBlock.OtherOwner });
    expect(screen.getByText(en.frameleaf_duplicates_blocked_other_owner)).toBeInTheDocument();
  });
});

it('keeps one accessible active heading focused while the previous group fades away', async () => {
  const animate = Element.prototype.animate;
  Element.prototype.animate = () =>
    ({
      cancel() {},
      pause() {},
      play() {},
      finished: new Promise(() => {}),
      currentTime: 0,
      playState: 'running',
    }) as unknown as Animation;
  try {
    setup();
    const heading = screen.getByRole('heading', { level: 2 });
    heading.focus();
    await userEvent.keyboard('{ArrowRight}');
    await tick();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 2, name: 'c' })).toHaveFocus();
  } finally {
    Element.prototype.animate = animate;
  }
});

const renderReview = (groups: ReviewGroup[], submit = vi.fn().mockResolvedValue({ id: 'job' })) => ({
  submit,
  view: render(DuplicateReview, {
    groups,
    history: { recent: [], active: [] },
    gateway: { getReview: vi.fn(), getHistory: vi.fn(), submit, getOperation: vi.fn() },
    trashEnabled: true,
    onOpen: vi.fn(),
    onOpenTrash: vi.fn(),
  }),
});

const keepers = (duplicateId: string, memberIds: string[], keepAssetIds: string[]) => [
  MediaOperationBulkAction.ResolveDuplicates,
  [{ duplicateId, decision: DuplicateDecisionKind.Keepers, memberIds, keepAssetIds }],
  expect.any(String),
];

it('keeps the chosen look-alikes in the durable decision payload', async () => {
  const { submit } = renderReview([
    {
      ...group('retakes', ['first', 'second', 'third']),
      lookAlike: true,
      suggestedKeepAssetIds: [],
    },
  ]);
  screen.getByRole('heading', { level: 2 }).focus();
  await userEvent.keyboard('12');
  expect(screen.getByRole('button', { name: 'Keep frame 1' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Keep frame 2' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Keep frame 3' })).toHaveAttribute('aria-pressed', 'false');
  await userEvent.keyboard('e');
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(...keepers('retakes', ['first', 'second', 'third'], ['first', 'second'])),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

describe('duplicate triage (FL-558)', () => {
  beforeAll(() => addMessages('dev', en));

  it('starts with the best copy chosen, compares every copy, and keeps another copy by number and Enter', async () => {
    const { submit } = renderReview([group('copies', ['first', 'second', 'third'])]);
    expect(screen.getByRole('radio', { name: 'Keep first.jpg' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: /Keep 1, trash 2/ })).toBeEnabled();
    screen.getByRole('heading', { level: 2 }).focus();
    await userEvent.keyboard('2');
    expect(screen.getByRole('radio', { name: 'Keep second.jpg' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Keep first.jpg' })).toHaveAttribute('aria-checked', 'false');
    await userEvent.keyboard('{Enter}');
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(...keepers('copies', ['first', 'second', 'third'], ['second'])),
    );
  });

  it('lines the copies up fact by fact, naming the albums that hold each one', () => {
    renderReview([
      {
        ...group('copies', ['first', 'second']),
        albums: [
          { assetId: 'first', names: ['Summer', 'Best of 2025'] },
          { assetId: 'second', names: [] },
        ],
      },
    ]);
    expect(screen.getByText('Albums')).toBeInTheDocument();
    expect(screen.getByText('Summer, Best of 2025')).toHaveClass('differs');
  });

  it('splits copies and look-alikes into two lanes', async () => {
    renderReview([
      group('lake', ['a', 'b']),
      { ...group('forest', ['c', 'd']), kind: DuplicateGroupKind.Burst, suggestedKeepAssetIds: [] },
    ]);
    const same = screen.getByRole('tab', { name: /Same photo/ });
    const alike = screen.getByRole('tab', { name: /Look-alikes/ });
    expect(same).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'a' })).toBeInTheDocument();
    await userEvent.click(alike);
    expect(alike).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('heading', { level: 2, name: 'c' })).toBeInTheDocument();
  });

  it('makes Stack the primary action of a burst and says why', () => {
    renderReview([{ ...group('forest', ['c', 'd']), kind: DuplicateGroupKind.Burst, suggestedKeepAssetIds: [] }]);
    expect(screen.getByText('Burst detected · Stack is recommended')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Stack burst/ })).toHaveClass('primary');
    expect(screen.getByRole('button', { name: /Choose photos to keep/ })).toBeDisabled();
  });

  it('ignores a second click on Keep while the next group arrives under the pointer', async () => {
    const { submit } = renderReview([group('lake', ['a', 'b']), group('forest', ['c', 'd'])]);
    const keep = screen.getByTestId('frameleaf-duplicate-keep');
    await userEvent.dblClick(keep);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    expect(submit).toHaveBeenCalledWith(...keepers('lake', ['a', 'b'], ['a']));
    expect(screen.getByTestId('frameleaf-duplicate-keep')).toBe(keep);
    await new Promise((resolve) => setTimeout(resolve, 450));
    await userEvent.click(keep);
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(2));
    expect(submit).toHaveBeenLastCalledWith(...keepers('forest', ['c', 'd'], ['c']));
  });

  it('keeps the best copy in every same-photo group after one confirmation', async () => {
    const { submit } = renderReview([
      group('lake', ['a', 'b']),
      group('forest', ['c', 'd', 'e']),
      { ...group('protected', ['f', 'g']), reviewRequiredReasons: ['edited-copy'] },
    ]);
    await userEvent.click(screen.getByRole('button', { name: /Keep best copy in all 2/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('3 copies go to the trash');
    expect(dialog).toHaveTextContent('1 group needs a closer look and is left for you.');
    await userEvent.click(screen.getByRole('button', { name: 'Keep best in 2 groups' }));
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        MediaOperationBulkAction.ResolveDuplicates,
        [
          { duplicateId: 'lake', decision: DuplicateDecisionKind.Keepers, memberIds: ['a', 'b'], keepAssetIds: ['a'] },
          {
            duplicateId: 'forest',
            decision: DuplicateDecisionKind.Keepers,
            memberIds: ['c', 'd', 'e'],
            keepAssetIds: ['c'],
          },
        ],
        expect.any(String),
      ),
    );
  });
});

it('keeps focus through the virtual window and decides the previously offscreen group', async () => {
  const groups = Array.from({ length: 40 }, (_, i) => group(`queue-${i}`, [`first-${i}`, `second-${i}`]));
  const submit = vi.fn().mockResolvedValue({ id: 'offscreen-job' });
  const height = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(540);
  try {
    const view = render(DuplicateReview, {
      groups,
      history: { recent: [], active: [] },
      gateway: { getReview: vi.fn(), getHistory: vi.fn(), submit, getOperation: vi.fn() },
      trashEnabled: true,
      onOpen: vi.fn(),
      onOpenTrash: vi.fn(),
    });
    const queue = view.container.querySelector('.fl-dr-queue-scroll')!;
    expect(queue.querySelectorAll('.fl-dr-queue-row').length).toBeLessThan(40);
    expect(queue.textContent).not.toContain('first-25');
    screen.getByRole('heading', { level: 2 }).focus();
    for (let i = 1; i <= 25; i++) {
      await userEvent.keyboard('{ArrowRight}');
      await tick();
      expect(screen.getByRole('heading', { level: 2, name: `first-${i}` })).toHaveFocus();
    }
    expect(queue.querySelector('[aria-current="true"]')).toHaveTextContent('first-25');
    await userEvent.keyboard('a');
    await waitFor(() =>
      expect(submit).toHaveBeenCalledWith(
        MediaOperationBulkAction.ResolveDuplicates,
        [
          {
            duplicateId: 'queue-25',
            decision: DuplicateDecisionKind.KeepAll,
            memberIds: ['first-25', 'second-25'],
            keepAssetIds: [],
          },
        ],
        expect.any(String),
      ),
    );
    expect(screen.getByRole('heading', { level: 2, name: 'first-26' })).toHaveFocus();
  } finally {
    height.mockRestore();
  }
});

it.each([false, true])('shows local capture time in duplicate review (contact sheet: %s)', (lookAlike) => {
  const previousLocale = get(locale);
  locale.set('en-US');
  try {
    const assets = group('dated', ['a', 'b']).assets.map((asset) => ({
      ...asset,
      localDateTime: '2026-01-15T16:20:00.000Z',
      exifInfo: { dateTimeOriginal: '2026-01-15T21:20:00.000Z', timeZone: 'America/Toronto' },
    }));
    const common = {
      group: { ...group('dated', ['a', 'b']), assets, lookAlike },
      actionable: true,
      keeperIds: ['a'],
      onOpen: vi.fn(),
    };
    if (lookAlike) {
      render(DuplicateContactSheet, {
        ...common,
        focused: assets[0],
        framePage: 0,
        onToggle: vi.fn(),
        onFocus: vi.fn(),
        onSelectAll: vi.fn(),
        onClear: vi.fn(),
        onPage: vi.fn(),
      });
    } else {
      render(DuplicateCompare, { ...common, suggestedId: 'a', trashEnabled: true, onChoose: vi.fn() });
    }
    expect(screen.getAllByText(/4:20(?::00)? PM/).length).toBeGreaterThan(0);
    expect(screen.queryAllByText(/9:20(?::00)? PM/)).toHaveLength(0);
  } finally {
    locale.set(previousLocale);
  }
});
