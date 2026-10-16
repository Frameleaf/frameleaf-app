import { frozenSource } from 'src/immich-import/adapters.js';
import { LEGACY_MIGRATIONS } from 'src/immich-import/legacy.js';

describe('legacy source views', () => {
  it('reads current releases directly, apart from the 3.3 empty OAuth id fix', () => {
    expect(Object.keys(frozenSource('3.2.4').views)).toEqual(['user']);
  });

  it('reshapes every table an Immich 2.0 release stores differently', () => {
    const { views, tables } = frozenSource('2.0.0');
    expect(Object.keys(views).sort()).toEqual(
      [
        'album',
        'album_asset',
        'album_user',
        'asset',
        'asset_exif',
        'asset_face',
        'asset_file',
        'memory_asset',
        'person',
        'shared_link_asset',
        'tag_asset',
        'user',
      ].sort(),
    );
    // 2.0 predates edits, OCR and the 3.0 audio/video tables; those are regenerated, never read.
    for (const table of ['asset_edit', 'asset_ocr', 'ocr_search', 'asset_audio', 'asset_video', 'asset_keyframe']) {
      expect(tables[table]).toBeUndefined();
    }
    expect(views.album_user).toContain('"albumsId" AS "albumId"');
    expect(views.album_user).toContain('UNION ALL');
    expect(views.asset_file.match(/UNION ALL/g)).toHaveLength(2);
  });

  it('only emits SELECTs', () => {
    for (const view of Object.values(frozenSource('2.0.0').views)) {
      expect(view.trimStart()).toMatch(/^SELECT /u);
      expect(view).not.toMatch(/\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/u);
    }
  });

  it('keys every rule to an upstream migration that every supported release ledger names consistently', () => {
    const newest = frozenSource('3.2.4').migrations;
    const current = LEGACY_MIGRATIONS.filter(
      (migration) => migration !== '1789419229196-ConvertUserOAuthIdEmptyStringToNull',
    );
    expect(current.filter((name) => !newest.includes(name))).toEqual([]);
  });
});
