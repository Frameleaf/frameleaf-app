import { readFileSync } from 'node:fs';
import {
  type DestinationImportPlan,
  bindDestinationImportPlan,
  destinationPlanFingerprint,
  parseDestinationImportPlan,
} from 'src/library-import/destination-plan.js';
import { manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import { type LibraryImportBinding } from 'src/library-import/state.js';

const fixture = JSON.parse(readFileSync(new URL('fixtures/manager-plan-v1.json', import.meta.url), 'utf8')) as {
  plan: DestinationImportPlan;
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
        Object.assign(plan, { version: 2 });
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
