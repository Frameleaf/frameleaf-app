import { DuplicateGroupBlock, DuplicateGroupKind } from '@frameleaf/sdk';
import { mdiChevronDoubleLeft, mdiChevronRight } from '@mdi/js';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
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

  it('uses the prototype group navigation icons (UT-21)', () => {
    setup();
    const previous = screen.getByRole('button', { name: 'Previous duplicate group' });
    const next = screen.getByRole('button', { name: 'Next duplicate group' });
    expect(previous.querySelector('path')?.getAttribute('d')).toBe(mdiChevronDoubleLeft);
    expect(next.querySelector('path')?.getAttribute('d')).toBe(mdiChevronRight);
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
