import { readFileSync } from 'node:fs';
import {
  type DestinationImportPlan,
  bindDestinationImportPlan,
  destinationPlanFingerprint,
  parseDestinationImportPlan,
} from 'src/library-import/destination-plan.js';
import placements from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { type LibraryImportBinding } from 'src/library-import/state.js';

it.each([
  'adopt',
  'relocate',
  'identity',
  'hash',
  'source-path',
  'duplicate-pair',
  'missing-reference',
  'unknown-field',
])('refuses unsafe shared original placement intent: %s', (scenario) => {
  const plan = structuredClone(placements.plan);
  const file = plan.files[1];
  switch (scenario) {
    case 'adopt':
    case 'relocate': {
      file.mode = scenario;
      break;
    }
    case 'identity': {
      file.sourceIdentity.inode = '99';
      break;
    }
    case 'hash': {
      file.sha256 = 'b'.repeat(64);
      break;
    }
    case 'source-path': {
      file.sourcePath = 'different.jpg';
      break;
    }
    case 'duplicate-pair': {
      file.sourceAssetId = 'asset-1';
      break;
    }
    case 'missing-reference': {
      Reflect.deleteProperty(file, 'sourceAssetId');
      break;
    }
    case 'unknown-field': {
      Object.assign(file, { password: 'synthetic' });
      break;
    }
  }
  expect(() => parseDestinationImportPlan(plan)).toThrow('IMPORT_PLAN_INVALID');
});

const shared = () => {
  const source = manifest();
  if (source.version !== 2) throw new Error('Expected V2 fixture');
  source.users.push({ id: 'owner-2', name: 'Other synthetic owner' });
  source.assets.push({ ...structuredClone(source.assets[0]), id: 'asset-2', ownerId: 'owner-2' });
  return source;
};

it('binds every shared original reference to its independent Manager placement', () => {
  const source = shared();
  expect(destinationPlanFingerprint(placements.plan)).toBe(placements.sha256);
  expect(
    bindDestinationImportPlan(
      placements.plan,
      {
        ...binding(),
        manifestSha256: manifestFingerprint(source),
        planSha256: placements.sha256,
      },
      source,
      placements.plan.destinationId,
    ),
  ).toEqual(placements.plan);
});

it('refuses legacy shared originals before any destination write', () => {
  const source = shared();
  expect(() =>
    bindDestinationImportPlan(
      { ...fixture.plan, owners: placements.plan.owners },
      {
        ...binding(),
        manifestSha256: manifestFingerprint(source),
        planSha256: destinationPlanFingerprint({ ...fixture.plan, owners: placements.plan.owners }),
      },
      source,
      fixture.plan.destinationId,
    ),
  ).toThrow('IMPORT_PLAN_FILE_MISMATCH');
});

it.each(['missing', 'nonmember', 'unknown-asset', 'unknown-file'])(
  'refuses incomplete placement coverage: %s',
  (scenario) => {
    const source = shared();
    const plan = structuredClone(placements.plan);
    switch (scenario) {
      case 'missing': {
        plan.files.pop();
        break;
      }
      case 'nonmember': {
        source.files.push({ ...source.files[0], id: 'unused-file', path: 'other.jpg' });
        source.assets[1].fileIds = ['unused-file'];
        if ('primaryFileId' in source.assets[1]) source.assets[1].primaryFileId = 'unused-file';

        break;
      }
      case 'unknown-asset': {
        plan.files[1].sourceAssetId = 'unknown';
        break;
      }
      case 'unknown-file': {
        plan.files[1].sourceFileId = 'unknown';
        break;
      }
      // No default
    }
    expect(() =>
      bindDestinationImportPlan(
        plan,
        {
          ...binding(),
          manifestSha256: manifestFingerprint(source),
          planSha256: destinationPlanFingerprint(plan),
        },
        source,
        plan.destinationId,
      ),
    ).toThrow('IMPORT_PLAN_FILE_MISMATCH');
  },
);

