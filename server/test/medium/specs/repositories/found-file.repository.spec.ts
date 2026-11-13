import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { FoundFileRepository } from 'src/repositories/found-file.repository.js';
import { DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1532: what is remembered about a found file comes back from a real database as it was written. */

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

const file = (path: string) => ({
  path,
  sizeInBytes: 10,
  modifiedAt: new Date('2026-11-01T10:00:00.000Z'),
  sha1: Buffer.alloc(20, 1),
  sha256: Buffer.alloc(32, 2),
  outcome: 'spare' as const,
  reason: null,
  ownerId: randomUUID(),
  assetId: randomUUID(),
  previousPath: null,
  steps: [
    { step: 'found', at: '2026-11-12T03:40:00.000Z' },
    { step: 'read', at: '2026-11-12T03:40:01.000Z', outcome: 'ok' },
  ],
});

describe(FoundFileRepository.name, () => {
  it('reads back what was written, with the steps as a list and the digests as bytes', async () => {
    const sut = new FoundFileRepository(defaultDatabase);
    const path = `/data/upload/${randomUUID()}/IMG_0001.jpg`;
    const written = file(path);

    await sut.upsert(written);

    const [read] = await sut.getByPaths([path, `/data/upload/${randomUUID()}/other.jpg`]);
    expect(read).toMatchObject({
      path,
      outcome: 'spare',
      reason: null,
      ownerId: written.ownerId,
      assetId: written.assetId,
      previousPath: null,
      steps: written.steps,
    });
    expect(Array.isArray(read.steps)).toBe(true);
    expect(Number(read.sizeInBytes)).toBe(10);
    expect(new Date(read.modifiedAt).getTime()).toBe(written.modifiedAt.getTime());
    expect(Buffer.from(read.sha1!).equals(written.sha1)).toBe(true);
    expect(Buffer.from(read.sha256!).equals(written.sha256)).toBe(true);
  });

  it('replaces what was known about a path, keeping one row for it', async () => {
    const sut = new FoundFileRepository(defaultDatabase);
    const path = `/data/upload/${randomUUID()}/IMG_0002.jpg`;
    await sut.upsert(file(path));

    await sut.upsert({
      ...file(path),
      outcome: 'back',
      previousPath: '/data/library/taylor/2020/08/IMG_0002.jpg',
      steps: [
        { step: 'found', at: '2026-11-12T03:40:00.000Z' },
        { step: 'back', at: '2026-11-13T03:40:00.000Z' },
      ],
    });

    const rows = await sut.getByPaths([path]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ outcome: 'back', previousPath: '/data/library/taylor/2020/08/IMG_0002.jpg' });
    expect(rows[0].steps.map(({ step }) => step)).toEqual(['found', 'back']);
  });

  it('asks the database nothing for no paths', async () => {
    await expect(new FoundFileRepository(defaultDatabase).getByPaths([])).resolves.toEqual([]);
  });
});
