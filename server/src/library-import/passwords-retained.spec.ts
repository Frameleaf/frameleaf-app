import { hash } from 'bcrypt';
import { createHash } from 'node:crypto';
import { inspect } from 'node:util';
import argonVectors from 'src/library-import/fixtures/password-argon2-vectors.json' with { type: 'json' };
import piwigoVectors from 'src/library-import/fixtures/password-piwigo-vectors.json' with { type: 'json' };
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';

const password = 'Synthetic private recovery password';
const context = {
  operationId: '11111111-1111-4111-8111-111111111111',
  sourceUserId: 'source-owner',
  destinationUserId: '22222222-2222-4222-8222-222222222222',
};
let encoded: string, sourceHash: string;
beforeAll(async () => {
  sourceHash = await hash(password, 4);
  encoded = (await ImportedPassword.fromSource(context, 'bcrypt', sourceHash)).forImport();
});

it('restores a stronger compatible v1 wrapper without depending on the current default hash cost', async () => {
  const prefix = '$flimport$1$';
  const value = JSON.parse(Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8'));
  value.verifier = await hash(
    createHash('sha256').update(sourceHash).digest('hex'),
    '$2b$13$' + value.verifier.slice(7, 29),
  );
  const retained = prefix + Buffer.from(JSON.stringify(value)).toString('base64url');
  const recovered = ImportedPassword.fromRetained(context, retained);
  expect(recovered.forImport()).toBe(retained);
  expect(await verifyImportedPassword(password, recovered.forImport())).toBe(true);
});

it('restores the bound protected verifier without the source hash or plaintext', async () => {
  const recovered = ImportedPassword.fromRetained(context, encoded);
  expect(recovered.forImport()).toBe(encoded);
  expect(recovered).toMatchObject(context);
  expect(await verifyImportedPassword(password, recovered.forImport())).toBe(true);
  expect(await verifyImportedPassword('wrong', recovered.forImport())).toBe(false);
  expect(JSON.stringify(recovered)).toBe('"[imported password redacted]"');
  expect(inspect(recovered)).not.toContain(encoded);
  expect(String(recovered)).not.toContain(encoded);
  expect(Object.isFrozen(recovered)).toBe(true);
});

it.each(['operationId', 'sourceUserId', 'destinationUserId'] as const)(
  'refuses a verifier rebound to another %s',
  (field) => {
    const value = field === 'sourceUserId' ? 'different-source-owner' : '33333333-3333-4333-8333-333333333333';
    expect(() => ImportedPassword.fromRetained({ ...context, [field]: value }, encoded)).toThrow(
      'SOURCE_PASSWORD_UNSUPPORTED',
    );
  },
);

it.each([null, '', '$flimport$1$invalid', '$flimport$2$invalid', '$flimport$1$' + 'a'.repeat(4097)])(
  'refuses malformed retained credentials without exposing their value',
  (value) => {
    expect(() => ImportedPassword.fromRetained(context, value)).toThrow(
      /^Imported password refused: SOURCE_PASSWORD_UNSUPPORTED$/,
    );
  },
);

it('does not accept a weaker destination wrapper or mixed source-format settings', () => {
  const prefix = '$flimport$1$';
  const value = JSON.parse(Buffer.from(encoded.slice(prefix.length), 'base64url').toString('utf8'));
  const altered = (input: unknown) => prefix + Buffer.from(JSON.stringify(input)).toString('base64url');
  expect(() =>
    ImportedPassword.fromRetained(context, altered({ ...value, verifier: '$2b$04$' + value.verifier.slice(7) })),
  ).toThrow('SOURCE_PASSWORD_UNSUPPORTED');
  expect(() =>
    ImportedPassword.fromRetained(context, altered({ ...value, format: 'piwigo-md5', settings: '' })),
  ).toThrow('SOURCE_PASSWORD_UNSUPPORTED');
});

it('restores all existing protected source-format families byte for byte', async () => {
  const bcrypt = await hash(password, 4);
  const sources = [
    ['photoprism-bcrypt', bcrypt],
    ['django-pbkdf2-sha256', 'pbkdf2_sha256$10000$synthetic-salt$VdKESgIicWV9gR3+m0G8tjf9+/w5JUuk8uWK5aPy6Gg='],
    ['php-password', bcrypt],
    ['php-password', argonVectors.vectors[0].hash],
    ['nextcloud-password', '1|' + bcrypt],
    ['nextcloud-password', '3|' + argonVectors.vectors[0].hash],
    ['piwigo-password', 'a'.repeat(32)],
    ['piwigo-password', piwigoVectors.vectors[0].hash],
  ] as const;
  for (const [format, source] of sources) {
    const original = await ImportedPassword.fromSource(context, format, source);
    expect(ImportedPassword.fromRetained(context, original.forImport()).forImport()).toBe(original.forImport());
  }
});

it('refuses retained Argon2 settings above the qualified budget before doing password work', async () => {
  const original = await ImportedPassword.fromSource(context, 'php-password', argonVectors.vectors[0].hash);
  const prefix = '$flimport$1$';
  const value = JSON.parse(Buffer.from(original.forImport().slice(prefix.length), 'base64url').toString('utf8'));
  value.settings.memoryCost = 102_401;
  expect(() =>
    ImportedPassword.fromRetained(context, prefix + Buffer.from(JSON.stringify(value)).toString('base64url')),
  ).toThrow('SOURCE_PASSWORD_UNSUPPORTED');
});
