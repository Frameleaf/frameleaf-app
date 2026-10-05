import { gunzipSync, gzipSync } from 'node:zlib';

/** Alter a genuine current dump so the restore tests reach SQL execution and post-restore health. */
export const amendBackupFixture = (backup: Buffer, mode: 'empty' | 'corrupted'): Buffer => {
  const sql = gunzipSync(backup).toString('utf8');
  const marker = '-- PostgreSQL database dump complete';
  const end = sql.lastIndexOf(marker);
  if (
    end < 0 ||
    !/-- Dumped from database version 19(?:[.\s]|beta|rc)/.test(sql) ||
    !/CREATE TABLE (?:public\.)?"?frameleaf_migrations"?\s*\(/.test(sql)
  ) {
    throw new Error('The restore fixture requires a complete canonical PostgreSQL 19 backup');
  }
  const amendment = mode === 'corrupted' ? 'IM CORRUPTED;' : 'UPDATE public."user" SET "isAdmin" = false;';
  return gzipSync(`${sql.slice(0, end)}${amendment}\n\n${sql.slice(end)}`);
};
