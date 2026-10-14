import type { AssetFaceResponseDto, PersonResponseDto } from '@frameleaf/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetCacheManager } from '$lib/managers/AssetCacheManager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { faceManager as faces } from '$lib/stores/face.svelte';
import { personFactory } from '@test-data/factories/person-factory';

const deferred = () => {
  let resolve!: (value: AssetFaceResponseDto[]) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<AssetFaceResponseDto[]>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, resolve, reject };
};

const row = (
  id: string,
  person: PersonResponseDto | null = null,
  hiddenAt: string | null = null,
): AssetFaceResponseDto => ({
  id,
  person,
  hiddenAt,
  correctedAt: null,
  revision: 'revision-1',
  boundingBoxX1: 0,
  boundingBoxY1: 0,
  boundingBoxX2: 10,
  boundingBoxY2: 10,
  imageWidth: 100,
  imageHeight: 100,
});

beforeEach(() => {
  vi.resetAllMocks();
  assetCacheManager.revoke();
  faces.clear();
});
afterEach(() => {
  faces.clear();
  assetCacheManager.revoke();
});

describe('face-store contracts', () => {
  it('preserves face and person order, grouped references and the last record for a repeated person ID', async () => {
    const alex = personFactory.build({ id: 'alex', name: 'Alex' });
    const updatedAlex = { ...alex, name: 'Updated Alex' };
    const bea = personFactory.build({ id: 'bea', name: 'Bea' });
    sdkMock.getFaces.mockResolvedValue([row('a', alex), row('unassigned'), row('b', bea), row('c', updatedAlex)]);
    await faces.getAssetFaces('photo');
    expect(faces.data.map(({ id }) => id)).toEqual(['a', 'unassigned', 'b', 'c']);
    expect(faces.people.map(({ id, name }) => ({ id, name }))).toEqual([
      { id: 'alex', name: 'Updated Alex' },
      { id: 'bea', name: 'Bea' },
    ]);
    expect(faces.people[0]).toBe(faces.data[3].person);
    expect(faces.facesByPersonId.get('alex')).toEqual([faces.data[0], faces.data[3]]);
    expect(faces.facesByPersonId.get('bea')?.[0]).toBe(faces.data[2]);
    expect(faces.facesByPersonId.has('unassigned')).toBe(false);
  });

  it('shares visible loading until clear and retries a failed request', async () => {
    sdkMock.getFaces.mockRejectedValueOnce(new Error('offline')).mockResolvedValue([row('a')]);
    await faces.getAssetFaces('photo');
    expect(faces.data).toEqual([]);
    await Promise.all([faces.getAssetFaces('photo'), faces.getAssetFaces('photo')]);
    await faces.getAssetFaces('photo');
    expect(sdkMock.getFaces).toHaveBeenCalledTimes(2);
    expect(faces.data[0].id).toBe('a');
    faces.clear();
    await faces.getAssetFaces('photo');
    expect(sdkMock.getFaces).toHaveBeenCalledTimes(3);
  });

  it('keeps hidden filtering, wire options and current failure handling', async () => {
    sdkMock.getFaces.mockResolvedValueOnce([row('hidden', null, '2026-01-01'), row('visible')]);
    await faces.loadHiddenFaces('photo');
    expect(sdkMock.getFaces.mock.calls[0][0]).toEqual({ id: 'photo', withHidden: true });
    expect(faces.hiddenFaces.map(({ id }) => id)).toEqual(['hidden']);
    sdkMock.getFaces.mockRejectedValueOnce(new Error('offline'));
    await faces.loadHiddenFaces('photo');
    expect(faces.hiddenFaces).toEqual([]);
  });
});

