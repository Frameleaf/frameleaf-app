import { importPlanSha256, type ImportPlan } from '../src/import-plan.js';

export function reviewedImport(
  files: Extract<ImportPlan, { version: 1 }>['files'],
  roots?: ImportPlan['roots'],
) {
  const devices = new Map<string, string>();
  for (const file of files) {
    devices.set(file.sourceRoot, file.sourceIdentity.device);
    devices.set(file.destinationRoot, file.destinationDevice);
  }
  const digest = 'a'.repeat(64);
  const plan: ImportPlan = {
    version: 1,
    source: {
      kind: 'photoview',
      version: '2.4.0',
      identity: 'synthetic',
      revision: 'frozen-1',
      schemaSha256: digest,
    },
    destinationId: '11111111-1111-4111-8111-111111111111',
    owners: [
      {
        sourceId: 'alice',
        destinationId: '22222222-2222-4222-8222-222222222222',
      },
    ],
    roots:
      roots ??
      [...devices].map(([id, device], index) => ({
        id,
        device,
        inode: String(index + 1),
        path: `/synthetic/${id}`,
      })),
    files,
  };
  const binding = {
    manifestSha256: digest,
    planSha256: importPlanSha256(plan),
  };
  const comparison = { expectedSha256: digest, actualSha256: digest };
  return {
    plan,
    binding,
    verification: {
      ...binding,
      records: comparison,
      relationships: comparison,
      permissions: comparison,
      regenerationRunId: '33333333-3333-4333-8333-333333333333',
    },
  };
}
