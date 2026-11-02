import { DatabaseSync } from 'node:sqlite';
import { readSqlitePassword } from 'src/library-import/sqlite-password.js';

const context = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceUserId: 'owner',
  destinationUserId: '22222222-2222-4222-8222-222222222222',
};
it('distinguishes absent credentials from missing owners and refuses malformed credentials without disclosing them', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,password TEXT)');
    db.prepare('INSERT INTO users VALUES(?,?)').run('owner', null);
    const read = () => readSqlitePassword(db, context, 'bcrypt', 'SELECT password FROM users WHERE id=?');
    expect(await read()).toBeUndefined();
    db.prepare('UPDATE users SET password=?').run('synthetic-unqualified-secret');
    await expect(read()).rejects.toThrow(/^Imported password refused: SOURCE_PASSWORD_UNAVAILABLE$/);
    db.exec('DELETE FROM users');
    await expect(read()).rejects.toThrow(/^Imported password refused: SOURCE_PASSWORD_UNAVAILABLE$/);
    db.close();
    await expect(read()).rejects.toThrow(/^Imported password refused: SOURCE_PASSWORD_UNAVAILABLE$/);
  } finally {
    if (db.isOpen) db.close();
  }
});
