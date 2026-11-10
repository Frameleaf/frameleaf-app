import { MediaHealthCategory, type FileProblemRowDto, type FileStepDto } from '@frameleaf/sdk';
import { addMessages } from 'svelte-i18n';
import en from '../../../../i18n/en.json';
import { folderPath, lineWords, offersRepair, problemKind, stepWords, storyWords } from './file-steps';

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

  it('added', () => {
    expect(stepWords(step('added', 'ok'))).toEqual({ what: 'Added' });
  });

  it('imported, and imported without its file', () => {
    expect(stepWords(step('imported', 'ok', { source: 'Northwind' }))).toEqual({
      what: 'Brought into Frameleaf',
      detail: 'From your Northwind library',
    });
    expect(stepWords(step('imported', 'failed', { source: 'Northwind', sourcePath: 'upload/x.heic' }))).toEqual({
      what: 'Brought into Frameleaf',
      detail: 'Northwind listed this photo, but its file wasn’t there. Only its small preview came across.',
      result: { tone: 'warn', text: 'Missing' },
    });
  });

  it('moved', () => {
    expect(stepWords(step('moved', 'ok', { folder: '2019/03' }))).toEqual({
      what: 'Put in its folder',
      detail:
        'Moved to Library › 2019 › 03. The new copy was checked against the old one before the old one was removed.',
      result: { tone: 'good', text: 'Checked' },
    });
  });

  it('not-on-drive', () => {
    expect(stepWords(step('not-on-drive', 'failed', { folder: '2020/08', name: 'IMG_3310.jpg' }))).toEqual({
      what: 'Not on the drive',
      detail: 'The nightly file check couldn’t find Library › 2020 › 08 › IMG_3310.jpg.',
      result: { tone: 'warn', text: 'Missing' },
    });
  });

  it('wont-open, by its cause', () => {
    const words = (cause: string) => stepWords(step('wont-open', 'failed', { cause }));
    expect(words('cut-short')).toEqual({
      what: 'Couldn’t open it',
      detail: 'Making its preview failed: the file stops partway through the picture.',
      result: { tone: 'warn', text: 'Damaged' },
    });
    expect(words('junk-in-front')?.detail).toBe(
      'Making its preview failed: Frameleaf didn’t recognise the start of the file.',
    );
    expect(words('broken-details')?.detail).toBe('Making its preview failed: the file’s details are damaged.');
    expect(words('unreadable')?.detail).toBe('Making its preview failed: the file can’t be read.');
    expect(words('changed')).toEqual({
      what: 'Couldn’t open it',
      detail:
        'Making its preview failed: the file is no longer the one Frameleaf stored. Part of the drive may be failing.',
      result: { tone: 'warn', text: 'Changed' },
    });
  });

  it('checked', () => {
    expect(stepWords(step('checked', 'failed', { cause: 'blank' }))).toEqual({
      what: 'Checked the file',
      detail:
        'Every part of it is blank. The picture was lost before it came to Frameleaf, so no copy of it was ever stored.',
      result: { tone: 'bad', text: 'Blank' },
    });
    expect(stepWords(step('checked', 'ok'))).toEqual({
      what: 'Checked the file',
      detail: 'It is complete and opens. Nothing needs fixing.',
      result: { tone: 'good', text: 'Fine' },
    });
    expect(stepWords(step('checked', 'failed', { cause: 'busy' }))?.result).toEqual({
      tone: 'off',
      text: 'Couldn’t check',
    });
  });

  it('looked-where-moving, naming where the library came from', () => {
    expect(stepWords(step('looked-where-moving', 'not-found', { folder: '2021/07' }), { source: 'Northwind' })).toEqual(
      {
        what: 'Looked where Northwind was moving it',
        detail: 'Northwind’s own records say it was being moved to Library › 2021 › 07. Nothing is there.',
        result: { tone: 'off', text: 'Not there' },
      },
    );
  });

  it('searched-copy', () => {
    expect(stepWords(step('searched-copy', 'not-found', { places: ['managed'] }))).toEqual({
      what: 'Looked for an exact copy',
      detail: 'Compared every file on this server’s drives by its contents, not its name.',
      result: { tone: 'off', text: 'None found' },
    });
    expect(
      stepWords(
        step('searched-copy', 'ok', { places: ['managed'], copies: 1, folder: '2020/08', name: 'IMG_3310+1.jpg' }),
      ),
    ).toEqual({
      what: 'Looked for an exact copy',
      detail: 'Found one at Library › 2020 › 08 › IMG_3310+1.jpg. Its contents match the photo exactly.',
      result: { tone: 'good', text: 'Found' },
    });
    // Look in a folder names the folder the person chose
    expect(stepWords(step('searched-copy', 'not-found', { folder: 'USB drive' }))?.detail).toBe(
      'Compared every file in USB drive by its contents, not its name.',
    );
  });

  it('checked-backups', () => {
    expect(
      stepWords(step('checked-backups', 'not-found', { backup: 'cloud', since: '2026-11-06T12:00:00.000Z' }), {
        locale: 'en-GB',
        now: new Date('2026-11-09T12:00:00.000Z'),
      }),
    ).toEqual({
      what: 'Checked your backups',
      detail: 'Cloud Backup began on 6 Nov, after this file was already lost.',
      result: { tone: 'off', text: 'Not there' },
    });
  });

  it('restored', () => {
    expect(stepWords(step('restored', 'ok', { backup: 'cloud' }), { category: MediaHealthCategory.Corrupt })).toEqual({
      what: 'Restored it from Cloud Backup',
      detail: 'The original is back where it was. The changed file is kept beside it.',
      result: { tone: 'good', text: 'Restored' },
    });
  });

  it('asked-phones', () => {
    expect(stepWords(step('asked-phones', 'waiting', { phones: 2 }))).toEqual({
      what: 'Asked your phones',
      detail: 'Your phones send it back if they still have it, the next time Frameleaf is opened on them.',
      result: { tone: 'warn', text: 'Waiting' },
    });
    expect(stepWords(step('asked-phones', 'not-found'), { waited: true })).toEqual({
      what: 'Asked your phones',
      detail: 'Not there. Every phone used with this library has now looked.',
      result: { tone: 'off', text: 'Not on a phone' },
    });
  });

  it('checked-on-phone', () => {
    expect(stepWords(step('checked-on-phone', 'not-found', { device: 'iPad' }))).toEqual({
      what: 'Checked on iPad',
      detail: 'Not on this iPad.',
      result: { tone: 'off', text: 'Not there' },
    });
  });

  it('repaired, by how it was repaired', () => {
    expect(stepWords(step('repaired', 'ok', { method: 'rebuilt', percentSaved: 92, metadataLost: false }))).toEqual({
      what: 'Repaired it',
      detail:
        'Rebuilt the picture from the part that was there: 92% of it. The date, place and camera details were copied over.',
      result: { tone: 'good', text: 'Repaired' },
    });
    expect(
      stepWords(step('repaired', 'ok', { method: 'lossless', metadataLost: false }), { cause: 'junk-in-front' })
        ?.detail,
    ).toBe('Removed unreadable data in front of the picture. Nothing in the picture changed.');
    expect(
      stepWords(step('repaired', 'ok', { method: 'lossless', metadataLost: false }), { cause: 'broken-details' })
        ?.detail,
    ).toBe('Rebuilt the damaged details. Nothing in the picture changed. The date and place were copied over.');
  });

  it('kept-damaged', () => {
    expect(stepWords(step('kept-damaged', 'info'))).toEqual({
      what: 'Kept the damaged file',
      detail: 'Beside the repaired one, in Library care. Undo puts it back.',
    });
  });

  it('put-back', () => {
    expect(stepWords(step('put-back', 'ok'), { category: MediaHealthCategory.Missing })).toEqual({
      what: 'Put it back',
      detail: 'Your library uses that file now. Nothing was copied, moved or renamed.',
      result: { tone: 'good', text: 'Found again' },
    });
  });

  it('unsupported', () => {
    expect(stepWords(step('unsupported', 'info', { extension: '.psd' }))).toEqual({
      what: 'Couldn’t make a preview',
      detail: 'Frameleaf can’t show Photoshop files yet.',
      result: { tone: 'off', text: 'Not supported' },
    });
  });

  it('undone, kept-as-is and removed', () => {
    expect(stepWords(step('undone', 'info', { by: 'Taylor' }))).toEqual({ what: 'Undone by Taylor' });
    expect(stepWords(step('kept-as-is', 'info'))).toEqual({
      what: 'Left as it is',
      detail: 'It can still be downloaded, shared and backed up.',
    });
    expect(stepWords(step('removed', 'info', { by: 'Taylor' }))).toEqual({ what: 'Removed from the library' });
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
});
