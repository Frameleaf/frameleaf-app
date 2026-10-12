import { randomUUID } from 'node:crypto';
import {
  ValidationInputEnvelope,
  ValidationInputPayload,
  ValidationInputState,
  nextValidationInputSequence,
  privateCopyScope,
  privateWorkScope,
  validPrivateCopy,
  validPrivateWork,
  validValidationInputs,
  validationInputScope,
  validationInputsDisposed,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';

const ownerId = randomUUID();
const resourceId = randomUUID();
const connectionId = randomUUID();
const auditRequestId = randomUUID();
const operationId = randomUUID();
const seals = new Map<string, { scope: string; payload: string }>();
const seal = (scope: string, payload: unknown) => {
  const token = randomUUID();
  seals.set(token, { scope, payload: canonicalJson(payload) });
  return token;
};
const authentic = (scope: string, payload: unknown, token: string) =>
  seals.get(token)?.scope === scope && seals.get(token)?.payload === canonicalJson(payload);
function inputEnvelope(
  state: ValidationInputState,
  overrides: Partial<ValidationInputPayload> = {},
): ValidationInputEnvelope {
  const pathNonce = randomUUID();
  const identity = { dev: 1, ino: 2, uid: 501, size: 10 };
  const stagingDirectory = `/private/staging/${resourceId}`;
  const payload: ValidationInputPayload = {
    version: 1,
    purpose: 'scheduled-weekly-validation-input',
    ownerId,
    resourceId,
    connectionId,
    auditRequestId,
    operationId,
    operationClaimToken: randomUUID(),
    resourceLeaseToken: randomUUID(),
    itemClaimId: randomUUID(),
    sourceAssetId: 'canonical-item',
    sequence: '1',
    pathNonce,
    stage: 'source',
    validationPath: `${stagingDirectory}/complete`,
    sourceIdentity: identity,
    copyGeneration: null,
    stagingDirectory,
    directoryPath: `${stagingDirectory}/.validation-${pathNonce}`,
    inputPath: `${stagingDirectory}/.validation-${pathNonce}/input`,
    directoryIdentity: identity,
    inputIdentity: identity,
    reservedInputBytes: 10,
    state,
    pending: [],
    fresh: {
      payload: {
        version: 1,
        basis: 'audit-fresh-download',
        binding: {
          ownerId,
          resourceId,
          connectionId,
          auditRequestId,
          operationId,
          sourceAssetId: 'canonical-item',
          cohortId: randomUUID(),
          memberOrdinal: '0',
          batchOrdinal: 0,
          grantId: randomUUID(),
          grantGeneration: 1,
          configFingerprint: 'config',
          privacyFingerprint: 'privacy',
          sourceResourceId: randomUUID(),
          identityId: randomUUID(),
          libraryKey: 'library',
          library: { area: 'private', zoneID: { zoneName: 'PrimarySync' } },
          sourceRevision: 'source',
          masterRevision: 'master',
          expectedSha256: 'a'.repeat(64),
          originalAssetId: randomUUID(),
          originalUpdateId: randomUUID(),
          originalPath: '/private/original',
          physicalId: randomUUID(),
          recordId: 'record',
          resourceKey: 'key',
          role: 'original',
          fingerprint: 'fingerprint',
          sizeInBytes: 10,
        },
        path: `${stagingDirectory}/complete`,
        identity: { ...identity, mtimeMs: 1, ctimeMs: 1 },
        sha1: 'b'.repeat(40),
        sha256: 'a'.repeat(64),
        appleFingerprint: 'fingerprint',
      },
      seal: 'fresh-seal',
    },
    ...overrides,
  };
  const envelope = {
    version: 1 as const,
    purpose: 'scheduled-weekly-validation-inputs' as const,
    ownerId,
    resourceId,
    highWater: payload.sequence,
    current: { payload, seal: seal(validationInputScope(payload), payload) },
    previousDisposed: null,
  };
  return { payload: envelope, seal: seal(validationInputsScope(envelope), envelope) };
}

describe('validation input envelopes', () => {
  it.each(['00', '-1', '+1', '1.5', '1e3', ' 1'])('rejects noncanonical sequence %s', (value) => {
    expect(() => nextValidationInputSequence(value)).toThrow();
  });
  it('advances beyond fixed-width limits exactly', () => {
    expect(nextValidationInputSequence('18446744073709551615')).toBe('18446744073709551616');
  });
  it.each(['reserved', 'preparing', 'running', 'settled', 'disposed'] as const)('accepts %s', (state) => {
    const envelope = inputEnvelope(state);
    expect(validValidationInputs(envelope)).toBe(true);
    expect(validationInputsDisposed(envelope)).toBe(state === 'disposed');
  });
  it.each([
    [
      'mark below current',
      (e: ValidationInputEnvelope) => {
        e.payload.highWater = '0';
      },
    ],
    [
      'previous equal current',
      (e: ValidationInputEnvelope) => {
        e.payload.previousDisposed = e.payload.current;
      },
    ],
    [
      'unknown version',
      (e: ValidationInputEnvelope) => {
        e.payload.version = 2 as never;
      },
    ],
    [
      'pending disposed work',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.pending = [randomUUID()];
      },
    ],
    [
      'missing directory identity',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.directoryIdentity = null;
      },
    ],
    [
      'missing input identity',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.inputIdentity = null;
      },
    ],
    [
      'fractional bytes',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.reservedInputBytes = 1.5;
      },
    ],
    [
      'aliased input',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.validationPath = e.payload.current.payload.inputPath;
      },
    ],
    [
      'foreign owner',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.ownerId = randomUUID();
      },
    ],
    [
      'foreign purpose',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.purpose = 'other' as never;
      },
    ],
    [
      'noncanonical path',
      (e: ValidationInputEnvelope) => {
        e.payload.current.payload.directoryPath += '/..';
      },
    ],
  ] as const)('rejects %s', (_name, mutate) => {
    const envelope = inputEnvelope('disposed');
    mutate(envelope);
    expect(validValidationInputs(envelope)).toBe(false);
    expect(validationInputsDisposed(envelope)).toBe(false);
  });
  it.each([
    'ownerId',
    'connectionId',
    'resourceId',
    'auditRequestId',
    'operationId',
    'operationClaimToken',
    'resourceLeaseToken',
    'itemClaimId',
    'pathNonce',
  ] as const)('rejects invalid UUID %s', (field) => {
    const envelope = inputEnvelope('settled', { [field]: 'not-a-uuid' });
    expect(validValidationInputs(envelope)).toBe(false);
  });
  it.each([undefined, null, {}, [], { payload: null }, { payload: {} }])('refuses unknown envelope %j', (value) => {
    expect(validValidationInputs(value)).toBe(false);
  });
  it('allows reserved inputs before physical identities exist', () => {
    expect(validValidationInputs(inputEnvelope('reserved', { directoryIdentity: null, inputIdentity: null }))).toBe(
      true,
    );
  });
  it('accepts a separately bound recovery destination', () => {
    expect(
      validValidationInputs(
        inputEnvelope('settled', {
          stage: 'recovery-destination',
          copyGeneration: randomUUID(),
          validationPath: '/private/.icloud-recovery/copy',
        }),
      ),
    ).toBe(true);
  });
  it('binds owner and purpose scopes without claiming shape validation authenticates', () => {
    const envelope = inputEnvelope('disposed');
    const current = envelope.payload.current;
    expect(authentic(validationInputScope(current.payload), current.payload, current.seal)).toBe(true);
    expect(
      authentic(validationInputScope({ ...current.payload, ownerId: randomUUID() }), current.payload, current.seal),
    ).toBe(false);
    expect(authentic(privateCopyScope(current.payload as never), current.payload, current.seal)).toBe(false);
    expect(authentic(validationInputsScope(envelope.payload), envelope.payload, envelope.seal)).toBe(true);
    expect(
      authentic(validationInputsScope({ ...envelope.payload, highWater: '2' }), envelope.payload, envelope.seal),
    ).toBe(false);
  });
  it('keeps twelve generations bounded with no attempt limit or numeric rounding', () => {
    let previous = null as ValidationInputEnvelope['payload']['previousDisposed'];
    let sequence = '18446744073709551615';
    for (let count = 0; count < 12; count++) {
      sequence = nextValidationInputSequence(sequence);
      const envelope = inputEnvelope('disposed', { sequence });
      envelope.payload.previousDisposed = previous;
      expect(validValidationInputs(envelope)).toBe(true);
      expect(validationInputsDisposed(envelope)).toBe(true);
      previous = envelope.payload.current;
      expect(Object.keys(envelope.payload).sort()).toEqual([
        'current',
        'highWater',
        'ownerId',
        'previousDisposed',
        'purpose',
        'resourceId',
        'version',
      ]);
    }
    expect(sequence).toBe('18446744073709551627');
  });
  it('preserves existing private copy and work shapes and scopes', () => {
    const generation = randomUUID();
    const ownership = {
      ownerId,
      resourceId,
      auditRequestId,
      operationId,
      operationClaimToken: randomUUID(),
      resourceLeaseToken: randomUUID(),
      itemClaimId: randomUUID(),
    };
    const copy = {
      ...ownership,
      version: 1 as const,
      purpose: 'scheduled-weekly-private-copy' as const,
      connectionId,
      sourceAssetId: 'canonical-item',
      generation,
      stagingPath: '/private/staging',
      promotedPath: '/private/.icloud-recovery/copy',
      temporaryPath: `/private/.icloud-recovery/copy.${generation}.partial`,
      reservedCopyBytes: 10,
      identity: { dev: 1, ino: 2, uid: 501, size: 10 },
      promoted: false,
      settled: true,
      disposed: false,
    };
    const work = {
      ...ownership,
      version: 1 as const,
      purpose: 'scheduled-weekly-private-work' as const,
      generation,
      copyGeneration: null,
      pending: [],
      settled: true,
    };
    expect(validPrivateCopy({ payload: copy, seal: 'old', pending: [] })).toBe(true);
    expect(validPrivateWork({ payload: work, seal: 'old' })).toBe(true);
    expect(privateCopyScope(copy)).toBe(`icloud-scheduled-private-copy:v1:${ownerId}:${resourceId}:${generation}`);
    expect(privateWorkScope(work)).toBe(`icloud-scheduled-private-work:v1:${ownerId}:${resourceId}:${generation}`);
  });
});