const fixture = JSON.parse(readFileSync(new URL('fixtures/manager-plan-v1.json', import.meta.url), 'utf8')) as {
  plan: Extract<DestinationImportPlan, { version: 1 }>;
  sha256: string;
};
const manifest = () =>
  parseImportManifest({
    format: 'frameleaf-library-import',
    version: 2,
    source: fixture.plan.source,
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: 'frozen-1',
      revisionAfter: 'frozen-1',
    },
    users: [{ id: 'owner-1', name: 'Synthetic owner' }],
    files: [{ id: 'file-1', path: 'camera.jpg', bytes: '14', sha256: fixture.plan.files[0].sha256, role: 'original' }],
    assets: [
      {
        id: 'asset-1',
        ownerId: 'owner-1',
        primaryFileId: 'file-1',
        fileIds: ['file-1'],
        visibility: 'timeline',
        metadata: {},
      },
    ],
    albums: [],
    losses: [],
  });
const binding = (): LibraryImportBinding => ({
  operationId: '33333333-3333-4333-8333-333333333333',
  manifestSha256: manifestFingerprint(manifest()),
  planSha256: fixture.sha256,
  source: fixture.plan.source,
});

it('matches a plan and fingerprint independently emitted by Manager', () => {
  expect(parseDestinationImportPlan(fixture.plan)).toEqual(fixture.plan);
  expect(destinationPlanFingerprint(fixture.plan)).toBe(fixture.sha256);
  expect(bindDestinationImportPlan(fixture.plan, binding(), manifest(), fixture.plan.destinationId)).toEqual(
    fixture.plan,
  );
});

it('canonicalizes object-key order without rewriting reviewed UUID spelling', () => {
  const plan = structuredClone(fixture.plan);
  plan.owners[0].destinationId = 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA';
  const reversed = Object.fromEntries(Object.entries(plan).toReversed());
  expect(destinationPlanFingerprint(reversed)).toBe(destinationPlanFingerprint(plan));
  expect(parseDestinationImportPlan(plan).owners[0].destinationId).toBe(plan.owners[0].destinationId);
});

