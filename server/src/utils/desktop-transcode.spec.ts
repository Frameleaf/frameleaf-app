import { describe, expect, it } from 'vitest';
import {
  DESKTOP_TRANSCODE_MIN_OUTPUT_BYTES,
  DESKTOP_TRANSCODE_PRESENCE_MS,
  desktopMayTranscode,
  desktopTranscodeMaxOutputBytes,
  desktopTranscodeOutputProblem,
  desktopTranscodeRefusal,
  hasDesktopForTranscode,
} from 'src/utils/desktop-transcode.js';

const ownerId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const deviceId = '33333333-3333-4333-8333-333333333333';
const revisionId = '44444444-4444-4444-8444-444444444444';
const plain = {
  locked: false,
  spherical: false,
  cinemaRaw: false,
  dolbyVision: false,
  logConversion: false,
};
const policy = (household: { devices: string[]; transcodeDevices?: string[] }) => ({
  version: 1 as const,
  accounts: {},
  household: { revisionId, ...household },
});

describe('desktopTranscodeRefusal', () => {
  it('allows an ordinary video', () => {
    expect(desktopTranscodeRefusal(plain)).toBeUndefined();
  });

  it.each([
    ['locked', 'locked'],
    ['spherical', 'spherical'],
    ['cinemaRaw', 'cinema-raw'],
    ['dolbyVision', 'dolby-vision'],
    ['logConversion', 'log-conversion'],
  ])('keeps %s on the server', (field, reason) => {
    expect(desktopTranscodeRefusal({ ...plain, [field]: true })).toBe(reason);
  });
});

describe('desktopMayTranscode', () => {
  const device = { id: deviceId, ownerId };

  it("takes its own account's video", () => {
    expect(desktopMayTranscode(null, device, ownerId)).toBe(true);
  });

  it("does not take another account's video as a household AI computer alone", () => {
    expect(desktopMayTranscode(policy({ devices: [deviceId] }), device, otherId)).toBe(false);
  });

  it("takes another account's video only on the household video list", () => {
    expect(desktopMayTranscode(policy({ devices: [deviceId], transcodeDevices: [deviceId] }), device, otherId)).toBe(
      true,
    );
  });

  it('ignores a video list entry that left the household', () => {
    expect(desktopMayTranscode(policy({ devices: [], transcodeDevices: [deviceId] }), device, otherId)).toBe(false);
  });
});

describe('hasDesktopForTranscode', () => {
  const now = Date.parse('2026-11-22T12:00:00.000Z');
  const seen = (age: number) => ({ devices: { [deviceId]: { ownerId, at: new Date(now - age).toISOString() } } });

  it('finds a desktop that asked recently', () => {
    expect(hasDesktopForTranscode(seen(1000), null, ownerId, now)).toBe(true);
  });

  it('does not wait for a desktop that went away', () => {
    expect(hasDesktopForTranscode(seen(DESKTOP_TRANSCODE_PRESENCE_MS), null, ownerId, now)).toBe(false);
  });

  it("does not count a desktop that may not take this owner's video", () => {
    expect(hasDesktopForTranscode(seen(1000), null, otherId, now)).toBe(false);
  });
});

describe('desktopTranscodeMaxOutputBytes', () => {
  it('allows twice the source, with a floor for short clips', () => {
    expect(desktopTranscodeMaxOutputBytes(10)).toBe(DESKTOP_TRANSCODE_MIN_OUTPUT_BYTES);
    expect(desktopTranscodeMaxOutputBytes(4 * 1024 ** 3)).toBe(8 * 1024 ** 3);
  });
});

describe('desktopTranscodeOutputProblem', () => {
  const expected = {
    durationSeconds: 100,
    videoCodec: 'h264',
    shortSide: 720,
    aspect: 16 / 9,
    hasAudio: true,
    audioCodec: 'aac',
  };
  const info = (video: object = {}, duration = 100, audio: object[] = [{ codecName: 'aac' }]) =>
    ({
      format: { duration, bitrate: 1 },
      videoStreams: [{ width: 1280, height: 720, codecName: 'h264', ...video }],
      audioStreams: audio,
    }) as never;

  it('accepts the planned file, also when rotated', () => {
    expect(desktopTranscodeOutputProblem(info(), expected)).toBeUndefined();
    expect(desktopTranscodeOutputProblem(info({ width: 720, height: 1280 }), expected)).toBeUndefined();
  });

  it.each([
    ['video-codec', info({ codecName: 'hevc' })],
    ['dimensions', info({ width: 1920, height: 1080 })],
    ['aspect', info({ width: 960, height: 720 })],
    ['duration', info({}, 90)],
    ['audio-missing', info({}, 100, [])],
    ['audio-codec', info({}, 100, [{ codecName: 'mp3' }])],
  ])('refuses %s', (problem, output) => {
    expect(desktopTranscodeOutputProblem(output, expected)).toBe(problem);
  });

  it('refuses audio the plan does not include, and accepts a matching silent file', () => {
    const silent = { ...expected, hasAudio: false, audioCodec: null };
    expect(desktopTranscodeOutputProblem(info(), silent)).toBe('audio-unexpected');
    expect(desktopTranscodeOutputProblem(info({}, 100, []), silent)).toBeUndefined();
  });

  it('refuses a file with no picture', () => {
    expect(
      desktopTranscodeOutputProblem(
        { format: { duration: 100, bitrate: 1 }, videoStreams: [], audioStreams: [] },
        expected,
      ),
    ).toBe('no-video');
  });
});
