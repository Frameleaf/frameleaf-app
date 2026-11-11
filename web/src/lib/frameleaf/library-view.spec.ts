import { AssetVisibility } from '@frameleaf/sdk';
import { describe, expect, it } from 'vitest';
import { THUMBNAIL_SIZE_DEFAULT, clampThumbnailSize } from '$lib/frameleaf/library-grid';
import {
  captionPatch,
  captionsFor,
  DEFAULT_LIBRARY_VIEW,
  hiddenParts,
  libraryViewFrom,
  nearestViewSize,
  sectionGrouping,
  VIEW_SIZES,
  viewTimelineOptions,
} from '$lib/frameleaf/library-view';

const view = (patch = {}) => ({ ...DEFAULT_LIBRARY_VIEW, ...patch });

describe('Library View menu choices (FL-1398)', () => {
  describe('captions, kept per layout', () => {
    it('starts with Browse bare, and the time (not the file name) on Timeline and Work', () => {
      expect(captionsFor(DEFAULT_LIBRARY_VIEW, 'browse')).toEqual({ time: false, names: false });
      expect(captionsFor(DEFAULT_LIBRARY_VIEW, 'timeline')).toEqual({ time: true, names: false });
      expect(captionsFor(DEFAULT_LIBRARY_VIEW, 'work')).toEqual({ time: true, names: false });
    });

    it('changes one layout and leaves the others as they were', () => {
      const changed = view(captionPatch('browse', { names: true }));
      expect(captionsFor(changed, 'browse')).toEqual({ time: false, names: true });
      expect(captionsFor(changed, 'work')).toEqual(captionsFor(DEFAULT_LIBRARY_VIEW, 'work'));
      expect(captionsFor(view(captionPatch('timeline', { time: false })), 'timeline').time).toBe(false);
    });
  });

  describe('stored choices', () => {
    it('fills what the account never changed from the defaults', () => {
      expect(libraryViewFrom()).toEqual(DEFAULT_LIBRARY_VIEW);
      expect(libraryViewFrom({ archived: true, groupBy: 'month' })).toEqual(view({ archived: true, groupBy: 'month' }));
    });

    it('reads a grouping it does not know as none', () => {
      expect(libraryViewFrom({ groupBy: 'decade' }).groupBy).toBe('none');
    });
  });

  describe('Size', () => {
    it('offers stops of the Thumbnail size slider, with Medium its default', () => {
      for (const { size } of VIEW_SIZES) {
        expect(clampThumbnailSize(size)).toBe(size);
      }
      expect(VIEW_SIZES.find(({ id }) => id === 'medium')?.size).toBe(THUMBNAIL_SIZE_DEFAULT);
    });

    it('marks the preset nearest the slider', () => {
      expect(nearestViewSize(140)).toBe('small');
      expect(nearestViewSize(170)).toBe('small');
      expect(nearestViewSize(230)).toBe('medium');
      expect(nearestViewSize(290)).toBe('large');
    });
  });

  describe('Stacks', () => {
    const library = { visibility: AssetVisibility.Timeline, withStacked: true };

    it('keeps stacks together by default: one photo per stack, as the page asks', () => {
      expect(viewTimelineOptions(library, DEFAULT_LIBRARY_VIEW, true)).toEqual(library);
    });

    it('shows every photo by no longer asking the timeline to collapse stacks', () => {
      expect(viewTimelineOptions(library, view({ stacksTogether: false }), true)).toEqual({
        visibility: AssetVisibility.Timeline,
      });
    });

    it('never collapses stacks on a page that shows every photo itself', () => {
      const album = { albumId: 'album-1' };
      expect(viewTimelineOptions(album, DEFAULT_LIBRARY_VIEW, false)).toEqual(album);
    });
  });

  describe('Also show', () => {
    const library = { visibility: AssetVisibility.Timeline, withStacked: true };

    it('leaves partner photos out when they are switched off', () => {
      expect(viewTimelineOptions(library, view({ partnerPhotos: false }), true)).toEqual({
        ...library,
        withPartners: false,
      });
    });

    it('adds archived items by naming no visibility, which never includes Locked', () => {
      const options = viewTimelineOptions(library, view({ archived: true }), true);
      expect(options).toEqual({ withStacked: true });
      expect('visibility' in options).toBe(false);
    });

    it('applies to the Library root only: Archive, Locked and an album keep their own scope', () => {
      const both = view({ archived: true, partnerPhotos: false });
      const locked = { visibility: AssetVisibility.Locked };
      expect(viewTimelineOptions(locked, both, true)).toEqual({ ...locked, withPartners: false });
      const favorites = { visibility: AssetVisibility.Timeline, isFavorite: true };
      expect(viewTimelineOptions(favorites, both, false)).toEqual(favorites);
    });

    it('does not change the options it was given', () => {
      const options = { ...library };
      viewTimelineOptions(options, view({ archived: true, stacksTogether: false, partnerPhotos: false }), true);
      expect(options).toEqual(library);
    });
  });

  describe('Group by', () => {
    it('puts Browse and Work in sections by day, month or year', () => {
      expect(sectionGrouping(view({ groupBy: 'day' }), { layout: 'browse', ordered: false })).toBe('days');
      expect(sectionGrouping(view({ groupBy: 'month' }), { layout: 'work', ordered: false })).toBe('months');
      expect(sectionGrouping(view({ groupBy: 'year' }), { layout: 'browse', ordered: false })).toBe('years');
    });

    it('is one bare grid by default', () => {
      expect(sectionGrouping(DEFAULT_LIBRARY_VIEW, { layout: 'browse', ordered: false })).toBeNull();
    });

    it('leaves the Timeline to its own Years, Months and Days, and the List view without sections', () => {
      const grouped = view({ groupBy: 'month' });
      expect(sectionGrouping(grouped, { layout: 'timeline', ordered: false })).toBeNull();
      expect(sectionGrouping(grouped, { layout: 'list', ordered: false })).toBeNull();
    });

    it('has no sections in an order with no dates (file name, rating)', () => {
      expect(sectionGrouping(view({ groupBy: 'day' }), { layout: 'work', ordered: true })).toBeNull();
    });
  });

  it('lists what the tiles hide for one attribute', () => {
    expect(hiddenParts(DEFAULT_LIBRARY_VIEW)).toBe('');
    expect(hiddenParts(view({ ratings: false, badges: false }))).toBe('ratings badges');
    expect(hiddenParts(view({ favorites: false }))).toBe('favorites');
  });
});
