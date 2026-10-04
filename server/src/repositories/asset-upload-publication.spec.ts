import type { Kysely, Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';

describe('upload asset publication transaction', () => {
  afterEach(() => vi.restoreAllMocks());
  it('inserts the canonical asset in the resource result transaction', async () => {
    const asset = { id: 'asset', ownerId: 'owner' };
    const query = {
      values: vi.fn().mockReturnThis(),
      returningAll: vi.fn().mockReturnThis(),
      executeTakeFirstOrThrow: vi.fn().mockResolvedValue(asset),
    };
    const tx = { insertInto: vi.fn().mockReturnValue(query) } as unknown as Transaction<DB>;
    const db = {
      transaction: vi.fn(() => {
        throw new Error('Independent transaction breaks atomic result');
      }),
    } as unknown as Kysely<DB>;
    const sut = new AssetRepository(db);
    expect(await sut.create(asset as never, undefined, tx)).toEqual(asset);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(tx.insertInto).toHaveBeenCalledWith('asset');
    expect(query.values).toHaveBeenCalledWith(asset);
  });
});
