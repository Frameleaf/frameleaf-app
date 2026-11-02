import { hash } from 'bcrypt';
import { ImportedPassword } from 'src/library-import/passwords.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';

const password = 'Frameleaf migration ✓ 123';
const context = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceUserId: 'source-owner',
  destinationUserId: '22222222-2222-4222-8222-222222222222',
};
const crypto = new CryptoRepository();

it('authenticates a protected imported bcrypt credential through the existing sign-in verifier', async () => {
  const source = await hash(password, 9);
  const imported = await ImportedPassword.fromSource(context, 'bcrypt', source);
  expect(await crypto.compareBcrypt(password, imported.forImport())).toBe(true);
  expect(await crypto.compareBcrypt('wrong password', imported.forImport())).toBe(false);
});

it('authenticates a protected Django credential without resetting its password', async () => {
  const source = 'pbkdf2_sha256$10000$synthetic-salt$VdKESgIicWV9gR3+m0G8t+NmiavllPA0ghPzkbOv3sE=';
  const imported = await ImportedPassword.fromSource(context, 'django-pbkdf2-sha256', source);
  expect(await crypto.compareBcrypt(password, imported.forImport())).toBe(true);
});

it('retains native password and binary PIN/secret verification', async () => {
  const native = await hash(password, 9);
  expect(await crypto.compareBcrypt(password, native)).toBe(true);
  expect(await crypto.compareBcrypt(Buffer.from(password), native)).toBe(true);
  expect(await crypto.compareBcrypt('wrong password', native)).toBe(false);
});
