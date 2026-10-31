import { UnauthorizedException } from '@nestjs/common';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { scriptedKysely } from 'test/scripted-kysely.js';

const userId = '11111111-1111-4111-8111-111111111111';
const dto = { userId, token: Buffer.from('hashed-token') };

it('locks the checked password through session insertion in one transaction', async () => {
  const { db, queries } = scriptedKysely(() => ({ rows: [{ id: userId }] }));
  try {
    await new SessionRepository(db).create(dto, 'checked-hash');
    expect(queries.map(({ sql }) => sql.split(' ', 1)[0])).toEqual(['begin', 'select', 'insert', 'commit']);
    expect(queries[1].sql).toContain('"user"."password" = $2');
    expect(queries[1].sql).toContain('"user"."deletedAt" is null');
    expect(queries[1].sql).toMatch(/for share$/);
    expect(queries[1].parameters).toEqual([userId, 'checked-hash']);
  } finally {
    await db.destroy();
  }
});

it('rejects changed or deleted credentials without inserting a session', async () => {
  const { db, queries } = scriptedKysely();
  try {
    await expect(new SessionRepository(db).create(dto, 'checked-hash')).rejects.toBeInstanceOf(UnauthorizedException);
    expect(queries.map(({ sql }) => sql.split(' ', 1)[0])).toEqual(['begin', 'select', 'rollback']);
  } finally {
    await db.destroy();
  }
});

it('retains ordinary session creation for non-password authentication', async () => {
  const { db, queries } = scriptedKysely(() => ({ rows: [{ id: 'session-id' }] }));
  try {
    await expect(new SessionRepository(db).create(dto)).resolves.toMatchObject({ id: 'session-id' });
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/^insert into "session"/);
  } finally {
    await db.destroy();
  }
});
