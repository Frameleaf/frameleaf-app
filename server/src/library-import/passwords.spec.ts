import { hash } from 'bcrypt';
import { inspect } from 'node:util';
import argonVectors from 'src/library-import/fixtures/password-argon2-vectors.json' with { type: 'json' };
import piwigoVectors from 'src/library-import/fixtures/password-piwigo-vectors.json' with { type: 'json' };
import vectors from 'src/library-import/fixtures/password-vectors.json' with { type: 'json' };
import {
  ImportedPassword,
  captureImportedPasswordContext,
  verifyImportedPassword,
} from 'src/library-import/passwords.js';

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

it('handles long interior whitespace without changing source password semantics', async () => {
  const credential = await ImportedPassword.fromSource(context, 'photoprism-bcrypt', bcryptHash);
  expect(await verifyImportedPassword('a' + ' '.repeat(1_000_000) + 'b', credential.forImport())).toBe(false);
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

it.each(argonVectors.vectors)('preserves native PHP Argon2 authentication for $hash', async (vector) => {
  for (const format of ['php-password', 'nextcloud-password'] as const) {
    const source =
      format === 'nextcloud-password'
        ? `${vector.hash.startsWith('$argon2id$') ? '3' : '2'}|${vector.hash}`
        : vector.hash;
    const credential = await ImportedPassword.fromSource(context, format, source);
    expect(await verifyImportedPassword(vector.password, credential.forImport())).toBe(true);
    expect(await verifyImportedPassword('wrong', credential.forImport())).toBe(false);
    expect(credential.forImport()).not.toContain(vector.hash);
    expect(JSON.stringify(credential)).not.toContain(source);
  }
});

// Generated by Django 5.2.8 Argon2PasswordHasher (argon2-cffi 25.1.0) with its default cost, as LibrePhotos 1.5.1 stores new passwords.
const djangoArgonVectors = [
  {
    password: 'synthetic Δ passphrase',
    hash: 'argon2$argon2id$v=19$m=102400,t=2,p=8$S2lyRGQyRUpJcW8zY294M3duY1M4bw$8Li7qAIWeiogQ0NZOEO6rc3z+PfqxVZVSVcgr3e9wZE',
  },
  {
    password: 'short',
    hash: 'argon2$argon2id$v=19$m=102400,t=2,p=8$MVRLbWQwWkc4STUyazBBWlRwZUJ6Sg$zQpR/rcuTqEqnJe+MAXGMg3axw4mJUhM50z8N5a/f7c',
  },
];

it.each(djangoArgonVectors)('preserves Django Argon2 authentication for $password', async (vector) => {
  const credential = await ImportedPassword.fromSource(context, 'django-password', vector.hash);
  expect(await verifyImportedPassword(vector.password, credential.forImport())).toBe(true);
  expect(await verifyImportedPassword(vector.password + 'x', credential.forImport())).toBe(false);
  expect(credential.forImport()).not.toContain(vector.hash);
  const retained = ImportedPassword.fromRetained(context, credential.forImport());
  expect(await verifyImportedPassword(vector.password, retained.forImport())).toBe(true);
});

it('reads Django PBKDF2 through the Django format and keeps older retained PBKDF2 credentials', async () => {
  const credential = await ImportedPassword.fromSource(context, 'django-password', djangoHash);
  const older = await ImportedPassword.fromSource(context, 'django-pbkdf2-sha256', djangoHash);
  for (const value of [credential, older])
    expect(ImportedPassword.fromRetained(context, value.forImport()).forImport()).toBe(value.forImport());
  await expect(
    ImportedPassword.fromSource(context, 'django-password', djangoArgonVectors[0].hash.slice('argon2'.length)),
  ).rejects.toThrow(/SOURCE_PASSWORD_UNSUPPORTED/);
});

it('refuses excessive Argon2 work and unsupported source versions without returning the source verifier', async () => {
  const encoded = argonVectors.vectors[0].hash;
  for (const [format, source] of [
    ['php-password', encoded.replace('m=1024', 'm=4294967295')],
    ['nextcloud-password', '4|' + encoded],
  ] as const)
    await expect(ImportedPassword.fromSource(context, format, source)).rejects.toThrow(
      /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
    );
});

it('refuses stored Argon2 settings above the qualified memory budget before deriving a password', async () => {
  const credential = await ImportedPassword.fromSource(context, 'php-password', argonVectors.vectors[0].hash);
  const prefix = '$flimport$1$';
  const payload = JSON.parse(Buffer.from(credential.forImport().slice(prefix.length), 'base64url').toString('utf8'));
  payload.settings.memoryCost = 102_401;
  const changed = prefix + Buffer.from(JSON.stringify(payload)).toString('base64url');
  expect(await verifyImportedPassword(argonVectors.vectors[0].password, changed)).toBe(false);
});

it.each(['data=YWJj', 'keyid=YWJj', 'foo=1'])('refuses unrepresented Argon2 parameters: %s', async (extra) => {
  const source = argonVectors.vectors[0].hash.replace('p=2$', () => `p=2,${extra}$`);
  await expect(ImportedPassword.fromSource(context, 'php-password', source)).rejects.toThrow(
    /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
  );
});

it.each(piwigoVectors.vectors)('preserves native Piwigo PHPass passwords: $hash', async (vector) => {
  const credential = await ImportedPassword.fromSource(context, 'piwigo-password', vector.hash);
  expect(await verifyImportedPassword(vector.password, credential.forImport())).toBe(true);
  expect(await verifyImportedPassword(vector.password + 'tail', credential.forImport())).toBe(false);
  expect(credential.forImport()).not.toContain(vector.hash);
  expect(JSON.stringify(credential)).not.toContain(vector.hash);
});

it('refuses PHPass passwords above the native byte limit and yields during costly verification', async () => {
  const vector = piwigoVectors.vectors[0];
  const credential = await ImportedPassword.fromSource(context, 'piwigo-password', vector.hash);
  const oversized = '✓'.repeat(1366);
  expect(await verifyImportedPassword(oversized, credential.forImport())).toBe(false);
  let finished = false;
  const work = verifyImportedPassword(vector.password, credential.forImport()).finally(() => {
    finished = true;
  });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(finished).toBe(false);
  expect(await work).toBe(true);
});

it.each(['$P$zabcdefgh' + 'a'.repeat(22), '$P$Gshort', '$H$Gabcdefgh' + 'a'.repeat(22), 'plaintext'])(
  'refuses unqualified Piwigo settings without exposing them',
  async (encoded) => {
    await expect(ImportedPassword.fromSource(context, 'piwigo-password', encoded)).rejects.toThrow(
      /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
    );
  },
);

it('preserves a PHP legacy MD5 password behind the destination verifier without loose numeric comparison', async () => {
  const encoded = '482c811da5d5b4bc6d497ffa98491e38'; // PHP md5('password123').
  const credential = await ImportedPassword.fromSource(context, 'piwigo-password', encoded);
  expect(await verifyImportedPassword('password123', credential.forImport())).toBe(true);
  expect(await verifyImportedPassword('wrong', credential.forImport())).toBe(false);
  expect(credential.forImport()).not.toContain(encoded);
  const magic = await ImportedPassword.fromSource(context, 'piwigo-password', '0e462097431906509019562988736854');
  expect(await verifyImportedPassword('240610708', magic.forImport())).toBe(true);
  expect(await verifyImportedPassword('QNKCDZO', magic.forImport())).toBe(false);
});

it('refuses noncanonical PHPass output bits', async () => {
  const encoded = piwigoVectors.vectors[0].hash.slice(0, -1) + 'D';
  await expect(ImportedPassword.fromSource(context, 'piwigo-password', encoded)).rejects.toThrow(
    /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
  );
});

it.each(piwigoVectors.legacyMd5)('preserves the native legacy Piwigo verifier: $hash', async (vector) => {
  const credential = await ImportedPassword.fromSource(context, 'piwigo-password', vector.hash);
  expect(await verifyImportedPassword(vector.password, credential.forImport())).toBe(vector.valid);
  expect(await verifyImportedPassword('wrong', credential.forImport())).toBe(vector.wrong);
});

it('captures a validated, immutable owner mapping without retaining caller authority', () => {
  const input = { ...context };
  const captured = captureImportedPasswordContext(input);
  input.sourceUserId = 'other-owner';
  expect(captured).toEqual(context);
  expect(Object.isFrozen(captured)).toBe(true);
  expect(() => Object.assign(captured, { sourceUserId: 'other-owner' })).toThrow();
});
it('refuses malformed mappings and throwing properties without disclosing their values', () => {
  for (const input of [
    { ...context, sourceUserId: '' },
    { ...context, destinationUserId: 'private-invalid-identity' },
    { ...context, extra: 'private-unreviewed-authority' },
    {
      ...context,
      get sourceUserId() {
        throw new Error('private-getter-diagnostic');
      },
    },
  ])
    expect(() => captureImportedPasswordContext(input)).toThrow(
      /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
    );
});
