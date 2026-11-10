import {
  FileProblemTab,
  MediaHealthCategory,
  type AdminConfigDto,
  type FileProblemDto,
  type FileProblemRowDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SystemConfigDraftStore } from '$lib/frameleaf/system-config-draft.svelte';
import en from '../../../../../../../i18n/en.json';
import FileProblems from './FileProblems.svelte';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));
const auth = vi.hoisted(() => ({ user: { id: 'u1', isAdmin: false }, params: {} }));
const state = vi.hoisted(() => ({ page: { url: new URL('http://localhost/user-settings?area=care&section=files') } }));

vi.mock('$app/state', () => state);
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: auth }));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  requireSystemConfigDraft: () => draft.store,
  getSystemConfigDraft: () => draft.store,
}));

const config = () =>
  ({
    libraryCare: {
      healthScan: true,
      healthScanCronExpression: '0 02 * * *',
      checksumScan: true,
      integrityAudit: true,
      livePhotoRepair: true,
      rawRecovery: true,
      duplicateReview: true,
      incrementalEnrichment: true,
      manualMetadata: true,
      autoRepair: true,
      askPhones: true,
    },
  }) as unknown as AdminConfigDto;

const newStore = () => {
  const store = new SystemConfigDraftStore(
    { config: config(), revision: 'r1' },
    { defaults: config(), load: vi.fn(), save: vi.fn() },
  ) as SystemConfigDraftStore & { draft: AdminConfigDto };
  draft.store = store;
  return store;
};

const at = (search = '') => {
  state.page.url = new URL(`http://localhost/user-settings?area=care&section=files${search}`);
};

const problem = (value: Partial<FileProblemRowDto> & Pick<FileProblemRowDto, 'id'>): FileProblemRowDto => ({
  assetId: `asset-${value.id}`,
  ownerId: 'u1',
  ownerName: 'Taylor',
  originalFileName: `${value.id}.jpg`,
  category: MediaHealthCategory.Corrupt,
  fixState: null,
  partSaved: false,
  line: null,
  updatedAt: '2026-11-09T02:15:00.000Z',
  pictureAllowed: true,
  canAct: true,
  ...value,
});

const waitingForPhone = problem({
  id: 'img-0877',
  originalFileName: 'IMG_0877.HEIC',
  category: MediaHealthCategory.Missing,
  fixState: 'waiting-phone',
  line: { step: 'asked-phones', outcome: 'waiting', facts: { phones: 1 } },
});
const emmas = problem({
  id: 'img-0611',
  originalFileName: 'IMG_0611.jpg',
  ownerId: 'u2',
  ownerName: 'Emma',
  category: MediaHealthCategory.Missing,
  fixState: 'missing',
  pictureAllowed: false,
  canAct: false,
  line: { step: 'asked-phones', outcome: 'not-found', facts: {} },
});
const blank = problem({
  id: 'scan-014',
  originalFileName: 'Scan_014.png',
  fixState: 'cant-repair',
  line: { step: 'checked', outcome: 'failed', facts: { cause: 'blank' } },
});
const partSaved = problem({
  id: 'img-2041',
  originalFileName: 'IMG_2041.jpg',
  fixState: 'part-saved',
  partSaved: true,
  line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92, metadataLost: false } },
});
const psd = problem({
  id: 'wedding-psd',
  originalFileName: 'Album-cover.psd',
  fixState: 'left-as-is',
  line: { step: 'unsupported', outcome: 'info', facts: { extension: '.psd' } },
});

const pages: Record<FileProblemTab, { items: FileProblemRowDto[]; total: number }> = {
  [FileProblemTab.Needs]: { items: [waitingForPhone, emmas, blank], total: 13 },
  [FileProblemTab.Fixed]: { items: [partSaved], total: 287 },
  [FileProblemTab.Kept]: { items: [psd], total: 4 },
};

