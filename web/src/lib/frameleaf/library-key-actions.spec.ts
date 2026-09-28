import { describe, expect, it } from 'vitest';
import { barOffers, libraryKeysActive, planKeyAction, type KeyActionInput, type KeyItem } from './library-key-actions';

const ME = 'me';
const item = (id: string, overrides: Partial<KeyItem> = {}): KeyItem => ({
  id,
  ownerId: ME,
  isFavorite: false,
  isArchived: false,
  isTrashed: false,
  isLocked: false,
  isVideo: false,
  isImage: true,
  ...overrides,
});
const input = (overrides: Partial<KeyActionInput> = {}): KeyActionInput => ({
  selection: [],
  focused: item('a'),
  context: { currentUserId: ME },
  ratingsEnabled: true,
  hasViewer: true,
  ...overrides,
});
const key = (id: string, value?: number) => ({ id, value });

describe('planKeyAction (FL-33, T-5)', () => {
  it('acts on the focused item when nothing is selected, and on the selection when there is one', () => {
    expect(planKeyAction(key('favorite'), input())).toEqual({ kind: 'run', action: 'favorite', ids: ['a'] });
    expect(planKeyAction(key('favorite'), input({ selection: [item('b'), item('c')] }))).toEqual({
      kind: 'run',
      action: 'favorite',
      ids: ['b', 'c'],
    });
  });

  it('toggles favorite and archive the way the prototype does', () => {
    expect(planKeyAction(key('favorite'), input({ focused: item('a', { isFavorite: true }) }))).toMatchObject({
      action: 'unfavorite',
    });
    expect(planKeyAction(key('archive'), input())).toMatchObject({ kind: 'run', action: 'archive' });
    expect(planKeyAction(key('archive'), input({ focused: item('a', { isArchived: true }) }))).toMatchObject({
      kind: 'run',
      action: 'unarchive',
    });
    // A mixed selection archives what is not archived yet.
    const mixed = [item('b', { isArchived: true }), item('c')];
    expect(planKeyAction(key('archive'), input({ selection: mixed }))).toMatchObject({ action: 'archive' });
  });

  describe('the Locked page', () => {
    const locked = (overrides: Partial<KeyActionInput> = {}) =>
      input({ context: { currentUserId: ME, locked: true }, focused: item('a', { isLocked: true }), ...overrides });

    it('never favorites, stacks, archives, rates, edits or tags faces', () => {
      for (const id of ['favorite', 'archive', 'edit', 'tag-people']) {
        expect(planKeyAction(key(id), locked())).toEqual({ kind: 'none' });
      }
      expect(planKeyAction(key('rate-3', 3), locked())).toEqual({ kind: 'none' });
      const two = [item('b', { isLocked: true }), item('c', { isLocked: true })];
      expect(planKeyAction(key('stack'), locked({ selection: two }))).toEqual({ kind: 'none' });
    });

    it('sends Delete to the bar as permanent deletion, which asks first', () => {
      expect(planKeyAction(key('delete'), locked())).toEqual({
        kind: 'bar',
        action: 'delete-permanently',
        ids: ['a'],
      });
    });

    it('treats a Locked item revealed elsewhere as Locked', () => {
      const revealed = input({ focused: item('a', { isLocked: true }) });
      expect(planKeyAction(key('favorite'), revealed)).toEqual({ kind: 'none' });
      expect(planKeyAction(key('delete'), revealed)).toMatchObject({ action: 'delete-permanently' });
    });
  });

  it('changes only the caller’s own items, but downloads a partner’s', () => {
    const partner = item('p', { ownerId: 'partner' });
    for (const id of ['favorite', 'archive', 'delete', 'edit', 'tag-people']) {
      expect(planKeyAction(key(id), input({ focused: partner }))).toEqual({ kind: 'none' });
    }
    expect(planKeyAction(key('rate-4', 4), input({ focused: partner }))).toEqual({ kind: 'none' });
    expect(planKeyAction(key('download'), input({ focused: partner }))).toEqual({
      kind: 'run',
      action: 'download',
      ids: ['p'],
    });
    // A mixed selection changes the caller's part of it only.
    expect(planKeyAction(key('favorite'), input({ selection: [partner, item('b')] }))).toEqual({
      kind: 'run',
      action: 'favorite',
      ids: ['b'],
    });
  });

  it('asks for two items before stacking, and stacks the caller’s own with the first leading', () => {
    expect(planKeyAction(key('stack'), input())).toEqual({
      kind: 'toast',
      message: 'frameleaf_library_shortcut_stack_needs_two',
    });
    expect(planKeyAction(key('stack'), input({ selection: [item('b'), item('c')] }))).toEqual({
      kind: 'run',
      action: 'stack',
      ids: ['b', 'c'],
      payload: { primaryId: 'b' },
    });
    expect(planKeyAction(key('stack'), input({ selection: [item('b'), item('p', { ownerId: 'partner' })] }))).toEqual({
      kind: 'none',
    });
  });

  it('deletes only a focused tile, never the scroll anchor, and leaves a selection to the bar', () => {
    expect(planKeyAction(key('delete'), input({ focused: null }))).toEqual({ kind: 'none' });
    expect(planKeyAction(key('delete'), input({ selection: [item('b')] }))).toEqual({ kind: 'none' });
    expect(planKeyAction(key('delete'), input())).toEqual({ kind: 'bar', action: 'delete', ids: ['a'] });
    expect(planKeyAction(key('delete'), input({ context: { currentUserId: ME, trash: true } }))).toMatchObject({
      action: 'delete-permanently',
    });
  });

  it('rates, edits and tags faces on the focused still only where ratings, a viewer and a still allow', () => {
    expect(planKeyAction(key('rate-5', 5), input())).toEqual({ kind: 'rate', id: 'a', value: 5 });
    expect(planKeyAction(key('rate-clear', 0), input())).toEqual({ kind: 'rate', id: 'a', value: 0 });
    expect(planKeyAction(key('rate-5', 5), input({ ratingsEnabled: false }))).toEqual({ kind: 'none' });
    expect(planKeyAction(key('edit'), input({ hasViewer: false }))).toEqual({ kind: 'none' });
    expect(planKeyAction(key('tag-people'), input({ focused: item('v', { isVideo: true, isImage: false }) }))).toEqual({
      kind: 'none',
    });
  });

  it('sends Add to album to the bar and selects the item for Tag, as the prototype does', () => {
    expect(planKeyAction(key('add-to-album'), input())).toEqual({ kind: 'bar', action: 'add-to-album', ids: ['a'] });
    expect(planKeyAction(key('tag'), input())).toEqual({
      kind: 'select-hint',
      id: 'a',
      hint: 'frameleaf_library_shortcut_tag_hint',
    });
  });

  it('does nothing over a "select everything matching" snapshot', () => {
    expect(planKeyAction(key('favorite'), input({ snapshot: true }))).toEqual({ kind: 'none' });
  });

  it('asks the bar what it offers', () => {
    expect(barOffers('favorite', [item('a')], { currentUserId: ME })).toBe(true);
    expect(barOffers('favorite', [item('a')], { currentUserId: ME, locked: true })).toBe(false);
    expect(barOffers('favorite', [], { currentUserId: ME })).toBe(false);
  });
});

describe('libraryKeysActive', () => {
  const root = (selector: string | null) => ({
    querySelector: (query: string) => (selector && query.includes(selector) ? ({} as Element) : null),
  });

  it('stays quiet while the viewer, a dialog or an ARIA modal has the keyboard, or while typing', () => {
    const base = { viewing: false, defaultPrevented: false, typing: false };
    expect(libraryKeysActive({ ...base, root: root(null) })).toBe(true);
    expect(libraryKeysActive({ ...base, viewing: true, root: root(null) })).toBe(false);
    expect(libraryKeysActive({ ...base, typing: true, root: root(null) })).toBe(false);
    expect(libraryKeysActive({ ...base, defaultPrevented: true, root: root(null) })).toBe(false);
    expect(libraryKeysActive({ ...base, root: root('dialog[open]') })).toBe(false);
    expect(libraryKeysActive({ ...base, root: root('[role="dialog"][aria-modal="true"]') })).toBe(false);
  });
});
