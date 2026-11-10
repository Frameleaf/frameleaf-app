import { Level, Worker } from '@frameleaf/sdk';
import {
  downloadName,
  mergeLines,
  retryDelay,
  shows,
  streamPath,
  type ServerLogLine,
} from '$lib/frameleaf/server-logs';

const line = (id: string, at: string, level = Level.Log): ServerLogLine => ({
  id,
  at,
  level,
  worker: Worker.Api,
  context: 'Test',
  message: id,
});

describe('server logs (FL-893)', () => {
  it('keeps each line once, oldest first, and only the newest ones past the limit', () => {
    const page = [line('c', '2026-11-10T10:00:03.000Z'), line('b', '2026-11-10T10:00:02.000Z')];
    const shown = mergeLines([], page);
    expect(shown.map(({ id }) => id)).toEqual(['b', 'c']);

    const tail = mergeLines(shown, [line('c', '2026-11-10T10:00:03.000Z'), line('d', '2026-11-10T10:00:04.000Z')]);
    expect(tail.map(({ id }) => id)).toEqual(['b', 'c', 'd']);

    const late = mergeLines(tail, [line('a', '2026-11-10T10:00:01.000Z')], 3);
    expect(late.map(({ id }) => id)).toEqual(['b', 'c', 'd']);
    expect(mergeLines(tail, [])).toBe(tail);
  });

  it('shows a level and anything more serious', () => {
    expect(shows(line('a', '', Level.Fatal), 'problems')).toBe(true);
    expect(shows(line('a', '', Level.Warn), 'problems')).toBe(false);
    expect(shows(line('a', '', Level.Warn), 'warnings')).toBe(true);
    expect(shows(line('a', '', Level.Debug), 'normal')).toBe(false);
    expect(shows(line('a', '', Level.Verbose), 'detailed')).toBe(true);
  });

  it('names downloads and the stream, and waits longer after each failed try', () => {
    expect(downloadName(72, new Date('2026-11-10T12:00:00Z'))).toBe('frameleaf-logs-2026-11-10-last-72h.zip');
    expect(streamPath({})).toBe('/admin/logs/stream');
    expect(streamPath({ worker: Worker.MachineLearning, q: 'faces model' })).toBe(
      '/admin/logs/stream?worker=machine-learning&q=faces+model',
    );
    expect([0, 1, 2, 10].map((attempt) => retryDelay(attempt))).toEqual([2000, 4000, 8000, 30_000]);
  });
});
