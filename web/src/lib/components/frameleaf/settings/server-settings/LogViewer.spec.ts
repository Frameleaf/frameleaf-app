import { getAssetInfo, Level, listServerLogs, Worker, type AssetResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import LogViewer from '$lib/components/frameleaf/settings/server-settings/LogViewer.svelte';
import type { ServerLogLine } from '$lib/frameleaf/server-logs';
import en from '../../../../../../../i18n/en.json';

/** Server logs (FL-893): the page, "Show", search, the live tail and its reconnecting, a line's details. */
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<object>()),
  listServerLogs: vi.fn(),
  getAssetInfo: vi.fn(),
  isHttpError: (error: unknown) => typeof error === 'object' && error !== null && 'status' in error,
}));
vi.mock('$app/state', () => ({ page: { url: new URL('http://localhost/user-settings?area=server&section=logs') } }));
vi.mock('$lib/frameleaf/server-logs', async (original) => ({
  ...(await original<object>()),
  retryDelay: () => 100,
}));

class FakeEventSource extends EventTarget {
  static all: FakeEventSource[] = [];
  closed = false;
  constructor(public url: string) {
    super();
    FakeEventSource.all.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.dispatchEvent(new Event('open'));
  }
  send(line: ServerLogLine) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(line) }));
  }
  fail() {
    this.dispatchEvent(new Event('error'));
  }
  static get last() {
    return FakeEventSource.all.at(-1)!;
  }
}

const assetId = '7b1f2c9e-4d3a-4f7e-9c1d-2a3b4c5d6e7f';
const line = (index: number, overrides: Partial<ServerLogLine> = {}): ServerLogLine => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  at: `2026-11-10T09:41:${String(index).padStart(2, '0')}.000Z`,
  worker: Worker.Microservices,
  level: Level.Log,
  context: 'Thumbnails',
  message: `Made previews ${index}`,
  ...overrides,
});
const PAGE = [
  line(3, { level: Level.Error, context: 'Video conversion', message: 'Couldn’t convert VID_0001.MOV', assetId }),
  line(2, { level: Level.Warn, context: 'Metadata', message: 'IMG_2041.HEIC has no date' }),
  line(1, { worker: Worker.Api, context: 'Sign in', message: 'Taylor signed in' }),
];
const lines = () => within(screen.getByRole('list', { name: en.frameleaf_logs_lines }));
const forbidden = () => Object.assign(new Error('Forbidden'), { status: 403 });

