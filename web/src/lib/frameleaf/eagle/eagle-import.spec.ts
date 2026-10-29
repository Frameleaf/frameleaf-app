import { eagleAnnotations } from '$lib/frameleaf/eagle/eagle-annotations';
import {
  eagleColour,
  eagleLibraryFingerprint,
  importResult,
  parseEagleItem,
  planEagleImport,
  previewTarget,
  reconciles,
  repeatedContents,
  supportedExtensions,
  topFolderNames,
  type EagleLibrary,
} from '$lib/frameleaf/eagle/eagle-import';
import {
  EagleLibraryError,
  entriesFromDirectory,
  entriesFromFileList,
  readEagleLibrary,
  type DirectoryHandleLike,
  type FileHandleLike,
} from '$lib/frameleaf/eagle/eagle-library-reader';
import { FIXTURE_LIBRARY_NAME, fixtureLibraryEntries } from '$lib/frameleaf/eagle/eagle-library.fixture';

const readFixture = () => readEagleLibrary(FIXTURE_LIBRARY_NAME, fixtureLibraryEntries());

describe('reading an Eagle library', () => {
  it('reads the folder tree, smart folders, tag groups and every item folder', async () => {
    const library = await readFixture();
    expect(library.name).toBe('Fixture.library');
    expect(library.folders.map(({ name }) => name)).toEqual(['Brand identity', 'Web', 'Inspiration']);
    expect(library.folders[0]).toMatchObject({ color: 'green', description: 'Marks we keep coming back to' });
    expect(library.smartFolders).toEqual(['Blue tones']);
    expect(library.tagGroups).toEqual(['Clients']);
    expect(library.items).toHaveLength(11);
    const hero = library.items.find(({ id }) => id === 'I1')!;
    expect(hero).toMatchObject({ name: 'hero', ext: 'jpg', star: 5, folders: ['F6', 'F7'], tags: ['hero', 'warm'] });
    expect(hero.file?.name).toBe('hero.jpg');
    expect(library.items.find(({ id }) => id === 'I10')!.file).toBeUndefined();
    expect(library.items.find(({ id }) => id === 'I11')!.unreadable).toBe(true);
  });

  it('tells two libraries with the same name apart', async () => {
    const first = await readFixture();
    const again = await readFixture();
    const other = await readEagleLibrary(FIXTURE_LIBRARY_NAME, fixtureLibraryEntries({ folderPrefix: 'G' }));
    expect(first.fingerprint).toMatch(/^hash:[\da-f]{28}$/);
    expect(again.fingerprint).toBe(first.fingerprint);
    expect(other.name).toBe(first.name);
    expect(other.fingerprint).not.toBe(first.fingerprint);
  });

  it('uses Eagle’s own library id when the metadata has one', () => {
    expect(eagleLibraryFingerprint({ id: 'LIB-1' }, [], 3)).toBe('eagle:id:LIB-1');
    expect(eagleLibraryFingerprint({}, [], 3)).not.toBe(eagleLibraryFingerprint({}, [], 4));
  });

  it('refuses a folder that is not an Eagle library', async () => {
    await expect(readEagleLibrary('Pictures', fixtureLibraryEntries())).rejects.toEqual(
      new EagleLibraryError('not-library'),
    );
    await expect(readEagleLibrary('Empty.library', [])).rejects.toEqual(new EagleLibraryError('not-library'));
  });

  it('takes the folder name and paths from a directory input', () => {
    const files = fixtureLibraryEntries().map(({ path, file }) => {
      Object.defineProperty(file, 'webkitRelativePath', { value: `${FIXTURE_LIBRARY_NAME}/${path}` });
      return file;
    });
    const { name, entries } = entriesFromFileList(files);
    expect(name).toBe(FIXTURE_LIBRARY_NAME);
    expect(entries.map(({ path }) => path)).toContain('images/I1.info/hero.jpg');
  });

  it('walks only the lists and images from a directory handle', async () => {
    const tree = new Map<string, File>(fixtureLibraryEntries().map(({ path, file }) => [path, file]));
    const directory = (name: string, prefix: string): DirectoryHandleLike => ({
      kind: 'directory',
      name,
      async *values() {
        const children = new Set<string>();
        for (const path of tree.keys()) {
          if (path.startsWith(prefix)) {
            children.add(path.slice(prefix.length).split('/', 1)[0]);
          }
        }
        for (const child of children) {
          const path = `${prefix}${child}`;
          yield tree.has(path)
            ? ({ kind: 'file', name: child, getFile: () => Promise.resolve(tree.get(path)!) } satisfies FileHandleLike)
            : directory(child, `${path}/`);
        }
      },
    });
    const { name, entries } = await entriesFromDirectory(directory(FIXTURE_LIBRARY_NAME, ''));
    expect(name).toBe(FIXTURE_LIBRARY_NAME);
    const paths = entries.map(({ path }) => path);
    expect(paths).toContain('metadata.json');
    expect(paths).toContain('images/I1.info/hero.jpg');
    expect(paths.some((path) => path.startsWith('backup/'))).toBe(false);
    expect((await readEagleLibrary(name, entries)).items).toHaveLength(11);
  });

  it('keeps untrusted metadata to the expected shape', () => {
    const item = parseEagleItem({ name: 7, ext: '.PNG', star: 9, tags: ['a', 'a', 3, ' b '], folders: 'F1' }, 'X1');
    expect(item).toMatchObject({ id: 'X1', name: 'X1', ext: 'png', star: 5, tags: ['a', 'b'], folders: [] });
  });
});

