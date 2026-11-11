import { describe, expect, it } from 'vitest';
import { classifyMedia, groupMedia, MediaWatch } from './media-discovery';

describe('Find media: what a page plays (FL-1427)', () => {
  it('tells playlists, files and stream pieces apart, and ignores everything else', () => {
    expect(classifyMedia('https://cdn.example/v/master.m3u8?token=1')).toEqual({
      url: 'https://cdn.example/v/master.m3u8?token=1',
      kind: 'manifest',
    });
    expect(classifyMedia('https://cdn.example/v/manifest.mpd')?.kind).toBe(
      'manifest',
    );
    expect(classifyMedia('https://cdn.example/v/seg-1.ts')?.kind).toBe(
      'segment',
    );
    expect(classifyMedia('https://cdn.example/v/chunk-3.m4s')?.kind).toBe(
      'segment',
    );
    expect(classifyMedia('https://cdn.example/clip.MP4')?.kind).toBe('file');
    // a video element's own address counts even without a file ending
    expect(classifyMedia('https://cdn.example/play?id=1', 'media')?.kind).toBe(
      'file',
    );
    for (const other of [
      'https://cdn.example/app.js',
      'https://cdn.example/photo.jpg',
      'https://cdn.example/play?id=1',
      'blob:https://page.example/1234',
      'data:video/mp4;base64,AAAA',
      'https://user:secret@cdn.example/clip.mp4',
      'ftp://cdn.example/clip.mp4',
      `https://cdn.example/${'a'.repeat(9000)}.mp4`,
      42,
    ])
      expect(classifyMedia(other)).toBeNull();
  });

  it('lists a stream once, by its playlist, with its pieces counted under it', () => {
    const found = groupMedia([
      { url: 'https://cdn.example/show/master.m3u8', kind: 'manifest' },
      { url: 'https://cdn.example/show/720p/seg-1.ts', kind: 'segment' },
      { url: 'https://cdn.example/show/720p/seg-2.ts', kind: 'segment' },
      { url: 'https://cdn.example/show/720p/seg-3.ts', kind: 'segment' },
      { url: 'https://cdn.example/trailer.mp4', kind: 'file' },
    ]);

    expect(found).toEqual([
      expect.objectContaining({
        kind: 'stream',
        url: 'https://cdn.example/show/master.m3u8',
        parts: 3,
      }),
      expect.objectContaining({
        kind: 'file',
        url: 'https://cdn.example/trailer.mp4',
      }),
    ]);
    // no piece is ever offered as a video of its own
    expect(found.some((item) => item.url?.endsWith('.ts'))).toBe(false);
  });

  it('gives a piece to the nearest playlist above it, never to another site’s', () => {
    const found = groupMedia([
      { url: 'https://cdn.example/a/master.m3u8', kind: 'manifest' },
      { url: 'https://cdn.example/a/hd/video.m3u8', kind: 'manifest' },
      { url: 'https://cdn.example/a/hd/1.m4s', kind: 'segment' },
      { url: 'https://other.example/a/hd/1.m4s', kind: 'segment' },
    ]);

    expect(found.map((item) => [item.kind, item.host, item.parts])).toEqual([
      ['stream', 'cdn.example', 0],
      ['stream', 'cdn.example', 1],
      ['parts', 'other.example', 1],
    ]);
  });

  it('treats a run of numbered files as pieces of one stream, not as separate videos', () => {
    const found = groupMedia([
      { url: 'https://cdn.example/v/init.mp4', kind: 'file' },
      { url: 'https://cdn.example/v/chunk-001.mp4', kind: 'file' },
      { url: 'https://cdn.example/v/chunk-002.mp4', kind: 'file' },
      { url: 'https://cdn.example/v/chunk-003.mp4', kind: 'file' },
    ]);

    expect(found).toEqual([
      expect.objectContaining({ kind: 'file', name: 'init.mp4' }),
      // no playlist was seen, so there is nothing to send for these
      expect.objectContaining({ kind: 'parts', parts: 3 }),
    ]);
    expect(found[1].url).toBeUndefined();
  });

  it('counts a file asked for in several ranges once', () => {
    const found = groupMedia([
      { url: 'https://cdn.example/clip.mp4?range=0-99&sig=a', kind: 'file' },
      { url: 'https://cdn.example/clip.mp4?range=100-199&sig=b', kind: 'file' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe('https://cdn.example/clip.mp4?range=0-99&sig=a');
  });
});

describe('watching one tab (FL-1427)', () => {
  const page = 'https://page.example/watch?v=1';

  it('keeps only the watched tab’s media requests', () => {
    const watch = new MediaWatch();
    watch.start(7, page);
    watch.record(7, 'https://cdn.example/v/master.m3u8', 'other');
    watch.record(7, 'https://cdn.example/app.js', 'other');
    watch.record(8, 'https://cdn.example/other-tab.mp4', 'media');

    expect(watch.list(7, page).map((item) => item.url)).toEqual([
      'https://cdn.example/v/master.m3u8',
    ]);
    expect(watch.list(8, page)).toEqual([]);
  });

  it('forgets everything when the tab goes to another page', () => {
    const watch = new MediaWatch();
    watch.start(7, page);
    watch.record(7, 'https://cdn.example/v/master.m3u8', 'other');

    watch.navigated(7, 'https://page.example/watch?v=2');

    expect(watch.list(7, 'https://page.example/watch?v=2')).toEqual([]);
    // and what the new page loads is listed for the new page only
    watch.record(7, 'https://cdn.example/v2/master.m3u8', 'other');
    expect(watch.list(7, 'https://page.example/watch?v=2')).toHaveLength(1);
    expect(watch.list(7, page)).toEqual([]);
  });

  it('keeps the list across a change of only the #fragment, and clears it on a reload', () => {
    const watch = new MediaWatch();
    watch.start(7, page);
    watch.record(7, 'https://cdn.example/clip.mp4', 'media');
    watch.navigated(7, `${page}#t=30`);
    expect(watch.list(7, page)).toHaveLength(1);

    // the same address loaded again is a new document
    watch.documentChanged(7, page);
    expect(watch.list(7, page)).toEqual([]);
    expect(watch.watching(7, page)).toBe(true);
  });

  it('never shows a page what another page loaded, even if no navigation was reported', () => {
    const watch = new MediaWatch();
    watch.start(7, page);
    watch.record(7, 'https://cdn.example/clip.mp4', 'media');

    expect(watch.list(7, 'https://elsewhere.example/')).toEqual([]);
  });

  it('stops when the tab closes or another tab is watched', () => {
    const watch = new MediaWatch();
    watch.start(7, page);
    watch.record(7, 'https://cdn.example/clip.mp4', 'media');
    watch.closed(7);
    expect(watch.watching(7, page)).toBe(false);
    expect(watch.list(7, page)).toEqual([]);

    watch.start(7, page);
    watch.record(7, 'https://cdn.example/clip.mp4', 'media');
    watch.start(9, 'https://second.example/');
    expect(watch.list(7, page)).toEqual([]);
  });
});
