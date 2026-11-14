import z from 'zod';
import { ConnectAccessPolicySchema, isPolicyNarrowing, requireConnectPolicy } from 'src/utils/connect-policy.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const album = '01000000-0000-4000-8000-000000000001';
const other = '01000000-0000-4000-8000-000000000002';
const policy = {
  version: 1 as const,
  readAlbumIds: [album],
  allLibraryRead: false,
  writableAlbumIds: [album],
  writeWorkspaces: ['photo' as const],
};

describe('Connect consent policy', () => {
  it('publishes an integer policy version for OpenAPI clients', () => {
    const document = z.toJSONSchema(ConnectAccessPolicySchema, { target: 'openapi-3.0', io: 'input' });
    const definitions = document.definitions as Record<string, typeof document>;
    const schema = document.$ref ? definitions[document.$ref.slice('#/definitions/'.length)] : document;
    expect(schema.properties?.version).toMatchObject({
      type: 'integer',
      format: 'int32',
      enum: [1],
    });
  });
  it.each([
    { ...policy, version: 2 },
    { ...policy, allLibraryRead: undefined },
    { ...policy, readAlbumIds: [album, album] },
    { ...policy, writeWorkspaces: ['locked'] },
    { ...policy, writableAlbumIds: ['not-a-uuid'] },
    { ...policy, writeWorkspaces: ['photo', 'photo'] },
    { ...policy, people: true },
  ])('rejects malformed or widening policy syntax', (value) => {
    expect(ConnectAccessPolicySchema.safeParse(value).success).toBe(false);
  });
  it('allows narrowing all-library reads to newly selected owned albums', () => {
    expect(isPolicyNarrowing({ ...policy, allLibraryRead: true }, { ...policy, readAlbumIds: [other] })).toBe(true);
    expect(isPolicyNarrowing(policy, { ...policy, readAlbumIds: [other] })).toBe(false);
  });
  it('never widens write targets or workspaces during restriction edits', () => {
    expect(isPolicyNarrowing(policy, { ...policy, writableAlbumIds: [other] })).toBe(false);
    expect(isPolicyNarrowing(policy, { ...policy, writeWorkspaces: ['design'] })).toBe(false);
    expect(isPolicyNarrowing(policy, { ...policy, allLibraryRead: true })).toBe(false);
    expect(isPolicyNarrowing(policy, { ...policy, readAlbumIds: [], writableAlbumIds: [], writeWorkspaces: [] })).toBe(
      true,
    );
  });
  it('rejects a session or legacy grant as restricted auth', () => {
    expect(() => requireConnectPolicy(authStub.user1)).toThrow();
  });
});