describe('Server logs (FL-893)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    FakeEventSource.all = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.mocked(listServerLogs).mockResolvedValue({ entries: PAGE, nextCursor: null });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists the newest lines oldest first, in words, and keeps only the serious ones when asked', async () => {
    render(LogViewer);

    expect(await screen.findByText('Taylor signed in')).toBeInTheDocument();
    const shown = lines().getAllByRole('button');
    expect(shown.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Taylor signed in'),
      expect.stringContaining('IMG_2041.HEIC has no date'),
      expect.stringContaining('Couldn’t convert VID_0001.MOV'),
    ]);
    expect(lines().getByText('Web · Sign in')).toBeInTheDocument();
    expect(lines().getByText(en.frameleaf_logs_level_problem)).toBeInTheDocument();
    expect(listServerLogs).toHaveBeenCalledWith({ worker: undefined, q: undefined, limit: 200 });
    expect(FakeEventSource.last.url).toBe('/api/admin/logs/stream');

    await fireEvent.change(screen.getByRole('combobox', { name: en.frameleaf_logs_show }), {
      target: { value: 'problems' },
    });
    expect(lines().getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText('Showing 1 of 3 lines.')).toBeInTheDocument();

    await fireEvent.click(screen.getAllByRole('button', { name: en.frameleaf_logs_clear })[0]);
    expect(lines().getAllByRole('button')).toHaveLength(3);
  });

  it('reads older pages to fill the screen and keeps every line in time order', async () => {
    vi.mocked(listServerLogs)
      .mockResolvedValueOnce({ entries: PAGE, nextCursor: 'cursor-1' })
      .mockResolvedValueOnce({
        entries: [
          line(0, { message: 'Older line 0', at: '2026-11-10T09:40:59.000Z' }),
          line(9, { message: 'Oldest line', at: '2026-11-10T09:40:58.000Z' }),
        ],
        nextCursor: null,
      });
    render(LogViewer);

    // fewer than a screenful shows, so the next page is read straight away
    expect(await screen.findByText('Oldest line')).toBeInTheDocument();
    expect(listServerLogs).toHaveBeenLastCalledWith({
      worker: undefined,
      q: undefined,
      before: 'cursor-1',
      limit: 200,
    });
    expect(
      lines()
        .getAllByRole('button')
        .map((row) => row.querySelector('.message')?.textContent),
    ).toEqual([
      'Oldest line',
      'Older line 0',
      'Taylor signed in',
      'IMG_2041.HEIC has no date',
      'Couldn’t convert VID_0001.MOV',
    ]);
    expect(screen.queryByRole('button', { name: en.frameleaf_logs_older })).not.toBeInTheDocument();
  });

  it('sends the search and the source to the server, and says when nothing matches', async () => {
    render(LogViewer);
    await screen.findByText('Taylor signed in');

    vi.mocked(listServerLogs).mockResolvedValue({ entries: [], nextCursor: null });
    await fireEvent.input(screen.getByRole('searchbox', { name: en.frameleaf_logs_search }), {
      target: { value: 'jasper' },
    });
    expect(await screen.findByText('Nothing matches “jasper” in the last 7 days')).toBeInTheDocument();
    expect(listServerLogs).toHaveBeenLastCalledWith({ worker: undefined, q: 'jasper', limit: 200 });

    await fireEvent.change(screen.getByRole('combobox', { name: en.frameleaf_logs_from }), {
      target: { value: Worker.MachineLearning },
    });
    await waitFor(() =>
      expect(listServerLogs).toHaveBeenLastCalledWith({ worker: Worker.MachineLearning, q: 'jasper', limit: 200 }),
    );
    expect(FakeEventSource.last.url).toBe('/api/admin/logs/stream?worker=machine-learning&q=jasper');
  });

  it('adds live lines at the bottom, holds them while paused, and shows them on request', async () => {
    render(LogViewer);
    await screen.findByText('Taylor signed in');
    FakeEventSource.last.open();
    expect(await screen.findByText(en.frameleaf_logs_live_body)).toBeInTheDocument();

    FakeEventSource.last.send(line(4, { message: 'Received 3 photos' }));
    expect(await lines().findByText('Received 3 photos')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_logs_pause }));
    FakeEventSource.last.send(line(5, { message: 'Found 2 faces' }));
    expect(await screen.findByText('1 new line is waiting.')).toBeInTheDocument();
    expect(screen.queryByText('Found 2 faces')).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_logs_show_them }));
    expect(await lines().findByText('Found 2 faces')).toBeInTheDocument();
  });

  it('says when the live tail drops, reads what it missed, and says when it is back', async () => {
    render(LogViewer);
    await screen.findByText('Taylor signed in');
    const first = FakeEventSource.last;
    first.open();

    vi.mocked(listServerLogs).mockResolvedValue({ entries: [line(6, { message: 'Started again' })], nextCursor: null });
    first.fail();
    expect(await screen.findByText(en.frameleaf_logs_reconnecting_body)).toBeInTheDocument();
    expect(first.closed).toBe(true);

    await waitFor(() => expect(FakeEventSource.all).toHaveLength(2));
    expect(listServerLogs).toHaveBeenLastCalledWith({
      worker: undefined,
      q: undefined,
      since: PAGE[0].at,
      limit: 200,
    });
    expect(await lines().findByText('Started again')).toBeInTheDocument();
    FakeEventSource.last.open();
    expect(await screen.findByText(en.frameleaf_logs_reconnected_body)).toBeInTheDocument();
  });

  it('opens a line with its fields and a link to the photo the admin can see', async () => {
    vi.mocked(getAssetInfo).mockResolvedValue({ id: assetId } as AssetResponseDto);
    render(LogViewer);
    await fireEvent.click(await screen.findByRole('button', { name: /Couldn’t convert VID_0001.MOV/ }));

    const dialog = within(await screen.findByRole('dialog', { name: en.frameleaf_logs_line_title }));
    expect(dialog.getByText(assetId)).toBeInTheDocument();
    expect(dialog.getByText('Video conversion')).toBeInTheDocument();
    expect(await dialog.findByRole('link', { name: en.frameleaf_logs_open_photo })).toHaveAttribute(
      'href',
      `/photos/${assetId}`,
    );
    expect(getAssetInfo).toHaveBeenCalledWith({ id: assetId });
  });

  it('leaves the photo link out when the photo is gone or not visible', async () => {
    vi.mocked(getAssetInfo).mockRejectedValue(new Error('Not found'));
    render(LogViewer);
    await fireEvent.click(await screen.findByRole('button', { name: /Couldn’t convert VID_0001.MOV/ }));

    const dialog = within(await screen.findByRole('dialog', { name: en.frameleaf_logs_line_title }));
    expect(dialog.getByText(assetId)).toBeInTheDocument();
    await waitFor(() => expect(getAssetInfo).toHaveBeenCalled());
    expect(dialog.queryByRole('link', { name: en.frameleaf_logs_open_photo })).not.toBeInTheDocument();
  });

  it('says when the logs could not be read, and tries again', async () => {
    vi.mocked(listServerLogs).mockRejectedValueOnce(new Error('offline'));
    render(LogViewer);

    expect(await screen.findByRole('heading', { name: en.frameleaf_logs_error_title })).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_logs_try_again }));
    expect(await screen.findByText('Taylor signed in')).toBeInTheDocument();
  });

  it('asks for a recent sign-in when the server refuses the logs away from home', async () => {
    vi.mocked(listServerLogs).mockRejectedValue(forbidden());
    render(LogViewer);

    expect(await screen.findByRole('heading', { name: en.frameleaf_logs_away_title })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: en.frameleaf_logs_sign_in_again })).toBeInTheDocument();
    expect(FakeEventSource.all).toHaveLength(0);
  });
});
