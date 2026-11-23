import { join } from 'node:path';
import type { VideoInfo } from 'src/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder, SystemMetadataKey } from 'src/enum.js';
import { DesktopAssistancePolicyRegistry, householdDevices } from 'src/utils/desktop-assistance-policy.js';

/** Not a `SystemMetadataKey` member: `enum.ts` is hashed into the schema catalog, and this adds no schema. */
export const DESKTOP_TRANSCODE_PRESENCE_KEY = 'frameleaf-desktop-transcode-presence' as SystemMetadataKey;
export const DESKTOP_TRANSCODE_LEASE_MS = 120_000;
/** A desktop that has not asked for a conversion for this long is not waited for. */
export const DESKTOP_TRANSCODE_PRESENCE_MS = DESKTOP_TRANSCODE_LEASE_MS + 30_000;
/** After a desktop attempt ends, the job that follows encodes here instead of offering the video again. */
export const DESKTOP_TRANSCODE_FALLBACK_MS = 60 * 60 * 1000;
export const DESKTOP_TRANSCODE_MIN_OUTPUT_BYTES = 1024 ** 3;
/** An uploaded file waits this long for its job to validate it; the desktop has stopped renewing the lease. */
export const DESKTOP_TRANSCODE_VALIDATION_MS = 60 * 60 * 1000;

/** Written one device at a time with `setEntry`, so desktops never overwrite each other. */
export type DesktopTranscodePresence = { devices?: Record<string, { ownerId: string; at: string }> };

export type DesktopTranscodeSource = {
  locked: boolean;
  /** Any 360° projection, stitched or already equirectangular. */
  spherical: boolean;
  cinemaRaw: boolean;
  dolbyVision: boolean;
  logConversion: boolean;
};

/** Why this video stays on the server; undefined when a desktop may convert it. */
export const desktopTranscodeRefusal = (source: DesktopTranscodeSource) => {
  if (source.locked) return 'locked';
  if (source.spherical) return 'spherical';
  if (source.cinemaRaw) return 'cinema-raw';
  if (source.dolbyVision) return 'dolby-vision';
  // The conversion's filter names a colour file on this server.
  if (source.logConversion) return 'log-conversion';
};

/** On the separate household video list, and still in the household. */
export const desktopTranscodesEveryone = (
  policy: DesktopAssistancePolicyRegistry | null | undefined,
  deviceId: string,
) => !!policy && householdDevices(policy).has(deviceId) && !!policy.household?.transcodeDevices?.includes(deviceId);

/** A desktop converts its own account's videos; everyone's only on the separate household video list. */
export const desktopMayTranscode = (
  policy: DesktopAssistancePolicyRegistry | null | undefined,
  device: { id: string; ownerId: string },
  videoOwnerId: string,
) => device.ownerId === videoOwnerId || desktopTranscodesEveryone(policy, device.id);

export const hasDesktopForTranscode = (
  presence: DesktopTranscodePresence | null | undefined,
  policy: DesktopAssistancePolicyRegistry | null | undefined,
  videoOwnerId: string,
  now = Date.now(),
) =>
  Object.entries(presence?.devices ?? {}).some(
    ([id, { ownerId, at }]) =>
      now - new Date(at).getTime() < DESKTOP_TRANSCODE_PRESENCE_MS &&
      desktopMayTranscode(policy, { id, ownerId }, videoOwnerId),
  );

/** What the server planned, frozen when the video is offered, so a later settings change cannot refuse the file. */
export type DesktopTranscodeExpectation = {
  durationSeconds: number;
  /** Null when the plan keeps the stream's own codec and the source named none. */
  videoCodec: string | null;
  shortSide: number;
  aspect: number;
  hasAudio: boolean;
  audioCodec: string | null;
};

/** A desktop's file is untrusted: why it is not the planned playback copy, or undefined when it is. */
export const desktopTranscodeOutputProblem = (info: VideoInfo, expected: DesktopTranscodeExpectation) => {
  const [video] = info.videoStreams;
  if (!video) return 'no-video';
  if (expected.videoCodec && video.codecName !== expected.videoCodec) return 'video-codec';
  const short = Math.min(video.width, video.height);
  const long = Math.max(video.width, video.height);
  // Encoders round to even sizes.
  if (short <= 0 || Math.abs(short - expected.shortSide) > 2) return 'dimensions';
  if (Math.abs(long / short - expected.aspect) > expected.aspect * 0.02) return 'aspect';
  const allowance = Math.max(1, expected.durationSeconds * 0.02);
  if (Math.abs(info.format.duration - expected.durationSeconds) > allowance) return 'duration';
  const [audio] = info.audioStreams;
  if (expected.hasAudio && !audio) return 'audio-missing';
  if (!expected.hasAudio && audio) return 'audio-unexpected';
  if (expected.hasAudio && expected.audioCodec && audio.codecName !== expected.audioCodec) return 'audio-codec';
};

/** The most a desktop may upload: a bad result cannot fill the disk. */
export const desktopTranscodeMaxOutputBytes = (sourceBytes: number) =>
  Math.max(sourceBytes * 2, DESKTOP_TRANSCODE_MIN_OUTPUT_BYTES);

export const desktopTranscodeStagingFolder = (ownerId: string, operationId: string) =>
  // Not under encoded-video: the integrity and found-files scans treat what they find there as library files.
  join(StorageCore.getFolderLocation(StorageFolder.Exports, ownerId), 'desktop-transcodes', operationId);
