import { defaults } from '@immich/sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import {
  ArchiveOperationError,
  ArchiveOperationScope,
  confirmArchiveOperation,
  prepareArchiveOperation,
  preparesArchiveOnServer,
} from '$lib/frameleaf/archive-operations';
import { createLibrarySession, type LibraryViewState } from '$lib/frameleaf/library-session';

const stateOf = (patch: Partial<LibraryViewState> = {}): LibraryViewState => ({
  ...createLibrarySession().state,
  ...patch,
});

describe('preparesArchiveOnServer', () => {
  it('counts the unfiltered library on the server', () => {
    expect(preparesArchiveOnServer(stateOf())).toBe(true);
  });

  it('never asks the server for a set wider than a filtered or scoped view showed', () => {
    const query = emptyDiscoveryQuery();
    expect(preparesArchiveOnServer(stateOf({ scope: { kind: 'album', id: 'album-1' } }))).toBe(false);
    expect(preparesArchiveOnServer(stateOf({ query: { ...query, text: 'beach' } }))).toBe(false);
    expect(preparesArchiveOnServer(stateOf({ query: { ...query, filter: { isFavorite: { eq: true } } } }))).toBe(false);
    expect(preparesArchiveOnServer(stateOf({ query: { ...query, spaceId: 'space-1' } }))).toBe(false);
    expect(preparesArchiveOnServer(stateOf({ query: { ...query, queryAssetId: 'asset-1' } }))).toBe(false);
  });
});

describe('archive operation calls', () => {
  const original = { fetch: defaults.fetch, baseUrl: defaults.baseUrl, headers: defaults.headers };

  afterEach(() => {
    Object.assign(defaults, original);
  });

  it('go through the SDK defaults, as a generated call does', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 'op-1' }, { status: 201 }));
    Object.assign(defaults, { fetch, baseUrl: '/api', headers: { 'x-immich-client': 'web' } });

    await prepareArchiveOperation({
      archiveOperationPrepareDto: { requestKey: 'key', scope: ArchiveOperationScope.MatchingOwnedTimeline },
    });

    expect(fetch).toHaveBeenCalledWith('/api/archive-operations/prepare', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'x-immich-client': 'web' },
      body: JSON.stringify({ requestKey: 'key', scope: 'matching-owned-timeline' }),
    });
  });

  it('report a refusal with its status, so an expired selection can be told apart', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ message: 'This selection expired' }, { status: 410 }));
    Object.assign(defaults, { fetch, baseUrl: '/api' });

    const request = confirmArchiveOperation({ id: 'op-1', archiveOperationConfirmDto: { requestKey: 'key' } });

    await expect(request).rejects.toEqual(new ArchiveOperationError('This selection expired', 410));
    await expect(request).rejects.toMatchObject({ status: 410 });
  });
});
