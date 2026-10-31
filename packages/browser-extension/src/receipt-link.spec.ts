import { describe, expect, it } from 'vitest';
import type { CaptureState } from './queue';
import { receiptLink } from './receipt-link';

const origin = 'https://photos.example';
const asset = '44444444-4444-4444-8444-444444444444';
const bookmark = '55555555-5555-4555-8555-555555555555';

describe('receiptLink', () => {
  it('opens a saved picture in the Boards viewer', () => {
    expect(
      receiptLink(origin, { state: 'saved', itemId: asset, itemKind: 'asset' }),
    ).toBe(`${origin}/pro/photos/${asset}`);
  });

  it('opens a saved link in Boards with its inspector open', () => {
    const link = receiptLink(origin, {
      state: 'saved',
      itemId: bookmark,
      itemKind: 'bookmark',
    });
    expect(link).toBe(`${origin}/pro?kinds=bookmark&bookmark=${bookmark}`);
    const url = new URL(link!);
    expect(url.pathname).toBe('/pro');
    expect(url.searchParams.get('kinds')).toBe('bookmark');
    expect(url.searchParams.get('bookmark')).toBe(bookmark);
  });

  it('opens the existing item when it was already in the library', () => {
    expect(
      receiptLink(origin, {
        state: 'duplicate',
        itemId: asset,
        itemKind: 'asset',
      }),
    ).toBe(`${origin}/pro/photos/${asset}`);
    expect(
      receiptLink(origin, {
        state: 'duplicate',
        itemId: bookmark,
        itemKind: 'bookmark',
      }),
    ).toBe(`${origin}/pro?kinds=bookmark&bookmark=${bookmark}`);
  });

  it.each<CaptureState>([
    'queued',
    'uploading',
    'committing',
    'needs-attention',
    'failed',
    'cancelled',
  ])('offers nothing to open while %s', (state) => {
    expect(receiptLink(origin, { state })).toBeNull();
    // Even a stray item id never makes an unfinished or cancelled save openable.
    expect(
      receiptLink(origin, { state, itemId: asset, itemKind: 'asset' }),
    ).toBeNull();
  });

  it('offers nothing without a server, a real item id or a known kind', () => {
    expect(
      receiptLink('', { state: 'saved', itemId: asset, itemKind: 'asset' }),
    ).toBeNull();
    expect(
      receiptLink(origin, {
        state: 'saved',
        itemId: '../admin',
        itemKind: 'asset',
      }),
    ).toBeNull();
    expect(receiptLink(origin, { state: 'saved', itemId: asset })).toBeNull();
  });
});
