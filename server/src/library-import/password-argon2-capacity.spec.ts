import { vi } from 'vitest';
import vectors from 'src/library-import/fixtures/password-argon2-vectors.json' with { type: 'json' };
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';

const native = vi.hoisted(() => ({ work: vi.fn() }));
vi.mock('@node-rs/argon2', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@node-rs/argon2')>()),
  hashRaw: (...args: unknown[]) => native.work(...args),
}));

it('bounds simultaneous memory-hard work and refuses an overflowing queue without starting more native work', async () => {
  const vector = vectors.vectors[0];
  const credential = await ImportedPassword.fromSource(
    {
      operationId: '11111111-1111-4111-8111-111111111111',
      sourceUserId: 'owner',
      destinationUserId: '22222222-2222-4222-8222-222222222222',
    },
    'php-password',
    vector.hash,
  );
  const { promise: blocked, resolve: release } = Promise.withResolvers<void>();
  let active = 0,
    maximum = 0;
  native.work.mockImplementation(async () => {
    active++;
    maximum = Math.max(maximum, active);
    try {
      await blocked;
      return Buffer.from(vector.hash.split('$').at(-1)!, 'base64');
    } finally {
      active--;
    }
  });
  const attempts = Array.from({ length: 10 }, () => verifyImportedPassword(vector.password, credential.forImport()));
  try {
    const overflowRefused = await Promise.race([
      attempts[9].then((result) => result === false),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    expect(overflowRefused).toBe(true);
    expect(maximum).toBe(1);
  } finally {
    release();
    await Promise.all(attempts);
  }
});
