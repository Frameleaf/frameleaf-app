import { describe, expect, it } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { isCurrentSession, isExpiredSelection, preparesArchiveOnServer } from '$lib/frameleaf/archive-operations';
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

describe('isExpiredSelection', () => {
  it('recognises the server refusing an expired selection', () => {
    sdkMock.isHttpError.mockImplementation((error) => error instanceof Error && 'status' in error);
    expect(isExpiredSelection(Object.assign(new Error('gone'), { status: 410 }))).toBe(true);
    expect(isExpiredSelection(Object.assign(new Error('conflict'), { status: 409 }))).toBe(false);
    expect(isExpiredSelection(new Error('offline'))).toBe(false);
  });
});

describe('isCurrentSession', () => {
  it('is true only when the server says the asking session archived it', () => {
    expect(isCurrentSession({ currentSession: true } as never)).toBe(true);
    expect(isCurrentSession({ currentSession: false } as never)).toBe(false);
    expect(isCurrentSession({} as never)).toBe(false);
  });
});
