import { MediaHealthCategory, type FileProblemDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import * as utils from '$lib/utils';
import en from '../../../../../../../i18n/en.json';
import FileStory from './FileStory.svelte';

const auth = vi.hoisted(() => ({ user: { id: 'u1', isAdmin: false }, params: {} }));

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 9, 2, minutes)).toISOString();

const repaired: FileProblemDto = {
  id: 'img-2041',
  assetId: 'asset-2041',
  ownerId: 'u1',
  ownerName: 'Taylor',
  originalFileName: 'IMG_2041.jpg',
  category: MediaHealthCategory.Corrupt,
  fixState: 'part-saved',
  partSaved: true,
  line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } },
  updatedAt: at(15),
  pictureAllowed: true,
  canAct: true,
  steps: [
    { at: at(14), step: 'wont-open', outcome: 'failed', facts: { cause: 'cut-short' } },
    {
      at: at(15),
      step: 'repaired',
      outcome: 'ok',
      facts: { method: 'rebuilt', percentSaved: 92, metadataLost: false },
    },
    { at: at(15), step: 'kept-damaged', outcome: 'info', facts: {} },
  ],
};

const missing: FileProblemDto = {
  ...repaired,
  id: 'img-0611',
  assetId: 'asset-0611',
  originalFileName: 'IMG_0611.jpg',
  category: MediaHealthCategory.Missing,
  fixState: 'missing',
  partSaved: false,
  line: { step: 'asked-phones', outcome: 'not-found', facts: {} },
  steps: [
    { at: at(1), step: 'not-on-drive', outcome: 'failed', facts: { folder: '2016/05', name: 'IMG_0611.jpg' } },
    { at: at(5), step: 'searched-copy', outcome: 'not-found', facts: { places: ['managed'] } },
    { at: at(6), step: 'asked-phones', outcome: 'not-found', facts: {} },
  ],
};

const emmas: FileProblemDto = { ...missing, ownerId: 'u2', ownerName: 'Emma', pictureAllowed: false, canAct: false };

const blank: FileProblemDto = {
  ...repaired,
  id: 'scan-014',
  originalFileName: 'Scan_014.png',
  fixState: 'cant-repair',
  partSaved: false,
  line: { step: 'checked', outcome: 'failed', facts: { cause: 'blank' } },
  steps: [
    { at: at(19), step: 'wont-open', outcome: 'failed', facts: { cause: 'unreadable' } },
    { at: at(19), step: 'checked', outcome: 'failed', facts: { cause: 'blank' } },
  ],
};

const folders = [
  { id: 'managed', name: 'Your library' },
  { id: 'recovery:usb', name: 'USB drive' },
];

const show = (problem: FileProblemDto) => {
  sdkMock.getFileProblem.mockResolvedValue(problem);
  const onDone = vi.fn();
  const onClose = vi.fn();
  // opened from its row, as the list does: the sheet is named for the file before its history arrives
  render(FileStory, { id: problem.id, row: problem, onDone, onClose });
  return { onDone, onClose, sheet: () => within(screen.getByRole('dialog', { name: problem.originalFileName })) };
};

const buttons = (dialog: HTMLElement) =>
  within(dialog)
    .getAllByRole('button')
    .map((button) => button.textContent?.trim())
    .filter(Boolean);