describe('face request ownership', () => {
  it('preserves the replacement installed synchronously during SDK setup', async () => {
    const obsolete = deferred();
    let replacement: Promise<void> | undefined;
    sdkMock.getFaces
      .mockImplementationOnce(() => {
        faces.clear();
        replacement = faces.getAssetFaces('fresh');
        return obsolete.promise;
      })
      .mockResolvedValueOnce([row('fresh')]);
    const oldLoad = faces.getAssetFaces('old');
    await vi.waitFor(() => expect(replacement).toBeDefined());
    await replacement;
    let settled = false;
    const joined = faces.getAssetFaces('fresh').then(() => {
      settled = true;
    });
    try {
      await vi.waitFor(() => expect(settled).toBe(true), { timeout: 100 });
      expect(faces.data.map(({ id }) => id)).toEqual(['fresh']);
      expect(sdkMock.getFaces).toHaveBeenCalledTimes(2);
    } finally {
      obsolete.resolve([row('old')]);
      await Promise.all([oldLoad, joined]);
    }
  });

  it('shares a visible read submitted synchronously during SDK setup', async () => {
    const request = deferred();
    let joined: Promise<void> | undefined;
    sdkMock.getFaces
      .mockImplementationOnce(() => {
        joined = faces.getAssetFaces('photo');
        return request.promise;
      })
      .mockResolvedValue([]);
    const loading = faces.getAssetFaces('photo');
    try {
      await vi.waitFor(() => expect(joined).toBeDefined());
      expect(sdkMock.getFaces).toHaveBeenCalledTimes(1);
    } finally {
      request.resolve([row('photo')]);
      await Promise.all([loading, joined]);
    }
    expect(faces.data.map(({ id }) => id)).toEqual(['photo']);
  });

  it('does not repopulate visible faces after clear', async () => {
    const request = deferred();
    sdkMock.getFaces.mockReturnValue(request.promise);
    const loading = faces.getAssetFaces('old');
    await vi.waitFor(() => expect(sdkMock.getFaces).toHaveBeenCalledTimes(1));
    faces.clear();
    request.resolve([row('old')]);
    await loading;
    expect(faces.data).toEqual([]);
    expect(faces.people).toEqual([]);
    expect(faces.facesByPersonId.size).toBe(0);
  });

  it('starts the next photo without waiting for the cleared request and ignores its late failure', async () => {
    const old = deferred();
    const fresh = deferred();
    sdkMock.getFaces.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldLoad = faces.getAssetFaces('old');
    await vi.waitFor(() => expect(sdkMock.getFaces).toHaveBeenCalledTimes(1));
    faces.clear();
    const freshLoad = faces.getAssetFaces('fresh');
    try {
      await Promise.resolve();
      expect(sdkMock.getFaces).toHaveBeenCalledTimes(2);
      old.reject(new Error('offline'));
      await oldLoad;
      const joined = faces.getAssetFaces('fresh');
      expect(sdkMock.getFaces).toHaveBeenCalledTimes(2);
      fresh.resolve([row('fresh')]);
      await Promise.all([freshLoad, joined]);
      expect(faces.data.map(({ id }) => id)).toEqual(['fresh']);
    } finally {
      old.resolve([]);
      fresh.resolve([]);
      await Promise.all([oldLoad, freshLoad]);
    }
  });

  it.each(['response', 'error'] as const)(
    'ignores an old hidden %s after clearing and reopening the same photo',
    async (kind) => {
      const old = deferred();
      sdkMock.getFaces.mockReturnValueOnce(old.promise).mockResolvedValueOnce([row('fresh', null, '2026-01-02')]);
      const oldLoad = faces.loadHiddenFaces('photo');
      faces.clear();
      await faces.loadHiddenFaces('photo');
      if (kind === 'error') {
        old.reject(new Error('old failure'));
      } else {
        old.resolve([row('old', null, '2026-01-01')]);
      }
      await oldLoad;
      expect(faces.hiddenFaces.map(({ id }) => id)).toEqual(['fresh']);
    },
  );

  it('aborts the obsolete hidden request when another read replaces it', async () => {
    const old = deferred();
    sdkMock.getFaces.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const loading = faces.loadHiddenFaces('photo');
    const signal = sdkMock.getFaces.mock.calls[0][1]?.signal;
    try {
      await faces.loadHiddenFaces('photo');
      expect(signal?.aborted).toBe(true);
    } finally {
      old.resolve([]);
      await loading;
    }
  });

  it('keeps a replacement hidden request submitted synchronously during abort from clear', async () => {
    const old = deferred();
    const fresh = deferred();
    sdkMock.getFaces.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldLoad = faces.loadHiddenFaces('photo');
    let replacement: Promise<void> | undefined;
    const signal = sdkMock.getFaces.mock.calls[0][1]?.signal;
    signal?.addEventListener('abort', () => {
      replacement = faces.loadHiddenFaces('fresh');
    });
    try {
      faces.clear();
      expect(sdkMock.getFaces).toHaveBeenCalledTimes(2);
      fresh.resolve([row('fresh', null, '2026-01-02')]);
      await replacement;
      old.resolve([row('old', null, '2026-01-01')]);
      await oldLoad;
      expect(faces.hiddenFaces.map(({ id }) => id)).toEqual(['fresh']);
    } finally {
      old.resolve([]);
      fresh.resolve([]);
      await oldLoad;
      await replacement;
    }
  });

  it.each(['SessionLocked', 'AuthLogout', 'SessionDelete'] as const)(
    'retires pending hidden faces at the %s access boundary',
    async (event) => {
      const request = deferred();
      sdkMock.getFaces.mockReturnValue(request.promise);
      const loading = faces.loadHiddenFaces('photo');
      eventManager.emit(event);
      request.resolve([row('private', null, '2026-01-01')]);
      await loading;
      expect(faces.hiddenFaces).toEqual([]);
    },
  );
});
