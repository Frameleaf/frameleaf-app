import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import LocationHistoryUtility from './LocationHistoryUtility.svelte';

const api = vi.hoisted(() => ({
  sources: vi.fn(),
  runs: vi.fn(),
  summary: vi.fn(),
  run: vi.fn(),
  proposals: vi.fn(),
  create: vi.fn(),
  apply: vi.fn(),
  undo: vi.fn(),
  remove: vi.fn(),
  upload: vi.fn(),
  part: vi.fn(),
  source: vi.fn(),
  geocode: vi.fn(),
}));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
  getLocationHistorySources: api.sources,
  getLocationFills: api.runs,
  getUtilitiesSummary: api.summary,
  getLocationFill: api.run,
  getLocationFillProposals: api.proposals,
  createLocationFill: api.create,
  applyLocationFill: api.apply,
  undoLocationFill: api.undo,
  deleteLocationHistorySource: api.remove,
  createLocationHistoryUpload: api.upload,
  uploadLocationHistoryPart: api.part,
  createLocationHistorySource: api.source,
  reverseGeocode: api.geocode,
}));

const source = (over = {}) => ({
  id: 's1',
  fileName: 'Timeline.json',
  kind: 'google-timeline',
  createdAt: '2026-01-01T00:00:00.000Z',
  importedAt: '2026-01-01T00:01:00.000Z',
  pointCount: 10,
  firstAt: '2019-03-02T12:00:00.000Z',
  lastAt: '2024-06-14T12:00:00.000Z',
  error: null,
  ...over,
});
const fill = (over = {}) => ({
  id: 'r1',
  createdAt: '2026-01-01T00:00:00.000Z',
  status: 'ready',
  maxGapMinutes: 15,
  from: null,
  to: null,
  candidateCount: 3,
  proposalCount: 2,
  appliedCount: 0,
  appliedAt: null,
  undoneAt: null,
  error: null,
  ...over,
});
const proposal = (assetId: string) => ({
  assetId,
  applied: false,
  gapSeconds: 120,
  latitude: 51.42,
  longitude: -116.18,
  localDateTime: '2026-08-15T08:12:00',
  method: 'nearest',
});

