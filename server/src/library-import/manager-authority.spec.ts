import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import {
  type ImportSourceAuthority,
  replyImportPreparationAuthority,
  replyImportSourceAuthority,
} from '#library-import-transfer/import-source-authority';
import {
  requestImportPreparationAuthority,
  requestImportSourceAuthority,
} from 'src/library-import/manager-authority.js';

const fixture = () => {
  const input = new PassThrough(),
    output = new PassThrough();
  const authority: ImportSourceAuthority = {
    installation: 'a'.repeat(12),
    binding: {
      operationId: randomUUID(),
      manifestSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      source: {
        kind: 'photoprism',
        version: 'synthetic',
        identity: 'fixture',
        revision: 'frozen',
        schemaSha256: 'c'.repeat(64),
      },
    },
    destinationId: randomUUID(),
    verify: vi.fn().mockResolvedValue(undefined),
  };
  return { input, output, authority };
};

afterEach(() => vi.useRealTimers());

it('requests a fresh source check on each boundary and accepts fragmented matching approvals', async () => {
  const { input, output, authority } = fixture();
  const nonces = new Set<string>();
  output.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trimEnd();
    const { nonce } = JSON.parse(line);
    expect(nonces.has(nonce)).toBe(false);
    nonces.add(nonce);
    void replyImportSourceAuthority(line, 'verify', authority).then((response) => {
      input.write(response!.slice(0, 10));
      input.write(response!.slice(10));
    });
  });
  for (let index = 0; index < 2; index++) {
    await requestImportSourceAuthority('verify', authority, input, output);
    expect(input.listenerCount('data')).toBe(0);
    expect(input.listenerCount('error')).toBe(0);
  }
  expect(authority.verify).toHaveBeenCalledTimes(2);
  expect(nonces.size).toBe(2);
});

it('refuses a stale approval for another challenge', async () => {
  const { input, output, authority } = fixture();
  output.on('data', (chunk: Buffer) => {
    void replyImportSourceAuthority(chunk.toString('utf8').trimEnd(), 'run', authority).then((response) => {
      const stale = JSON.parse(response!);
      stale.nonce = randomUUID();
      input.write(JSON.stringify(stale) + '\n');
    });
  });
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
});

it('refuses a lost Manager connection while waiting', async () => {
  const { input, output, authority } = fixture();
  output.on('data', () => input.end());
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
});

it('refuses an in-flight input close without waiting for the authority timeout', async () => {
  vi.useFakeTimers();
  const { input, output, authority } = fixture();
  output.on('data', () => input.destroy());
  let result = 'waiting';
  const request = requestImportSourceAuthority('run', authority, input, output)
    .then(() => {
      result = 'allowed';
    })
    .catch(() => {
      result = 'refused';
    });
  await vi.advanceTimersByTimeAsync(1);
  try {
    expect(result).toBe('refused');
    expect(input.listenerCount('close')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await vi.runAllTimersAsync();
    await request;
  }
});

it.each(['input', 'output'] as const)('refuses an already destroyed %s without sending a challenge', async (side) => {
  const { input, output, authority } = fixture();
  const sent = vi.fn();
  output.on('data', sent);
  ({ input, output })[side].destroy();
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
  expect(sent).not.toHaveBeenCalled();
  expect(input.listenerCount('data')).toBe(0);
});

it('bounds an unterminated response before attempting JSON parsing', async () => {
  const { input, output, authority } = fixture();
  output.on('data', () => input.write('x'.repeat(65_537)));
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
});

it('cannot wait indefinitely for source-fence verification', async () => {
  vi.useFakeTimers();
  const { input, output, authority } = fixture();
  const checked = expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
  await vi.advanceTimersByTimeAsync(120_001);
  await checked;
  expect(input.listenerCount('data')).toBe(0);
});

it('refuses malformed review identity before sending a challenge', async () => {
  const { input, output, authority } = fixture();
  const sent = vi.fn();
  output.on('data', sent);
  authority.binding.manifestSha256 = 'unsealed';
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_invalid',
  );
  expect(sent).not.toHaveBeenCalled();
});

it('refuses input errors without exposing the channel error', async () => {
  const { input, output, authority } = fixture();
  output.on('data', () => input.emit('error', new Error('synthetic-private-input')));
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
});

it('refuses output write failure without leaving an unhandled stream error', async () => {
  const { input, authority } = fixture();
  const output = new Writable({
    write(_chunk, _encoding, done) {
      done(new Error('synthetic-private-output'));
    },
  });
  await expect(requestImportSourceAuthority('run', authority, input, output)).rejects.toThrow(
    'import_source_authority_unavailable',
  );
});

it('checks the reviewed preparation input through the same bounded Manager pipe', async () => {
  const { input, output, authority } = fixture();
  const seal = {
    operationId: authority.binding.operationId,
    destinationId: authority.destinationId,
    source: authority.binding.source,
    preparationSha256: 'd'.repeat(64),
  };
  output.on('data', (chunk: Buffer) => {
    const line = chunk.toString('utf8').trimEnd();
    void replyImportPreparationAuthority(line, { ...seal, verify: authority.verify }).then((response) => {
      input.write(response!);
    });
  });
  await requestImportPreparationAuthority(seal, input, output);
  expect(authority.verify).toHaveBeenCalledOnce();
  expect(input.listenerCount('data')).toBe(0);
});
