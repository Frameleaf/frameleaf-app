import { EagleImportStatus, EagleImportTargetMode, type EagleImportResponseDto } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { importResult, planEagleImport, reconciles } from '$lib/frameleaf/eagle/eagle-import';
import {
  ServerEagleImportRun,
  libraryFromServer,
  readServerLibrary,
  runningServerImport,
} from '$lib/frameleaf/eagle/eagle-server-import.svelte';

const item = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  name: id.toLowerCase(),
  ext: 'jpg',
  size: 10,
  width: 100,
  height: 100,
  url: '',
  annotation: '',
  tags: [],
  folders: [],
  star: 0,
  isDeleted: false,
  modificationTime: 1_789_000_000_000,
  comments: [],
  present: true,
  unreadable: false,
  ...overrides,
});

const libraryDto = {
  name: 'Studio References.library',
  folders: [
    { id: 'F1', name: 'Web', parentId: null, color: 'blue' },
    { id: 'F2', name: 'Hero sections', parentId: 'F1' },
    { id: 'F3', name: 'Type', parentId: null },
  ],
  smartFolders: ['Blue tones'],
  tagGroups: [],
  changed: 1_790_000_000_000,
  items: [
    item('I1', { folders: ['F2'], tags: ['warm'], star: 5, url: 'https://example.com/a' }),
    item('I2'),
    item('I3', { present: false }),
    item('I4', { unreadable: true }),
    item('I5', { ext: 'otf' }),
  ],
  fingerprint: 'eagle:id:L1',
  supported: ['jpg', 'png'],
  earlierImport: null,
};

const importDto = (overrides: Partial<EagleImportResponseDto> = {}): EagleImportResponseDto => ({
  id: 'import-1',
  rootId: '0',
  path: 'Design/Studio References.library',
  libraryName: 'Studio References.library',
  fingerprint: 'eagle:id:L1',
  status: EagleImportStatus.Running,
  targetMode: EagleImportTargetMode.Inside,
  insideAlbumId: null,
  rootAlbumId: 'album-root',
  total: 2,
  done: 0,
  already: 0,
  collections: 3,
  failed: [],
  recent: [],
  error: null,
  createdAt: '2026-10-29T10:00:00.000Z',
  updatedAt: '2026-10-29T10:00:00.000Z',
  ...overrides,
});

