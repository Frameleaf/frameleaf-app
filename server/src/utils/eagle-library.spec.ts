import {
  buildEagleLibrary,
  eagleAddedDate,
  eagleColour,
  eagleFolders,
  eagleLibraryFingerprint,
  eagleSourceUrl,
  findEagleItemFile,
  isComing,
  parseEagleFolders,
  topFolderNames,
} from 'src/utils/eagle-library.js';

const metadata = {
  folders: [
    {
      id: 'F1',
      name: 'Brand 🌿',
      iconColor: 'orange',
      description: ' Marks ',
      children: [{ id: 'F2', name: 'Logos', icon: 'star', children: [] }],
    },
    { id: '', name: 'No id', children: [] },
  ],
  smartFolders: [{ id: 'S1', name: 'Blue tones' }],
  tagsGroups: [{ id: 'G1', name: 'Clients' }],
  modificationTime: 1_790_000_000_000,
};

describe('FL-653 Eagle library on the server', () => {
  it('maps a library as the browser importer does', () => {
    const library = buildEagleLibrary('Studio References.library', metadata, [
      {
        id: 'I1',
        metadata: {
          id: 'I1',
          name: 'hero',
          ext: 'JPG',
          tags: ['warm', 'warm', ' '],
          folders: ['F2'],
          star: 7,
          url: ' https://example.com/a ',
          modificationTime: 1_789_000_000_000,
        },
        fileNames: ['metadata.json', 'hero_thumbnail.png', 'hero.jpg'],
      },
      { id: 'I2', metadata: { id: 'I2', name: 'gone', ext: 'png' }, fileNames: ['metadata.json'] },
      { id: 'I3', metadata: undefined, fileNames: [] },
    ])!;
    expect(library.folders).toHaveLength(1);
    expect(library.folders[0]).toMatchObject({ name: 'Brand 🌿', color: 'orange', description: 'Marks' });
    expect(library.smartFolders).toEqual(['Blue tones']);
    expect(library.tagGroups).toEqual(['Clients']);
    expect(library.items[0]).toMatchObject({
      ext: 'jpg',
      tags: ['warm'],
      star: 5,
      url: 'https://example.com/a',
      present: true,
      fileName: 'hero.jpg',
    });
    expect(library.items[1]).toMatchObject({ present: false });
    expect(library.items[2]).toMatchObject({ id: 'I3', unreadable: true, present: false });
    // The same value the browser's reader gives this library (checked against web/.../eagle-import.ts).
    expect(eagleLibraryFingerprint(metadata, parseEagleFolders(metadata.folders), 3)).toBe(library.fingerprint);
    const supported = new Set(['jpg', 'png']);
    expect(library.items.filter((item) => isComing(item, supported)).map(({ id }) => id)).toEqual(['I1']);
  });

  it('gives the same fingerprint as the browser for the same lists', () => {
    const lists = { folders: [{ id: 'F1', name: 'Brand 🌿', children: [{ id: 'F2', name: 'Logos', children: [] }] }] };
    expect(eagleLibraryFingerprint(lists, parseEagleFolders(lists.folders), 7)).toBe(
      'hash:12473b5ae1c6e707ebc9ee703766',
    );
    expect(eagleLibraryFingerprint({ id: 'L1' }, [], 0)).toBe('eagle:id:L1');
  });

  it('is no library without its list', () => {
    expect(buildEagleLibrary('x.library', undefined, [])).toBeUndefined();
  });

  it('finds the item file only among the names its folder listed', () => {
    expect(findEagleItemFile({ name: '../../etc/passwd', ext: 'jpg' }, ['photo.jpg'])).toBe('photo.jpg');
    expect(findEagleItemFile({ name: 'a', ext: 'jpg' }, ['b.jpg', 'c.jpg'])).toBeUndefined();
    expect(findEagleItemFile({ name: 'a', ext: 'png' }, ['a_thumbnail.png', 'metadata.json'])).toBeUndefined();
  });

  it('names clashing top folders "Name (Eagle)" only at the top level', () => {
    const folders = parseEagleFolders(metadata.folders);
    expect(topFolderNames(folders, { mode: 'top' }, ['brand 🌿']).get('F1')).toBe('Brand 🌿 (Eagle)');
    expect(topFolderNames(folders, { mode: 'inside', inside: 'new' }, ['brand 🌿']).get('F1')).toBe('Brand 🌿');
    expect(eagleFolders(folders).map(({ id, parent, depth }) => [id, parent, depth])).toEqual([
      ['F1', null, 1],
      ['F2', 'F1', 2],
    ]);
    expect([eagleColour('Orange'), eagleColour('yellow'), eagleColour('aqua'), eagleColour('black')]).toEqual([
      'amber',
      'amber',
      'teal',
      undefined,
    ]);
  });

  it('takes only web addresses and past dates', () => {
    expect(eagleSourceUrl({ url: 'https://example.com/a' })).toBe('https://example.com/a');
    expect(eagleSourceUrl({ url: 'file:///Users/a.png' })).toBeUndefined();
    expect(eagleSourceUrl({ url: 'https://user:pass@example.com/' })).toBeUndefined();
    expect(eagleSourceUrl({ url: 'not a url' })).toBeUndefined();
    expect(eagleAddedDate({ modificationTime: 1000 }, 2000)?.getTime()).toBe(1000);
    expect(eagleAddedDate({ modificationTime: 3000 }, 2000)).toBeUndefined();
    expect(eagleAddedDate({ modificationTime: 0 }, 2000)).toBeUndefined();
  });
});
