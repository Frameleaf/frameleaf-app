import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { ICloudTransportRepository } from 'src/repositories/icloud-transport.repository.js';

// Fixtures exercise actual JSON parsing and stream disposal; only the internal HTTPS send seam is replaced.
describe(ICloudTransportRepository.name, () => {
  let sut: ICloudTransportRepository;
  const session = { version: 1, state: 'connected' };
  const respond = (value: unknown, headers: Record<string, string> = {}) => {
    const stream = Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { headers });
    vi.spyOn(sut as unknown as { send: () => Promise<IncomingMessage> }, 'send').mockResolvedValue(
      stream as unknown as IncomingMessage,
    );
    return stream;
  };
  beforeEach(() => {
    sut = new ICloudTransportRepository();
  });
  it.each(['connected', 'awaiting-2fa', 'awaiting-device-approval', 'reauthentication-required'])(
    'accepts supported auth state %s',
    async (state) => {
      respond({ version: 1, state, session });
      expect(await sut.authenticate({ action: 'validate' })).toEqual({ state, session });
    },
  );
  it.each([
    { version: 2, state: 'connected', session },
    { state: 'connected', session },
    { version: 1, state: 'administrator', session },
    { version: 1, state: 'connected', session: null },
    { version: 1, state: 'connected', session: { version: 2 } },
    { version: 1, state: 'connected', session: {} },
  ])('rejects unsupported auth envelope %j', async (value) => {
    respond(value);
    await expect(sut.authenticate({ action: 'validate' })).rejects.toMatchObject({ code: 'icloud_response_invalid' });
  });
  it('accepts protocol v1 inventory with session v1', async () => {
    const page = { version: 1, session, records: [], complete: true, capabilities: {} };
    respond(page);
    expect(await sut.inventory({ session, kind: 'assets' })).toEqual(page);
  });
  it.each([
    { version: 2, session },
    { session },
    { version: 1 },
    { version: 1, session: null },
    { version: 1, session: { version: 2 } },
    { version: 1, session: {} },
  ])('rejects unsupported inventory envelope %j', async (envelope) => {
    respond({ ...envelope, records: [], complete: true, capabilities: {} });
    await expect(sut.inventory({ session, kind: 'assets' })).rejects.toMatchObject({ code: 'icloud_response_invalid' });
  });
  it.each([null, {}, { version: 2 }])('destroys download stream with unsupported session %j', async (value) => {
    const stream = respond('original bytes', {
      'x-icloud-session': Buffer.from(JSON.stringify(value)).toString('base64url'),
      'x-icloud-resource-fingerprint': 'fingerprint',
      'x-icloud-resource-size': '14',
    });
    await expect(
      sut.download({ session, library: { scope: 'private' } as never, recordId: 'asset', resourceKey: 'original' }),
    ).rejects.toMatchObject({ code: 'icloud_session_invalid' });
    expect(stream.destroyed).toBe(true);
  });
  it('accepts a download session v1 and retains the readable body', async () => {
    const stream = respond('original bytes', {
      'x-icloud-session': Buffer.from(JSON.stringify(session)).toString('base64url'),
      'x-icloud-resource-fingerprint': 'fingerprint',
      'x-icloud-resource-size': '14',
    });
    expect(
      await sut.download({
        session,
        library: { scope: 'private' } as never,
        recordId: 'asset',
        resourceKey: 'original',
      }),
    ).toMatchObject({ session, stream, fingerprint: 'fingerprint', size: 14 });
    expect(stream.destroyed).toBe(false);
    stream.destroy();
  });
});
