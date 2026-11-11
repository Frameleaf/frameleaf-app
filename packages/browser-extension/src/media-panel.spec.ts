import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaOperationView } from './media-api';
import {
  creatorAddress,
  defaultSaves,
  downloadRequest,
  followRequest,
  historyOf,
  InspectionWatch,
  itemSummary,
  pageChoice,
  type FollowChoices,
  type InspectionReply,
} from './media-panel';

/** FL-1449: what the Page tab's media half offers for a page, and what it sends. */
const INSPECTION = '0190a000-0000-7000-8000-000000000001';
const ITEM = '0190a000-0000-7000-8000-000000000002';
const OTHER = '0190a000-0000-7000-8000-000000000003';
const ALBUM = '33333333-3333-4333-8333-333333333333';
const operation = (
  overrides: Partial<MediaOperationView> = {},
): MediaOperationView => ({
  id: INSPECTION,
  state: 'ready',
  kind: 'item',
  provider: 'youtube',
  creator: 'Mara Ellis',
  creatorId: 'UCabcdefghijklmnopqrstuv',
  complete: true,
  limitation: null,
  error: null,
  albumId: null,
  items: [
    {
      id: ITEM,
      title: 'Building the loft',
      kind: 'video',
      creator: 'Mara Ellis',
    },
  ],
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
  ...overrides,
});
const feed = (overrides: Partial<MediaOperationView> = {}) =>
  operation({ kind: 'feed', ...overrides });
const choices = (overrides: Partial<FollowChoices> = {}): FollowChoices => ({
  platform: 'youtube',
  reach: 'recent',
  since: '',
  saves: defaultSaves('youtube'),
  quality: 'best',
  interval: 60,
  ...overrides,
});

describe('what the media half of the Page tab is, from the page’s address', () => {
  it.each([
    [
      'https://www.youtube.com/@maraellis',
      'Follow this channel',
      'Save what they post on YouTube',
    ],
    [
      'https://x.com/northtimber',
      'Follow this account',
      'Save what they post on X',
    ],
    [
      'https://www.pinterest.com/valleylight',
      'Follow this profile',
      'Save what they post on Pinterest',
    ],
    [
      'https://www.facebook.com/alpinelodge',
      'Follow this page',
      'Save what they post on Facebook',
    ],
  ])(
    'a whole channel, account, profile or page is followed: %s',
    (address, title, hint) => {
      expect(pageChoice(address)).toEqual(
        expect.objectContaining({ kind: 'follow', icon: 'rss', title, hint }),
      );
    },
  );

  it.each([
    ['https://www.youtube.com/watch?v=loft3', 'Download this video'],
    ['https://www.youtube.com/shorts/abc', 'Download this short'],
    ['https://www.youtube.com/playlist?list=PL1', 'Download this playlist'],
    ['https://x.com/northtimber/status/184', 'Download this post'],
    ['https://www.pinterest.com/pin/123/', 'Download this pin'],
  ])(
    'one video or post is downloaded, never followed: %s',
    (address, title) => {
      expect(pageChoice(address)).toEqual(
        expect.objectContaining({
          kind: 'download',
          icon: 'download',
          title,
          hint: 'Just this, with its title and tags',
        }),
      );
    },
  );

  it.each([
    'https://alpinelodge.example/rooms/loft',
    // a platform's own pages that are neither one creator nor one post
    'https://www.youtube.com/',
    'chrome://extensions',
    '',
    null,
  ])('any other page lists its media: %s', (address) => {
    expect(pageChoice(address)).toEqual(
      expect.objectContaining({
        kind: 'other',
        title: 'Download its media',
        hint: 'Video, pictures and sound',
      }),
    );
  });
});

describe('how far back is asked, never assumed', () => {
  it('is nothing until one is chosen, and since a date needs the date', () => {
    expect(historyOf('', '')).toBeNull();
    expect(historyOf('since', '')).toBeNull();
    expect(historyOf('since', 'yesterday')).toBeNull();
    expect(historyOf('recent', '')).toEqual({ mode: 'recent', count: 20 });
    expect(historyOf('all', '')).toEqual({ mode: 'all' });
    expect(historyOf('new', '')).toEqual({ mode: 'new' });
    expect(historyOf('since', '2026-01-01')).toEqual({
      mode: 'since',
      since: new Date('2026-01-01T00:00:00').toISOString(),
    });
  });

  it('nothing is sent to follow a creator until it is chosen', () => {
    expect(followRequest(feed(), choices({ reach: '' }))).toBeNull();
    expect(followRequest(feed(), choices({ reach: 'since' }))).toBeNull();
    expect(followRequest(feed(), choices({ reach: 'new' }))).not.toBeNull();
  });

  it('downloading one video and following its creator too needs it as well', () => {
    // the download alone needs no such choice
    expect(
      downloadRequest(operation(), {
        label: 'A',
        video: true,
        quality: 'best',
      }),
    ).not.toBeNull();
    expect(followRequest(feed(), choices({ reach: '' }))).toBeNull();
  });
});

