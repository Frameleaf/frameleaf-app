import {
  FoundFileOutcome,
  FoundFileReason,
  type AdminConfigDto,
  type FoundFileDetailResponseDto,
  type FoundFileResponseDto,
  type FoundFilesSummaryResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import FoundFiles from './FoundFiles.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const state = vi.hoisted(() => ({
  page: { url: new URL('http://localhost/user-settings?area=care&section=found-files') },
}));
const navigation = vi.hoisted(() => ({ goto: vi.fn() }));

vi.mock('$app/state', () => state);
vi.mock('$app/navigation', () => navigation);
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({ libraryCare: { putBackFoundFiles: true, clearGonePreviews: true } }) as unknown as AdminConfigDto;
const newStore = () => {
  const store = new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };
  draft.store = store;
  return store;
};

const at = (search = '') => {
  state.page.url = new URL(`http://localhost/user-settings?area=care&section=found-files${search}`);
};

const ME = 'u1';
const EMMA = 'u2';
const file = (value: Partial<FoundFileResponseDto> & Pick<FoundFileResponseDto, 'id'>): FoundFileResponseDto => ({
  fileName: `${value.id}.jpg`,
  path: `/data/upload/${ME}/3f/9a/${value.id}.jpg`,
  sizeInBytes: 4_200_000,
  outcome: FoundFileOutcome.Added,
  reason: null,
  ownerId: ME,
  assetId: `asset-${value.id}`,
  viewable: true,
  sortedAt: '2026-11-12T08:40:00.000Z',
  ...value,
});

const backFile = file({ id: 'img-3310', outcome: FoundFileOutcome.Back });
const addedFile = file({ id: 'img-7731' });
const emmas = file({ id: 'img-9002', ownerId: EMMA, viewable: false });
const spareFile = file({ id: 'img-2041-copy', outcome: FoundFileOutcome.Spare });
const orphan = file({
  id: 'orphan-1',
  outcome: FoundFileOutcome.Needs,
  reason: FoundFileReason.NoOwner,
  ownerId: null,
  assetId: null,
  path: '/data/upload/5b2e/3f/9a/orphan-1.jpg',
});

const summary = (value: Partial<FoundFilesSummaryResponseDto> = {}): FoundFilesSummaryResponseDto => ({
  back: 1,
  added: 2,
  spare: 1,
  spareSizeInBytes: 4_200_000,
  needs: 64,
  left: 0,
  tidied: { previews: 18_306, previewSizeInBytes: 3_400_000_000, sidecars: 2114 },
  groups: [
    {
      reason: FoundFileReason.NoOwner,
      ownerId: null,
      folder: '/data/upload/5b2e',
      count: 64,
      sizeInBytes: 1_200_000_000,
    },
  ],
  ...value,
});

const serve = (counts = summary()) => {
  sdkMock.getFoundFilesSummary.mockResolvedValue(counts);
  sdkMock.getFoundFiles.mockImplementation(({ outcome }) => {
    const items = {
      [FoundFileOutcome.Back]: [backFile],
      [FoundFileOutcome.Added]: [addedFile, emmas],
      [FoundFileOutcome.Spare]: [spareFile],
      [FoundFileOutcome.Needs]: counts.groups.length > 0 ? [orphan] : [],
      [FoundFileOutcome.Left]: [],
    }[outcome];
    return Promise.resolve({ items, nextCursor: null });
  });
  sdkMock.searchUsersAdmin.mockResolvedValue([
    { id: ME, name: 'Taylor' },
    { id: EMMA, name: 'Emma' },
  ] as never);
  sdkMock.getIntegrityOverview.mockResolvedValue({ running: [] } as never);
};

const show = async () => {
  render(FoundFiles);
  await screen.findByRole('group', { name: 'Show' });
};
const tab = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

