import { MediaHealthCategory, type FileProblemRowDto, type FileStepDto } from '@frameleaf/sdk';
import { addMessages, t, type MessageFormatter, type Translations } from 'svelte-i18n';
import { get } from 'svelte/store';
import en from '../../../../i18n/en.json';
import {
  folderPath,
  lineWords,
  offersLookIn,
  offersRepair,
  problemKind,
  stepWords,
  storyWords,
  type StepContext,
  type StepWords,
} from './file-steps';

type KitTone = NonNullable<StepWords['result']>['tone'];

const step = (name: string, outcome: string, facts: Record<string, unknown> = {}): FileStepDto => ({
  at: '2026-11-09T02:15:00.000Z',
  step: name,
  outcome,
  facts,
});

const row = (value: Partial<FileProblemRowDto> = {}): FileProblemRowDto => ({
  id: 'p1',
  assetId: 'a1',
  ownerId: 'u1',
  ownerName: 'Taylor',
  originalFileName: 'IMG_2041.jpg',
  category: MediaHealthCategory.Corrupt,
  fixState: 'repaired',
  partSaved: false,
  line: null,
  updatedAt: '2026-11-09T02:15:00.000Z',
  pictureAllowed: true,
  canAct: true,
  ...value,
});

describe('file steps in plain words (FL-1338)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('shows a path as "Library › 2019 › 03", with the file name when it has one', () => {
    expect(folderPath({ folder: '2019/03' })).toBe('Library › 2019 › 03');
    expect(folderPath({ folder: '2020/08', name: 'IMG_3310.jpg' })).toBe('Library › 2020 › 08 › IMG_3310.jpg');
    expect(folderPath({ folder: '', name: 'IMG_1.jpg' })).toBe('Library › IMG_1.jpg');
    expect(folderPath({})).toBeUndefined();
  });

  /**
   * Every step, outcome and variant the history can say, each with its sentence. The last test checks
   * that these cases reach every `frameleaf_file_step_*` and `frameleaf_file_kind_*` string, so a string
   * no step can say does not sit in i18n/en.json unused.
   */
  const r = (tone: KitTone, text: string) => ({ tone, text });
  const missingCategory = { category: MediaHealthCategory.Missing };
  const corruptCategory = { category: MediaHealthCategory.Corrupt };
  const named = { source: 'Northwind' };
  const nov9 = { locale: 'en-GB', now: new Date('2026-11-09T12:00:00.000Z') };
  const cases: Array<[string, string, string, Record<string, unknown>, StepContext, StepWords]> = [
    ['added', 'added', 'ok', {}, {}, { what: 'Added' }],
    [
      'imported',
      'imported',
      'ok',
      { source: 'Northwind' },
      {},
      { what: 'Brought into Frameleaf', detail: 'From your Northwind library' },
    ],
    [
      'imported, as the design calls it',
      'imported',
      'info',
      { source: 'Northwind' },
      {},
      { what: 'Brought into Frameleaf', detail: 'From your Northwind library' },
    ],
    [
      'imported without its file',
      'imported',
      'failed',
      { source: 'Northwind', sourcePath: 'upload/x.heic' },
      {},
      {
        what: 'Brought into Frameleaf',
        detail: 'Northwind listed this photo, but its file wasn’t there. Only its small preview came across.',
        result: r('warn', 'Missing'),
      },
    ],
    [
      'imported without its file, from an unnamed library',
      'imported',
      'failed',
      {},
      {},
      {
        what: 'Brought into Frameleaf',
        detail: 'Its file wasn’t there. Only its small preview came across.',
        result: r('warn', 'Missing'),
      },
    ],
    [
      'moved',
      'moved',
      'ok',
      { folder: '2019/03' },
      {},
      {
        what: 'Put in its folder',
        detail:
          'Moved to Library › 2019 › 03. The new copy was checked against the old one before the old one was removed.',
        result: r('good', 'Checked'),
      },
    ],
    [
      'not on the drive',
      'not-on-drive',
      'failed',
      { folder: '2020/08', name: 'IMG_3310.jpg' },
      {},
      {
        what: 'Not on the drive',
        detail: 'The nightly file check couldn’t find Library › 2020 › 08 › IMG_3310.jpg.',
        result: r('warn', 'Missing'),
      },
    ],
    [
      'not on the drive, nowhere it may name',
      'not-on-drive',
      'failed',
      {},
      {},
      { what: 'Not on the drive', detail: 'The nightly file check couldn’t find it.', result: r('warn', 'Missing') },
    ],
    ...(
      [
        ['cut-short', 'the file stops partway through the picture.'],
        ['junk-in-front', 'Frameleaf didn’t recognise the start of the file.'],
        ['broken-details', 'the file’s details are damaged.'],
        ['unreadable', 'the file can’t be read.'],
        ['blank', 'the file can’t be read.'],
      ] as const
    ).map(([cause, words]): (typeof cases)[number] => [
      `wont open: ${cause}`,
      'wont-open',
      'failed',
      { cause },
      {},
      { what: 'Couldn’t open it', detail: `Making its preview failed: ${words}`, result: r('warn', 'Damaged') },
    ]),
    [
      'wont open: changed',
      'wont-open',
      'failed',
      { cause: 'changed' },
      {},
      {
        what: 'Couldn’t open it',
        detail:
          'Making its preview failed: the file is no longer the one Frameleaf stored. Part of the drive may be failing.',
        result: r('warn', 'Changed'),
      },
    ],
    [
      'wont open, found by a file check',
      'wont-open',
      'failed',
      { folder: '2019/03', name: 'IMG_2041.jpg' },
      {},
      {
        what: 'Couldn’t open it',
        detail: 'The nightly file check couldn’t open Library › 2019 › 03 › IMG_2041.jpg.',
        result: r('warn', 'Damaged'),
      },
    ],
    [
      'wont open, found by a file check nowhere it may name',
      'wont-open',
      'failed',
      {},
      {},
      { what: 'Couldn’t open it', detail: 'The nightly file check couldn’t open it.', result: r('warn', 'Damaged') },
    ],
    [
      'checked: fine',
      'checked',
      'ok',
      {},
      {},
      {
        what: 'Checked the file',
        detail: 'It is complete and opens. Nothing needs fixing.',
        result: r('good', 'Fine'),
      },
    ],
    ...(
      [
        [
          'blank',
          'Every part of it is blank. The picture was lost before it came to Frameleaf, so no copy of it was ever stored.',
          r('bad', 'Blank'),
        ],
        ['cut-short', 'The file stops partway through the picture.', r('warn', 'Damaged')],
        ['junk-in-front', 'Frameleaf didn’t recognise the start of the file.', r('warn', 'Damaged')],
        ['broken-details', 'The file’s details are damaged.', r('warn', 'Damaged')],
        ['unreadable', 'The file can’t be read.', r('warn', 'Damaged')],
        ['changed', 'It still opens, but it is no longer the file Frameleaf stored.', r('warn', 'Changed')],
        [
          'busy',
          'It couldn’t be read after three tries. Frameleaf tries again at the next file check.',
          r('off', 'Couldn’t check'),
        ],
      ] as const
    ).map(([cause, detail, result]): (typeof cases)[number] => [
      `checked: ${cause}`,
      'checked',
      'failed',
      { cause },
      {},
      { what: 'Checked the file', detail, result },
    ]),
    [
      'looked where it was being moved',
      'looked-where-moving',
      'not-found',
      { folder: '2021/07' },
      named,
      {
        what: 'Looked where Northwind was moving it',
        detail: 'Northwind’s own records say it was being moved to Library › 2021 › 07. Nothing is there.',
        result: r('off', 'Not there'),
      },
    ],
    [
      'looked where it was being moved, from an unnamed library',
      'looked-where-moving',
      'not-found',
      { folder: '2021/07' },
      {},
      {
        what: 'Looked where it was being moved',
        detail: 'The records it came with say it was being moved to Library › 2021 › 07. Nothing is there.',
        result: r('off', 'Not there'),
      },
    ],
    [
      'looked where it was being moved, and a file is there',
      'looked-where-moving',
      'ok',
      { folder: '2021/07', name: 'IMG_1.jpg' },
      named,
      {
        what: 'Looked where Northwind was moving it',
        detail: 'Northwind’s own records say it was being moved to Library › 2021 › 07 › IMG_1.jpg. A file is there.',
        result: r('good', 'Found'),
      },
    ],
    [
      'looked where it was being moved, from an unnamed library, and a file is there',
      'looked-where-moving',
      'ok',
      { folder: '2021/07' },
      {},
      {
        what: 'Looked where it was being moved',
        detail: 'The records it came with say it was being moved to Library › 2021 › 07. A file is there.',
        result: r('good', 'Found'),
      },
    ],
    [
      'found one copy',
      'searched-copy',
      'ok',
      { places: ['managed'], copies: 1, folder: '2020/08', name: 'IMG_3310+1.jpg' },
      {},
      {
        what: 'Looked for an exact copy',
        detail: 'Found one at Library › 2020 › 08 › IMG_3310+1.jpg. Its contents match the photo exactly.',
        result: r('good', 'Found'),
      },
    ],
    [
      'found several copies',
      'searched-copy',
      'ok',
      { places: ['managed'], copies: 3 },
      {},
      {
        what: 'Looked for an exact copy',
        detail: 'Found 3 copies whose contents match the photo exactly.',
        result: r('good', 'Found'),
      },
    ],
    [
      'found copies in the folder the person chose',
      'searched-copy',
      'ok',
      { folder: 'USB drive', copies: 2 },
      {},
      {
        what: 'Looked for an exact copy',
        detail: 'Found 2 copies in USB drive whose contents match the photo exactly.',
        result: r('good', 'Found'),
      },
    ],
    [
      'found no copy',
      'searched-copy',
      'not-found',
      { places: ['managed'] },
      {},
      {
        what: 'Looked for an exact copy',
        detail: 'Compared every file on this server’s drives by its contents, not its name.',
        result: r('off', 'None found'),
      },
    ],
    [
      'found no copy in the folder the person chose',
      'searched-copy',
      'not-found',
      { folder: 'USB drive' },
      {},
      {
        what: 'Looked for an exact copy',
        detail: 'Compared every file in USB drive by its contents, not its name.',
        result: r('off', 'None found'),
      },
    ],
    [
      'not in the backups, since when',
      'checked-backups',
      'not-found',
      { backup: 'cloud', since: '2026-11-06T12:00:00.000Z' },
      nov9,
      {
        what: 'Checked your backups',
        detail: 'Cloud Backup began on 6 Nov, after this file was already lost.',
        result: r('off', 'Not there'),
      },
    ],
    [
      'not in the backups',
      'checked-backups',
      'not-found',
      { backup: 'cloud' },
      {},
      { what: 'Checked your backups', detail: 'Cloud Backup doesn’t have it.', result: r('off', 'Not there') },
    ],
    [
      'in the backups',
      'checked-backups',
      'ok',
      { backup: 'cloud', since: '2026-11-06T12:00:00.000Z' },
      nov9,
      { what: 'Checked your backups', detail: 'Cloud Backup has the original.', result: r('good', 'Found') },
    ],
    [
      'restored a changed file',
      'restored',
      'ok',
      { backup: 'cloud' },
      corruptCategory,
      {
        what: 'Restored it from Cloud Backup',
        detail: 'The original is back where it was. The changed file is kept beside it.',
        result: r('good', 'Restored'),
      },
    ],
    [
      'restored a missing file',
      'restored',
      'ok',
      { backup: 'cloud' },
      missingCategory,
      {
        what: 'Restored it from Cloud Backup',
        detail: 'The original is back where it was.',
        result: r('good', 'Restored'),
      },
    ],
    [
      'asked the phones',
      'asked-phones',
      'waiting',
      { phones: 2 },
      {},
      {
        what: 'Asked your phones',
        detail: 'Your phones send it back if they still have it, the next time Frameleaf is opened on them.',
        result: r('warn', 'Waiting'),
      },
    ],
    [
      'every phone has looked',
      'asked-phones',
      'not-found',
      {},
      { waited: true },
      {
        what: 'Asked your phones',
        detail: 'Not there. Every phone used with this library has now looked.',
        result: r('off', 'Not on a phone'),
      },
    ],
    [
      'no phone to ask',
      'asked-phones',
      'not-found',
      {},
      { waited: false },
      {
        what: 'Asked your phones',
        detail: 'No phone uses Frameleaf for this library.',
        result: r('off', 'Not on a phone'),
      },
    ],
    [
      'a phone sent it back',
      'asked-phones',
      'ok',
      { device: 'Taylor’s iPhone' },
      {},
      { what: 'Asked your phones', detail: 'Taylor’s iPhone sent it back.', result: r('good', 'Found') },
    ],
    [
      'an unnamed phone sent it back',
      'asked-phones',
      'ok',
      {},
      {},
      { what: 'Asked your phones', detail: 'A phone sent it back.', result: r('good', 'Found') },
    ],
    [
      'checked on a phone',
      'checked-on-phone',
      'not-found',
      { device: 'iPad' },
      {},
      { what: 'Checked on iPad', detail: 'Not on this iPad.', result: r('off', 'Not there') },
    ],
    [
      'checked on an unnamed phone',
      'checked-on-phone',
      'not-found',
      {},
      {},
      { what: 'Checked on a phone', detail: 'Not on this phone.', result: r('off', 'Not there') },
    ],
    ...(
      [
        [
          'rebuilt, part saved',
          { method: 'rebuilt', percentSaved: 92, metadataLost: false },
          {},
          'Rebuilt the picture from the part that was there: 92% of it. The date, place and camera details were copied over.',
        ],
        [
          'rebuilt, part saved, details lost',
          { method: 'rebuilt', percentSaved: 92, metadataLost: true },
          {},
          'Rebuilt the picture from the part that was there: 92% of it. Some of the date, place and camera details couldn’t be copied over.',
        ],
        [
          'rebuilt whole',
          { method: 'rebuilt', percentSaved: 100, metadataLost: false },
          {},
          'Rebuilt the picture from what could be read. The whole picture was saved.',
        ],
        [
          'unreadable data removed',
          { method: 'lossless', metadataLost: false },
          { cause: 'junk-in-front' },
          'Removed unreadable data in front of the picture. Nothing in the picture changed.',
        ],
        [
          'details rebuilt',
          { method: 'lossless', metadataLost: false },
          { cause: 'broken-details' },
          'Rebuilt the damaged details. Nothing in the picture changed. The date and place were copied over.',
        ],
        [
          'details rebuilt, details lost',
          { method: 'lossless', metadataLost: true },
          { cause: 'broken-details' },
          'Rebuilt the damaged details. Nothing in the picture changed. Some of the date and place details couldn’t be copied over.',
        ],
        [
          'lossless, cause unknown',
          { method: 'lossless', metadataLost: false },
          {},
          'Fixed the damaged data around the picture. Nothing in the picture changed.',
        ],
        [
          'only its small preview',
          { method: 'preview', metadataLost: true },
          {},
          'Saved the small preview stored inside the file. The full picture was lost.',
        ],
        [
          'another kind of image',
          { method: 'converted', metadataLost: false },
          {},
          'This file held another kind of image under a .jpg name. It was saved as a real JPEG.',
        ],
      ] as const
    ).map(([label, facts, context, detail]): (typeof cases)[number] => [
      `repaired: ${label}`,
      'repaired',
      'ok',
      facts,
      context,
      { what: 'Repaired it', detail, result: r('good', 'Repaired') },
    ]),
    [
      'repaired by a person',
      'repaired',
      'ok',
      { method: 'lossless', metadataLost: false, by: 'Taylor' },
      {},
      {
        what: 'Repaired by Taylor',
        detail: 'Fixed the damaged data around the picture. Nothing in the picture changed.',
        result: r('good', 'Repaired'),
      },
    ],
    [
      'kept the damaged file',
      'kept-damaged',
      'info',
      {},
      {},
      { what: 'Kept the damaged file', detail: 'Beside the repaired one, in Library care. Undo puts it back.' },
    ],
    [
      'put a missing file back',
      'put-back',
      'ok',
      {},
      missingCategory,
      {
        what: 'Put it back',
        detail: 'Your library uses that file now. Nothing was copied, moved or renamed.',
        result: r('good', 'Found again'),
      },
    ],
    [
      'put a changed file’s original back',
      'put-back',
      'ok',
      {},
      corruptCategory,
      {
        what: 'Put it back',
        detail: 'A copy of the original takes the changed file’s place. The changed file is kept beside it.',
        result: r('good', 'Found again'),
      },
    ],
    [
      'put back what a phone sent',
      'put-back',
      'ok',
      {},
      { ...missingCategory, fromPhone: true },
      {
        what: 'Put it back',
        detail: 'Your library uses the photo your phone sent.',
        result: r('good', 'Found again'),
      },
    ],
    [
      'copied a lost original back from the old folders',
      'put-back',
      'ok',
      { copied: true },
      missingCategory,
      {
        what: 'Copied it back',
        detail:
          'A copy in the folders your old photo app used matched exactly. Frameleaf copied it into your library and left the old one where it was.',
        result: r('good', 'Found again'),
      },
    ],
    [
      'copied back by a person’s own choice',
      'put-back',
      'ok',
      { copied: true, by: 'Taylor' },
      missingCategory,
      {
        what: 'Copied it back',
        detail:
          'A copy in the folders your old photo app used matched exactly. Frameleaf copied it into your library and left the old one where it was. Taylor chose it.',
        result: r('good', 'Found again'),
      },
    ],
    ...(
      [
        ['.psd', 'Photoshop'],
        ['.ai', 'Illustrator'],
        ['.indd', 'InDesign'],
        ['.TGA', 'TGA'],
      ] as const
    ).map(([extension, kind]): (typeof cases)[number] => [
      `couldn’t make a preview of ${extension}`,
      'unsupported',
      'info',
      { extension },
      {},
      {
        what: 'Couldn’t make a preview',
        detail: `Frameleaf can’t show ${kind} files yet.`,
        result: r('off', 'Not supported'),
      },
    ]),
    ['undone by a person', 'undone', 'info', { by: 'Taylor' }, {}, { what: 'Undone by Taylor' }],
    ['undone', 'undone', 'info', {}, {}, { what: 'Undone' }],
    [
      'left as it is',
      'kept-as-is',
      'info',
      {},
      {},
      { what: 'Left as it is', detail: 'It can still be downloaded, shared and backed up.' },
    ],
    ['removed', 'removed', 'info', { by: 'Taylor' }, {}, { what: 'Removed from the library' }],
  ];

  it.each(cases)('%s', (_label, name, outcome, facts, context, expected) => {
    expect(stepWords(step(name, outcome, facts), context)).toEqual(expected);
  });

  it('has a step for every step sentence and file kind in i18n/en.json, and no sentence nothing says', () => {
    const asked = new Set<string>();
    const translate = get(t);
    const recording = ((id: Translations, options?: never) => {
      asked.add(id);
      return translate(id, options);
    }) as unknown as MessageFormatter;
    for (const [, name, outcome, facts, context] of cases) {
      stepWords(step(name, outcome, facts), context, recording);
    }
    const keys = new Set(Object.keys(en));
    const strings = [...keys].filter(
      (key) => key.startsWith('frameleaf_file_step_') || key.startsWith('frameleaf_file_kind_'),
    );
    expect(strings.filter((key) => !asked.has(key))).toEqual([]);
    expect([...asked].filter((key) => !keys.has(key))).toEqual([]);
  });

  it('leaves out a step it has no words for, rather than inventing one', () => {
    expect(stepWords(step('something-new', 'ok'))).toBeUndefined();
    expect(stepWords(step('repaired', 'waiting'))).toBeUndefined();
  });

  it('tells a story with what earlier steps knew: where it came from and whether phones were asked', () => {
    const story = storyWords({
      category: MediaHealthCategory.Missing,
      steps: [
        step('imported', 'failed', { source: 'Northwind', sourcePath: 'upload/x.heic' }),
        step('looked-where-moving', 'not-found', { folder: '2021/07' }),
        step('asked-phones', 'waiting', { phones: 1 }),
        step('asked-phones', 'not-found'),
        step('something-new', 'ok'),
      ],
    });
    expect(story.map(({ words }) => words.what)).toEqual([
      'Brought into Frameleaf',
      'Looked where Northwind was moving it',
      'Asked your phones',
      'Asked your phones',
    ]);
    expect(story[3].words.detail).toBe('Not there. Every phone used with this library has now looked.');
  });

  it('tells a row its story in one line', () => {
    expect(
      lineWords(
        row({
          partSaved: true,
          fixState: 'part-saved',
          line: { step: 'repaired', outcome: 'ok', facts: { method: 'rebuilt', percentSaved: 92 } },
        }),
      ),
    ).toBe('The end of the file was cut off. 92% of the picture was saved.');
    expect(lineWords(row({ line: { step: 'checked', outcome: 'failed', facts: { cause: 'blank' } } }))).toBe(
      'The file is there, but its contents are blank. It can’t be repaired.',
    );
    expect(lineWords(row({ line: { step: 'restored', outcome: 'ok', facts: { backup: 'cloud' } } }))).toBe(
      'Changed on the drive after Frameleaf stored it. The original came back from Cloud Backup.',
    );
    expect(lineWords(row({ line: { step: 'unsupported', outcome: 'info', facts: { extension: '.psd' } } }))).toBe(
      'A Photoshop file. It’s fine and kept as it is, but Frameleaf can’t make a preview of it.',
    );
    // otherwise the step's own sentence
    expect(
      lineWords(
        row({ category: MediaHealthCategory.Missing, line: { step: 'asked-phones', outcome: 'waiting', facts: {} } }),
      ),
    ).toBe('Your phones send it back if they still have it, the next time Frameleaf is opened on them.');
    expect(lineWords(row({ line: null }))).toBeUndefined();
  });

  it('sorts a problem into what the page shows for it', () => {
    expect(problemKind(row({ fixState: 'part-saved' }))).toBe('repaired');
    expect(problemKind(row({ fixState: 'restored' }))).toBe('found');
    expect(problemKind(row({ fixState: 'waiting-phone', category: MediaHealthCategory.Missing }))).toBe('missing');
    expect(problemKind(row({ fixState: 'cant-repair' }))).toBe('unrepairable');
    expect(problemKind(row({ fixState: 'couldnt-check' }))).toBe('unchecked');
    expect(problemKind(row({ fixState: 'left-as-is' }))).toBe('kept');
    // not looked at yet: it needs the person
    expect(problemKind(row({ fixState: null, category: MediaHealthCategory.Missing }))).toBe('missing');
    expect(problemKind(row({ fixState: null }))).toBe('unrepairable');
  });

  it('offers Repair… for a damaged JPEG that repair is off for, or whose repair was undone', () => {
    const problem = (steps: FileStepDto[], value: Partial<FileProblemRowDto> = {}) => ({
      ...row({ fixState: 'cant-repair', ...value }),
      steps,
    });
    expect(offersRepair(problem([step('checked', 'failed', { cause: 'cut-short' })]))).toBe(true);
    expect(
      offersRepair(
        problem([step('repaired', 'ok', { method: 'rebuilt' }), step('kept-damaged', 'info'), step('undone', 'info')]),
      ),
    ).toBe(true);
    expect(offersRepair(problem([step('checked', 'failed', { cause: 'blank' })]))).toBe(false);
    expect(
      offersRepair(problem([step('checked', 'failed', { cause: 'cut-short' })], { originalFileName: 'Scan_014.png' })),
    ).toBe(false);
    expect(offersRepair(problem([step('checked', 'failed', { cause: 'cut-short' })], { fixState: 'repaired' }))).toBe(
      false,
    );
  });

  it('offers Look in a folder for a missing file, and for a damaged one only when it changed after it was stored', () => {
    const problem = (category: MediaHealthCategory, fixState: string, steps: FileStepDto[]) => ({
      ...row({ category, fixState }),
      steps,
    });
    expect(offersLookIn(problem(MediaHealthCategory.Missing, 'missing', []))).toBe(true);
    expect(offersLookIn(problem(MediaHealthCategory.Missing, 'waiting-phone', []))).toBe(true);
    expect(
      offersLookIn(
        problem(MediaHealthCategory.Corrupt, 'cant-repair', [step('checked', 'failed', { cause: 'changed' })]),
      ),
    ).toBe(true);
    // it arrived damaged: every exact copy has the same damage
    expect(
      offersLookIn(
        problem(MediaHealthCategory.Corrupt, 'cant-repair', [step('checked', 'failed', { cause: 'blank' })]),
      ),
    ).toBe(false);
    // the latest cause decides
    expect(
      offersLookIn(
        problem(MediaHealthCategory.Corrupt, 'cant-repair', [
          step('wont-open', 'failed', { cause: 'changed' }),
          step('checked', 'failed', { cause: 'unreadable' }),
        ]),
      ),
    ).toBe(false);
    expect(
      offersLookIn(problem(MediaHealthCategory.Corrupt, 'repaired', [step('checked', 'failed', { cause: 'changed' })])),
    ).toBe(false);
  });
});
