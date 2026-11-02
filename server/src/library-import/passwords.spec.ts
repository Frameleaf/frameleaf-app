import { hash } from 'bcrypt';
import { inspect } from 'node:util';
import vectors from 'src/library-import/fixtures/password-vectors.json' with { type: 'json' };
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';

const password = 'Frameleaf migration ✓ 123';
const context = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceUserId: 'source-owner',
  destinationUserId: '22222222-2222-4222-8222-222222222222',
};
const djangoHash = 'pbkdf2_sha256$10000$synthetic-salt$VdKESgIicWV9gR3+m0G8t+NmiavllPA0ghPzkbOv3sE=';
let bcryptHash: string;
beforeAll(async () => {
  bcryptHash = await hash(password, 9);
});

it.each(['bcrypt', 'photoprism-bcrypt'] as const)(
  'preserves %s authentication without exposing the source verifier',
  async (format) => {
    const credential = await ImportedPassword.fromSource(context, format, bcryptHash);
    const target = credential.forImport();
    expect(await verifyImportedPassword(password, target)).toBe(true);
    expect(await verifyImportedPassword('wrong password', target)).toBe(false);
    expect(target).not.toContain(bcryptHash);
    expect(JSON.stringify({ credential })).not.toContain(target);
    expect(inspect(credential)).not.toContain(target);
    expect(credential.sourceUserId).toBe('source-owner');
  },
);

it('preserves the source whitespace rules rather than using JavaScript trim', async () => {
  const credential = await ImportedPassword.fromSource(context, 'photoprism-bcrypt', bcryptHash);
  expect(await verifyImportedPassword(`\u{85} ${password} \u{85}`, credential.forImport())).toBe(true);
  expect(await verifyImportedPassword(`\u{FEFF}${password}\u{FEFF}`, credential.forImport())).toBe(false);
});

it('preserves a Python-generated Django PBKDF2 verifier and strengthens its stored representation', async () => {
  const credential = await ImportedPassword.fromSource(
    { ...context, sourceUserId: 'django-owner' },
    'django-pbkdf2-sha256',
    djangoHash,
  );
  expect(await verifyImportedPassword(password, credential.forImport())).toBe(true);
  expect(await verifyImportedPassword('wrong password', credential.forImport())).toBe(false);
  expect(credential.forImport()).not.toContain(djangoHash);
});

it('leaves existing native password verification to the normal path', async () => {
  expect(await verifyImportedPassword(password, bcryptHash)).toBeUndefined();
});

it.each([
  ['bcrypt', 'plaintext'],
  ['bcrypt', '$2b$31$' + 'a'.repeat(53)],
  ['django-pbkdf2-sha256', djangoHash.replace('$10000$', '$999999999$')],
  ['django-pbkdf2-sha256', djangoHash.replace('$synthetic-salt$', '$$')],
] as const)('refuses unsupported %s data without including it in errors', async (format, encoded) => {
  await expect(ImportedPassword.fromSource(context, format, encoded)).rejects.toThrow(
    /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
  );
});

it('rejects malformed imported credentials without expensive work', async () => {
  for (const encoded of ['$flimport$1$invalid', '$flimport$1$' + 'a'.repeat(4096)])
    expect(await verifyImportedPassword(password, encoded)).toBe(false);
});

it('keeps credential identity stable on resume and separate across owners', async () => {
  const first = await ImportedPassword.fromSource(context, 'bcrypt', bcryptHash);
  const resumed = await ImportedPassword.fromSource(context, 'bcrypt', bcryptHash);
  const other = await ImportedPassword.fromSource({ ...context, sourceUserId: 'other-owner' }, 'bcrypt', bcryptHash);
  expect(resumed.forImport()).toBe(first.forImport());
  expect(other.forImport()).not.toBe(first.forImport());
});

it.each([...vectors.go.vectors, ...vectors.php.vectors])(
  'matches native bcrypt semantics for $hash',
  async (vector) => {
    const credential = await ImportedPassword.fromSource(context, 'bcrypt', vector.hash);
    expect(await verifyImportedPassword(vector.password, credential.forImport())).toBe(true);
    expect(await verifyImportedPassword(vector.password + 'tail', credential.forImport())).toBe(vector.extendedMatches);
  },
);
