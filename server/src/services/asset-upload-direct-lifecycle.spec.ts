import { setImmediate } from 'node:timers/promises';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetUploadDirectService } from 'src/services/asset-upload-direct.service.js';

const auth = { user: { id: 'owner' } } as AuthDto;
const resource = { maxAppendSize: 1024 };
const offer = {
  version: 1,
  sdp: [
    'v=0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'a=ice-ufrag:test',
    'a=ice-pwd:abcdefghijklmnopqrstuv',
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => 'AA').join(':')}`,
    'a=setup:actpass',
    'a=sctp-port:5000',
    'a=end-of-candidates',
  ].join('\r\n'),
};
const setup = () => {
  const authenticate = vi.fn().mockResolvedValue(auth);
  const head = vi.fn().mockResolvedValue(resource);
  const admission = {
    claimDirectUploadPeer: vi.fn().mockResolvedValue(true),
    releaseDirectUploadPeer: vi.fn().mockResolvedValue(undefined),
  };
  const service = new AssetUploadDirectService({ head } as never, { authenticate } as never, admission as never);
  const allocate = vi.spyOn(service as unknown as { createPeer: () => never }, 'createPeer').mockImplementation(() => {
    throw new Error('Peer allocation is forbidden after shutdown');
  });
  return { service, authenticate, head, admission, allocate };
};

it.each(['auth', 'head', 'admission'] as const)(
  'drains an in-flight %s negotiation before shutdown completes',
  async (phase) => {
    const { service, authenticate, head, admission, allocate } = setup();
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const wait = async () => {
      entered.resolve();
      await resume.promise;
    };
    if (phase === 'auth')
      authenticate.mockImplementationOnce(async () => {
        await wait();
        return auth;
      });
    else if (phase === 'head')
      head.mockImplementationOnce(async () => {
        await wait();
        return resource;
      });
    else {
      admission.claimDirectUploadPeer.mockImplementationOnce(async () => {
        await wait();
        return true;
      });
      admission.releaseDirectUploadPeer.mockReturnValueOnce(released.promise);
    }
    const negotiating = service.negotiate(auth, 'upload', offer, {});
    const refused = expect(negotiating).rejects.toMatchObject({ status: 503 });
    await entered.promise;
    let finished = false;
    const shutdown = service.onShutdown().then(() => {
      finished = true;
    });
    try {
      await setImmediate();
      expect(finished).toBe(false);
      resume.resolve();
      if (phase === 'admission') {
        await vi.waitFor(() => expect(admission.releaseDirectUploadPeer).toHaveBeenCalledOnce());
        await setImmediate();
        expect(finished).toBe(false);
      }
      released.resolve();
      await Promise.all([shutdown, refused]);
      expect(allocate).not.toHaveBeenCalled();
      if (phase !== 'admission') expect(admission.claimDirectUploadPeer).not.toHaveBeenCalled();
      else expect(admission.releaseDirectUploadPeer).toHaveBeenCalledWith(expect.any(String), 'owner');
    } finally {
      resume.resolve();
      released.resolve();
      await Promise.allSettled([shutdown, refused]);
    }
  },
);

it('refuses a new negotiation after shutdown before authentication or peer allocation', async () => {
  const { service, authenticate, admission, allocate } = setup();
  await service.onShutdown();
  await expect(service.negotiate(auth, 'upload', offer, {})).rejects.toMatchObject({ status: 503 });
  expect(authenticate).not.toHaveBeenCalled();
  expect(admission.claimDirectUploadPeer).not.toHaveBeenCalled();
  expect(allocate).not.toHaveBeenCalled();
});
