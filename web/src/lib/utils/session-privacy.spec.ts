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
    downloadManager.add('export', '/download', ['protected-asset'], 'private', 1);
    const replace = vi.spyOn(location, 'replace').mockImplementation(() => {
      expect(document.documentElement.style.display).toBe('none');
      expect(pause).toHaveBeenCalled();
      expect(downloadManager.assets.size).toBe(0);
    });

    revokeSessionView('/photos');
    expect(replace).toHaveBeenCalledWith('/photos');
  });

  it('keeps the old document concealed if navigation fails', () => {
    vi.spyOn(location, 'replace').mockImplementation(() => {
      throw new Error('navigation failed');
    });
    expect(() => revokeSessionView('/photos')).toThrow('navigation failed');
    expect(document.documentElement.style.display).toBe('none');
  });
});