const story = (row: FileProblemRowDto, value: Partial<FileProblemDto> = {}): FileProblemDto => ({
  ...row,
  steps: [
    { at: '2026-11-09T02:14:00.000Z', step: 'wont-open', outcome: 'failed', facts: { cause: 'cut-short' } },
    {
      at: '2026-11-09T02:15:00.000Z',
      step: 'repaired',
      outcome: 'ok',
      facts: { method: 'rebuilt', percentSaved: 92, metadataLost: false },
    },
    { at: '2026-11-09T02:15:00.000Z', step: 'kept-damaged', outcome: 'info', facts: {} },
  ],
  ...value,
});

const hero = () => within(screen.getByRole('region', { name: 'Damaged and missing files' }));
const row = (name: string) => within(screen.getByText(name, { selector: 'strong' }).closest('li')!);
const conflict = (message: string) => Object.assign(new Error('Conflict'), { status: 409, data: { message } });

describe('Damaged and missing files (FL-1338)', () => {
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
    at();
    auth.user.isAdmin = false;
    draft.store = undefined;
    sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: unknown })?.status === 'number');
    sdkMock.getFileProblems.mockImplementation(({ tab }) => Promise.resolve(pages[tab]));
    sdkMock.getFileProblem.mockResolvedValue(story(partSaved));
    sdkMock.getAssetInfo.mockResolvedValue({ localDateTime: '2019-03-12T16:31:00.000Z' } as never);
  });

  it('opens on what needs the person, with the three tabs and their counts', async () => {
    render(FileProblems);

    expect(await hero().findByRole('heading', { name: '13 files need you' })).toBeInTheDocument();
    expect(
      hero().getByText(
        'Frameleaf found 300 files that wouldn’t open or had gone missing, and fixed 287 of them by itself. Every damaged file is kept, so any fix can be undone.',
      ),
    ).toBeInTheDocument();
    const tabs = within(screen.getByRole('group', { name: 'Show' }));
    expect(tabs.getByRole('button', { name: 'Needs you · 13' })).toHaveAttribute('aria-pressed', 'true');
    expect(tabs.getByRole('button', { name: 'Fixed for you · 287' })).toBeInTheDocument();
    expect(tabs.getByRole('button', { name: 'Left as they are · 4' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs you' })).toBeInTheDocument();

    expect(row('IMG_0877.HEIC').getByText('Waiting for a phone')).toBeInTheDocument();
    expect(row('Scan_014.png').getByText('Needs you')).toBeInTheDocument();
    expect(
      row('Scan_014.png').getByText('The file is there, but its contents are blank. It can’t be repaired.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show 10 more' })).toBeInTheDocument();
  });

  it('flags a repair that saved only part of the picture', async () => {
    render(FileProblems);

    await fireEvent.click(await screen.findByRole('button', { name: 'Fixed for you · 287' }));

    expect(screen.getByRole('heading', { name: 'Fixed for you' })).toBeInTheDocument();
    expect(row('IMG_2041.jpg').getByText('Part saved')).toBeInTheDocument();
    expect(
      row('IMG_2041.jpg').getByText('The end of the file was cut off. 92% of the picture was saved.'),
    ).toBeInTheDocument();
  });

  it('shows another account’s file with a lock, never its picture', async () => {
    render(FileProblems);

    await screen.findByText('IMG_0611.jpg', { selector: 'strong' });
    const theirs = screen.getByText('IMG_0611.jpg', { selector: 'strong' }).closest('li')!;
    expect(within(theirs).getByText(/Only Emma sees this photo and can undo or replace it\./)).toBeInTheDocument();
    expect(within(theirs).getByText(/Emma’s library/)).toBeInTheDocument();
    expect(theirs.querySelector('img')).toBeNull();
    // the reader's own file shows its picture
    expect(
      screen.getByText('IMG_0877.HEIC', { selector: 'strong' }).closest('li')!.querySelector('img'),
    ).not.toBeNull();
  });

  it('opens a file’s What happened sheet from its address', async () => {
    at('&file=img-2041');
    render(FileProblems);

    const sheet = await screen.findByRole('dialog', { name: 'IMG_2041.jpg' });
    expect(sdkMock.getFileProblem).toHaveBeenCalledWith({ id: 'img-2041' });
    expect(await within(sheet).findByRole('heading', { name: 'What happened' })).toBeInTheDocument();
    expect(within(sheet).getByText('Repaired it')).toBeInTheDocument();
  });

  it('undoes a repair and says what that means', async () => {
    sdkMock.undoFileProblemFix.mockResolvedValue(story(partSaved, { fixState: 'cant-repair' }));
    render(FileProblems);

    await fireEvent.click(await screen.findByRole('button', { name: 'Fixed for you · 287' }));
    await fireEvent.click(screen.getByRole('button', { name: 'What happened to IMG_2041.jpg' }));
    const sheet = await screen.findByRole('dialog', { name: 'IMG_2041.jpg' });
    await fireEvent.click(await within(sheet).findByRole('button', { name: 'Undo repair' }));

    expect(sdkMock.undoFileProblemFix).toHaveBeenCalledWith({ id: 'img-2041' });
    expect(
      await screen.findByText(
        'Undone. IMG_2041.jpg is the damaged file again, and it won’t be repaired again unless you ask.',
      ),
    ).toBeInTheDocument();
  });

  it('says why a fix can’t be undone, in the server’s words', async () => {
    sdkMock.undoFileProblemFix.mockRejectedValue(
      conflict("This photo changed since Frameleaf fixed it, so it can't be undone."),
    );
    render(FileProblems);

    await fireEvent.click(await screen.findByRole('button', { name: 'Fixed for you · 287' }));
    await fireEvent.click(screen.getByRole('button', { name: 'What happened to IMG_2041.jpg' }));
    const sheet = await screen.findByRole('dialog', { name: 'IMG_2041.jpg' });
    await fireEvent.click(await within(sheet).findByRole('button', { name: 'Undo repair' }));

    expect(
      await within(sheet).findByText("This photo changed since Frameleaf fixed it, so it can't be undone."),
    ).toBeInTheDocument();
  });

  it('shows a member the promise but not the server’s switches', async () => {
    render(FileProblems);

    await hero().findByRole('heading', { name: '13 files need you' });
    expect(screen.queryByRole('heading', { name: 'What Frameleaf does by itself' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing is deleted to fix a file')).toBeInTheDocument();
  });

  it('gives an administrator the switches, bound to the settings being edited', async () => {
    auth.user.isAdmin = true;
    const store = newStore();
    render(FileProblems);

    expect(await screen.findByRole('heading', { name: 'What Frameleaf does by itself' })).toBeInTheDocument();
    // the promise style: it always looks, so it says "Always", not "On"
    const look = screen.getByRole('switch', { name: 'Look for missing files' });
    expect(look).toBeDisabled();
    expect(look).toHaveTextContent('Always');

    await fireEvent.click(screen.getByRole('switch', { name: 'Repair damaged photos by themselves' }));
    expect(store.draft.libraryCare?.autoRepair).toBe(false);
    expect(
      screen.getByText('Off: damaged photos wait in Needs you, where you see each repair before choosing it.'),
    ).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('switch', { name: 'Ask phones for missing photos' }));
    expect(store.draft.libraryCare?.askPhones).toBe(false);
    expect(screen.getByText('Nothing is deleted to fix a file')).toBeInTheDocument();
  });

  it('says so when nothing has needed fixing', async () => {
    sdkMock.getFileProblems.mockResolvedValue({ items: [], total: 0 });
    render(FileProblems);

    expect(await hero().findByRole('heading', { name: 'Every file is there and opens' })).toBeInTheDocument();
    expect(
      screen.getByText('Nothing needs you. Anything Frameleaf can’t fix by itself waits here.'),
    ).toBeInTheDocument();
  });
});
