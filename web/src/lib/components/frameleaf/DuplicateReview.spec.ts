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
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import DuplicateReview from '$lib/components/frameleaf/DuplicateReview.svelte';
import type { ReviewGroup } from '$lib/frameleaf/duplicate-review';
import type { DuplicateReviewGateway } from '$lib/frameleaf/duplicate-review-session.svelte';
import en from '../../../../../i18n/en.json';

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

it('keeps the chosen two contact-sheet copies in the durable decision payload', async () => {
  const copies = group('copies', ['first', 'second', 'third']);
  const submit = vi.fn().mockResolvedValue({ id: 'keepers-job' });
  render(DuplicateReview, {
    groups: [copies],
    history: { recent: [], active: [] },
    gateway: { getReview: vi.fn(), getHistory: vi.fn(), submit, getOperation: vi.fn() },
    trashEnabled: true,
    onOpen: vi.fn(),
    onOpenTrash: vi.fn(),
  });
  screen.getByRole('heading', { level: 2 }).focus();
  await userEvent.keyboard('12');
  expect(screen.getByRole('checkbox', { name: 'Keep frame 1' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Keep frame 2' })).toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Keep frame 3' })).not.toBeChecked();
  await userEvent.keyboard('e');
  await waitFor(() =>
    expect(submit).toHaveBeenCalledWith(
      MediaOperationBulkAction.ResolveDuplicates,
      [
        {
          duplicateId: 'copies',
          decision: DuplicateDecisionKind.Keepers,
          memberIds: ['first', 'second', 'third'],
          keepAssetIds: ['first', 'second'],
        },
      ],
      expect.any(String),
    ),
  );
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
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
