import { ConnectUploadStartDto } from 'src/dtos/connect-media.dto.js';

const input = {
  requestId: 'save-1',
  albumId: '10000000-0000-4000-8000-000000000002',
  workspace: 'design',
  filename: 'page.png',
  size: 10,
  sha256: 'a'.repeat(64),
  contentType: 'image/png',
  fileCreatedAt: '2026-11-13T00:00:00Z',
  fileModifiedAt: '2026-11-13T00:00:00Z',
};
describe('Connect upload trust boundary', () => {
  it('accepts genuine Canva provenance without inventing a page URL', () => {
    const result = ConnectUploadStartDto.schema.parse({
      ...input,
      provenance: {
        provider: 'canva',
        externalId: 'design1',
        title: 'Design',
        exportedAt: input.fileCreatedAt,
        entryLabel: 'Page 1',
        entryOrdinal: 1,
      },
    });
    expect(result.provenance?.pageUrl).toBeUndefined();
  });
  it.each([
    { size: 0 },
    { sha256: 'invalid' },
    { filename: '../secret.png' },
    { contentType: 'text/html' },
    { contentType: 'image/jpeg' },
    { workspace: 'photo', filename: 'page.pdf', contentType: 'application/pdf' },
    { sourceUrl: 'https://example.org/file.png' },
    { publication: 'connect' },
  ])('rejects invalid or caller-controlled authority %j', (change) => {
    expect(ConnectUploadStartDto.schema.safeParse({ ...input, ...change }).success).toBe(false);
  });
});
