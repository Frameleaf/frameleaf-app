import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { MediaRecoveryRepository } from 'src/repositories/media-recovery.repository.js';

const mocks = vi.hoisted(() => ({
  itemHint: vi.fn(),
  lockItem: vi.fn(),
  guardScheduled: vi.fn(),
  guardAudit: vi.fn(),
}));
vi.mock('kysely', () => ({
  Kysely: class {},
  sql: (strings: TemplateStringsArray, ...parameters: unknown[]) => ({
    execute: (db: { executeQuery: (query: unknown) => unknown }) =>
      db.executeQuery({ text: strings.join('?'), parameters }),
  }),
}));
vi.mock('src/repositories/icloud-edit-authority.repository.js', () => ({
  ICloudEditAuthorityRepository: class {
    itemHint = mocks.itemHint;
  },
}));
vi.mock('src/repositories/icloud-item-claim-lock.js', () => ({ lockICloudItemClaims: mocks.lockItem }));
vi.mock('src/repositories/icloud-scheduled-authority.js', () => ({ guardScheduledAudit: mocks.guardScheduled }));
vi.mock('src/repositories/icloud-audit.repository.js', () => ({ guardAuditAuthority: mocks.guardAudit }));
vi.mock('src/repositories/asset-local-effect.repository.js', () => ({}));
vi.mock('src/repositories/icloud-edit-transaction.js', () => ({}));
vi.mock('src/repositories/icloud-scheduled-publication.js', () => ({}));
vi.mock('src/repositories/icloud-scheduled-staging.repository.js', () => ({
  ICloudScheduledStagingRepository: class {},
}));
vi.mock('src/repositories/icloud-weekly-adoption-authority.js', () => ({}));
vi.mock('src/repositories/physical-file.repository.js', () => ({}));
vi.mock('src/utils/database.js', () => ({}));
vi.mock('src/utils/studio-project.js', () => ({}));

describe('recovery reservation lock prefix', () => {
  const ownerId = 'owner';
  const sourceAssetId = 'scheduled-item';
  let events: string[];
  let hint: { sourceAssetId: string } | undefined;
  let queries: { text: string; parameters: unknown[] }[];
  let sut: MediaRecoveryRepository;
  const input = {
    ownerId,
    resourceId: 'resource',
    leaseToken: 'lease',
    includeHidden: false,
    verified: { sha256: Buffer.alloc(32) },
    outcome: 'imported',
    proposedPath: '/private/recovery',
    audit: { purpose: 'scheduled-weekly', auditRequestId: 'audit', operationId: 'operation' },
  } as Parameters<MediaRecoveryRepository['reserve']>[0];

  beforeEach(() => {
    vi.resetAllMocks();
    events = [];
    queries = [];
    hint = { sourceAssetId };
    const trx = {
      executeQuery: vi.fn((query: { text: string; parameters: unknown[] }) => {
        queries.push(query);
        if (query.text.includes('icloud-staging-reservations')) {
          events.push('budget');
          return Promise.resolve({ rows: [] });
        }
        events.push('hint');
        return Promise.resolve({ rows: hint ? [hint] : [] });
      }),
    };
    mocks.itemHint.mockImplementation(() => {
      events.push('edit-hint');
      return Promise.resolve(null);
    });
    mocks.lockItem.mockImplementation(() => {
      events.push('item');
      return Promise.resolve();
    });
    mocks.guardScheduled.mockImplementation(() => {
      events.push('scheduled-guard');
      return Promise.resolve({ source: { sourceAssetId } });
    });
    mocks.guardAudit.mockResolvedValue(undefined);
    sut = new MediaRecoveryRepository({
      transaction: () => ({ execute: (callback: (db: unknown) => unknown) => callback(trx) }),
    } as unknown as Kysely<DB>);
    const internal = sut as unknown as {
      lockAuthority: () => Promise<void>;
      lockResource: () => Promise<unknown>;
    };
    vi.spyOn(internal, 'lockAuthority').mockImplementation(() => {
      events.push('authority');
      return Promise.resolve();
    });
    vi.spyOn(internal, 'lockResource').mockImplementation(() => {
      events.push('resource');
      return Promise.resolve();
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it.each(['imported', 'repaired-missing', 'repaired-corrupt', 'reused'] as const)(
    'takes the scheduled item fence before any budget/authority lock for %s',
    async (outcome) => {
      expect(await sut.reserve({ ...input, outcome })).toBeUndefined();
      expect(events).toEqual([
        'hint',
        'item',
        ...(outcome === 'reused' ? [] : ['budget']),
        'scheduled-guard',
        'authority',
        'resource',
      ]);
      expect(mocks.itemHint).not.toHaveBeenCalled();
      expect(mocks.lockItem).toHaveBeenCalledWith(expect.anything(), ownerId, [sourceAssetId]);
      expect(queries[0].parameters).toEqual(['audit', ownerId, 'operation']);
      expect(queries[0].text).toContain('s.id=q."sourceResourceId" AND s."ownerId"=q."ownerId"');
      expect(queries[0].text).toContain("q.purpose='scheduled-weekly'");
    },
  );

  it.each([undefined, { sourceAssetId: '' }])(
    'refuses a missing scheduled source binding before taking locks',
    async (binding) => {
      hint = binding;
      expect(await sut.reserve(input)).toBeUndefined();
      expect(events).toEqual(['hint']);
      expect(mocks.guardScheduled).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, { source: { sourceAssetId: 'changed-item' } }])(
    'refuses failed admission or changed source identity under the prefix',
    async (guarded) => {
      mocks.guardScheduled.mockImplementation(() => {
        events.push('scheduled-guard');
        return Promise.resolve(guarded);
      });
      expect(await sut.reserve(input)).toBeUndefined();
      expect(events).toEqual(['hint', 'item', 'budget', 'scheduled-guard']);
    },
  );

  it.each(['manual-session', 'unknown'])('retains refusal of unproven %s audit authority', async (purpose) => {
    const internal = sut as unknown as { lockResource: () => Promise<{ status: string }> };
    vi.spyOn(internal, 'lockResource').mockResolvedValue({ status: 'staged' });
    expect(await sut.reserve({ ...input, audit: { ...input.audit, purpose } } as typeof input)).toBeUndefined();
    expect(mocks.guardAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose }),
      ownerId,
      true,
      {
        id: input.resourceId,
        leaseToken: input.leaseToken,
      },
    );
    expect(mocks.guardScheduled).not.toHaveBeenCalled();
    expect(queries).toEqual([]);
  });

  it.each([undefined, 'manual-session', 'unknown'])(
    'preserves the edit-only hint and avoids scheduled budget admission for %s authority',
    async (purpose) => {
      mocks.itemHint.mockResolvedValue('edit-item');
      const audit = purpose ? { ...input.audit, purpose } : undefined;
      expect(await sut.reserve({ ...input, audit } as typeof input)).toBeUndefined();
      expect(events).toEqual(['item', 'authority', 'resource']);
      expect(mocks.lockItem).toHaveBeenCalledWith(expect.anything(), ownerId, ['edit-item']);
      expect(mocks.guardScheduled).not.toHaveBeenCalled();
      expect(queries).toEqual([]);
    },
  );
});
