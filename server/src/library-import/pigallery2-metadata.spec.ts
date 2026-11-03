import metadata from 'src/library-import/fixtures/pigallery2/3.5.2-metadata.json' with { type: 'json' };
import { resolvePigallery2File } from 'src/library-import/pigallery2-files.js';
import { pigallery2SidecarCandidates } from 'src/library-import/pigallery2-sidecars.js';

it('finds all nine native case-sensitive XMP companions outside the native file table', () => {
  const inventory = new Set(metadata.files.map((file) => file.path));
  for (const [original, expected] of Object.entries(metadata.expectations.existingSidecars))
    expect(pigallery2SidecarCandidates(original).filter((path) => inventory.has(path))).toEqual(expected);
  expect(metadata.rows.file_entity.map((row) => row.name).toSorted()).toEqual(['notes.md', 'track.gpx']);
});
it('resolves native photo, video and metadata-file paths and actual original lengths', () => {
  const files = [];
  for (const table of ['media_entity', 'file_entity'] as const)
    for (const captured of metadata.rows[table]) {
      const folder = metadata.rows.directory_entity.find((d) => d.id === captured.directoryId)!;
      const file = resolvePigallery2File(
        table,
        {
          ...captured,
          id: BigInt(captured.id),
          directoryId: BigInt(captured.directoryId),
          ...('metadataFilesize' in captured ? { metadataFilesize: BigInt(captured.metadataFilesize) } : {}),
        },
        { ...folder, id: BigInt(folder.id), parentId: folder.parentId === null ? null : BigInt(folder.parentId) },
      );
      if (!file.path.startsWith('enriched/')) continue;
      const actual = metadata.files.find((f) => f.path === file.path)!;
      expect(actual).toBeDefined();
      expect(file.bytes).toBe(table === 'media_entity' ? actual.bytes : null);
      files.push(file.path);
    }
  expect(files.toSorted()).toEqual([
    'enriched/clip.mp4',
    'enriched/fallback.jpg',
    'enriched/notes.md',
    'enriched/priority.jpg',
    'enriched/track.gpx',
  ]);
});