describe('location history', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    for (const mock of Object.values(api)) {
      mock.mockReset();
    }
    api.sources.mockResolvedValue([source()]);
    api.runs.mockResolvedValue([]);
    api.summary.mockResolvedValue({ withoutPlace: 3 });
    api.geocode.mockResolvedValue([{ city: 'Lake Louise', state: 'Alberta', country: 'Canada' }]);
    api.proposals.mockResolvedValue({
      total: 2,
      hasNextPage: false,
      days: [{ day: '2026-08-15', proposals: [proposal('a'), proposal('b')] }],
    });
  });

  it('says what to do when there is no history', async () => {
    api.sources.mockResolvedValue([]);
    render(LocationHistoryUtility);
    expect(await screen.findByRole('heading', { name: 'No location history yet' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose files…' })).toBeInTheDocument();
    expect(screen.getByLabelText('Choose location history files')).toHaveAttribute(
      'accept',
      '.json,.gpx,.rec,.geojson,.zip',
    );
    expect(screen.getByText('Your location history stays on your server')).toBeInTheDocument();
  });

  it('sends a file in parts and lists it while it is read', async () => {
    api.sources.mockResolvedValue([]);
    api.upload.mockResolvedValue({ id: 'u1', receivedBytes: 0 });
    api.part.mockResolvedValue({ id: 'u1', receivedBytes: 4 });
    api.source.mockResolvedValue(source({ importedAt: null, firstAt: null, lastAt: null, kind: null }));
    render(LocationHistoryUtility);
    await screen.findByRole('heading', { name: 'No location history yet' });
    await userEvent.upload(
      screen.getByLabelText('Choose location history files'),
      new File(['data'], 'Timeline.json', { type: 'application/json' }),
    );
    expect(await screen.findByText('Reading')).toBeInTheDocument();
    expect(api.upload).toHaveBeenCalledWith({ locationHistoryUploadCreateDto: { size: 4 } }, expect.anything());
    expect(api.part.mock.calls[0][0]).toMatchObject({ id: 'u1', offset: 0 });
    expect(api.part.mock.calls[0][1].headers).toEqual({ 'Content-Type': 'application/octet-stream' });
    expect(api.source).toHaveBeenCalledWith(
      { locationHistorySourceCreateDto: { uploadId: 'u1', fileName: 'Timeline.json' } },
      expect.anything(),
    );
  });

  it('names a file that is not history and does not send it', async () => {
    api.sources.mockResolvedValue([]);
    render(LocationHistoryUtility);
    await screen.findByRole('heading', { name: 'No location history yet' });
    const input = screen.getByLabelText('Choose location history files');
    await fireEvent.change(input, { target: { files: [new File(['x'], 'holiday.pdf')] } });
    expect(await screen.findByText('Not a location history file')).toBeInTheDocument();
    expect(api.upload).not.toHaveBeenCalled();
  });

  it('starts at 15 minutes, then applies only the ticked photos', async () => {
    api.create.mockResolvedValue(fill());
    api.apply.mockResolvedValue(fill({ status: 'applying' }));
    render(LocationHistoryUtility);
    await userEvent.click(await screen.findByRole('button', { name: 'See suggested places' }));
    expect(api.create).toHaveBeenCalledWith({ locationFillCreateDto: { maxGapMinutes: 15 } });
    const box = await screen.findAllByRole('checkbox', { name: /Add Lake Louise to the photo/ });
    await userEvent.click(box[1]);
    await userEvent.click(screen.getByRole('button', { name: 'Deselect all' }));
    await userEvent.click(box[0]);
    await userEvent.click(screen.getByRole('button', { name: 'Add a place to 1 photo' }));
    expect(api.apply).toHaveBeenCalledWith({ id: 'r1', locationFillApplyDto: { assetIds: ['a'] } });
  });

  it('applies every proposal without naming them when all are ticked', async () => {
    api.runs.mockResolvedValue([fill()]);
    api.apply.mockResolvedValue(fill({ status: 'applying' }));
    render(LocationHistoryUtility);
    await userEvent.click(await screen.findByRole('button', { name: 'Add places to 2 photos' }));
    expect(api.apply).toHaveBeenCalledWith({ id: 'r1', locationFillApplyDto: { assetIds: undefined } });
  });

  it('offers a wider time when nothing is close enough', async () => {
    api.runs.mockResolvedValue([fill({ proposalCount: 0, maxGapMinutes: 5 })]);
    render(LocationHistoryUtility);
    expect(await screen.findByText('No photos within 5 minutes of your history')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try 15 minutes' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try 60 minutes' })).toBeInTheDocument();
  });

  it('says when there is nothing to fill', async () => {
    api.summary.mockResolvedValue({ withoutPlace: 0 });
    render(LocationHistoryUtility);
    expect(await screen.findByRole('heading', { name: 'Every photo already has a place' })).toBeInTheDocument();
  });

  it('offers Undo for an applied run', async () => {
    api.runs.mockResolvedValue([fill({ status: 'applied', appliedCount: 2 })]);
    api.undo.mockResolvedValue(fill({ status: 'undoing', appliedCount: 2 }));
    render(LocationHistoryUtility);
    // Once in the banner and once in the live region that announces it.
    expect(await screen.findAllByText('Places added to 2 photos')).toHaveLength(2);
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(api.undo).toHaveBeenCalledWith({ id: 'r1' });
  });

  it('says how many could not be changed', async () => {
    api.runs.mockResolvedValue([fill({ status: 'applied', appliedCount: 1, error: 'stopped' })]);
    render(LocationHistoryUtility);
    expect(await screen.findByText('Places added to 1 of 2 photos')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'See the 1' })).toBeInTheDocument();
  });

  it('asks before removing, and says photos keep their places', async () => {
    api.remove.mockResolvedValue('');
    render(LocationHistoryUtility);
    await userEvent.click(await screen.findByRole('button', { name: 'Remove Timeline.json' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/photos that were already given a place from it keep that place/)).toBeTruthy();
    expect(api.remove).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Remove history' }));
    expect(api.remove).toHaveBeenCalledWith({ id: 's1' });
    await waitFor(() =>
      expect(screen.getByText(/was removed from your location history. Photos keep their places/)).toBeInTheDocument(),
    );
  });

  it('never says points, parse, job or queue', () => {
    const words = Object.entries(en)
      .filter(([key]) => key.startsWith('frameleaf_location_history_'))
      .map(([, value]) => String(value).toLowerCase());
    expect(words.length).toBeGreaterThan(90);
    for (const word of words) {
      expect(word).not.toMatch(/\b(points?|pars(e|ing)|jobs?|queues?|cron)\b/);
    }
  });
});
