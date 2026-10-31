import { describe, expect, it } from 'vitest';
import { renderStorageTemplate } from '$lib/frameleaf/onboarding';

describe('storage template example', () => {
  it('renders the live storage template example, and only notes tokens it cannot preview', () => {
    expect(renderStorageTemplate('{{y}}/{{y}}-{{MM}}-{{dd}}/{{filename}}', 'taylor')).toEqual({
      path: 'library/taylor/2026/2026-09-14/IMG_4021.jpg',
      unknown: [],
      previewable: true,
    });
    // Valid server tokens the sample does not know are not errors; the server validates on save.
    const block = renderStorageTemplate('{{#if album}}{{album}}{{else}}Other{{/if}}/{{filename}}', 'taylor');
    expect(block.previewable).toBe(false);
    expect(block.unknown).toEqual(['#if album', 'else', '/if']);
    expect(renderStorageTemplate('{{album-startDate-y}}/{{filename}}', 'taylor').unknown).toEqual([
      'album-startDate-y',
    ]);
    expect(renderStorageTemplate('', 'taylor')).toMatchObject({ previewable: true, path: 'library/taylor/….jpg' });
  });
});
