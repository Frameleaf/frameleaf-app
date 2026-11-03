import { CaptureCommitDto } from 'src/dtos/capture.dto.js';
import { captureRequestHash } from 'src/utils/capture.js';

const input = {
  captureId: '10000000-0000-4000-8000-000000000001',
  albumId: '10000000-0000-4000-8000-000000000002',
  source: { pageUrl: 'https://example.org', title: 'Reference', capturedAt: '2026-10-28T12:00:00Z' },
  bookmark: { url: 'https://example.org', title: 'Reference' },
};

describe('capture commit boundary', () => {
  it('requires exactly one bookmark or upload resource', () => {
    expect(CaptureCommitDto.schema.safeParse(input).success).toBe(true);
    expect(CaptureCommitDto.schema.safeParse({ ...input, bookmark: undefined }).success).toBe(false);
    expect(CaptureCommitDto.schema.safeParse({ ...input, uploadResourceId: input.albumId }).success).toBe(false);
    expect(
      CaptureCommitDto.schema.safeParse({
        ...input,
        bookmark: undefined,
        uploadResourceId: input.captureId,
        sha256: 'a'.repeat(64),
      }).success,
    ).toBe(true);
    expect(
      CaptureCommitDto.schema.safeParse({
        ...input,
        bookmark: undefined,
        uploadResourceId: input.albumId,
        sha256: 'a'.repeat(64),
      }).success,
    ).toBe(false);
    expect(
      CaptureCommitDto.schema.safeParse({ ...input, bookmark: undefined, uploadResourceId: input.captureId }).success,
    ).toBe(false);
  });

  it('never admits owner overrides, arbitrary metadata, personal scope or preview IDs', () => {
    for (const extra of [
      { ownerId: input.albumId },
      { metadata: [] },
      { libraryScope: 'personal' },
      { previewAssetId: input.albumId },
    ]) {
      expect(CaptureCommitDto.schema.safeParse({ ...input, bookmark: { ...input.bookmark, ...extra } }).success).toBe(
        false,
      );
    }
    expect(CaptureCommitDto.schema.safeParse({ ...input, ownerId: input.albumId }).success).toBe(false);
    expect(
      CaptureCommitDto.schema.safeParse({ ...input, source: { ...input.source, captureId: input.albumId } }).success,
    ).toBe(false);
  });

  it('normalizes tag set order for a retry and hashes meaningful changes', () => {
    const tags = [input.captureId, input.albumId];
    const a = CaptureCommitDto.schema.parse({ ...input, tagIds: tags });
    const b = CaptureCommitDto.schema.parse({ ...input, tagIds: [tags[1], tags[0], tags[0]] });
    expect(captureRequestHash(a)).toEqual(captureRequestHash(b));
    expect(captureRequestHash({ ...a, note: 'Changed' })).not.toEqual(captureRequestHash(a));
  });
});
