import { getAssetInfo, getRecentIdenticalFileChanges, undoIdenticalFileChange } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import MergedForYou from '$lib/components/frameleaf/MergedForYou.svelte';
import { isIdenticalGroup } from '$lib/frameleaf/duplicate-review';
import { mergedRows } from '$lib/frameleaf/merged-for-you';
import en from '../../../../../i18n/en.json';

/** Duplicate review › Merged for you (FL-416): the automatic merges, newest first, each with Undo. */
const user = vi.hoisted(() => ({ id: 'taylor', isAdmin: true }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  getAssetInfo: vi.fn(),
  getRecentIdenticalFileChanges: vi.fn(),
  undoIdenticalFileChange: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user, authenticated: true } }));

const now = new Date();
const merge = (operationId: string, automatic: boolean, overrides: Record<string, unknown> = {}) =>
  ({
    operationId,
    createdAt: new Date(now.getTime() - 60_000).toISOString(),
    undoable: true,
    automatic,
    groups: [
      {
        decisionId: `${operationId}-d`,
        duplicateId: `${operationId}-g`,
        decision: 'keepers',
        memberIds: ['kept', 'newer'],
        keepAssetIds: ['kept'],
        trashAssetIds: ['newer'],
        applied: true,
        undone: false,
        undoing: false,
        ...overrides,
      },
    ],
  }) as never;
const link = {
  id: 'change-1',
  assetId: 'morgan-video',
  originalFileName: 'VID_0311.MOV',
  ownerId: 'morgan',
  ownerName: 'Morgan',
  keptAssetId: 'taylor-video',
  keptOwnerName: 'Taylor',
  sizeInBytes: 412_000_000,
  createdAt: new Date(now.getTime() - 120_000).toISOString(),
  undoneAt: null,
  restorable: true,
};

describe('Merged for you (FL-416)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAssetInfo).mockResolvedValue({ originalFileName: 'IMG_2040.HEIC' } as never);
    vi.mocked(getRecentIdenticalFileChanges).mockResolvedValue([link]);
  });

  it('lists only the merges Frameleaf made, newest first', () => {
    const rows = mergedRows([merge('mine', false), merge('auto', true)], [link]);
    expect(rows.map((row) => row.key)).toEqual(['merge:auto-d', 'link:change-1']);
  });

  it('undoes a merge in one library through the review, and a shared file through its change', async () => {
    const onUndoMerge = vi.fn().mockResolvedValue(true);
    vi.mocked(undoIdenticalFileChange).mockResolvedValue({ ...link, undoneAt: now.toISOString() } as never);
    render(MergedForYou, { recent: [merge('auto', true)], onUndoMerge });

    const section = within(await screen.findByRole('region', { name: en.frameleaf_merged_title }));
    expect(await section.findByText('IMG_2040.HEIC')).toBeInTheDocument();
    expect(section.getByText('2 photos became one in your library')).toBeInTheDocument();
    expect(await section.findByText('VID_0311.MOV')).toBeInTheDocument();
    expect(section.getByText('Morgan and Taylor have the same file; each keeps their own')).toBeInTheDocument();
    expect(section.getByText('412 MB saved')).toBeInTheDocument();
    expect(section.getByText(/^2 this week · 412 MB saved$/)).toBeInTheDocument();

    const [first, second] = section.getAllByRole('button', { name: en.frameleaf_merged_undo });
    await fireEvent.click(first);
    expect(onUndoMerge).toHaveBeenCalledWith(expect.objectContaining({ operationId: 'auto' }), 'auto-g');
    await fireEvent.click(second);
    expect(undoIdenticalFileChange).toHaveBeenCalledWith({ id: 'change-1' });
    expect(await section.findByText(en.frameleaf_merged_undone)).toBeInTheDocument();
  });

  it('shows nothing when Frameleaf merged nothing', () => {
    vi.mocked(getRecentIdenticalFileChanges).mockResolvedValue([]);
    render(MergedForYou, { recent: [merge('mine', false)], onUndoMerge: vi.fn() });
    expect(screen.queryByRole('region', { name: en.frameleaf_merged_title })).toBeNull();
  });

  it('tells identical files from look-alikes by their checksum', () => {
    const asset = (checksum: string) => ({ checksum }) as never;
    expect(isIdenticalGroup({ kind: 'similar', assets: [asset('a'), asset('a')] } as never)).toBe(true);
    expect(isIdenticalGroup({ kind: 'similar', assets: [asset('a'), asset('b')] } as never)).toBe(false);
    expect(isIdenticalGroup({ kind: 'burst', assets: [asset('a'), asset('a')] } as never)).toBe(false);
  });
});