describe('What happened (FL-1338)', () => {
  beforeAll(() => {
    addMessages('dev', en);
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.open = true;
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.open = false;
    };
  });

  beforeEach(() => {
    vi.clearAllMocks();
    auth.user.isAdmin = false;
    sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: unknown })?.status === 'number');
    sdkMock.getAssetInfo.mockResolvedValue({ localDateTime: '2019-03-12T16:31:00.000Z' } as never);
    sdkMock.getFileProblemFolders.mockResolvedValue(folders);
    sdkMock.getManagerAccess.mockResolvedValue({ url: 'http://manager.test' });
  });

  it('shows a repair beside the damaged file it kept, what was lost, and every step', async () => {
    const { sheet } = show(repaired);

    expect(await sheet().findByText('Repaired it')).toBeInTheDocument();
    expect(sheet().getByText('Damaged file, kept')).toBeInTheDocument();
    expect(sheet().getByText('Repaired photo, in your library')).toBeInTheDocument();
    expect(sheet().getByText('Won’t open')).toBeInTheDocument();
    expect(sheet().getByText('Repaired, part saved')).toBeInTheDocument();
    expect(sheet().getByText('Taylor’s')).toBeInTheDocument();
    expect(sheet().getByText('The bottom of the picture couldn’t be saved')).toBeInTheDocument();
    expect(sheet().getByText(/so the bottom 8% of the picture is grey/)).toBeInTheDocument();
    expect(
      sheet().getByText('Making its preview failed: the file stops partway through the picture.'),
    ).toBeInTheDocument();
    expect(sheet().getByText('Beside the repaired one, in Library care. Undo puts it back.')).toBeInTheDocument();
    expect(sheet().getByRole('button', { name: 'Undo repair' })).toBeInTheDocument();
    expect(sheet().getByRole('button', { name: 'Keep repaired photo' })).toBeInTheDocument();
  });

  it('keeps another account’s photo to itself: no picture, and only Try again for an administrator', async () => {
    auth.user.isAdmin = true;
    sdkMock.tryFileProblemAgain.mockResolvedValue(emmas);
    const { sheet, onDone } = show(emmas);

    expect(await sheet().findByText('In Emma’s library')).toBeInTheDocument();
    expect(
      sheet().getByText('Only Emma sees this photo and can undo or replace it, from Library care when signed in.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('dialog').querySelector('img')).toBeNull();
    expect(sdkMock.getAssetInfo).not.toHaveBeenCalled();
    expect(buttons(screen.getByRole('dialog'))).toEqual(['Try again', 'Done']);

    await fireEvent.click(sheet().getByRole('button', { name: 'Try again' }));
    expect(sdkMock.tryFileProblemAgain).toHaveBeenCalledWith({ id: 'img-0611' });
    await vi.waitFor(() => expect(onDone).toHaveBeenCalled());
  });

  it('gives a member who can’t act on a photo only Done', async () => {
    const { sheet } = show(emmas);

    await sheet().findByText('In Emma’s library');
    expect(buttons(screen.getByRole('dialog'))).toEqual(['Done']);
  });

  it('looks in a folder the person chooses, and tells a member who adds other drives', async () => {
    sdkMock.lookInFolderForFileProblem.mockResolvedValue(missing);
    const { sheet, onDone } = show(missing);

    await fireEvent.click(await sheet().findByRole('button', { name: 'Look in a folder…' }));
    const look = within(await screen.findByRole('dialog', { name: 'Look in a folder' }));
    expect(await look.findByRole('radio', { name: 'Your library' })).toBeInTheDocument();
    expect(
      look.getByText('To look on another drive, ask whoever runs this server to add it in Frameleaf Manager.'),
    ).toBeInTheDocument();
    expect(look.queryByRole('link', { name: 'Open Frameleaf Manager' })).not.toBeInTheDocument();
    expect(sdkMock.getManagerAccess).not.toHaveBeenCalled();

    await fireEvent.click(look.getByRole('radio', { name: 'USB drive' }));
    await fireEvent.click(look.getByRole('button', { name: 'Look in this folder' }));

    expect(sdkMock.lookInFolderForFileProblem).toHaveBeenCalledWith({
      id: 'img-0611',
      fileProblemLookInDto: { folderId: 'recovery:usb' },
    });
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith(
        'Frameleaf is looking in USB drive. What it finds shows in this photo’s history.',
      ),
    );
  });

  it('sends an administrator to Frameleaf Manager for another drive', async () => {
    auth.user.isAdmin = true;
    const { sheet } = show(missing);

    await fireEvent.click(await sheet().findByRole('button', { name: 'Look in a folder…' }));
    const look = within(await screen.findByRole('dialog', { name: 'Look in a folder' }));
    expect(look.getByText('To look on another drive, add it in Frameleaf Manager first.')).toBeInTheDocument();
    expect(await look.findByRole('link', { name: 'Open Frameleaf Manager' })).toHaveAttribute(
      'href',
      'http://manager.test/#services',
    );
  });

  it('says why Frameleaf can’t look there, in the server’s words', async () => {
    sdkMock.lookInFolderForFileProblem.mockRejectedValue(
      Object.assign(new Error('Bad Request'), {
        status: 400,
        data: { message: "Frameleaf can't look for this photo in that folder." },
      }),
    );
    const { sheet, onDone } = show(missing);

    await fireEvent.click(await sheet().findByRole('button', { name: 'Look in a folder…' }));
    const look = within(await screen.findByRole('dialog', { name: 'Look in a folder' }));
    await fireEvent.click(await look.findByRole('radio', { name: 'Your library' }));
    await fireEvent.click(look.getByRole('button', { name: 'Look in this folder' }));

    expect(await look.findByText("Frameleaf can't look for this photo in that folder.")).toBeInTheDocument();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('keeps a file that can’t be repaired as it is', async () => {
    sdkMock.keepFileProblem.mockResolvedValue({ ...blank, fixState: 'left-as-is' });
    const { sheet, onDone } = show(blank);

    expect(await sheet().findByText('Its preview from before')).toBeInTheDocument();
    // it arrived blank: every exact copy is blank too, so there is no folder worth looking in
    expect(buttons(screen.getByRole('dialog'))).toEqual(['Remove from library…', 'Keep as it is']);
    expect(sheet().getByRole('button', { name: 'Keep as it is' })).toHaveClass('primary');
    await fireEvent.click(sheet().getByRole('button', { name: 'Keep as it is' }));

    expect(sdkMock.keepFileProblem).toHaveBeenCalledWith({ id: 'scan-014' });
    await vi.waitFor(() =>
      expect(onDone).toHaveBeenCalledWith('Scan_014.png is kept as it is and moves to “Left as they are”.'),
    );
  });

  it('offers Look in a folder for a damaged file that changed after Frameleaf stored it', async () => {
    const { sheet } = show({
      ...blank,
      steps: [{ at: at(19), step: 'checked', outcome: 'failed', facts: { cause: 'changed' } }],
    });

    expect(await sheet().findByText('Its preview from before')).toBeInTheDocument();
    expect(buttons(screen.getByRole('dialog'))).toEqual(['Remove from library…', 'Keep as it is', 'Look in a folder…']);
    expect(sheet().getByRole('button', { name: 'Look in a folder…' })).toHaveClass('primary');
  });

  it('says when the folders couldn’t be read, and reads them again next time', async () => {
    sdkMock.getFileProblemFolders.mockRejectedValueOnce(new Error('offline'));
    const { sheet } = show(missing);

    await fireEvent.click(await sheet().findByRole('button', { name: 'Look in a folder…' }));
    let look = within(await screen.findByRole('dialog', { name: 'Look in a folder' }));
    expect(await look.findByText('Couldn’t read the folders just now. Try again in a moment.')).toBeInTheDocument();
    expect(look.queryByText('There is no folder to look in yet.')).not.toBeInTheDocument();
    await fireEvent.click(look.getByRole('button', { name: 'Cancel' }));

    await fireEvent.click(sheet().getByRole('button', { name: 'Look in a folder…' }));
    look = within(await screen.findByRole('dialog', { name: 'Look in a folder' }));
    expect(await look.findByRole('radio', { name: 'USB drive' })).toBeInTheDocument();
    expect(look.queryByText('Couldn’t read the folders just now. Try again in a moment.')).not.toBeInTheDocument();
    expect(sdkMock.getFileProblemFolders).toHaveBeenCalledTimes(2);
  });

  describe('the damaged file a repair kept', () => {
    it('downloads it between Undo repair and Keep repaired photo, named as the server names it', async () => {
      const blob = new Blob(['damaged']);
      const download = vi.spyOn(utils, 'downloadBlob').mockImplementation(() => {});
      sdkMock.downloadFileProblemKeptFile.mockResolvedValue(blob as never);
      const { sheet, onDone } = show(repaired);

      await sheet().findByText('Repaired it');
      expect(buttons(screen.getByRole('dialog'))).toEqual(['Undo repair', 'Download damaged file', 'Keep repaired photo']);
      await fireEvent.click(sheet().getByRole('button', { name: 'Download damaged file' }));

      expect(sdkMock.downloadFileProblemKeptFile).toHaveBeenCalledWith({ id: 'img-2041' });
      await vi.waitFor(() => expect(download).toHaveBeenCalledWith(blob, 'IMG_2041 (damaged).jpg'));
      // the sheet stays open: the person is still looking at the repair
      expect(onDone).not.toHaveBeenCalled();
      download.mockRestore();
    });

    it('is not offered for another account’s photo', async () => {
      const { sheet } = show({ ...repaired, canAct: false, pictureAllowed: false });
      await sheet().findByText('In Taylor’s library');
      expect(sheet().queryByRole('button', { name: 'Download damaged file' })).not.toBeInTheDocument();
    });

    it('is not offered for a file that was never repaired', async () => {
      const { sheet } = show(missing);
      await sheet().findByRole('button', { name: 'Look in a folder…' });
      expect(sheet().queryByRole('button', { name: 'Download damaged file' })).not.toBeInTheDocument();
    });

    it('is not offered once the photo is Locked', async () => {
      sdkMock.getAssetInfo.mockResolvedValue({ localDateTime: '2019-03-12T16:31:00.000Z', visibility: 'locked' } as never);
      const { sheet } = show(repaired);

      await sheet().findByText('Repaired it');
      // the button goes once the photo's details say it is Locked
      await vi.waitFor(() =>
        expect(sheet().queryByRole('button', { name: 'Download damaged file' })).not.toBeInTheDocument(),
      );
      expect(sheet().getByRole('button', { name: 'Undo repair' })).toBeInTheDocument();
    });

    it('shows the server’s words when there is no kept file, and saves nothing', async () => {
      const download = vi.spyOn(utils, 'downloadBlob').mockImplementation(() => {});
      sdkMock.downloadFileProblemKeptFile.mockRejectedValue(
        Object.assign(new Error('Not Found'), {
          status: 404,
          data: { message: 'There is no damaged file kept for this photo.' },
        }),
      );
      const { sheet } = show(repaired);

      await fireEvent.click(await sheet().findByRole('button', { name: 'Download damaged file' }));

      expect(await sheet().findByText('There is no damaged file kept for this photo.')).toBeInTheDocument();
      expect(download).not.toHaveBeenCalled();
      download.mockRestore();
    });

    it('says plainly that it failed when the server gives no reason', async () => {
      sdkMock.downloadFileProblemKeptFile.mockRejectedValue(new Error('offline'));
      const { sheet } = show(repaired);

      await fireEvent.click(await sheet().findByRole('button', { name: 'Download damaged file' }));

      expect(await sheet().findByText(en.frameleaf_files_action_failed)).toBeInTheDocument();
    });
  });
});
