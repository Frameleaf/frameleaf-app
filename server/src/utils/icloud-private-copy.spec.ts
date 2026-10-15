import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import * as files from 'node:fs/promises';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ValidationInputEnvelope,
  ValidationInputPayload,
  ValidationInputState,
  nextValidationInputSequence,
  privateCopyIdentity,
  privateCopyScope,
  privateWorkScope,
  unlinkOwnedValidationInput,
  validPrivateCopy,
  validPrivateWork,
  validValidationInputs,
  validationInputScope,
  validationInputsDisposed,
  validationInputsScope,
} from 'src/utils/icloud-private-copy.js';
import { canonicalJson } from 'src/utils/studio-project.js';

vi.mock('node:fs/promises', { spy: true });

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
  it.each([
    ['recovery-destination', null, '/library/upload/owner/candidate.jpg', false],
    ['existing-destination', null, '/library/upload/owner/candidate.jpg', true],
    ['existing-destination', randomUUID(), '/library/upload/owner/candidate.jpg', false],
  ] as const)('binds %s with copy generation %s at %s: %s', (stage, copyGeneration, validationPath, valid) => {
    expect(validValidationInputs(inputEnvelope('settled', { stage, copyGeneration, validationPath }))).toBe(valid);
  });
  it('refuses an existing destination that is the staged source', () => {
    const envelope = inputEnvelope('settled', { stage: 'existing-destination', copyGeneration: null });
    const payload = envelope.payload.current.payload;
    expect(
      validValidationInputs(
        inputEnvelope('settled', {
          stage: 'existing-destination',
          copyGeneration: null,
          validationPath: payload.fresh.payload.path,
        }),
      ),
    ).toBe(false);
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

describe('owned validation input disposal', () => {
  const roots: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
    roots.length = 0;
  });
  async function ownedInput() {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fl296-input-owned-')));
    roots.push(root);
    const pathNonce = randomUUID();
    const directoryPath = join(root, `.validation-${pathNonce}`);
    const inputPath = join(directoryPath, 'input');
    await mkdir(directoryPath, { mode: 0o700 });
    await writeFile(inputPath, Buffer.alloc(10), { mode: 0o600, flag: 'wx' });
    return inputEnvelope('settled', {
      pathNonce,
      stagingDirectory: root,
      directoryPath,
      inputPath,
      validationPath: join(root, 'complete'),
      directoryIdentity: privateCopyIdentity(await stat(directoryPath)),
      inputIdentity: privateCopyIdentity(await stat(inputPath)),
    }).payload.current.payload;
  }
  it('removes only the exact input and retains the owned parent for transaction retry', async () => {
    const input = await ownedInput();
    await unlinkOwnedValidationInput(input);
    expect(await readdir(input.directoryPath)).toEqual([]);
    expect(privateCopyIdentity(await stat(input.directoryPath))).toMatchObject({
      dev: input.directoryIdentity!.dev,
      ino: input.directoryIdentity!.ino,
      uid: input.directoryIdentity!.uid,
    });
    await unlinkOwnedValidationInput(input);
  });
  it('opens NOFOLLOW and refuses a failed handle close before unlink', async () => {
    const input = await ownedInput();
    const originalOpen = files.open;
    const opened = vi.spyOn(files, 'open').mockImplementationOnce(async (...args) => {
      const handle = await originalOpen(...args);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, 'close').mockImplementationOnce(async () => {
        await close();
        throw new Error('fixture_close_failed');
      });
      return handle;
    });
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow('fixture_close_failed');
    expect(opened).toHaveBeenCalledWith(input.inputPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    expect(await readFile(input.inputPath)).toEqual(Buffer.alloc(10));
  });
  it('retains the input after failed unlink and permits an exact retry', async () => {
    const input = await ownedInput();
    const failure = vi.spyOn(files, 'unlink').mockRejectedValueOnce(new Error('fixture_unlink_failed'));
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow('fixture_unlink_failed');
    expect(await readFile(input.inputPath)).toEqual(Buffer.alloc(10));
    failure.mockRestore();
    await unlinkOwnedValidationInput(input);
    expect(await readdir(input.directoryPath)).toEqual([]);
  });
  it('retains the exact input when an unexpected directory entry exists', async () => {
    const input = await ownedInput();
    await writeFile(join(input.directoryPath, 'foreign'), 'retain');
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow();
    expect(await readFile(input.inputPath)).toEqual(Buffer.alloc(10));
  });
  it('refuses missing input when its persisted parent was replaced', async () => {
    const input = await ownedInput();
    await rename(input.directoryPath, `${input.directoryPath}-old`);
    await mkdir(input.directoryPath, { mode: 0o700 });
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow();
    expect(await readFile(`${input.directoryPath}-old/input`)).toEqual(Buffer.alloc(10));
  });
  it('refuses missing parent instead of inferring physical disposal', async () => {
    const input = await ownedInput();
    await unlink(input.inputPath);
    await rmdir(input.directoryPath);
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow();
  });
  it.each([
    'file-mode',
    'parent-mode',
    'file-inode',
    'file-size',
    'file-symlink',
    'parent-symlink',
    'identity',
    'pending',
  ] as const)('retains custody on %s mutation', async (kind) => {
    const input = await ownedInput();
    switch (kind) {
      case 'file-mode': {
        await chmod(input.inputPath, 0o644);
        break;
      }
      case 'parent-mode': {
        await chmod(input.directoryPath, 0o755);
        break;
      }
      case 'file-inode': {
        await rename(input.inputPath, join(input.stagingDirectory, 'old'));
        await writeFile(input.inputPath, Buffer.alloc(10), { mode: 0o600 });

        break;
      }
      case 'file-size': {
        await writeFile(input.inputPath, Buffer.alloc(9));
        break;
      }
      case 'file-symlink': {
        await rename(input.inputPath, join(input.stagingDirectory, 'old'));
        await symlink(join(input.stagingDirectory, 'old'), input.inputPath);

        break;
      }
      case 'parent-symlink': {
        await rename(input.directoryPath, `${input.directoryPath}-old`);
        await symlink(`${input.directoryPath}-old`, input.directoryPath);

        break;
      }
      case 'identity': {
        input.directoryIdentity = null;
        break;
      }
      case 'pending': {
        input.pending = [randomUUID()];
        // No default
        break;
      }
    }
    await expect(unlinkOwnedValidationInput(input)).rejects.toThrow();
    expect(await lstat(input.inputPath)).toBeDefined();
  });
});