describe('FoundFiles (FL-1533)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    at();
    newStore();
    serve();
  });

  it('says what became of the files and opens on what needs a decision', async () => {
    await show();

    expect(await screen.findByText('3 photos are back in the library')).toBeInTheDocument();
    expect(
      screen.getByText(/68 files were on the drive but in nobody’s library\..*64 need a decision from you\./),
    ).toBeInTheDocument();
    for (const name of [/Needs you · 64/, /Put back · 1/, /Added · 2/, /Spare copies · 1/]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
    expect(screen.getByText('64 files in a folder no account uses')).toBeInTheDocument();
    expect(screen.getByText(/\/data\/upload\/5b2e belongs to no account/)).toBeInTheDocument();
  });

  it('shows the photos as pictures, and a lock for another account’s', async () => {
    const { container } = render(FoundFiles);
    await screen.findByRole('group', { name: 'Show' });
    await tab(/Added · 2/);

    const mine = await screen.findByRole('button', { name: 'What happened to img-7731.jpg' });
    expect(mine.querySelector('img')).not.toBeNull();
    const theirs = screen.getByRole('button', { name: 'What happened to img-9002.jpg' });
    expect(theirs.querySelector('img')).toBeNull();
    expect(within(theirs).getByText('Emma’s photo')).toBeInTheDocument();
    // not even a request for another account's picture: the only picture is the other photo's
    expect(container.querySelectorAll(':scope .grid img')).toHaveLength(1);
  });

  it('adds a folder’s files to the chosen account, batch after batch, then reloads', async () => {
    sdkMock.resolveFoundFiles
      .mockResolvedValueOnce({ back: 1, added: 49, spare: 0, waiting: 0, skipped: 0, nextCursor: 'c1' })
      .mockResolvedValueOnce({ back: 0, added: 12, spare: 2, waiting: 0, skipped: 0, nextCursor: null });
    await show();

    const add = await screen.findByRole('button', { name: 'Add 64 photos' });
    expect(add).toBeDisabled();
    await fireEvent.change(screen.getByLabelText('Whose library these photos go to'), { target: { value: EMMA } });
    await fireEvent.click(add);

    await waitFor(() => expect(sdkMock.resolveFoundFiles).toHaveBeenCalledTimes(2));
    expect(sdkMock.resolveFoundFiles).toHaveBeenNthCalledWith(1, {
      foundFilesResolveDto: { reason: 'no-owner', folder: '/data/upload/5b2e', ownerId: EMMA, cursor: undefined },
    });
    expect(sdkMock.resolveFoundFiles.mock.calls[1][0].foundFilesResolveDto.cursor).toBe('c1');
    expect(await screen.findByText(/62 photos are in the library now\. 2 were spare copies\./)).toBeInTheDocument();
    expect(sdkMock.getFoundFilesSummary).toHaveBeenCalledTimes(2);
  });

  it('asks before deleting spare copies and says how many were kept', async () => {
    sdkMock.deleteSpareFoundFiles.mockResolvedValue({ deleted: 3, freedBytes: 12_600_000, kept: 1, nextCursor: null });
    await show();
    await tab(/Spare copies · 1/);

    await fireEvent.click(screen.getByRole('button', { name: 'Delete 1 spare copy…' }));
    expect(sdkMock.deleteSpareFoundFiles).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog', { name: 'Delete 1 spare copy?' });
    await fireEvent.click(within(dialog).getByRole('button', { name: 'Delete 1 copy' }));

    expect(await screen.findByText(/3 spare copies deleted, freeing .*1 was kept/)).toBeInTheDocument();
    expect(sdkMock.deleteSpareFoundFiles).toHaveBeenCalledExactlyOnceWith({
      foundFilesDeleteSpareDto: { cursor: undefined },
    });
  });

  it('opens a photo’s story and undoes putting it back', async () => {
    const detail: FoundFileDetailResponseDto = {
      ...backFile,
      previousPath: '/data/library/taylor/2020/08/IMG_3310.jpg',
      steps: [
        { step: 'found', at: '2026-11-12T08:40:00.000Z' },
        { step: 'read', at: '2026-11-12T08:40:01.000Z', outcome: 'ok' },
        { step: 'back', at: '2026-11-12T08:40:02.000Z' },
        { step: 'something-newer', at: '2026-11-12T08:40:03.000Z' },
      ],
    };
    sdkMock.getFoundFile.mockResolvedValue(detail);
    sdkMock.undoFoundFile.mockResolvedValue({ ...detail, outcome: FoundFileOutcome.Left });
    await show();
    await tab(/Put back · 1/);
    await fireEvent.click(screen.getByRole('button', { name: 'What happened to img-3310.jpg' }));

    const dialog = await screen.findByRole('dialog', { name: 'img-3310.jpg' });
    expect(await within(dialog).findByText('Put it back')).toBeInTheDocument();
    expect(within(dialog).getByText('/data/library/taylor/2020/08/IMG_3310.jpg')).toBeInTheDocument();
    // a step the page does not know is left out, never shown raw
    expect(within(dialog).queryByText(/something-newer/)).toBeNull();

    await fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(sdkMock.undoFoundFile).toHaveBeenCalledExactlyOnceWith({ id: 'img-3310' }));
    expect(await screen.findByText(/listed as missing again/)).toBeInTheDocument();
  });

  it('offers nothing but Done for another account’s photo', async () => {
    sdkMock.getFoundFile.mockResolvedValue({ ...emmas, previousPath: null, steps: [] });
    at('&file=img-9002');
    await show();

    const dialog = await screen.findByRole('dialog', { name: 'img-9002.jpg' });
    expect(await within(dialog).findByText('In Emma’s library')).toBeInTheDocument();
    expect(dialog.querySelector('img')).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Take out of library' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Done' })).toBeInTheDocument();
  });

  it('lists what was tidied without asking, and edits the two switches in the settings draft', async () => {
    const store = newStore();
    await show();

    expect(screen.getByText('18,306 previews for photos that are gone')).toBeInTheDocument();
    expect(screen.getByText('2,114 edit-detail files beside their photos')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('switch', { name: 'Put found photos back by themselves' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'Clear previews for photos that are gone' }));
    expect(store.draft.libraryCare).toMatchObject({ putBackFoundFiles: false, clearGonePreviews: false });
    expect(screen.getByText(/found photos wait in Needs you/)).toBeInTheDocument();
  });

  it('says so when nothing was found, and when nothing is left to decide', async () => {
    serve(
      summary({
        back: 0,
        added: 0,
        spare: 0,
        needs: 0,
        groups: [],
        tidied: { previews: 0, previewSizeInBytes: 0, sidecars: 0 },
      }),
    );
    const first = render(FoundFiles);
    expect(await screen.findByText('Every file on the drive is in a library')).toBeInTheDocument();
    expect(screen.queryByText('Tidied without asking')).toBeNull();
    first.unmount();

    serve(summary({ needs: 0, groups: [] }));
    render(FoundFiles);
    expect(await screen.findByText('Nothing needs you')).toBeInTheDocument();
    expect(screen.getByText(/Anything Frameleaf won’t decide by itself waits here/)).toBeInTheDocument();
  });

  it('says the list could not be loaded', async () => {
    sdkMock.getFoundFilesSummary.mockRejectedValue(new Error('offline'));
    render(FoundFiles);
    expect(await screen.findByText('Couldn’t load the list just now. Try again in a moment.')).toBeInTheDocument();
  });
});
