import type { StudioReverseSource } from 'src/utils/studio-reverse-conform.js';
import { StudioReverseConformRepository } from 'src/repositories/studio-reverse-conform.repository.js';

const ffmpeg = vi.hoisted(() => vi.fn());
vi.mock('fluent-ffmpeg', () => ({ default: ffmpeg }));

const source: StudioReverseSource = {
  width: 32,
  height: 32,
  frames: 3,
  frameRate: { num: 3, den: 1 },
  duration: 1,
  videoIndex: 0,
  audioIndex: null,
  channels: null,
  sampleRate: null,
};

it.each(['reverse', 'preview'] as const)('detaches cancellation when %s cannot start', async (method) => {
  const failure = new Error('FFmpeg could not start');
  const command = {
    inputOptions: vi.fn().mockReturnThis(),
    outputOptions: vi.fn().mockReturnThis(),
    format: vi.fn().mockReturnThis(),
    output: vi.fn().mockReturnThis(),
    on: vi.fn().mockReturnThis(),
    run: vi.fn(() => {
      throw failure;
    }),
    kill: vi.fn(),
  };
  ffmpeg.mockReturnValue(command);
  const controller = new AbortController();
  const sut = new StudioReverseConformRepository();

  await expect(sut[method]('/source', '/output', source, controller.signal, vi.fn())).rejects.toBe(failure);
  controller.abort();

  expect(command.run).toHaveBeenCalledOnce();
  expect(command.kill).not.toHaveBeenCalled();
});
