/**
 * FL-1560: SMPTE timecode, as Studio's graph protocol specifies it (section 3.6): a label
 * `HH:MM:SS:FF` for each frame, or `HH:MM:SS;FF` when it is drop-frame.
 *
 * Drop-frame counting is defined only for the NTSC rates 30000/1001 and 60000/1001: labels 00 and 01
 * (00 to 03 at 59.94) are skipped at the start of every minute except each tenth one, so the label
 * keeps pace with the clock. At every other rate a timecode counts every frame, whatever separator it
 * was written with.
 */

export type TimecodeRate = { num: number; den: number };

const PATTERN = /^(\d{2}):(\d{2}):(\d{2})([:;.,])(\d{2,3})$/;
const DAY_SECONDS = 24 * 60 * 60;

/**
 * The start timecode a file records, in its canonical form: two digits each for hours, minutes and
 * seconds, `;` before the frames when it is drop-frame (ffmpeg also writes `.` and `,`) and `:`
 * otherwise. Anything else, an hour of 24 or more included, is no timecode at all.
 */
export function normalizeTimecode(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = PATTERN.exec(value.trim());
  if (!match) {
    return null;
  }
  const [, hours, minutes, seconds, separator, frames] = match;
  if (Number(hours) >= 24 || Number(minutes) >= 60 || Number(seconds) >= 60) {
    return null;
  }
  return `${hours}:${minutes}:${seconds}${separator === ':' ? ':' : ';'}${frames}`;
}

/** Whether a canonical timecode is written as drop-frame. */
export const isDropFrameTimecode = (timecode: string): boolean => timecode.charAt(8) === ';';

/** Frames per labelled second: 30 for 30000/1001, 25 for 25. */
export function nominalFrames(rate: TimecodeRate): number | null {
  if (!Number.isSafeInteger(rate.num) || !Number.isSafeInteger(rate.den) || rate.num <= 0 || rate.den <= 0) {
    return null;
  }
  const nominal = Math.round(rate.num / rate.den);
  return nominal > 0 ? nominal : null;
}

/** Labels skipped each minute when the rate counts drop-frame: 2 at 29.97, 4 at 59.94, 0 otherwise. */
export function droppedPerMinute(rate: TimecodeRate): number {
  if (rate.num * 1001 === rate.den * 30_000) {
    return 2;
  }
  if (rate.num * 1001 === rate.den * 60_000) {
    return 4;
  }
  return 0;
}

/**
 * The frame count a timecode names, counted from 00:00:00:00 at `rate`. Drop-frame counting applies
 * when the timecode is written as drop-frame and the rate is 29.97 or 59.94. Null when the label
 * does not exist at that rate: frames beyond the second, or a label drop-frame skips.
 */
export function timecodeToFrames(timecode: string, rate: TimecodeRate): number | null {
  const canonical = normalizeTimecode(timecode);
  const nominal = nominalFrames(rate);
  if (!canonical || !nominal) {
    return null;
  }
  const [hours, minutes, seconds, frames] = canonical.split(/[:;]/).map(Number);
  if (frames >= nominal) {
    return null;
  }
  const dropped = isDropFrameTimecode(canonical) ? droppedPerMinute(rate) : 0;
  if (dropped > 0 && seconds === 0 && frames < dropped && minutes % 10 !== 0) {
    return null;
  }
  const totalMinutes = hours * 60 + minutes;
  const labels = (totalMinutes * 60 + seconds) * nominal + frames;
  return labels - dropped * (totalMinutes - Math.floor(totalMinutes / 10));
}

/**
 * The label of a frame counted from 00:00:00:00 at `rate`, wrapping every 24 hours. Drop-frame is
 * used only when asked for and the rate is 29.97 or 59.94.
 */
export function framesToTimecode(frame: number, rate: TimecodeRate, dropFrame: boolean): string | null {
  const nominal = nominalFrames(rate);
  if (!nominal || !Number.isSafeInteger(frame) || frame < 0) {
    return null;
  }
  const dropped = dropFrame ? droppedPerMinute(rate) : 0;
  let count = frame;
  if (dropped > 0) {
    const perTenMinutes = nominal * 600 - dropped * 9;
    const perMinute = nominal * 60 - dropped;
    count %= perTenMinutes * 6 * 24;
    const tens = Math.floor(count / perTenMinutes);
    const rest = count % perTenMinutes;
    // the first minute of each ten keeps every label; the nine after it each skip `dropped`
    count += dropped * 9 * tens + (rest < dropped ? 0 : dropped * Math.floor((rest - dropped) / perMinute));
  }
  count %= nominal * DAY_SECONDS;
  const pad = (value: number) => String(value).padStart(2, '0');
  const frames = count % nominal;
  const totalSeconds = Math.floor(count / nominal);
  const label = `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}`;
  return `${label}${dropped > 0 ? ';' : ':'}${pad(frames)}`;
}
