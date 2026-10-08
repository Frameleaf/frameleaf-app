import { randomUUID } from 'node:crypto';
import { ICloudEditBaselineSchema, ICloudEditSuccessorSchema } from 'src/dtos/icloud-identity.dto.js';
import { UploadSourceIdentitySchema } from 'src/utils/asset-upload-resource.js';

describe('administrative edit decision wire contracts', () => {
  it('preserves original metadata and keeps opaque source tokens distinct from authority', () => {
    const original = { kind: 'icloud', cloudIdentifier: 'opaque', role: 'original' };
    expect(UploadSourceIdentitySchema.safeParse(original).success).toBe(true);
    expect(
      UploadSourceIdentitySchema.safeParse({ ...original, role: 'edit-render', editVersion: 'opaque-A' }).success,
    ).toBe(true);
  });
  it('requires exact expected authority generation and rejects invented source-proof fields', () => {
    const baseline = {
      requestId: randomUUID(),
      expectedGeneration: 0,
      receiptId: randomUUID(),
      holder: { kind: 'device', id: randomUUID() },
      sourceIncarnation: randomUUID(),
      nativeVersion: 'opaque-A',
    };
    expect(ICloudEditBaselineSchema.safeParse(baseline).success).toBe(true);
    expect(ICloudEditBaselineSchema.safeParse({ ...baseline, expectedGeneration: -1 }).success).toBe(false);
    expect(ICloudEditBaselineSchema.safeParse({ ...baseline, orderedTimestamp: 1 }).success).toBe(false);
    expect(ICloudEditBaselineSchema.safeParse({ ...baseline, sourceIncarnation: undefined }).success).toBe(false);
  });
  it('requires a bound resource and current canonical version for an explicit successor decision', () => {
    const successor = {
      requestId: randomUUID(),
      expectedGeneration: 1,
      expectedVersionId: randomUUID(),
      channel: 'device',
      resourceId: randomUUID(),
    };
    expect(ICloudEditSuccessorSchema.parse(successor).policy).toBe('keep');
    expect(ICloudEditSuccessorSchema.safeParse({ ...successor, expectedVersionId: undefined }).success).toBe(false);
    expect(ICloudEditSuccessorSchema.safeParse({ ...successor, expectedGeneration: Infinity }).success).toBe(false);
    expect(ICloudEditSuccessorSchema.safeParse({ ...successor, byteEquivalent: true }).success).toBe(false);
  });
});
