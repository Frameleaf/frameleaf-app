import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaRepository } from 'src/repositories/media.repository.js';
import { AudioChannelPolicy, getDeliveryAudioChannelArgs, validateAudioMaster } from 'src/utils/media-policy.js';

/**
 * FL-102: the edited-master audio check against real ffmpeg output. A 5.1 source is generated
 * here rather than committed, then rendered the ways a master can go right or wrong, and each
 * result is probed by the production `MediaRepository.probe`.
 */
const hasFfmpeg = (() => {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasFfmpeg)('edited-master audio validation on real media (FL-102)', () => {
  let folder: string;
  let media: MediaRepository;
  const ffmpeg = (...args: string[]) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'pipe' });

  beforeAll(() => {
    folder = mkdtempSync(join(tmpdir(), 'fl-102-audio-'));
    media = new MediaRepository(LoggingRepository.create());
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=320x240:rate=30000/1001:duration=3',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=48000:duration=3',
      '-filter_complex',
      '[1:a]pan=5.1|FL=c0|FR=c0|FC=c0|LFE=c0|BL=c0|BR=c0[a]',
      '-map',
      '0:v',
      '-map',
      '[a]',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-shortest',
      join(folder, 'source.mp4'),
    );
  });

  afterAll(() => rmSync(folder, { recursive: true, force: true }));

  const render = (name: string, audioArgs: string[]) => {
    const output = join(folder, name);
    ffmpeg('-i', join(folder, 'source.mp4'), '-c:v', 'libx264', '-c:a', 'aac', ...audioArgs, output);
    return output;
  };

  const validate = async (path: string, policy = AudioChannelPolicy.Preserve) => {
    const source = (await media.probe(join(folder, 'source.mp4'))).audioStreams[0];
    const master = await media.probe(path);
    return () =>
      validateAudioMaster({
        source,
        output: master.audioStreams[0],
        outputVideo: master.videoStreams[0],
        policy,
      });
  };

  it('probes the generated source as 5.1 at 48 kHz with stream durations', async () => {
    const source = await media.probe(join(folder, 'source.mp4'));
    expect(source.audioStreams[0]).toMatchObject({ channels: 6, channelLayout: '5.1', sampleRate: 48_000 });
    expect(source.audioStreams[0].duration).toBeGreaterThan(2.9);
    expect(source.videoStreams[0].duration).toBeGreaterThan(2.9);
  });

  it('reports a layout ffprobe cannot name as unknown rather than as a layout called "unknown"', async () => {
    const path = join(folder, 'side.m4a');
    ffmpeg(
      '-f',
      'lavfi',
      '-i',
      'sine=sample_rate=48000:duration=1',
      '-af',
      'pan=5.1(side)|FL=c0|FR=c0|FC=c0|LFE=c0|SL=c0|SR=c0',
      '-c:a',
      'aac',
      path,
    );
    const [audio] = (await media.probe(path)).audioStreams;
    expect(audio.channels).toBe(6);
    expect(audio.channelLayout === null || typeof audio.channelLayout === 'string').toBe(true);
    expect(audio.channelLayout).not.toBe('unknown');
  });

  it('accepts a master rendered with the preserving channel arguments', async () => {
    const source = (await media.probe(join(folder, 'source.mp4'))).audioStreams[0];
    const path = render('preserved.mp4', getDeliveryAudioChannelArgs(source, AudioChannelPolicy.Preserve));
    expect(await validate(path)).not.toThrow();
  });

  it('refuses a silent stereo downmix, and accepts it only when chosen', async () => {
    const path = render('stereo.mp4', ['-ac', '2']);
    expect(await validate(path)).toThrow('audio channels instead of 6');
    expect(await validate(path, AudioChannelPolicy.DownmixStereo)).not.toThrow();
  });

  it('refuses a master whose audio stops before the picture', async () => {
    const path = render('short.mp4', ['-af', 'atrim=0:2']);
    expect(await validate(path)).toThrow('drift apart');
  });

  it('refuses a master with no audio', async () => {
    const path = render('silent.mp4', ['-an']);
    expect(await validate(path)).toThrow('missing');
  });
});
