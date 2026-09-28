/**
 * The render worker contract for streamed Studio playback (FL-96, `STU-402`).
 *
 * The render worker lives outside this repository (its hardware qualification is FL-145), so this
 * file is the contract it implements, in one place, alongside the host that speaks it. The e2e
 * suite's worker double (`e2e/src/ui/mock-network/studio-stream-worker-double.ts`) implements it
 * against a real browser peer connection.
 *
 * ## Signalling (HTTP, through the server; the media never is)
 *
 * The worker claims a `studio_preview_stream` operation like any other render (FL-95), heartbeats
 * it, and while it holds it:
 *
 * 1. `POST /render-workers/operations/{id}/stream` `{ claimToken }` at least every two seconds.
 *    - `close: true` — stop sending at once, close the peer connection, acknowledge the cancel
 *      (`POST .../cancel-ack`). Nothing more is sent for this session, ever.
 *    - `offerNeeded: true` — create a new peer connection (an ICE restart after a reconnect) with
 *      one **send-only video** transceiver and one data channel labelled
 *      {@link STUDIO_STREAM_CONTROL_LABEL}, wait for ICE gathering to complete (non-trickle), and
 *      `POST .../stream/offer` `{ claimToken, negotiation, sdp }` for the round named.
 *    - `answer` — apply it as the remote description. The server has written the session's bitrate
 *      bound (`b=AS`/`b=TIAS`) into it; stay within it, and within `bounds` (resolution, frame
 *      rate, duration).
 * 2. Render the stored `revision` from project storage, resolved as FL-95 resolves a preview; start
 *    paused at `start` and wait for the browser's first control message.
 *
 * ## Control (the data channel, browser ↔ worker)
 *
 * JSON text messages, one per `send`. Every intent carries a monotonic `seekGeneration`; the worker
 * applies only the newest it has seen and ignores anything older, so a burst of seeks costs one
 * render. Times are exact rationals `"num/den"` in seconds (FL-93), never floats.
 *
 * Browser → worker: {@link StudioStreamIntent}.
 * Worker → browser: {@link StudioStreamReport} — a `frame` report for every frame it sends (or at
 * least ten a second), naming the seek generation and revision it belongs to and its PTS. The
 * browser discards the picture until a report for its current generation and revision arrives, so
 * a stale frame from before a seek, or from a superseded revision, is never shown as current.
 */

export const STUDIO_STREAM_CONTROL_LABEL = 'fl-control';

/** An exact time in seconds, `num/den` (FL-93). */
export type StudioStreamTime = string;

export type StudioStreamIntent =
  | { type: 'play'; seekGeneration: number; at: StudioStreamTime }
  | { type: 'pause'; seekGeneration: number; at: StudioStreamTime }
  | { type: 'seek'; seekGeneration: number; at: StudioStreamTime; playing: boolean };

export type StudioStreamReport =
  | {
      type: 'frame';
      seekGeneration: number;
      revision: number;
      /** The frame's own presentation timestamp in `timebase` units. */
      pts: string;
      timebase: StudioStreamTime;
    }
  /** The sequence ended; the worker holds the last frame paused. */
  | { type: 'ended'; seekGeneration: number; revision: number };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const isGeneration = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const RATIONAL = /^-?\d{1,16}\/[1-9]\d{0,15}$/;

/** Read a worker report, or null for anything that is not one. The channel is not trusted. */
export const parseStudioStreamReport = (data: unknown): StudioStreamReport | null => {
  if (typeof data !== 'string' || data.length > 4096) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(value) || !isGeneration(value.seekGeneration) || !isGeneration(value.revision)) {
    return null;
  }
  if (value.type === 'ended') {
    return { type: 'ended', seekGeneration: value.seekGeneration, revision: value.revision };
  }
  if (
    value.type === 'frame' &&
    typeof value.pts === 'string' &&
    /^-?\d{1,19}$/.test(value.pts) &&
    typeof value.timebase === 'string' &&
    RATIONAL.test(value.timebase)
  ) {
    return {
      type: 'frame',
      seekGeneration: value.seekGeneration,
      revision: value.revision,
      pts: value.pts,
      timebase: value.timebase,
    };
  }
  return null;
};
