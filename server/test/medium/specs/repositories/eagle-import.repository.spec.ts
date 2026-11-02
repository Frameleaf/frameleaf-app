import { Kysely, sql } from 'kysely';
import { EagleImportRepository } from 'src/repositories/eagle-import.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const sut = new EagleImportRepository(db);
  // Other tests' imports would be claimed first; this suite owns the table while it runs.
  await db.deleteFrom('eagle_import').execute();
  const create = (libraryPath = '/imports/Studio.library') =>
    sut.create({
      ownerId: user.id,
      rootId: '0',
      relativePath: 'Studio.library',
      libraryPath,
      libraryName: 'Studio.library',
      fingerprint: 'eagle:id:L1',
      target: { mode: 'inside', inside: 'new' },
      existingTop: ['Web'],
    });
  return { sut, user, create };
};

describe('FL-653 Eagle imports on the server', () => {
  it('lets one worker at a time hold an import, until its lease runs out', async () => {
    const { sut, create } = await setup();
    const row = (await create())!;
    expect(row).toMatchObject({ status: 'running', existingTop: ['Web'], albums: {}, failed: [] });
    const [first, second] = await Promise.all([sut.claim('w1', 60_000), sut.claim('w2', 60_000)]);
    expect([first?.id, second?.id].filter(Boolean)).toEqual([row.id]);
    const holder = first ? 'w1' : 'w2';
    const other = first ? 'w2' : 'w1';
    await expect(sut.claim(other, 60_000)).resolves.toBeUndefined();
    await expect(sut.renew(row.id, other, 60_000)).resolves.toBeUndefined();
    await expect(sut.renew(row.id, holder, 60_000)).resolves.toBe('running');

    await db
      .updateTable('eagle_import')
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where('id', '=', row.id)
      .execute();
    await expect(sut.claim(other, 60_000)).resolves.toMatchObject({ id: row.id, leaseOwner: other });
    // The worker that lost it can no longer write.
    await sut.save(row.id, holder, { total: 99 });
    await expect(sut.getById(row.id)).resolves.toMatchObject({ total: 0 });
  });

  it('stops a held import after the item in hand, and one nobody holds at once', async () => {
    const { sut, user, create } = await setup();
    const held = (await create('/imports/A.library'))!;
    await sut.claim('w1', 60_000);
    await expect(sut.requestStop(held.id, user.id)).resolves.toMatchObject({ status: 'stopping' });
    await sut.finish(held.id, 'w1', 'finished');
    await expect(sut.getById(held.id)).resolves.toMatchObject({ status: 'stopped', leaseOwner: null });

    const idle = (await create('/imports/B.library'))!;
    await expect(sut.requestStop(idle.id, user.id)).resolves.toMatchObject({ status: 'stopped' });
    await expect(sut.requestStop(idle.id, '00000000-0000-4000-8000-000000000000')).resolves.toBeUndefined();
  });

  it('runs one import of a library at a time, so a second start shares the first', async () => {
    const { sut, user, create } = await setup();
    const [first, second] = await Promise.all([create(), create()]);
    expect(first?.id).toBe(second?.id);
    const other = await create('/imports/Other.library');
    expect(other?.id).not.toBe(first?.id);
    // A stopped import of the library can't start again while another is running.
    await sut.requestStop(first!.id, user.id);
    const third = await create();
    expect(third?.id).not.toBe(first?.id);
    await expect(sut.restart(first!.id, { target: { mode: 'top' } })).resolves.toBeUndefined();
  });

  it('keeps a stop that came after the run’s last check', async () => {
    const { sut, user, create } = await setup();
    const row = await create();
    await sut.claim('w1', 60_000);
    await db
      .updateTable('eagle_import')
      .set({ leaseExpiresAt: sql`now() - interval '1 second'` })
      .where('id', '=', row!.id)
      .execute();
    await expect(sut.requestStop(row!.id, user.id)).resolves.toMatchObject({ status: 'stopped' });
    await sut.finish(row!.id, 'w1', 'finished');
    await expect(sut.getById(row!.id)).resolves.toMatchObject({ status: 'stopped' });
  });

  it('records each item once and carries on the same library', async () => {
    const { sut, user, create } = await setup();
    const row = (await create())!;
    // Only the worker holding the import can record an item.
    await expect(sut.addOutcome(row.id, 'w1', 'I1', '6b0bd5a4-2f52-4e2a-9d2c-0d9a7b4c1f10', false)).resolves.toBe(
      false,
    );
    await sut.claim('w1', 60_000);
    await sut.addOutcome(row.id, 'w1', 'I1', '6b0bd5a4-2f52-4e2a-9d2c-0d9a7b4c1f10', false);
    await sut.addOutcome(row.id, 'w1', 'I1', '6b0bd5a4-2f52-4e2a-9d2c-0d9a7b4c1f10', false);
    await sut.addOutcome(row.id, 'w1', 'I2', '7c1ce6b5-3a63-4f3b-8e3d-1e0b8c5d2a21', true);
    await expect(sut.addOutcome(row.id, 'w2', 'I3', '7c1ce6b5-3a63-4f3b-8e3d-1e0b8c5d2a21', true)).resolves.toBe(false);
    await expect(sut.counts(row.id)).resolves.toEqual({ done: 2, already: 1 });

    await sut.save(row.id, 'w1', { failed: ['I3'], albums: { F1: 'a' } });
    await sut.finish(row.id, 'w1', 'finished');
    // Finished with an item left over: choosing the library again carries it on.
    const again = await sut.findResumable(user.id, row.libraryPath, row.fingerprint);
    expect(again).toMatchObject({ id: row.id, failed: ['I3'], albums: { F1: 'a' } });
    // Carrying on keeps the top-level names the import started with, for "Name (Eagle)".
    await expect(sut.restart(row.id, { target: { mode: 'top' } })).resolves.toMatchObject({
      existingTop: ['Web'],
      status: 'running',
      target: { mode: 'top' },
    });
    await expect(sut.findResumable(user.id, row.libraryPath, 'another')).resolves.toBeUndefined();
    await expect(sut.listUnfinished(user.id)).resolves.toHaveLength(1);
  });
});
