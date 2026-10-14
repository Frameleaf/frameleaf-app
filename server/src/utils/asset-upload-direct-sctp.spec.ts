import { RTCPeerConnection } from 'werift';

describe('pinned werift inbound reassembly bounds', () => {
  it.each(['window', 'gaps', 'fragments'])('closes before buffering a malicious %s overflow', async (overflow) => {
    const peer = new RTCPeerConnection({ iceServers: [] });
    peer.createDataChannel('fixture');
    const sctp = peer.sctpTransport!.sctp;
    const internal = sctp as unknown as {
      advertisedRwnd: number;
      sackMisOrdered: Set<number>;
      inboundStreams: Record<number, { reassembly: unknown[] }>;
      receiveDataChunk: (chunk: unknown) => void;
    };
    const stop = vi.spyOn(sctp, 'stop').mockResolvedValue(undefined);
    switch (overflow) {
      case 'window': {
        internal.advertisedRwnd = 1;
        break;
      }
      case 'gaps': {
        internal.sackMisOrdered = new Set(Array.from({ length: 4096 }, (_, index) => index));
        break;
      }
      case 'fragments': {
        internal.inboundStreams[0] = { reassembly: Array.from({ length: 4096 }, () => ({})) };
        // No default
        break;
      }
    }
    internal.receiveDataChunk({ tsn: 1, streamId: 1, userData: Buffer.alloc(2), flags: 0 });
    expect(stop).toHaveBeenCalledOnce();
    expect(internal.inboundStreams[1]).toBeUndefined();
    stop.mockRestore();
    await peer.close();
  });
});