describe('the check before importing', () => {
  let library: EagleLibrary;
  beforeEach(async () => {
    library = await readFixture();
  });

  it('counts what comes over and lists by name what can’t', () => {
    const plan = planEagleImport(library, { existing: new Set(['I6']) });
    expect(plan).toMatchObject({
      found: 11,
      coming: 6,
      newFiles: 5,
      already: 1,
      leftOut: 5,
      trash: ['old-draft.png'],
      unsupported: [
        { name: 'Lodge Serif.otf', reason: 'font' },
        { name: 'fire-crackle.mp3', reason: 'sound' },
      ],
      missing: ['I11.info', 'missing.jpg'],
      collections: 7,
      topLevel: 3,
      depth: 3,
      inSeveral: 1,
      unfiled: 1,
      tags: 3,
      rated: 3,
      notes: 2,
      sources: 3,
      annotations: 0,
      areaCommentsWaiting: 1,
      colouredFolders: 4,
      notMapped: {
        smartFolders: ['Blue tones'],
        tagGroups: ['Clients'],
        folderIcons: ['Logos', 'Inspiration'],
        videoComments: ['loop.mp4'],
      },
    });
    expect(plan.coming + plan.leftOut).toBe(plan.found);
  });

  it('counts annotations once they can be written', () => {
    const plan = planEagleImport(library, { annotations: true });
    expect(plan).toMatchObject({ annotations: 1, areaCommentsWaiting: 0 });
  });

  it('lists a type the server does not take, instead of dropping it', () => {
    const supported = supportedExtensions(['.jpg', '.png', '.webp', '.mp4']);
    const plan = planEagleImport(library, { supported });
    expect(plan.unsupported).toContainEqual({ name: 'display.svg', reason: 'other' });
    expect(plan.coming + plan.leftOut).toBe(plan.found);
  });

  it('keeps what an earlier run did when carrying on', () => {
    const plan = planEagleImport(library, {
      existing: new Set(['I1', 'I6']),
      outcomes: { I1: { assetId: 'a1', duplicate: false } },
    });
    // I1 was sent by the first run, so it is "added", not "already", even though it is in the library now.
    expect(plan).toMatchObject({ already: 1, newFiles: 5, done: 1 });
  });
});

describe('where it goes', () => {
  it('keeps nested names, and renames only clashing top folders at the top level', async () => {
    const library = await readFixture();
    expect(previewTarget(library, { mode: 'inside', inside: 'new' }, 'Studio References', ['Web'])).toEqual({
      inside: 'Studio References',
      top: ['Brand identity', 'Web', 'Inspiration'],
      clashes: [],
    });
    expect(previewTarget(library, { mode: 'top' }, '', ['web', 'Inspiration'])).toEqual({
      inside: undefined,
      top: ['Brand identity', 'Web (Eagle)', 'Inspiration (Eagle)'],
      clashes: ['Web', 'Inspiration'],
    });
    expect(topFolderNames(library, { mode: 'top' }, ['Web']).get('F4')).toBe('Web (Eagle)');
  });

  it('maps Eagle folder colours onto the collection colours', () => {
    expect(
      ['red', 'orange', 'yellow', 'green', 'aqua', 'blue', 'purple', 'pink'].map((colour) => eagleColour(colour)),
    ).toEqual(['red', 'amber', 'amber', 'green', 'teal', 'blue', 'purple', 'pink']);
    expect(eagleColour('Orange')).toBe('amber');
    expect(eagleColour('grey')).toBeUndefined();
  });
});

