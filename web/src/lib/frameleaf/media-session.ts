/**
 * Media Session for the slideshow and for video (FL-36), ported from MediaViewer.jsx:887-923
 * (#7 "lock screen, Control Center, headphones and media keys"). The lock screen and the
 * hardware keys show what is playing and can play, pause, and move to the previous or next item.
 *
 * `bindMediaSession` returns a cleanup that removes every handler it set and clears the
 * metadata, so nothing keeps pointing at a viewer that has closed. Only the latest binding owns
 * the session: an older binding's cleanup (a video viewer stepping aside as a slideshow starts)
 * never clears what a newer one published, whichever order their effects run in.
 *
 * A Locked item is never published: its name, place and preview must not reach the lock screen
 * or the OS media controls, so binding one clears the session instead.
 */

/** The artist line when nothing more specific is playing: the product name (MediaViewer.jsx:897). */
export const MEDIA_SESSION_ARTIST = 'Frameleaf';

export type MediaSessionControls = {
  play?: () => void;
  pause?: () => void;
  previous?: () => void;
  next?: () => void;
};

export type MediaSessionOptions = {
  /** The item is Locked: nothing about it is published and the session is cleared. */
  locked?: boolean;
  title: string;
  artist: string;
  album?: string;
  /** A preview image for the lock screen. */
  artwork?: string;
  /** Leave undefined for video: the browser reports the media element's own state. */
  playing?: boolean;
  controls: MediaSessionControls;
};

const ACTIONS: ReadonlyArray<[MediaSessionAction, keyof MediaSessionControls]> = [
  ['play', 'play'],
  ['pause', 'pause'],
  ['previoustrack', 'previous'],
  ['nexttrack', 'next'],
];

const session = (): MediaSession | undefined =>
  typeof navigator !== 'undefined' && 'mediaSession' in navigator && typeof MediaMetadata === 'function'
    ? navigator.mediaSession
    : undefined;

/** The binding that currently owns the session. */
let owner: symbol | undefined;

const setHandler = (target: MediaSession, action: MediaSessionAction, handler: (() => void) | null) => {
  try {
    target.setActionHandler(action, handler);
  } catch {
    // an action this browser does not support
  }
};

/** Removes every handler and the metadata, whoever published them. */
export const clearMediaSession = (): void => {
  owner = undefined;
  const target = session();
  if (!target) {
    return;
  }
  for (const [action] of ACTIONS) {
    setHandler(target, action, null);
  }
  target.metadata = null;
  target.playbackState = 'none';
};

export const bindMediaSession = ({
  locked = false,
  title,
  artist,
  album,
  artwork,
  playing,
  controls,
}: MediaSessionOptions): (() => void) => {
  const target = session();
  if (!target) {
    return () => {};
  }
  if (locked) {
    clearMediaSession();
    return () => {};
  }

  const token = Symbol('media-session');
  owner = token;
  target.metadata = new MediaMetadata({
    title,
    artist,
    album: album ?? '',
    artwork: artwork ? [{ src: artwork, sizes: '512x512' }] : [],
  });
  for (const [action, key] of ACTIONS) {
    const handler = controls[key];
    setHandler(target, action, handler ? () => handler() : null);
  }
  if (playing !== undefined) {
    target.playbackState = playing ? 'playing' : 'paused';
  }

  return () => {
    if (owner === token) {
      clearMediaSession();
    }
  };
};
