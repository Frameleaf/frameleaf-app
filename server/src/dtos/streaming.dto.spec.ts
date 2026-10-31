import { HlsPlaylistHeaderDto, HlsSegmentHeaderDto } from 'src/dtos/streaming.dto.js';

describe('Frameleaf HLS headers', () => {
  it('reads playback hints using the Frameleaf names', () => {
    expect(HlsPlaylistHeaderDto.schema.parse({ 'x-frameleaf-hls-pos': '12.5' })).toEqual({
      'x-frameleaf-hls-pos': 12.5,
    });
    expect(HlsSegmentHeaderDto.schema.parse({ 'x-frameleaf-hls-msn': '3' })).toEqual({
      'x-frameleaf-hls-msn': 3,
    });
  });

  it('retains numeric validation and optional hints', () => {
    expect(HlsPlaylistHeaderDto.schema.safeParse({ 'x-frameleaf-hls-pos': '-1' }).success).toBe(false);
    expect(HlsSegmentHeaderDto.schema.safeParse({ 'x-frameleaf-hls-msn': '1.5' }).success).toBe(false);
    expect(HlsPlaylistHeaderDto.schema.parse({})).toEqual({});
    expect(HlsSegmentHeaderDto.schema.parse({})).toEqual({});
  });

  it('normalizes hints from installed clients while canonical hints take precedence', () => {
    expect(HlsPlaylistHeaderDto.schema.parse({ 'x-immich-hls-pos': '8.5' })).toEqual({ 'x-frameleaf-hls-pos': 8.5 });
    expect(HlsSegmentHeaderDto.schema.parse({ 'x-immich-hls-msn': '7' })).toEqual({ 'x-frameleaf-hls-msn': 7 });
    expect(HlsSegmentHeaderDto.schema.parse({ 'x-frameleaf-hls-msn': '2', 'x-immich-hls-msn': 'invalid' })).toEqual({
      'x-frameleaf-hls-msn': 2,
    });
    expect(HlsPlaylistHeaderDto.schema.safeParse({ 'x-immich-hls-pos': '-1' }).success).toBe(false);
  });
});
