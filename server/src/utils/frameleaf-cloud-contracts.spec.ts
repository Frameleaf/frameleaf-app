import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { backupUsageSchema } from 'src/utils/frameleaf-cloud-backup.js';
import { readBackupPlan } from 'src/utils/frameleaf-cloud-link.js';
import { discoveryProblem, discoverySchema } from 'src/utils/frameleaf-cloud.js';
import { pushGatewayUrl } from 'src/utils/frameleaf-push.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

type RegistryReceipt = {
  version: string;
  sha256: string;
  sourceCommit: string;
  fixtures: { path: string; sha256: string }[];
};

describe('published Frameleaf Cloud 0.0.3 conformance', () => {
  const receipt = cloudContractFixture<RegistryReceipt>('registry-0.0.3.json');
  const unchanged = [
    {
      path: 'instance/heartbeat-response-backup-plan.json',
      sha256: '13db6046387130888405e41c771eaecab81417a6eb5d6ea30633f0c38c98ec38',
    },
    {
      path: 'instance/heartbeat-response-backup-plan-family.json',
      sha256: '66b2b6ce305c97a6132eacea96855e9461e2457478d810c64e3dec0c9d0070d0',
    },
    {
      path: 'backup/usage-plan-full.json',
      sha256: '5d0b9f7003e6f4b43e5396a830dc40c87beed70b534e726b97e6d73563635893',
    },
  ];

  it('pins the registry receipt and every selectively imported byte', () => {
    expect(receipt.version).toBe('0.0.3');
    expect(receipt.sha256).toBe('23aeee533b7b969473e1a6ab53f1d0299369ea015eb37f85c4cc847cfd194eba');
    expect(receipt.sourceCommit).toBe('b7e9b37b53392694383ecc69fe4d7f18496d4ac2');
    expect(receipt.fixtures).toHaveLength(13);
    expect(new Set(receipt.fixtures.map(({ path }) => path)).size).toBe(13);
    for (const { path, sha256 } of [...receipt.fixtures, ...unchanged]) {
      const bytes = readFileSync(join(import.meta.dirname, '../../test/fixtures/frameleaf-cloud-contracts', path));
      expect(createHash('sha256').update(bytes).digest('hex'), path).toBe(sha256);
    }
  });

  it.each(['instance/discovery.json', 'instance/discovery-instance.json'])(
    'uses the genuine %s push origin while preserving optional discovery policy',
    (name) => {
      const document = discoverySchema.parse(cloudContractFixture(name));
      expect(discoveryProblem('https://api.frameleaf.cloud', document)).toBeNull();
      expect(pushGatewayUrl(document, null)).toBe('https://push.frameleaf.cloud/v1/push/send');
      expect(pushGatewayUrl(document, 'https://configured.frameleaf.cloud/')).toBe(
        'https://configured.frameleaf.cloud/v1/push/send',
      );
      const { push: _, ...endpoints } = document.endpoints!;
      expect(pushGatewayUrl({ ...document, endpoints }, null)).toBeNull();
    },
  );

  it('retains the unchanged heartbeat backupPlan and plan_full read-only contracts', () => {
    for (const { path } of unchanged.slice(0, 2)) {
      const heartbeat = cloudContractFixture<{ backupPlan: unknown }>(path);
      expect(readBackupPlan(heartbeat.backupPlan)).toEqual(heartbeat.backupPlan);
    }
    expect(backupUsageSchema.parse(cloudContractFixture('backup/usage-plan-full.json'))).toMatchObject({
      readOnly: true,
      readOnlyReason: 'plan_full',
    });
  });
});

describe('published Frameleaf Cloud 0.0.3 identity receipt', () => {
  it('pins the independent identity receipt and all eight genuine bytes without changing registry selection', () => {
    const directory = join(import.meta.dirname, '../../test/fixtures/frameleaf-cloud-contracts');
    const receiptBytes = readFileSync(join(directory, 'identity-0.0.3.json'));
    expect(createHash('sha256').update(receiptBytes).digest('hex')).toBe(
      '0fe0f6d1966d73384d2d9cc62d92b3b72bcdcf43ca8d345d119a933ebab0d706',
    );
    const identity = cloudContractFixture<RegistryReceipt>('identity-0.0.3.json');
    expect(identity.version).toBe('0.0.3');
    expect(identity.sha256).toBe('23aeee533b7b969473e1a6ab53f1d0299369ea015eb37f85c4cc847cfd194eba');
    expect(identity.sourceCommit).toBe('b7e9b37b53392694383ecc69fe4d7f18496d4ac2');
    expect(identity.fixtures.map(({ path }) => path)).toEqual([
      'identity/device-authorization-request.json',
      'identity/device-authorization-response.json',
      'identity/device-token-request.json',
      'identity/device-token-pending.json',
      'identity/token-request-client-credentials.json',
      'identity/token-response-instance.json',
      'identity/token-response-link.json',
      'identity/instance-claims.json',
    ]);
    for (const { path, sha256 } of identity.fixtures) {
      expect(
        createHash('sha256')
          .update(readFileSync(join(directory, path)))
          .digest('hex'),
        path,
      ).toBe(sha256);
    }
  });
});
