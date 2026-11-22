import { mapAlbum } from 'src/dtos/album.dto.js';
import { AlbumFactory } from 'test/factories/album.factory.js';
import { getForAlbum } from 'test/mappers.js';

describe('mapAlbum', () => {
  it('should set start and end dates', () => {
    const startDate = new Date('2023-02-22T05:06:29.716Z');
    const endDate = new Date('2025-01-01T01:02:03.456Z');
    const album = AlbumFactory.from()
      .asset({ localDateTime: endDate }, (builder) => builder.exif())
      .asset({ localDateTime: startDate }, (builder) => builder.exif())
      .build();
    const dto = mapAlbum(getForAlbum(album));
    expect(dto.startDate).toEqual(startDate.toISOString());
    expect(dto.endDate).toEqual(endDate.toISOString());
  });

  it('sends no member their email address, and keeps the avatar colour it gives (FL-1743)', () => {
    const album = AlbumFactory.from().albumUser().build();
    const dto = mapAlbum(getForAlbum(album));
    expect(album.albumUsers.every(({ user }) => user.email !== '')).toBe(true);
    expect(dto.albumUsers).toHaveLength(2);
    expect(dto.albumUsers.map(({ user }) => user.email)).toEqual(['', '']);
    expect(dto.albumUsers.every(({ user }) => !!user.avatarColor)).toBe(true);
  });

  it('should not set start and end dates for empty assets', () => {
    const dto = mapAlbum(getForAlbum(AlbumFactory.create()));
    expect(dto.startDate).toBeUndefined();
    expect(dto.endDate).toBeUndefined();
  });
});