it.each(['owner-alias', 'root-alias', 'path-alias', 'source-identity', 'cross-device-move', 'unknown-version'])(
  'refuses an unsafe plan: %s',
  (scenario) => {
    const plan = structuredClone(fixture.plan);
    switch (scenario) {
      case 'owner-alias': {
        plan.owners = [
          { sourceId: 'one', destinationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          { sourceId: 'two', destinationId: 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA' },
        ];
        break;
      }
      case 'root-alias': {
        plan.roots[1].inode = plan.roots[0].inode;
        break;
      }
      case 'path-alias': {
        plan.files.push({ ...plan.files[0], id: 'second' });
        break;
      }
      case 'source-identity': {
        plan.files[0].sourceIdentity.device = '8';
        break;
      }
      case 'cross-device-move': {
        plan.files[0].mode = 'relocate';
        plan.files[0].destinationDevice = '8';
        plan.roots[1].device = '8';
        break;
      }
      case 'unknown-version': {
        Object.assign(plan, { version: 99 });
        break;
      }
    }
    expect(() => parseDestinationImportPlan(plan)).toThrow('IMPORT_PLAN_INVALID');
  },
);

it('redacts unrecognized credential-bearing input', () => {
  expect(() => parseDestinationImportPlan({ ...fixture.plan, password: 'synthetic-private-value' })).toThrow(
    'Library import refused: IMPORT_PLAN_INVALID',
  );
});

it.each(['manifest', 'plan', 'destination', 'source', 'owners', 'files'])(
  'binds the reviewed %s before any destination write',
  (scenario) => {
    const plan = structuredClone(fixture.plan),
      expected = binding();
    let destinationId = plan.destinationId;
    switch (scenario) {
      case 'manifest': {
        expected.manifestSha256 = 'b'.repeat(64);
        break;
      }
      case 'plan': {
        plan.files[0].destinationPath = 'owner/changed.jpg';
        break;
      }
      case 'destination': {
        destinationId = '44444444-4444-4444-8444-444444444444';
        break;
      }
      case 'source': {
        plan.source.revision = 'changed';
        expected.planSha256 = destinationPlanFingerprint(plan);
        break;
      }
      case 'owners': {
        plan.owners[0].sourceId = 'other-owner';
        expected.planSha256 = destinationPlanFingerprint(plan);
        break;
      }
      case 'files': {
        plan.files[0].sha256 = 'b'.repeat(64);
        expected.planSha256 = destinationPlanFingerprint(plan);
        break;
      }
    }
    expect(() => bindDestinationImportPlan(plan, expected, manifest(), destinationId)).toThrow(
      'Library import refused: IMPORT_PLAN_',
    );
  },
);

it('requires review of same-owner duplicate primary bytes before any file effects', () => {
  const source = shared();
  source.assets[1].ownerId = 'owner-1';
  const plan = structuredClone(placements.plan);
  expect(() =>
    bindDestinationImportPlan(
      plan,
      { ...binding(), manifestSha256: manifestFingerprint(source), planSha256: destinationPlanFingerprint(plan) },
      source,
      plan.destinationId,
    ),
  ).toThrow('IMPORT_PLAN_DUPLICATE_REVIEW_REQUIRED');
});

it.each([false, true])('selects the original after a leading V1 auxiliary file, duplicate=%s', (duplicate) => {
  const source = shared();
  Object.assign(source, { version: 1 });
  for (const asset of source.assets) Reflect.deleteProperty(asset, 'primaryFileId');
  source.files.push(
    {
      ...source.files[0],
      id: 'file-2',
      path: 'other.jpg',
      sha256: duplicate ? source.files[0].sha256 : 'b'.repeat(64),
    },
    {
      ...source.files[0],
      id: 'auxiliary',
      path: 'shared.xmp',
      sha256: 'c'.repeat(64),
      role: 'sidecar',
    },
  );
  source.assets[0].fileIds = ['auxiliary', 'file-1'];
  source.assets[1].fileIds = ['auxiliary', 'file-2'];
  source.assets[1].ownerId = 'owner-1';
  if (duplicate) {
    source.files.push({ ...source.files[2], id: 'auxiliary-2', path: 'other.xmp', sha256: 'd'.repeat(64) });
    source.assets[1].fileIds[0] = 'auxiliary-2';
  }
  const plan = structuredClone(placements.plan);
  plan.files[1] = {
    ...plan.files[1],
    sourceFileId: 'file-2',
    sourcePath: 'other.jpg',
    sha256: source.files[1].sha256,
    sourceIdentity: { ...plan.files[1].sourceIdentity, inode: '4' },
  };
  plan.files.push(
    ...['asset-1', 'asset-2'].map((sourceAssetId, index) => ({
      ...plan.files[0],
      id: 'auxiliary-' + index,
      sourceFileId: 'auxiliary',
      sourceAssetId,
      sourcePath: 'shared.xmp',
      destinationPath: index + '/shared.xmp',
      sha256: 'c'.repeat(64),
      sourceIdentity: { ...plan.files[0].sourceIdentity, inode: '5' },
    })),
  );
  if (duplicate)
    Object.assign(plan.files[3], {
      sourceFileId: 'auxiliary-2',
      sourcePath: 'other.xmp',
      sha256: 'd'.repeat(64),
      sourceIdentity: { ...plan.files[3].sourceIdentity, inode: '6' },
    });
  const bind = () =>
    bindDestinationImportPlan(
      plan,
      { ...binding(), manifestSha256: manifestFingerprint(source), planSha256: destinationPlanFingerprint(plan) },
      source,
      plan.destinationId,
    );
  if (duplicate) expect(bind).toThrow('IMPORT_PLAN_DUPLICATE_REVIEW_REQUIRED');
  else expect(bind()).toEqual(plan);
});

it('refuses destination paths that collide through different reviewed roots', () => {
  const plan = structuredClone(placements.plan);
  plan.roots.push({ ...plan.roots[1], id: 'nested', path: plan.roots[1].path + '/owner', inode: '99' });
  plan.files[1].destinationRoot = 'nested';
  plan.files[1].destinationPath = 'camera.jpg';
  expect(() => parseDestinationImportPlan(plan)).toThrow('IMPORT_PLAN_INVALID');
});
