import { ConflictException } from '@nestjs/common';
import {
  FORK_HANDOFF_WRITE_REFUSAL,
  lockPublicForkWrites,
  withPublicForkWrites,
} from 'src/repositories/fork-write-guard.js';
import { forkGuardAnswer, scriptedKysely } from 'test/scripted-kysely.js';

describe('public fork-table write guard (FL-44)', () => {
  it('lets a server without the fork schema write its public tables', async () => {
    const { db, queries } = scriptedKysely(forkGuardAnswer({ schema: false }));

    await expect(withPublicForkWrites(db, () => Promise.resolve('written'))).resolves.toBe('written');
    expect(queries.some(({ sql }) => sql.includes('FOR SHARE'))).toBe(false);
  });

  it.each(['legacy', 'dual-write', 'ready', 'active'])('writes in the writable %s phase', async (phase) => {
    const { db, queries } = scriptedKysely(forkGuardAnswer({ phase }));

    await expect(withPublicForkWrites(db, () => Promise.resolve('written'))).resolves.toBe('written');
    expect(queries.map(({ sql }) => sql).at(-1)).toBe('commit');
  });

  it.each(['inactive', 'failed'])('refuses a write in the %s phase and rolls back', async (phase) => {
    const { db, queries } = scriptedKysely(forkGuardAnswer({ phase }));
    const write = vi.fn(() => Promise.resolve('written'));

    await expect(withPublicForkWrites(db, write)).rejects.toThrow(new ConflictException(FORK_HANDOFF_WRITE_REFUSAL));
    expect(write).not.toHaveBeenCalled();
    expect(queries.map(({ sql }) => sql).at(-1)).toBe('rollback');
  });

  it('refuses a write while a handoff or return reconciliation runs', async () => {
    const { db } = scriptedKysely(forkGuardAnswer({ phase: 'ready', handoff: true }));

    await expect(
      db.transaction().execute((tx) => lockPublicForkWrites(tx, 'Studio is unavailable during database handoff')),
    ).rejects.toThrow('Studio is unavailable during database handoff');
  });

  it('holds the phase for the rest of the transaction', async () => {
    const { db, queries } = scriptedKysely(forkGuardAnswer({ phase: 'active' }));

    await withPublicForkWrites(db, (tx) => tx.deleteFrom('media_operation').execute());
    const statements = queries.map(({ sql }) => sql);
    const share = statements.findIndex((sql) => sql.includes('FOR SHARE'));
    const write = statements.findIndex((sql) => sql.startsWith('delete from "media_operation"'));
    expect(share).toBeGreaterThan(0);
    expect(write).toBeGreaterThan(share);
  });
});
