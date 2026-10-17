import { StorageCore } from 'src/cores/storage.core.js';
import {
  isInsideFolder,
  parseStudioExportPublishSnapshot,
  studioExportFileName,
  studioExportStagingFolder,
} from 'src/utils/studio-export.js';

describe('isInsideFolder', () => {
  const folder = '/data/exports/owner/studio-exports/staging/op-1';

  it('accepts a file inside the folder', () => {
    expect(isInsideFolder(folder, `${folder}/out.mp4`)).toBe(true);
    expect(isInsideFolder(folder, `${folder}/nested/out.mp4`)).toBe(true);
  });

  it('refuses the folder itself, siblings, traversal and relative paths', () => {
    expect(isInsideFolder(folder, folder)).toBe(false);
    expect(isInsideFolder(folder, `${folder}-2/out.mp4`)).toBe(false);
    expect(isInsideFolder(folder, `${folder}/../op-2/out.mp4`)).toBe(false);
    expect(isInsideFolder(folder, '/data/library/owner/original.mov')).toBe(false);
    expect(isInsideFolder(folder, 'out.mp4')).toBe(false);
  });
});

describe('studioExportStagingFolder', () => {
  beforeAll(() => StorageCore.setMediaLocation('/data'));

  it('is private to the owner and to one render', () => {
    const a = studioExportStagingFolder('owner-a', 'op-1');
    expect(a).toContain('/exports/owner-a/');
    expect(a.endsWith('/op-1')).toBe(true);
    expect(studioExportStagingFolder('owner-a', 'op-2')).not.toBe(a);
  });
});

describe('studioExportFileName', () => {
  it('keeps the project name without anything a path could use', () => {
    expect(studioExportFileName('Lake / trip: day 1', '.mp4')).toBe('Lake trip day 1.mp4');
    expect(studioExportFileName('../..', '.mp4')).toBe('.. ...mp4');
    expect(studioExportFileName(' '.repeat(3), '.webm')).toBe('Studio export.webm');
  });
});

describe('parseStudioExportPublishSnapshot', () => {
  it('accepts only a complete publication snapshot', () => {
    const snapshot = {
      kind: 'studio-export-publish',
      versionId: 'v',
      renderOperationId: 'r',
      projectId: 'p',
      revision: 3,
    };
    expect(parseStudioExportPublishSnapshot(snapshot)).toEqual(snapshot);
    expect(parseStudioExportPublishSnapshot({ ...snapshot, kind: 'studio-export' })).toBeNull();
    expect(parseStudioExportPublishSnapshot({ ...snapshot, revision: '3' })).toBeNull();
    expect(parseStudioExportPublishSnapshot(null)).toBeNull();
  });
});
