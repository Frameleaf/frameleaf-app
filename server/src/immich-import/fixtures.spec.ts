import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import provenance from 'src/immich-import/fixtures/structure/provenance.json' with { type: 'json' };

it('keeps frozen SQL evidence tied to its recorded immutable source hashes', () => {
  const read = (name: string) => readFileSync(new URL(`fixtures/structure/${name}`, import.meta.url));
  const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
  expect(digest(gunzipSync(Buffer.from(read(provenance.dump).toString(), 'base64')))).toBe(provenance.dumpSha256);
  for (const migration of [...provenance.migrations, provenance.reverseMigration]) {
    expect(digest(read(migration.fixture))).toBe(migration.sha256);
  }
  for (const [file, hash] of Object.entries(provenance.structuralSql)) {
    expect(digest(read(file))).toBe(hash);
  }
});