describe('what following sends', () => {
  it('carries how far back, what to save, the quality and how often', () => {
    expect(
      followRequest(
        feed(),
        choices({
          saves: { videos: true, shorts: false, live: true },
          quality: '1080',
          interval: 360,
        }),
      ),
    ).toEqual({
      type: 'media-subscribe',
      label: 'Mara Ellis · YouTube',
      inspectionId: INSPECTION,
      history: { mode: 'recent', count: 20 },
      saves: { videos: true, shorts: false, live: true },
      quality: '1080',
      intervalMinutes: 360,
    });
  });

  it('sends only the switches the platform has, with the design’s defaults for any left alone', () => {
    const sent = followRequest(
      feed({ provider: 'twitter' }),
      choices({
        platform: 'x',
        saves: { replies: true, shorts: true },
        quality: '720',
      }),
    );
    expect(sent?.saves).toEqual({
      images: true,
      videos: true,
      replies: true,
      reposts: false,
    });
    // the quality choice is only offered on YouTube
    expect(sent).not.toHaveProperty('quality');
    expect(sent).not.toHaveProperty('parentId');
  });

  it('never follows what your Library did not read as a creator’s own page', () => {
    expect(followRequest(operation(), choices())).toBeNull();
    expect(followRequest(feed({ state: 'inspecting' }), choices())).toBeNull();
    expect(
      followRequest(feed({ creator: null, creatorId: null }), choices()),
    ).toBeNull();
    expect(followRequest(null, choices())).toBeNull();
  });
});

describe('what a download sends', () => {
  it('names no collection when your Library knows the creator, even if one was picked earlier', () => {
    const sent = downloadRequest(operation(), {
      label: 'Building the loft',
      video: true,
      quality: '720',
      albumId: ALBUM,
    });
    expect(sent).toEqual({
      type: 'media-download',
      label: 'Building the loft',
      inspectionId: INSPECTION,
      itemIds: [ITEM],
      tagIds: [],
      overrideSuppression: false,
      quality: '720',
    });
    expect(sent).not.toHaveProperty('albumId');
  });

  it('with no creator found it waits for a collection, then sends that one', () => {
    const unknown = operation({ creator: null, creatorId: null });
    expect(
      downloadRequest(unknown, { label: 'A', video: false, quality: 'best' }),
    ).toBeNull();
    expect(
      downloadRequest(unknown, {
        label: 'A',
        video: false,
        quality: 'best',
        albumId: ALBUM,
      }),
    ).toEqual(expect.objectContaining({ albumId: ALBUM, itemIds: [ITEM] }));
  });

  it('sends everything the check found, and leaves quality out unless a video’s was changed', () => {
    const many = operation({
      items: [
        { id: ITEM, title: 'One', kind: 'image', creator: null },
        { id: OTHER, title: 'Two', kind: 'image', creator: null },
      ],
    });
    const sent = downloadRequest(many, {
      label: 'A',
      video: false,
      quality: '720',
    });
    expect(sent?.itemIds).toEqual([ITEM, OTHER]);
    expect(sent).not.toHaveProperty('quality');
    expect(
      downloadRequest(operation(), {
        label: 'A',
        video: true,
        quality: 'best',
      }),
    ).not.toHaveProperty('quality');
    expect(itemSummary(many)).toBe('2 pictures');
  });

  it('sends nothing before your Library has finished looking, or when it found nothing', () => {
    const settings = { label: 'A', video: true, quality: 'best' as const };
    expect(downloadRequest(null, settings)).toBeNull();
    expect(
      downloadRequest(operation({ state: 'inspecting' }), settings),
    ).toBeNull();
    expect(
      downloadRequest(operation({ state: 'failed' }), settings),
    ).toBeNull();
    expect(downloadRequest(operation({ items: [] }), settings)).toBeNull();
  });
});

