import { DatabaseSync } from 'node:sqlite';
import vectors from 'src/library-import/fixtures/password-vectors.json' with { type: 'json' };
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
    db.prepare('UPDATE users SET password=?').run('!synthetic-unusable-password');
    for (const format of ['django-pbkdf2-sha256', 'django-password'] as const)
      expect(await readSqlitePassword(db, context, format, 'SELECT password FROM users WHERE id=?')).toBeUndefined();
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

it('binds a credential to the owner used for lookup even when the caller exposes changing properties', async () => {
  const db = new DatabaseSync(':memory:');
  let reads = 0;
  const input = {
    ...context,
    get sourceUserId() {
      return reads++ === 0 ? 'owner' : 'other-owner';
    },
  };
  try {
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,password TEXT)');
    db.prepare('INSERT INTO users VALUES(?,?)').run('owner', vectors.go.vectors[0].hash);
    const credential = await readSqlitePassword(db, input, 'bcrypt', 'SELECT password FROM users WHERE id=?');
    expect(credential).toMatchObject(context);
    expect(reads).toBe(1);
  } finally {
    db.close();
  }
});

it('refuses a valid verifier prefix followed by embedded NUL text', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE users(id TEXT PRIMARY KEY,password TEXT)');
    db.prepare('INSERT INTO users VALUES(?,?)').run('owner', `${vectors.go.vectors[0].hash}\0suffix`);
    await expect(readSqlitePassword(db, context, 'bcrypt', 'SELECT password FROM users WHERE id=?')).rejects.toThrow(
      /^Imported password refused: SOURCE_PASSWORD_UNAVAILABLE$/,
    );
  } finally {
    db.close();
  }
});
