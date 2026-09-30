import type { Kysely, Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ForkEnrichmentRepository } from 'src/repositories/fork-enrichment.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';

describe('upload asset publication transaction', () => {
  afterEach(() => vi.restoreAllMocks());
  it('joins the resource result transaction, including privacy and enrichment', async () => {
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
    const privacy = vi.spyOn(ForkPrivacyRepository.prototype, 'mirrorFromLegacy').mockResolvedValue(undefined);
    const enrichment = vi.spyOn(ForkEnrichmentRepository.prototype, 'initialize').mockResolvedValue(undefined);
    const sut = new AssetRepository(db);
    expect(await sut.create(asset as never, undefined, tx)).toEqual(asset);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(privacy).toHaveBeenCalledWith(asset.id, tx);
    expect(enrichment).toHaveBeenCalledWith([asset.id], tx);
  });
});