describe('whose page "Follow them too" would follow', () => {
  it.each([
    ['https://x.com/northtimber/status/184', null, 'https://x.com/northtimber'],
    [
      'https://bsky.app/profile/someone.bsky.social/post/3k',
      null,
      'https://bsky.app/profile/someone.bsky.social',
    ],
    [
      'https://www.reddit.com/user/someone/comments/1/x/',
      null,
      'https://www.reddit.com/user/someone',
    ],
    [
      'https://www.facebook.com/alpinelodge/videos/99',
      null,
      'https://www.facebook.com/alpinelodge',
    ],
    [
      'https://www.youtube.com/watch?v=abc',
      'UCabcdefghijklmnopqrstuv',
      'https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv',
    ],
    [
      'https://www.youtube.com/watch?v=abc',
      '@maraellis',
      'https://www.youtube.com/@maraellis',
    ],
  ])('%s', (address, creatorId, expected) => {
    expect(creatorAddress(address, creatorId)).toBe(expected);
  });

  it.each([
    // the address names no account, and nothing your Library read does either
    ['https://www.youtube.com/watch?v=abc', null],
    ['https://www.youtube.com/watch?v=abc', '../../@someone/../x'],
    ['https://www.youtube.com/watch?v=abc', 'https://evil.example/@a'],
    ['https://x.com/i/status/184', null],
    ['https://www.reddit.com/r/woodworking/comments/1/x/', null],
    ['https://www.pinterest.com/pin/123/', null],
    ['https://fb.watch/abc', null],
    // already a whole account, or not a platform at all
    ['https://x.com/northtimber', null],
    ['https://alpinelodge.example/rooms/loft', '@someone'],
  ])('offers nothing when it cannot tell: %s', (address, creatorId) => {
    expect(creatorAddress(address, creatorId)).toBeNull();
  });
});

describe('a reply for a view the user has left', () => {
  const later = () => {
    let resolve!: (reply: InspectionReply) => void;
    const promise = new Promise<InspectionReply>((done) => (resolve = done));
    return { promise, resolve };
  };
  let changed: ReturnType<typeof vi.fn<(value: MediaOperationView) => void>>;
  let failed: ReturnType<typeof vi.fn<(error: string) => void>>;
  beforeEach(() => {
    vi.useFakeTimers();
    changed = vi.fn();
    failed = vi.fn();
  });
  afterEach(() => vi.useRealTimers());

  it('follows a check until it is ready', async () => {
    const read = vi
      .fn<(id: string) => Promise<InspectionReply>>()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true, operation: operation() });
    const watch = new InspectionWatch(read, changed, failed);

    await watch.begin(async () => ({
      ok: true,
      operation: operation({ state: 'inspecting' }),
    }));
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'inspecting' }),
    );
    await vi.advanceTimersByTimeAsync(1500);
    // an answer without the check in it is asked for again
    await vi.advanceTimersByTimeAsync(3000);

    expect(read).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledWith(INSPECTION);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({ state: 'ready' }),
    );
    expect(failed).not.toHaveBeenCalled();
  });

  it('changes nothing when the poll comes back after the view was left', async () => {
    const answer = later();
    const read = vi.fn(() => answer.promise);
    const watch = new InspectionWatch(read, changed, failed);
    await watch.begin(async () => ({
      ok: true,
      operation: operation({ state: 'inspecting' }),
    }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(read).toHaveBeenCalledTimes(1);
    changed.mockClear();

    watch.leave();
    answer.resolve({ ok: true, operation: operation() });
    await vi.runAllTimersAsync();

    expect(changed).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    // and it is not asked about again
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('a failed reply for a check that was left says nothing either', async () => {
    const answer = later();
    const watch = new InspectionWatch(() => answer.promise, changed, failed);
    await watch.begin(async () => ({
      ok: true,
      operation: operation({ state: 'inspecting' }),
    }));
    await vi.advanceTimersByTimeAsync(1500);
    watch.leave();
    answer.resolve({ ok: false, error: 'Gone', problem: 'grant' });
    await vi.runAllTimersAsync();
    expect(failed).not.toHaveBeenCalled();
  });

  it('a first reply that arrives after a newer check was started is dropped, whichever order they come in', async () => {
    const first = later();
    const watch = new InspectionWatch(vi.fn(), changed, failed);
    const slow = watch.begin(() => first.promise);
    await watch.begin(async () => ({
      ok: true,
      operation: operation({ id: OTHER }),
    }));

    first.resolve({ ok: true, operation: operation() });
    await slow;

    expect(changed).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ id: OTHER }),
    );
  });

  it('says why when the check it is following fails', async () => {
    const watch = new InspectionWatch(
      async () => ({
        ok: false,
        error: 'Start again from the page.',
        problem: 'refused',
      }),
      changed,
      failed,
    );
    await watch.begin(async () => ({
      ok: true,
      operation: operation({ state: 'inspecting' }),
    }));
    await vi.advanceTimersByTimeAsync(1500);
    expect(failed).toHaveBeenCalledWith(
      'Start again from the page.',
      'refused',
    );

    await watch.begin(async () => {
      throw new Error('no extension');
    });
    expect(failed).toHaveBeenLastCalledWith(
      'Could not reach the extension. Reopen it and try again.',
      undefined,
    );
  });
});
