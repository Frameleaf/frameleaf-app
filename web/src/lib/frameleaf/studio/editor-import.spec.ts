import {
  chooseEditorImportFiles,
  defaultEditorImportUses,
  editorImportClock,
  editorImportMediaChoices,
  editorImportMediaPlan,
  editorImportNoteKey,
  editorImportNoticeKey,
  filesForMissingMedia,
  groupEditorImportNotes,
  type EditorImportMediaItem,
} from '$lib/frameleaf/studio/editor-import';

const file = (name: string, size = 10, folder?: string) => {
  const value = new File(['x'.repeat(size)], name);
  if (folder) {
    Object.defineProperty(value, 'webkitRelativePath', { value: `${folder}/${name}` });
  }
  return value;
};

const media: EditorImportMediaItem[] = [
  { key: 'a', name: 'Lake morning.mov', match: 'found', assetId: 'asset-a', carried: false },
  { key: 'b', name: 'Kayak.mp4', match: 'likely', assetId: 'asset-b', carried: false },
  { key: 'c', name: 'Ridge.jpg', match: 'possible', assetId: 'asset-c', carried: false },
  { key: 'd', name: 'Campfire.wav', match: 'missing', assetId: null, carried: false },
  { key: 'e', name: 'Drone.mov', match: 'missing', assetId: null, carried: true },
  { key: 'f', name: 'Gone.mov', match: 'missing', assetId: null, carried: false },
];

describe('chooseEditorImportFiles', () => {
  it('takes the project file and the CDL and LUT files beside it', () => {
    const choice = chooseEditorImportFiles([file('Look.cube'), file('Lake day.fcpxml'), file('Grade.cdl')]);
    expect(choice).toMatchObject({ kind: 'project', project: { name: 'Lake day.fcpxml' } });
    expect(choice.kind === 'project' && choice.sidecars.map((sidecar) => sidecar.name)).toEqual([
      'Look.cube',
      'Grade.cdl',
    ]);
  });

  it('finds the project inside a chosen bundle folder', () => {
    const choice = chooseEditorImportFiles([
      file('notes.xml', 10, 'Lake day.fcpxmld'),
      file('Info.fcpxml', 10, 'Lake day.fcpxmld'),
    ]);
    expect(choice).toMatchObject({ kind: 'project', project: { name: 'Info.fcpxml' } });
  });

  it('sends a Frameleaf bundle to the bundle import, and nothing else counts', () => {
    expect(chooseEditorImportFiles([file('Lake day.zip')])).toMatchObject({ kind: 'bundle' });
    expect(chooseEditorImportFiles([file('notes.pdf')])).toEqual({ kind: 'none' });
  });
});

describe('notes', () => {
  it('groups notes by kind, naming each clip once in timeline order', () => {
    const groups = groupEditorImportNotes([
      { code: 'effect-dropped', clip: 'Kayak', atSeconds: 6 },
      { code: 'audio-crossfade', clip: 'Lake → Campfire', atSeconds: 2 },
      { code: 'effect-dropped', clip: 'Lake', atSeconds: 1 },
      { code: 'effect-dropped', clip: 'Kayak', atSeconds: 9 },
    ]);
    expect(groups.differently).toEqual([{ code: 'audio-crossfade', names: ['Lake → Campfire'] }]);
    expect(groups.cant).toEqual([{ code: 'effect-dropped', names: ['Lake', 'Kayak'] }]);
  });

  it('phrases known codes and falls back for one this release does not know', () => {
    expect(editorImportNoteKey('speed-ramp')).toBe('frameleaf_studio_editor_import_note_speed_ramp');
    expect(editorImportNoteKey('from-the-future')).toBe('frameleaf_studio_editor_import_note_other');
    expect(editorImportNoticeKey('edl-frame-rate')).toBe('frameleaf_studio_editor_import_notice_edl_frame_rate');
    expect(editorImportNoticeKey('nope')).toBe('frameleaf_studio_editor_import_notice_other');
  });
});

describe('media plan', () => {
  it('sends only the folder files the project needs, by name without regard to case', () => {
    const uses = defaultEditorImportUses(media);
    expect([...uses]).toEqual(['b']);
    const folder = [file('campfire.WAV', 300), file('Ridge.jpg', 50), file('Other.mov'), file('Drone.mov')];
    const sending = filesForMissingMedia(media, uses, folder);
    // Ridge is a possible match the person did not use, so its file is sent; the drone came in the archive.
    expect([...sending.keys()]).toEqual(['c', 'd']);
  });

  it('always adds up: found + matched + added + carried + placeholders = files', () => {
    const uses = new Set(['b']);
    const sending = filesForMissingMedia(media, uses, [file('Campfire.wav', 300)]);
    const plan = editorImportMediaPlan(media, uses, sending);
    expect(plan).toEqual({ files: 6, found: 1, matched: 1, upload: 1, carried: 1, placeholders: 2, uploadBytes: 300 });
    expect(plan.found + plan.matched + plan.upload + plan.carried + plan.placeholders).toBe(plan.files);
  });

  it('sends each file’s choice, a declined match as a placeholder', () => {
    expect(editorImportMediaChoices(media.slice(0, 4), new Set(), new Map([['d', 'sent-d']]))).toEqual([
      { key: 'a', assetId: 'asset-a' },
      { key: 'b', assetId: null },
      { key: 'c', assetId: null },
      { key: 'd', assetId: 'sent-d', added: true },
    ]);
  });
});

it('shows timeline times as the editor does', () => {
  expect(editorImportClock(6.4)).toBe('0:06');
  expect(editorImportClock(3725)).toBe('1:02:05');
});
