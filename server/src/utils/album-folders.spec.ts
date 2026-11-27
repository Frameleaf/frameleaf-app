import { describe, expect, it } from 'vitest';
import {
  AlbumFolderItem,
  albumFolderView,
  DEFAULT_ALBUM_FOLDER_CHOICES,
  fileStem,
  folderDisplay,
  matchAlbumVersions,
  resolveAlbumFolderChoices,
  subfolderOf,
} from 'src/utils/album-folders.js';

const at = '2026-11-19T10:00:00.000Z';
const item = (
  id: string,
  folder: string,
  originalFileName: string,
  takenAt = at,
  isVideo = false,
): AlbumFolderItem => ({
  id,
  folder,
  originalFileName,
  takenAt,
  isVideo,
});

describe('album folders', () => {
  it('uses the photographer defaults', () => {
    const choices = resolveAlbumFolderChoices(null);
    expect(folderDisplay(choices, 'Original')).toBe('with');
    expect(folderDisplay(choices, 'Edits')).toBe('with');
    expect(folderDisplay(choices, 'raw')).toBe('hidden');
    expect(folderDisplay(choices, 'Video')).toBe('section');
    expect(folderDisplay(choices, '')).toBe('with');
    expect(choices.prefer).toEqual(['Edits', 'Original', 'RAW']);
  });

  it('matches choices without regard to case', () => {
    const choices = resolveAlbumFolderChoices({ folders: { RAW: 'section', edits: 'album' } });
    expect(folderDisplay(choices, 'raw')).toBe('section');
    expect(folderDisplay(choices, 'Edits')).toBe('album');
  });

  it('finds the folder inside the album folder', () => {
    expect(subfolderOf('/photos/Event/RAW', '/photos/Event')).toBe('RAW');
    expect(subfolderOf('/photos/Event/RAW/day 2', '/photos/Event')).toBe('RAW');
    expect(subfolderOf('/photos/Event', '/photos/Event')).toBe('');
    expect(subfolderOf('/photos/Event 2/RAW', '/photos/Event')).toBe('');
    expect(subfolderOf('/RAW', '/')).toBe('RAW');
  });

  it('strips extensions and editor suffixes from file names', () => {
    expect(fileStem('IMG_4821.CR3')).toBe('img_4821');
    expect(fileStem('IMG_4821-edit.jpg')).toBe('img_4821');
    expect(fileStem('IMG_4821_Edited-2.jpg')).toBe('img_4821_edited-2');
    expect(fileStem('IMG_4821 copy (1).jpg')).toBe('img_4821');
    expect(fileStem('IMG_4821-2.jpg')).toBe('img_4821-2');
  });

  it('puts the preferred version in front and counts how each matched', () => {
    const items = [
      item('raw-1', 'RAW', 'IMG_1.CR3'),
      item('orig-1', 'Original', 'IMG_1.JPG'),
      item('edit-1', 'Edits', 'IMG_1-edit.jpg'),
      item('orig-2', 'Original', 'IMG_2.JPG', '2026-11-19T11:00:00.000Z'),
      item('edit-2', 'Edits', 'Nathan-hug-final.jpg', '2026-11-19T11:00:00.400Z'),
      item('orig-3', 'Original', 'IMG_3.JPG', '2026-11-19T12:00:00.000Z'),
      item('video-1', 'Video', 'IMG_1.MOV', at, true),
    ];
    const { rows, matchedByName, matchedByTime } = matchAlbumVersions(items, DEFAULT_ALBUM_FOLDER_CHOICES);
    expect(matchedByName).toBe(1);
    expect(matchedByTime).toBe(1);
    expect(rows).toEqual(
      expect.arrayContaining([
        { assetId: 'raw-1', frontAssetId: 'edit-1', matchedBy: 'name' },
        { assetId: 'orig-1', frontAssetId: 'edit-1', matchedBy: 'name' },
        { assetId: 'edit-1', frontAssetId: 'edit-1', matchedBy: 'name' },
        { assetId: 'orig-2', frontAssetId: 'edit-2', matchedBy: 'time' },
        { assetId: 'edit-2', frontAssetId: 'edit-2', matchedBy: 'time' },
      ]),
    );
    expect(rows).toHaveLength(5);
  });

  it('follows the show-in-front order and never puts a hidden version in front', () => {
    const items = [item('raw-1', 'RAW', 'IMG_1.CR3'), item('orig-1', 'Original', 'IMG_1.JPG')];
    const choices = resolveAlbumFolderChoices({ prefer: ['RAW', 'Original'] });
    expect(matchAlbumVersions(items, choices).rows.every((row) => row.frontAssetId === 'orig-1')).toBe(true);
    const shown = resolveAlbumFolderChoices({ prefer: ['RAW', 'Original'], folders: { RAW: 'with' } });
    expect(matchAlbumVersions(items, shown).rows.every((row) => row.frontAssetId === 'raw-1')).toBe(true);
  });

  it('leaves out folders shown in a section or as an album inside', () => {
    const items = [item('orig-1', 'Original', 'IMG_1.JPG'), item('edit-1', 'Edits', 'IMG_1-edit.jpg')];
    const choices = resolveAlbumFolderChoices({ folders: { Edits: 'section' } });
    expect(matchAlbumVersions(items, choices).rows).toEqual([]);
  });

  it('does not join a renamed file when two photos were taken at that moment', () => {
    const items = [
      item('orig-1', 'Original', 'IMG_1.JPG'),
      item('orig-2', 'Original', 'IMG_2.JPG'),
      item('edit-1', 'Edits', 'renamed.jpg'),
    ];
    expect(matchAlbumVersions(items, DEFAULT_ALBUM_FOLDER_CHOICES).rows).toEqual([]);
  });

  it('builds the timeline view from the choices', () => {
    const choices = resolveAlbumFolderChoices({ folders: { Edits: 'album', Video: 'with' }, versions: 'each' });
    const view = albumFolderView('album-1', '/photos/Event', choices);
    expect(view.exclude.toSorted()).toEqual(['edits', 'raw', 'videos']);
    expect(view.oneVersion).toBe(false);
    expect(albumFolderView('album-1', '/photos/Event', choices, 'RAW').only).toBe('raw');
  });
});
