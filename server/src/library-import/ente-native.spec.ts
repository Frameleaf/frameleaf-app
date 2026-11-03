import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { resolveEnteComponents } from 'src/library-import/ente-files.js';
import media from 'src/library-import/fixtures/ente/0.4.2-media.json' with { type: 'json' };

describe('Ente native media export evidence', () => {
  it.each(media.cases)('resolves $account / $folder originals and their generated source bytes', (source) => {
    const files = resolveEnteComponents(source.record, source.inventory, source.album);
    expect(files).toEqual(
      source.expected.map((file) => ({
        albumId: file.albumId,
        fileId: file.fileId,
        ownerId: file.ownerId,
        role: file.role,
        path: file.path,
        bytes: file.bytes,
        sourceHash: file.sourceHash,
      })),
    );
    for (const [index, file] of files.entries()) {
      const expected = source.expected[index];
      const bytes = readFileSync(new URL(`fixtures/ente/media/${expected.input}`, import.meta.url));
      expect(String(bytes.length)).toBe(file.bytes);
      expect(createHash('blake2b512').update(bytes).digest('base64')).toBe(file.sourceHash);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256);
    }
  });

  it('retains distinct identities and owners for matching original bytes', () => {
    const owner = media.cases.find((source) => source.account === 'alice' && source.inventory.id === media.ids.first)!;
    const other = media.cases.find((source) => source.inventory.id === media.ids.bobFile)!;
    const [first] = resolveEnteComponents(owner.record, owner.inventory, owner.album);
    const [second] = resolveEnteComponents(other.record, other.inventory, other.album);
    expect(first.sourceHash).toBe(second.sourceHash);
    expect(first.fileId).not.toBe(second.fileId);
    expect(first.ownerId).not.toBe(second.ownerId);
  });

  it('refuses a sharee inventory when resolving an owner-only album membership', () => {
    const owner = media.cases.find((source) => source.album.ente.albumID === media.ids.secondary)!;
    const sharee = media.cases.find((source) => source.account === 'bob' && source.inventory.id === media.ids.first)!;
    expect(() => resolveEnteComponents(owner.record, sharee.inventory, owner.album)).toThrow('ENTE_FILES_INVALID');
  });
});
