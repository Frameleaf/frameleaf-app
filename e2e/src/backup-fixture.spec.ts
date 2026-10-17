import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { amendBackupFixture } from './backup-fixture';

const dump = `-- Dumped from database version 19beta4
CREATE TABLE public.frameleaf_migrations (name text);
CREATE TABLE public."user" ("isAdmin" boolean);
-- PostgreSQL database dump complete
`;

describe('canonical restore fixtures', () => {
  it('fails corrupted SQL before replaying the dump while preserving admission markers', () => {
    const fixture = gunzipSync(amendBackupFixture(gzipSync(dump), 'corrupted')).toString();
    expect(fixture).toBe(`IM CORRUPTED;\n${dump}`);
  });

  it('removes admin status only after restoring the canonical tables', () => {
    const fixture = gunzipSync(amendBackupFixture(gzipSync(dump), 'empty')).toString();
    expect(fixture.indexOf('UPDATE public."user"')).toBeGreaterThan(fixture.indexOf('CREATE TABLE public."user"'));
    expect(fixture).toContain('SET LOCAL search_path = pg_catalog, public;');
    expect(fixture.trimEnd()).toMatch(/-- PostgreSQL database dump complete$/);
  });

  it.each([
    dump.replace('19beta4', '18.0'),
    dump.replace('frameleaf_migrations', 'kysely_migrations'),
    dump.replace('-- PostgreSQL database dump complete', ''),
  ])('refuses a noncanonical or incomplete source', (source) => {
    expect(() => amendBackupFixture(gzipSync(source), 'corrupted')).toThrow('complete canonical PostgreSQL 19 backup');
  });
});
