import { QueueName } from '@immich/sdk';
import {
  historyFor,
  JOB_HISTORY_LIMIT,
  JOB_HISTORY_STORAGE_KEY,
  readJobHistory,
  recordJobHistory,
  type JobHistoryEntry,
} from './job-history';

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  };
};

const entry = (id: string, queue?: QueueName): JobHistoryEntry => ({
  id,
  at: '2026-09-24T10:00:00.000Z',
  title: `Command ${id}`,
  queue,
  affected: 1,
});

describe('Job manager queue action history (FL-71)', () => {
  it('keeps the newest commands first, at most 120', () => {
    const storage = memory();
    for (let index = 0; index < JOB_HISTORY_LIMIT + 5; index++) {
      recordJobHistory(entry(String(index), QueueName.Ocr), storage);
    }
    const history = readJobHistory(storage);
    expect(history).toHaveLength(JOB_HISTORY_LIMIT);
    expect(history[0].id).toBe(String(JOB_HISTORY_LIMIT + 4));
  });

  it('scopes the history to one queue', () => {
    const entries = [entry('1', QueueName.Ocr), entry('2', QueueName.Library), entry('3')];
    expect(historyFor(entries, QueueName.Ocr).map(({ id }) => id)).toEqual(['1']);
    expect(historyFor(entries).map(({ id }) => id)).toEqual(['1', '2', '3']);
  });

  it('reads unreadable or malformed storage as empty and survives a storage that refuses writes', () => {
    const storage = memory();
    storage.setItem(JOB_HISTORY_STORAGE_KEY, '{not json');
    expect(readJobHistory(storage)).toEqual([]);
    storage.setItem(JOB_HISTORY_STORAGE_KEY, JSON.stringify([{ id: 1 }, entry('ok')]));
    expect(readJobHistory(storage).map(({ id }) => id)).toEqual(['ok']);

    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('quota');
      },
    };
    expect(recordJobHistory(entry('a'), refusing)).toEqual([entry('a')]);
    expect(readJobHistory(undefined)).toEqual([]);
  });
});