describe('Eagle import from a folder the server can open', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rebuilds Eagle's folder tree and plans the check from the server's read", async () => {
    sdkMock.checkEagleLibrary.mockResolvedValue(libraryDto);
    const { library, supported } = await readServerLibrary({ rootId: '0', path: 'Design/Studio References.library' });
    expect(sdkMock.checkEagleLibrary).toHaveBeenCalledWith(
      { eagleLibraryCheckDto: { rootId: '0', path: 'Design/Studio References.library' } },
      { signal: undefined },
    );
    expect(library.folders.map(({ name, children }) => [name, children.map(({ name }) => name)])).toEqual([
      ['Web', ['Hero sections']],
      ['Type', []],
    ]);
    const plan = planEagleImport(library, { supported });
    expect(plan).toMatchObject({
      found: 5,
      coming: 2,
      missing: ['I4.info', 'i3.jpg'],
      collections: 3,
      depth: 2,
      sources: 1,
    });
    expect(plan.unsupported).toEqual([{ name: 'i5.otf', reason: 'font' }]);
  });

  it('starts on the server and follows it to the report, which adds up', async () => {
    const library = libraryFromServer(libraryDto);
    const supported = new Set(libraryDto.supported);
    sdkMock.createEagleImport.mockResolvedValue(importDto());
    sdkMock.getEagleImport
      .mockResolvedValueOnce(
        importDto({
          done: 1,
          recent: [{ id: 'I1', name: 'i1.jpg', duplicate: false, collections: ['Hero sections'] }],
        }),
      )
      .mockResolvedValueOnce(importDto({ status: EagleImportStatus.Finished, done: 2, already: 1 }))
      .mockResolvedValueOnce(
        importDto({
          status: EagleImportStatus.Finished,
          done: 2,
          already: 1,
          outcomes: { I1: { assetId: 'a1', duplicate: false }, I2: { assetId: 'a2', duplicate: true } },
        }),
      );
    const run = await ServerEagleImportRun.begin(
      { rootId: '0', path: 'Design/Studio References.library' },
      library,
      { mode: 'inside', inside: 'new' },
      ['Web'],
    );
    expect(sdkMock.createEagleImport).toHaveBeenCalledWith({
      eagleImportCreateDto: {
        rootId: '0',
        path: 'Design/Studio References.library',
        fingerprint: 'eagle:id:L1',
        targetMode: EagleImportTargetMode.Inside,
        existingTop: ['Web'],
      },
    });
    const finished = run.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(run).toMatchObject({ state: 'running', done: 1 });
    expect(run.recent[0].collections).toEqual(['Hero sections']);
    await vi.advanceTimersByTimeAsync(2000);
    await finished;
    expect(run).toMatchObject({ state: 'finished', done: 2, already: 1, rootAlbumId: 'album-root' });

    // The server finds files already here as it reads them, so the report plans again with the outcomes.
    const plan = planEagleImport(library, { supported, outcomes: run.outcomes });
    const result = importResult(plan, library, {
      outcomes: run.outcomes,
      failed: run.failed,
      collections: run.collections,
      stopped: false,
      supported,
    });
    expect(result).toMatchObject({ added: 1, already: 1, notReached: 0, sources: 1 });
    expect(reconciles(plan, result)).toBe(true);
  });

  it('carries the earlier import on into the collection it chose, and Stop asks the server', async () => {
    sdkMock.createEagleImport.mockResolvedValue(
      importDto({ targetMode: EagleImportTargetMode.Inside, insideAlbumId: 'album-x', failed: ['I2'] }),
    );
    const run = await ServerEagleImportRun.begin(
      { rootId: '0', path: 'p.library' },
      { fingerprint: 'f' },
      { mode: 'inside', inside: 'album-x' },
      [],
    );
    expect(sdkMock.createEagleImport.mock.calls[0][0].eagleImportCreateDto).toMatchObject({
      insideAlbumId: 'album-x',
    });
    expect(run.target).toEqual({ mode: 'inside', inside: 'album-x' });
    expect([...run.failed]).toEqual(['I2']);
    sdkMock.stopEagleImport.mockResolvedValue(importDto({ status: EagleImportStatus.Stopping }));
    run.stop();
    expect(run.state).toBe('stopping');
    await vi.advanceTimersByTimeAsync(0);
    expect(sdkMock.stopEagleImport).toHaveBeenCalledWith({ id: 'import-1' });
  });

  it('takes the earlier import to carry on from the server’s read, finished-with-leftovers included', async () => {
    const earlier = importDto({ id: 'old', status: EagleImportStatus.Finished, failed: ['I2'] });
    sdkMock.checkEagleLibrary.mockResolvedValue({ ...libraryDto, earlierImport: earlier });
    await expect(readServerLibrary({ rootId: '0', path: 'p.library' })).resolves.toMatchObject({
      earlier: { id: 'old', failed: ['I2'] },
    });
    sdkMock.checkEagleLibrary.mockResolvedValue({ ...libraryDto, earlierImport: null });
    await expect(readServerLibrary({ rootId: '0', path: 'p.library' })).resolves.toMatchObject({
      earlier: undefined,
    });
  });

  it('keeps following through a long outage, backing off, and never ends on its own', async () => {
    sdkMock.createEagleImport.mockResolvedValue(importDto());
    sdkMock.getEagleImport.mockRejectedValue(new Error('offline'));
    const run = await ServerEagleImportRun.begin(
      { rootId: '0', path: 'p.library' },
      { fingerprint: 'f' },
      { mode: 'top' },
      [],
    );
    let ended = false;
    void run.start().then(() => (ended = true));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(ended).toBe(false);
    expect(run.state).toBe('running');
    expect(run.unreachable).toBe(true);
    // Backed off: far fewer than one request every two seconds.
    expect(sdkMock.getEagleImport.mock.calls.length).toBeLessThan(40);

    sdkMock.getEagleImport.mockReset();
    sdkMock.getEagleImport
      .mockResolvedValueOnce(importDto({ status: EagleImportStatus.Finished, done: 2 }))
      .mockResolvedValueOnce(importDto({ status: EagleImportStatus.Finished, done: 2, outcomes: {} }));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ended).toBe(true);
    expect(run).toMatchObject({ state: 'finished', unreachable: false });
    expect(sdkMock.getEagleImport).toHaveBeenLastCalledWith({ id: 'import-1', outcomes: true });
  });

  it('finds the import the server is running', async () => {
    sdkMock.getEagleImports.mockResolvedValue({
      imports: [
        importDto({ id: 'old', status: EagleImportStatus.Stopped, path: 'other.library' }),
        importDto({ id: 'live' }),
      ],
    });
    await expect(runningServerImport()).resolves.toMatchObject({ id: 'live' });
  });
});
