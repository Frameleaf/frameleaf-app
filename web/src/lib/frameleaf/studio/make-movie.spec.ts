import { describe, expect, it } from 'vitest';
import {
  isBarBeat,
  movieRequest,
  movieStepLabels,
  movieStepsDone,
  percentOf,
  shortTimecode,
  shotAt,
} from './make-movie';

describe('make a movie helpers', () => {
  it('asks the server for the source and the choices made', () => {
    const album = { kind: 'album' as const, albumId: 'a1', name: 'Lake weekend', itemCount: 40 };
    expect(
      movieRequest(album, { lengthSeconds: 60, music: 'generated', mood: 'warm', songAssetId: 's1', title: '  ' }),
    ).toEqual({ albumId: 'a1', lengthSeconds: 60, music: 'generated', mood: 'warm', sourceName: 'Lake weekend' });

    const selection = {
      kind: 'selection' as const,
      assetIds: ['x', 'y'],
      name: '2 items',
      photoCount: 1,
      videoCount: 1,
    };
    expect(
      movieRequest(selection, {
        lengthSeconds: 30,
        music: 'song',
        mood: 'calm',
        songAssetId: 's1',
        title: ' Summer ',
        previousId: 'job-1',
      }),
    ).toEqual({
      assetIds: ['x', 'y'],
      lengthSeconds: 30,
      music: 'song',
      songAssetId: 's1',
      title: 'Summer',
      sourceName: '2 items',
      previousId: 'job-1',
    });

    const memory = { kind: 'memory' as const, memoryId: 'm1', name: 'A year ago', itemCount: 12 };
    expect(
      movieRequest(memory, { lengthSeconds: 180, music: 'generated', mood: 'big', songAssetId: null, title: '' }),
    ).toMatchObject({
      memoryId: 'm1',
      lengthSeconds: 180,
      mood: 'big',
    });
  });

  it('names the music step after the music', () => {
    expect(movieStepLabels('generated').music.now).toBe('frameleaf_movie_step_music');
    expect(movieStepLabels('song').music.now).toBe('frameleaf_movie_step_beat');
  });

  it('counts the steps done from the job', () => {
    expect(movieStepsDone('moments', false)).toBe(0);
    expect(movieStepsDone('music', false)).toBe(1);
    expect(movieStepsDone('title', false)).toBe(3);
    expect(movieStepsDone('done', true)).toBe(4);
  });

  it('places the preview on the movie', () => {
    const shots = [
      { start: 0, end: 4 },
      { start: 4, end: 8 },
    ];
    expect(shotAt(shots, 5)).toBe(shots[1]);
    expect(shotAt(shots, 99)).toBe(shots[0]);
    expect(percentOf(15, 60)).toBe(25);
    expect(shortTimecode(75.4)).toBe('1:15');
    expect(isBarBeat(4.01, [0, 4, 8])).toBe(true);
    expect(isBarBeat(4.5, [0, 4, 8])).toBe(false);
  });
});
