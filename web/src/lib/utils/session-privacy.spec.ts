import { beforeEach, describe, expect, it, vi } from 'vitest';
import { downloadManager } from '$lib/managers/download-manager.svelte';
import { revokeSessionView } from '$lib/utils/session-privacy';

vi.mock('$app/environment', () => ({ browser: true }));

describe('revokeSessionView', () => {
  beforeEach(() => {
    document.documentElement.style.removeProperty('display');
    document.body.replaceChildren();
    downloadManager.clearAll();
    vi.restoreAllMocks();
  });

  it('conceals all UI and pauses media before replacing the document and its caches', () => {
    const video = document.createElement('video');
    document.body.append(video);
    const pause = vi.spyOn(video, 'pause').mockImplementation(() => {});
    let request: AbortSignal | undefined;
    downloadManager.start({ name: 'private.zip', assetIds: ['protected-asset'] }, ({ signal }) => {
      request = signal;
      return new Promise<Blob>(() => {});
    });
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {
      expect(document.documentElement.style.display).toBe('none');
      expect(pause).toHaveBeenCalled();
      // FL-45: the protected download is aborted, not only hidden.
      expect(downloadManager.assets.size).toBe(0);
      expect(request?.aborted).toBe(true);
    });

    revokeSessionView('/photos');
    expect(replace).toHaveBeenCalledWith('/photos');
  });

  it('clears sources and posters in the production custom-player shadow boundary', () => {
    const custom = document.createElement('hls-video');
    custom.setAttribute('src', '/private/stream.m3u8');
    custom.setAttribute('poster', '/private/poster');
    const shadow = custom.attachShadow({ mode: 'open' });
    const media = document.createElement('video');
    media.src = '/private/video';
    media.poster = '/private/poster';
    media.append(document.createElement('source'));
    shadow.append(media);
    document.body.append(custom);
    const pause = vi.spyOn(media, 'pause').mockImplementation(() => {
      throw new Error('player error');
    });
    const load = vi.spyOn(media, 'load').mockImplementation(() => {});
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});

    revokeSessionView('/photos');

    expect(pause).toHaveBeenCalled();
    expect(load).toHaveBeenCalled();
    expect(custom.hasAttribute('src')).toBe(false);
    expect(custom.hasAttribute('poster')).toBe(false);
    expect(media.hasAttribute('src')).toBe(false);
    expect(media.hasAttribute('poster')).toBe(false);
    expect(media.querySelector('source')).toBeNull();
    expect(media.srcObject).toBeNull();
    expect(replace).toHaveBeenCalledWith('/photos');
  });

  it('clears media immediately and waits for Picture-in-Picture exit before replacing the document', async () => {
    const video = document.createElement('video');
    document.body.append(video);
    let completeExit!: () => void;
    const exiting = new Promise<void>((resolve) => (completeExit = resolve));
    const oldElement = Object.getOwnPropertyDescriptor(document, 'pictureInPictureElement');
    const oldExit = Object.getOwnPropertyDescriptor(document, 'exitPictureInPicture');
    Object.defineProperties(document, {
      pictureInPictureElement: { configurable: true, value: video },
      exitPictureInPicture: { configurable: true, value: () => exiting },
    });
    const pause = vi.spyOn(video, 'pause');
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {});
    try {
      revokeSessionView('/photos');
      expect(document.documentElement.style.display).toBe('none');
      expect(pause).toHaveBeenCalled();
      expect(replace).not.toHaveBeenCalled();
      completeExit();
      await exiting;
      await Promise.resolve();
      expect(replace).toHaveBeenCalledWith('/photos');
    } finally {
      for (const [name, descriptor] of [
        ['pictureInPictureElement', oldElement],
        ['exitPictureInPicture', oldExit],
      ] as const) {
        if (descriptor) {
          Object.defineProperty(document, name, descriptor);
        } else {
          Reflect.deleteProperty(document, name);
        }
      }
    }
  });

  it('keeps the old document concealed if navigation fails', () => {
    vi.spyOn(location, 'replace').mockImplementation(() => {
      throw new Error('navigation failed');
    });
    expect(() => revokeSessionView('/photos')).toThrow('navigation failed');
    expect(document.documentElement.style.display).toBe('none');
  });
});
