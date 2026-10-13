import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { RTCPeerConnection } from 'werift';
import type { Readable } from 'node:stream';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { Permission } from 'src/enum.js';
import { AssetUploadDirectService } from 'src/services/asset-upload-direct.service.js';
import { DIRECT_UPLOAD_CHANNEL, DIRECT_UPLOAD_LIMITS } from 'src/utils/asset-upload-direct.js';

describe('direct upload receiver with real ICE/DTLS/SCTP peers', () => {
  const auth = { user: { id: randomUUID() } } as AuthDto;
  const id = randomUUID();
  let service: AssetUploadDirectService;
  let peers: RTCPeerConnection[];
  let row: { offset: number; maxAppendSize: number; state: string; ingested: boolean };
  let liveAuth: { authenticate: ReturnType<typeof vi.fn> };
  let uploads: { head: ReturnType<typeof vi.fn>; append: ReturnType<typeof vi.fn> };
  let bytes: Buffer;
  beforeEach(() => {
    peers = [];
    bytes = Buffer.alloc(0);
    row = { offset: 0, maxAppendSize: DIRECT_UPLOAD_LIMITS.appendBytes, state: 'receiving', ingested: false };
    liveAuth = { authenticate: vi.fn().mockResolvedValue(auth) };
    uploads = {
      head: vi.fn().mockImplementation(() => Promise.resolve(row)),
      append: vi.fn().mockImplementation(async (_auth, _id, headers, input: Readable) => {
        for await (const part of input) bytes = Buffer.concat([bytes, part]);
        row = { ...row, offset: bytes.length };
        return { resource: row };
      }),
    };
    service = new AssetUploadDirectService(
      uploads as never,
      liveAuth as never,
      {
        claimDirectUploadPeer: vi.fn().mockResolvedValue(true),
        releaseDirectUploadPeer: vi.fn().mockResolvedValue(undefined),
      } as never,
    );
    vi.spyOn(service as unknown as { createPeer: () => RTCPeerConnection }, 'createPeer').mockImplementation(() => {
      const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false, maxMessageSize: 65_536 });
      peers.push(peer);
      return peer;
    });
  });
  afterEach(async () => {
    await service.onShutdown();
    await Promise.all(peers.map((peer) => peer.close()));
    vi.restoreAllMocks();
  });
  const offer = async (label = DIRECT_UPLOAD_CHANNEL, ordered = true) => {
    const peer = new RTCPeerConnection({ iceServers: [], iceUseIpv6: false, maxMessageSize: 65_536 });
    peers.push(peer);
    const channel = peer.createDataChannel(label, { ordered });
    await peer.setLocalDescription(await peer.createOffer());
    return { peer, channel, body: { version: 1, sdp: peer.localDescription!.sdp } };
  };
  const connect = async (label = DIRECT_UPLOAD_CHANNEL, ordered = true) => {
    const client = await offer(label, ordered);
    const response = await service.negotiate(auth, id, client.body, { authorization: 'Bearer synthetic-token' });
    const opened = client.channel.stateChange.watch((state) => state === 'open', 10_000);
    await client.peer.setRemoteDescription({ type: 'answer', sdp: response.sdp });
    await opened;
    return client;
  };
  const append = (length = 4, complete = false) => ({
    version: 1,
    type: 'append',
    requestId: randomUUID(),
    offset: 0,
    length,
    complete,
  });
  it('reauthenticates WAN upload access, transfers real encrypted frames and returns durable native offset', async () => {
    const { channel } = await connect();
    const control = append();
    const result = channel.onMessage.asPromise(10_000);
    channel.send(JSON.stringify(control));
    channel.send(Buffer.from('abcd'));
    const [reply] = await result;
    expect(JSON.parse(String(reply))).toEqual({
      version: 1,
      type: 'ack',
      requestId: control.requestId,
      status: 204,
      offset: 4,
      complete: false,
    });
    expect(bytes.toString()).toBe('abcd');
    expect(uploads.append).toHaveBeenCalledTimes(1);
    expect(liveAuth.authenticate).toHaveBeenCalledTimes(3);
    expect(liveAuth.authenticate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ via: 'wan', permission: Permission.AssetUpload }),
      }),
    );
  }, 20_000);
  it('refuses an unowned resource before allocating a peer', async () => {
    const client = await offer();
    uploads.head.mockRejectedValueOnce(new NotFoundException());
    await expect(service.negotiate(auth, id, client.body, {})).rejects.toThrow(NotFoundException);
    expect(peers).toHaveLength(1);
  });
  it.each([new ForbiddenException(), { user: { id: randomUUID() } }])(
    'blocks live revocation or changed owner before append',
    async (changed) => {
      const { channel } = await connect();
      if (changed instanceof Error) liveAuth.authenticate.mockRejectedValue(changed);
      else liveAuth.authenticate.mockResolvedValue(changed);
      const result = channel.onMessage.asPromise(10_000);
      const control = append();
      channel.send(JSON.stringify(control));
      channel.send(Buffer.from('abcd'));
      const [reply] = await result;
      expect(JSON.parse(String(reply))).toEqual({
        version: 1,
        type: 'error',
        requestId: control.requestId,
        status: 403,
      });
      expect(uploads.append).not.toHaveBeenCalled();
    },
    20_000,
  );
  it('holds only two peers per owner and releases capacity on shutdown', async () => {
    const client = await offer();
    await service.negotiate(auth, id, client.body, {});
    await service.negotiate(auth, id, client.body, {});
    await expect(service.negotiate(auth, id, client.body, {})).rejects.toMatchObject({ status: 429 });
    expect(peers).toHaveLength(3);
    await service.onShutdown();
    expect((service as unknown as { peers: Map<unknown, unknown> }).peers.size).toBe(0);
  }, 20_000);
  it('rejects overlapping controls without committing bytes', async () => {
    const { channel } = await connect();
    const control = append();
    const result = channel.onMessage.asPromise(10_000);
    channel.send(JSON.stringify(control));
    channel.send(JSON.stringify(append()));
    const [reply] = await result;
    expect(JSON.parse(String(reply))).toMatchObject({ type: 'error', status: 400 });
    expect(uploads.append).not.toHaveBeenCalled();
  }, 20_000);
  it('closing a partial frame sequence leaves the native offset unchanged', async () => {
    const { channel, peer } = await connect();
    channel.send(JSON.stringify(append(8)));
    channel.send(Buffer.from('abcd'));
    await peer.close();
    expect(uploads.append).not.toHaveBeenCalled();
    expect(row.offset).toBe(0);
  }, 20_000);

  it('closes on the idle deadline and clears captured credential references', async () => {
    const client = await offer();
    const scheduled = vi.spyOn(globalThis, 'setTimeout');
    await service.negotiate(auth, id, client.body, { authorization: 'Bearer synthetic-token' });
    const deadline = scheduled.mock.calls.find(([, ms]) => ms === DIRECT_UPLOAD_LIMITS.idleMs)![0];
    deadline();
    const sessions = (service as unknown as { peers: Map<unknown, unknown> }).peers;
    expect(sessions.size).toBe(0);
    const request = liveAuth.authenticate.mock.calls[0][0];
    expect(request.headers).toEqual({});
    expect(request.queryParams).toEqual({});
  });

  it('rejects a stalled negotiation when shutdown closes the peer', async () => {
    const client = await offer();
    const peer = new RTCPeerConnection({ iceServers: [] });
    peers.push(peer);
    vi.spyOn(peer, 'setRemoteDescription').mockReturnValue(new Promise(() => {}));
    const started = Promise.withResolvers<void>();
    vi.spyOn(service as unknown as { createPeer: () => RTCPeerConnection }, 'createPeer').mockImplementation(() => {
      started.resolve();
      return peer;
    });
    const negotiation = service.negotiate(auth, id, client.body, {});
    const refusal = expect(negotiation).rejects.toMatchObject({ status: 503 });
    await started.promise;
    await Promise.resolve();
    await service.onShutdown();
    await refusal;
  });
});
