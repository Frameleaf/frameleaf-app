import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { createSqlProgressStreams } from 'src/services/database-backup.service.js';

const dump = Buffer.from('BEGIN;\nCOPY media FROM stdin;\na\tb\nc\td\n\\.\nCOMMIT;\n');

afterEach(() => vi.useRealTimers());

it.each(Array.from({ length: dump.length + 1 }, (_, split) => split))(
  'preserves COPY counting and all bytes across split %i',
  async (split) => {
    vi.useFakeTimers();
    const progress = vi.fn();
    const [source, sink] = createSqlProgressStreams(progress);
    Readable.from([dump.subarray(0, split), dump.subarray(split)]).pipe(source);
    const output: Buffer[] = [];
    for await (const chunk of source) output.push(chunk);
    sink.end('BEGIN\nCOPY 2\n');
    await finished(sink);
    await vi.advanceTimersByTimeAsync(100);
    expect(Buffer.concat(output)).toEqual(dump);
    expect(progress).toHaveBeenLastCalledWith(2 / 3);
  },
);

it('keeps approximate progress before completion and caps completed progress', async () => {
  vi.useFakeTimers();
  const progress = vi.fn();
  const [source, sink] = createSqlProgressStreams(progress);
  source.resume();
  source.write('SELECT 1;\n\n');
  await vi.advanceTimersByTimeAsync(100);
  expect(progress).toHaveBeenLastCalledWith(0.11);
  source.end();
  await finished(source);
  sink.end('SELECT 1\nEXTRA\n');
  await finished(sink);
  await vi.advanceTimersByTimeAsync(100);
  expect(progress).toHaveBeenLastCalledWith(1);
});
