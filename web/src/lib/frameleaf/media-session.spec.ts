import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMediaSession, clearMediaSession } from './media-session';

describe('bindMediaSession (FL-36)', () => {
  const handlers = new Map<string, (() => void) | null>();
  const session = {
    metadata: null as unknown,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => handlers.set(action, handler)),
  };

  beforeEach(() => {
    handlers.clear();
    clearMediaSession();
    session.metadata = null;
    session.playbackState = 'none';
    Object.defineProperty(navigator, 'mediaSession', { value: session, configurable: true });
    vi.stubGlobal(
      'MediaMetadata',
      class {
        constructor(public init: MediaMetadataInit) {}
      },
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    Reflect.deleteProperty(navigator, 'mediaSession');
  });

  it('publishes the item and wires play, pause, previous and next', () => {
    const controls = { play: vi.fn(), pause: vi.fn(), previous: vi.fn(), next: vi.fn() };
    bindMediaSession({
      title: 'IMG_1.jpg',
      artist: 'Lisbon',
      album: 'May 3',
      artwork: '/a.jpg',
      playing: true,
      controls,
    });

    expect((session.metadata as { init: MediaMetadataInit }).init).toMatchObject({
      title: 'IMG_1.jpg',
      artist: 'Lisbon',
      album: 'May 3',
      artwork: [{ src: '/a.jpg', sizes: '512x512' }],
    });
    expect(session.playbackState).toBe('playing');
    handlers.get('play')?.();
    handlers.get('pause')?.();
    handlers.get('previoustrack')?.();
    handlers.get('nexttrack')?.();
    expect(controls.play).toHaveBeenCalledOnce();
    expect(controls.pause).toHaveBeenCalledOnce();
    expect(controls.previous).toHaveBeenCalledOnce();
    expect(controls.next).toHaveBeenCalledOnce();
  });

  it('removes every handler and the metadata on cleanup', () => {
    const cleanup = bindMediaSession({ title: 'x', artist: 'y', controls: { play: vi.fn(), next: vi.fn() } });
    cleanup();
    expect(new Set(handlers.values())).toEqual(new Set([null]));
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
  });

  it('is a no-op without Media Session support', () => {
    Reflect.deleteProperty(navigator, 'mediaSession');
    expect(() => bindMediaSession({ title: 'x', artist: 'y', controls: {} })()).not.toThrow();
  });

  // A Locked item's name, place and preview never reach the OS.
  it('publishes nothing for a Locked item and clears what was there', () => {
    bindMediaSession({ title: 'visible.jpg', artist: 'a', controls: { play: vi.fn() } });
    const cleanup = bindMediaSession({
      locked: true,
      title: 'secret.jpg',
      artist: 'a',
      album: 'Home',
      artwork: '/secret.jpg',
      controls: { play: vi.fn(), next: vi.fn() },
    });

    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe('none');
    expect(new Set(handlers.values())).toEqual(new Set([null]));
    expect(() => cleanup()).not.toThrow();
  });

  // A video viewer stepping aside as a slideshow starts must not clear the slideshow's session,
  // whichever effect runs first.
  it('lets only the latest binding clear the session', () => {
    const video = bindMediaSession({ title: 'clip.mp4', artist: 'Frameleaf', controls: { play: vi.fn() } });
    const slideshow = bindMediaSession({ title: 'slide.jpg', artist: 'Album', controls: { next: vi.fn() } });

    video();
    expect((session.metadata as { init: MediaMetadataInit }).init.title).toBe('slide.jpg');
    expect(handlers.get('nexttrack')).toBeTypeOf('function');

    slideshow();
    expect(session.metadata).toBeNull();
  });

  it('keeps a newer binding when the older cleanup runs first or last', () => {
    const slideshow = bindMediaSession({ title: 'slide.jpg', artist: 'Album', controls: {} });
    slideshow();
    const video = bindMediaSession({ title: 'clip.mp4', artist: 'Frameleaf', controls: {} });
    slideshow();
    expect((session.metadata as { init: MediaMetadataInit }).init.title).toBe('clip.mp4');
    video();
    expect(session.metadata).toBeNull();
  });
});