describe('the finish report', () => {
  it('reconciles with the check when everything came over', async () => {
    const library = await readFixture();
    const plan = planEagleImport(library, { existing: new Set(['I6']) });
    const outcomes = Object.fromEntries(
      ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'].map((id) => [id, { assetId: `a-${id}`, duplicate: id === 'I6' }]),
    );
    const result = importResult(plan, library, { outcomes, collections: 7, stopped: false });
    expect(result).toMatchObject({ added: 5, already: 1, leftOut: 5, notReached: 0, tags: 3, rated: 3, notes: 2 });
    expect(reconciles(plan, result)).toBe(true);
  });

  it('accounts for every item when the import was stopped', async () => {
    const library = await readFixture();
    const plan = planEagleImport(library);
    const result = importResult(plan, library, {
      outcomes: { I1: { assetId: 'a1', duplicate: false }, I2: { assetId: 'a2', duplicate: false } },
      collections: 7,
      stopped: true,
    });
    expect(result).toMatchObject({ added: 2, already: 0, leftOut: 5, notReached: 4 });
    expect(reconciles(plan, result)).toBe(true);
  });

  it('counts a file that could not be sent as not come over, by name', async () => {
    const library = await readFixture();
    const plan = planEagleImport(library);
    const outcomes = Object.fromEntries(
      ['I1', 'I2', 'I3', 'I4', 'I5'].map((id) => [id, { assetId: id, duplicate: false }]),
    );
    const result = importResult(plan, library, { outcomes, failed: new Set(['I6']), collections: 7, stopped: false });
    expect(result).toMatchObject({ failed: ['already.png'], leftOut: 6, notReached: 0 });
    expect(reconciles(plan, result)).toBe(true);
  });

  it('does not reconcile when the numbers differ from the check', async () => {
    const library = await readFixture();
    const plan = planEagleImport(library, { existing: new Set(['I6']) });
    const outcomes = Object.fromEntries(
      ['I1', 'I2', 'I3', 'I4', 'I5', 'I6'].map((id) => [id, { assetId: id, duplicate: false }]),
    );
    const result = importResult(plan, library, { outcomes, collections: 7, stopped: false });
    expect(reconciles(plan, result)).toBe(false);
    expect(reconciles(plan, { ...result, notReached: 1 })).toBe(false);
  });
});

describe('Eagle comments as annotations', () => {
  it('turns area comments on a picture into rectangles from Eagle, as fractions', () => {
    expect(
      eagleAnnotations({
        ext: 'jpg',
        width: 1000,
        height: 500,
        comments: [
          { id: 'C1', x: 100, y: 50, width: 200, height: 100, annotation: ' This corner ' },
          { id: 'C2', x: 0, y: 0, width: 0, height: 0, annotation: 'A plain comment' },
          { id: 'C 1', x: 900, y: 400, width: 400, height: 400, annotation: '' },
        ],
      }),
    ).toEqual([
      {
        id: 'eagle-C1',
        kind: 'rect',
        geometry: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        note: 'This corner',
        origin: 'eagle',
      },
      {
        id: 'eagle-C-1',
        kind: 'rect',
        geometry: { x: 0.9, y: 0.8, width: expect.closeTo(0.1), height: expect.closeTo(0.2) },
        origin: 'eagle',
      },
    ]);
  });

  it('gives videos and pictures of unknown size none', () => {
    const comments = [{ id: 'C1', x: 1, y: 1, width: 5, height: 5, annotation: 'x' }];
    expect(eagleAnnotations({ ext: 'mp4', width: 100, height: 100, comments })).toEqual([]);
    expect(eagleAnnotations({ ext: 'png', width: 0, height: 0, comments })).toEqual([]);
  });

  it('keeps ids unique, notes short and the count within the limit', () => {
    const comments = Array.from({ length: 250 }, () => ({
      id: 'same',
      x: 1,
      y: 1,
      width: 5,
      height: 5,
      annotation: 'n'.repeat(400),
    }));
    const annotations = eagleAnnotations({ ext: 'png', width: 100, height: 100, comments });
    expect(annotations).toHaveLength(200);
    expect(new Set(annotations.map(({ id }) => id)).size).toBe(200);
    expect(annotations[0].note).toHaveLength(280);
  });
});

describe('files that appear twice in the library', () => {
  it('counts every copy after the first as already in your library', async () => {
    const library = await readFixture();
    const checksums = new Map([
      ['I1', { sha256: 'a' }],
      ['I2', { sha256: 'b' }],
      ['I3', { sha256: 'a' }],
      ['I5', { sha256: 'a' }],
    ]);
    const repeated = repeatedContents(library.items, checksums);
    expect([...repeated]).toEqual(['I3', 'I5']);
    const plan = planEagleImport(library, { existing: repeated });
    expect(plan).toMatchObject({ already: 2, newFiles: 4 });
  });
});
