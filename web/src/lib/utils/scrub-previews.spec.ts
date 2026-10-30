import { filmstripToVtt } from '$lib/utils/scrub-previews';

describe('filmstripToVtt', () => {
  const filmstrip = {
    assetId: 'a',
    version: 'v',
    durationMs: 10_000,
    format: 'jpeg',
    mimeType: 'image/jpeg',
    frameWidth: 320,
    frameHeight: 180,
    columns: 2,
    rows: 2,
    spriteWidth: 640,
    spriteHeight: 360,
    frames: [
      { index: 0, timeMs: 1250, x: 0, y: 0 },
      { index: 1, timeMs: 3750, x: 320, y: 0 },
      { index: 2, timeMs: 6250, x: 0, y: 180 },
      { index: 3, timeMs: 8750, x: 320, y: 180 },
    ],
  } as const;

  it('gives every frame the slice of the video it was cut from', () => {
    const vtt = filmstripToVtt(filmstrip as never, 'https://x/api/assets/a/filmstrip/sprite?key=k');
    expect(vtt.split('\n\n').map((cue) => cue.trim())).toEqual([
      'WEBVTT',
      '00:00:00.000 --> 00:00:02.500\nhttps://x/api/assets/a/filmstrip/sprite?key=k#xywh=0,0,320,180',
      '00:00:02.500 --> 00:00:05.000\nhttps://x/api/assets/a/filmstrip/sprite?key=k#xywh=320,0,320,180',
      '00:00:05.000 --> 00:00:07.500\nhttps://x/api/assets/a/filmstrip/sprite?key=k#xywh=0,180,320,180',
      '00:00:07.500 --> 00:00:10.000\nhttps://x/api/assets/a/filmstrip/sprite?key=k#xywh=320,180,320,180',
    ]);
  });

  it('writes hours for long videos and has no cues without frames', () => {
    expect(filmstripToVtt({ ...filmstrip, durationMs: 7_200_000 } as never, 's')).toContain(
      '01:30:00.000 --> 02:00:00.000',
    );
    expect(filmstripToVtt({ ...filmstrip, frames: [] } as never, 's')).toBe('WEBVTT\n');
  });
});
