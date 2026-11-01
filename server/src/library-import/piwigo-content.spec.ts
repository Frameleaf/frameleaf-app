import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/piwigo/16.4.0-content.json' with { type: 'json' };

describe('Piwigo native synthetic originals', () => {
  it.each(content.originals)('retains independently hashed native original $id', (original) => {
    const bytes = Buffer.from(original.originalBase64, 'base64');
    const image = content.rows.images.find((row) => row.id === original.id)!;
    expect(image.path).toBe(original.path);
    expect(String(bytes.length)).toBe(original.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(original.sha256);
    expect(original.sha256).not.toBe(image.md5sum);
    expect(createHash('md5').update(bytes).digest('hex')).toBe(image.md5sum);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes.readUInt32BE(16)).toBe(image.width);
    expect(bytes.readUInt32BE(20)).toBe(image.height);
  });
  it('excludes credentials, sessions, bearer keys and cached permissions from content records', () => {
    const serialized = JSON.stringify(content.rows);
    for (const field of ['password', 'activation_key', 'secret_key', 'auth_key', 'sessions', 'user_cache'])
      expect(serialized).not.toContain(`"${field}`);
  });
});
