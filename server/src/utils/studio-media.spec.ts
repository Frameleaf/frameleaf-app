import { defaults } from 'src/dtos/config.dto.js';
import {
  PeakAccumulator,
  decodeWaveformPeaks,
  encodeWaveformPeaks,
  getFilmstripFrameCommand,
  getWaveformCommand,
  planFilmstrip,
  resampleWaveformPeaks,
  studioMediaFingerprint,
  waveformChannelCount,
} from 'src/utils/studio-media.js';

const pcm = (...samples: number[]) => {
  const buffer = Buffer.alloc(samples.length * 2);
  for (const [index, sample] of samples.entries()) {
    buffer.writeInt16LE(sample, index * 2);
  }
  return buffer;
};

describe('studio media', () => {
  describe('planFilmstrip', () => {
    it('samples the centre of equal slices and lays tiles out in rows', () => {
      const plan = planFilmstrip({
        durationMs: 10_000,
        width: 1920,
        height: 1080,
        rotation: 0,
        count: 5,
        tileHeight: 90,
      });
      expect(plan.timesMs).toEqual([1000, 3000, 5000, 7000, 9000]);
      expect(plan).toMatchObject({
        tileWidth: 160,
        tileHeight: 90,
        columns: 5,
        rows: 1,
        spriteWidth: 800,
        spriteHeight: 90,
      });
    });

    it('swaps the dimensions of a rotated video', () => {
      const plan = planFilmstrip({
        durationMs: 1000,
        width: 1920,
        height: 1080,
        rotation: -90,
        count: 1,
        tileHeight: 160,
      });
      expect(plan.tileWidth).toBe(90);
    });

    it('wraps rows at 4096 pixels and clamps extreme aspect ratios', () => {
      const plan = planFilmstrip({
        durationMs: 60_000,
        width: 8000,
        height: 1000,
        rotation: 0,
        count: 120,
        tileHeight: 240,
      });
      expect(plan.tileWidth).toBe(720);
      expect(plan.columns).toBe(5);
      expect(plan.rows).toBe(24);
      expect(plan.spriteWidth).toBeLessThanOrEqual(4096);
    });

    it('keeps timestamps inside a zero or tiny duration', () => {
      expect(
        planFilmstrip({ durationMs: 0, width: 0, height: 0, rotation: 0, count: 3, tileHeight: 90 }).timesMs,
      ).toEqual([0, 0, 0]);
    });
  });

  it('seeks to the frame and scales it to the requested height', () => {
    const command = getFilmstripFrameCommand(
      defaults.ffmpeg,
      { index: 0, colorTransfer: 'bt709', colorPrimaries: 'bt709' } as never,
      1500,
      90,
    );
    expect(command.inputOptions).toEqual(['-ss', '1.500']);
    expect(command.outputOptions).toEqual(expect.arrayContaining(['-frames:v', '1', '-c:v', 'mjpeg']));
    expect(command.outputOptions.join(' ')).toContain('scale=-2:90');
  });

  it('decodes the first audio stream to 8 kHz s16le with the requested channels', () => {
    const audio = { index: 2, codecName: 'aac', profile: null, bitrate: 0, channels: 6 };
    expect(waveformChannelCount(audio, 'mono')).toBe(1);
    expect(waveformChannelCount(audio, 'all')).toBe(6);
    expect(waveformChannelCount({ ...audio, channels: 12 }, 'all')).toBe(8);
    expect(waveformChannelCount({ ...audio, channels: null }, 'all')).toBe(2);
    expect(getWaveformCommand(audio, 1).outputOptions).toEqual(
      expect.arrayContaining(['-map', '0:2', '-ac', '1', '-ar', '8000', '-f', 's16le']),
    );
  });

  it('fingerprints the path, size and modification time', () => {
    const base = { path: '/a.mp4', size: 10, mtimeMs: 1000.4 };
    expect(studioMediaFingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(studioMediaFingerprint(base)).toBe(studioMediaFingerprint({ ...base, mtimeMs: 1000.9 }));
    expect(studioMediaFingerprint(base)).not.toBe(studioMediaFingerprint({ ...base, size: 11 }));
    expect(studioMediaFingerprint(base)).not.toBe(studioMediaFingerprint({ ...base, path: '/b.mp4' }));
  });

  describe('PeakAccumulator', () => {
    it('keeps the min and max of every bucket per channel, across split chunks', () => {
      const accumulator = new PeakAccumulator(2, 2);
      const bytes = pcm(100, -5, -200, 7, 50, 30, 60, -40, 1, 2);
      accumulator.write(bytes.subarray(0, 3));
      accumulator.write(bytes.subarray(3));
      const peaks = accumulator.finish();
      expect(peaks).toMatchObject({ channels: 2, bucketCount: 3, frameCount: 5, samplesPerBucket: 2 });
      expect([...peaks.peaks]).toEqual([-200, 100, -5, 7, 50, 60, -40, 30, 1, 1, 2, 2]);
    });

    it('halves its resolution instead of growing past the cap', () => {
      const accumulator = new PeakAccumulator(1, 1, 4);
      accumulator.write(pcm(1, 2, 3, 4, 5, 6, 7, 8, 9));
      const peaks = accumulator.finish();
      expect(peaks.bucketCount).toBeLessThan(4);
      expect(peaks.samplesPerBucket).toBeGreaterThan(1);
      expect(peaks.frameCount).toBe(9);
      expect(Math.min(...peaks.peaks)).toBe(1);
      expect(Math.max(...peaks.peaks)).toBe(9);
    });
  });

  describe('waveform cache', () => {
    it('round-trips through its binary form', () => {
      const accumulator = new PeakAccumulator(2, 4);
      accumulator.write(pcm(...Array.from({ length: 40 }, (_, index) => (index % 2 ? -index : index) * 100)));
      const peaks = accumulator.finish();
      expect(decodeWaveformPeaks(encodeWaveformPeaks(peaks))).toEqual(peaks);
    });

    it('stores a video without audio as zero channels', () => {
      const silent = {
        channels: 0,
        sampleRate: 1,
        samplesPerBucket: 1,
        bucketCount: 0,
        frameCount: 0,
        peaks: new Int16Array(),
      };
      expect(decodeWaveformPeaks(encodeWaveformPeaks(silent))).toEqual(silent);
    });

    it('rejects truncated or foreign bytes', () => {
      const encoded = encodeWaveformPeaks(new PeakAccumulator(1, 1).finish());
      expect(decodeWaveformPeaks(Buffer.from('not a cache'))).toBeNull();
      expect(decodeWaveformPeaks(Buffer.concat([encoded, Buffer.from([1])]))).toBeNull();
    });
  });

  describe('resampleWaveformPeaks', () => {
    const accumulator = new PeakAccumulator(1, 1);
    accumulator.write(pcm(-32_768, 16_384, 0, 8192, -8192, 32_767, 0, 0));
    const peaks = accumulator.finish();

    it('merges cached buckets into the requested count, normalized', () => {
      const result = resampleWaveformPeaks(peaks, 2);
      expect(result.bucketCount).toBe(2);
      expect(result.channels).toEqual([{ min: [-1, -0.25], max: [0.5, 1] }]);
      expect(result.durationMs).toBe(1);
    });

    it('never returns more buckets than were cached', () => {
      expect(resampleWaveformPeaks(peaks, 1000).bucketCount).toBe(8);
    });
  });
});
