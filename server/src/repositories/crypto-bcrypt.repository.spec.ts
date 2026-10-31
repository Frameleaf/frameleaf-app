import { CryptoRepository } from 'src/repositories/crypto.repository.js';

it('returns asynchronous bcrypt verification while retaining password/hash compatibility', async () => {
  const repository = new CryptoRepository();
  const hash = await repository.hashBcrypt('correct password', 4);
  const matching = repository.compareBcrypt('correct password', hash);
  expect(matching).toBeInstanceOf(Promise);
  await expect(matching).resolves.toBe(true);
  await expect(repository.compareBcrypt('incorrect password', hash)).resolves.toBe(false);
  await expect(repository.compareBcrypt(Buffer.from('correct password'), hash)).resolves.toBe(true);
});
