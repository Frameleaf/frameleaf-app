import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bindMediaSession } from './media-session';

describe('bindMediaSession (FL-36)', () => {
  const handlers = new Map<string, (() => void) | null>();
  const session = {
    metadata: null as unknown,
    playbackState: 'none',
    setActionHandler: vi.fn((action: string, handler: (() => void) | null) => handlers.set(action, handler)),
  };

  beforeEach(() => {
    handlers.clear();
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
});
