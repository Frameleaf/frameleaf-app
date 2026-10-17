import { describe, expect, it } from 'vitest';
import {
  isEnteringViewer,
  isLeavingViewer,
  shouldPageForViewer,
  spaceAssetHref,
  spaceViewerList,
  VIEWER_LOOKAHEAD,
  VIEWER_SEEK_PAGES,
} from '$lib/frameleaf/space-viewer';

const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));

describe('spaceAssetHref', () => {
  it('opens the item inside the space', () => {
    expect(spaceAssetHref('space-1', 'asset-1')).toBe('/sharing/space-1/photos/asset-1');
  });

  it('carries the open panel so closing the viewer lands on it', () => {
    expect(spaceAssetHref('space-1', 'asset-1', '?panel=activity')).toBe(
      '/sharing/space-1/photos/asset-1?panel=activity',
    );
  });

  it('drops the grid scroll hint', () => {
    expect(spaceAssetHref('space-1', 'asset-1', '?at=asset-9&panel=places')).toBe(
      '/sharing/space-1/photos/asset-1?panel=places',
    );
    expect(spaceAssetHref('space-1', 'asset-1', '?at=asset-9')).toBe('/sharing/space-1/photos/asset-1');
  });
});

describe('spaceViewerList', () => {
  it('walks the whole space when nothing is narrowed', () => {
    expect(spaceViewerList(items, undefined, 'c')).toBe(items);
  });

  it('walks only what is new, in the grid order, while the grid shows only what is new', () => {
    const filter = new Set(['d', 'b']);
    expect(spaceViewerList(items, filter, 'b').map(({ id }) => id)).toEqual(['b', 'd']);
  });

  it('walks the whole space for an item opened from outside the narrowed grid', () => {
    const filter = new Set(['d', 'b']);
    expect(spaceViewerList(items, filter, 'a')).toBe(items);
    expect(spaceViewerList(items, filter, null)).toBe(items);
  });
});

describe('shouldPageForViewer', () => {
  const base = { index: 0, length: 100, page: 1, exhausted: false, loading: false, failed: false };

  it('looks for an item that is not loaded yet', () => {
    expect(shouldPageForViewer({ ...base, index: -1, length: 0, page: 0 })).toBe(true);
    expect(shouldPageForViewer({ ...base, index: -1 })).toBe(true);
  });

  it('stops looking after a bounded number of pages', () => {
    expect(shouldPageForViewer({ ...base, index: -1, page: VIEWER_SEEK_PAGES })).toBe(false);
  });

  it('pages ahead near the end of what is loaded', () => {
    expect(shouldPageForViewer({ ...base, index: 99 - VIEWER_LOOKAHEAD })).toBe(true);
    expect(shouldPageForViewer({ ...base, index: 99 })).toBe(true);
    expect(shouldPageForViewer({ ...base, index: 50 })).toBe(false);
  });

  it('never pages while loading, after a failure, or once the space has run out', () => {
    expect(shouldPageForViewer({ ...base, index: 99, loading: true })).toBe(false);
    expect(shouldPageForViewer({ ...base, index: 99, failed: true })).toBe(false);
    expect(shouldPageForViewer({ ...base, index: 99, exhausted: true })).toBe(false);
    expect(shouldPageForViewer({ ...base, index: -1, exhausted: true })).toBe(false);
  });
});

describe('isEnteringViewer and isLeavingViewer', () => {
  const grid = { params: { spaceId: 'space-1' } };
  const viewer = { params: { spaceId: 'space-1', assetId: 'asset-1' } };
  const next = { params: { spaceId: 'space-1', assetId: 'asset-2' } };

  it('tells opening from closing', () => {
    expect(isEnteringViewer(grid, viewer)).toBe(true);
    expect(isLeavingViewer(viewer, grid)).toBe(true);
  });

  it('treats moving between items as neither', () => {
    expect(isEnteringViewer(viewer, next)).toBe(false);
    expect(isLeavingViewer(viewer, next)).toBe(false);
  });

  it('treats leaving the app as not closing the viewer', () => {
    expect(isLeavingViewer(viewer, null)).toBe(false);
  });
});
