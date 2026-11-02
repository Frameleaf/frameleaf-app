import { CreateAlbumDto, UpdateAlbumDto } from 'src/dtos/album.dto.js';

describe('album colour', () => {
  it('accepts the eight named colours and null, and refuses anything else', () => {
    expect(UpdateAlbumDto.schema.safeParse({ color: 'teal' }).success).toBe(true);
    expect(UpdateAlbumDto.schema.safeParse({ color: null }).success).toBe(true);
    expect(UpdateAlbumDto.schema.safeParse({ color: 'orange' }).success).toBe(false);
    expect(UpdateAlbumDto.schema.safeParse({ color: '#ff0000' }).success).toBe(false);
    expect(CreateAlbumDto.schema.safeParse({ albumName: 'Moodboards', color: 'amber' }).success).toBe(true);
    expect(CreateAlbumDto.schema.safeParse({ albumName: 'Moodboards', color: null }).success).toBe(false);
  });
});
