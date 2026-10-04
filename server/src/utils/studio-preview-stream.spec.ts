import { MediaOperationStatus } from 'src/enum.js';
import {
  STREAM_IDLE_MS,
  STREAM_MAX_DURATION_MS,
  STREAM_MAX_SDP_BYTES,
  capVideoBitrate,
  isValidAnswerSdp,
  isValidOfferSdp,
  readStreamSignal,
  streamBounds,
  streamCloseReason,
  streamState,
  streamWorkerLost,
} from 'src/utils/studio-preview-stream.js';

const offer = [
  'v=0',
  'o=- 1 2 IN IP4 127.0.0.1',
  's=-',
  't=0 0',
  'a=group:BUNDLE 0 1',
  'm=video 9 UDP/TLS/RTP/SAVPF 96',
  'c=IN IP4 0.0.0.0',
  'b=AS:50000',
  'a=mid:0',
  'a=sendonly',
  'a=rtpmap:96 H264/90000',
  'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
  'c=IN IP4 0.0.0.0',
  'a=mid:1',
  '',
].join('\r\n');

const answer = offer.replace('a=sendonly', 'a=recvonly').replace('b=AS:50000\r\n', '');

describe('studio preview stream rules', () => {
  describe('streamBounds', () => {
    it('bounds bitrate, frame rate and duration by quality', () => {
      expect(streamBounds('draft', 640, 360)).toEqual({
        maxBitrateKbps: 1500,
        maxWidth: 640,
        maxHeight: 360,
        maxFrameRate: 30,
        maxDurationSeconds: STREAM_MAX_DURATION_MS / 1000,
      });
      expect(streamBounds('full', 7680, 4320)).toMatchObject({
        maxBitrateKbps: 12_000,
        maxWidth: 3840,
        maxHeight: 2160,
      });
    });

    it('never streams larger than the viewport or the quality cap', () => {
      expect(streamBounds('standard', 4000, 3000)).toMatchObject({ maxWidth: 1920, maxHeight: 1080 });
      expect(streamBounds('standard', 480, 270)).toMatchObject({ maxWidth: 480, maxHeight: 270 });
    });
  });

  describe('capVideoBitrate', () => {
    it('replaces any bandwidth line in every video section with the server bound', () => {
      const capped = capVideoBitrate(offer, 6000);
      expect(capped).toContain('c=IN IP4 0.0.0.0\r\nb=AS:6000\r\nb=TIAS:6000000\r\na=mid:0');
      expect(capped).not.toContain('b=AS:50000');
      // The data channel section is left alone.
      expect(capped.split('m=application', 2)[1]).not.toContain('b=AS');
    });

    it('adds the bound when the section had none', () => {
      expect(capVideoBitrate(answer, 1500)).toContain(
        'm=video 9 UDP/TLS/RTP/SAVPF 96\r\nc=IN IP4 0.0.0.0\r\nb=AS:1500',
      );
    });
  });

  describe('sdp validation', () => {
    it('accepts a send-only video offer with a data channel', () => {
      expect(isValidOfferSdp(offer)).toBe(true);
    });

    it('refuses an offer that would receive from the browser', () => {
      expect(isValidOfferSdp(offer.replace('a=sendonly', 'a=sendrecv'))).toBe(false);
      expect(isValidOfferSdp(offer.replace('m=video', 'm=audio'))).toBe(false);
    });

    it('refuses an offer without the control channel', () => {
      expect(isValidOfferSdp(offer.split('m=application', 1)[0])).toBe(false);
    });

    it('accepts a receive-only answer and refuses one that sends', () => {
      expect(isValidAnswerSdp(answer)).toBe(true);
      expect(isValidAnswerSdp(answer.replace('a=recvonly', 'a=inactive'))).toBe(true);
      expect(isValidAnswerSdp(offer)).toBe(false);
      expect(isValidAnswerSdp(answer.replace('m=video', 'm=audio'))).toBe(false);
    });

    it('refuses an answer without exactly one control channel section', () => {
      expect(isValidAnswerSdp(answer.split('m=application', 1)[0])).toBe(false);
      expect(isValidAnswerSdp(`${answer}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`)).toBe(false);
    });

    it('refuses oversized or non-SDP text', () => {
      expect(isValidAnswerSdp('x'.repeat(STREAM_MAX_SDP_BYTES + 1))).toBe(false);
      expect(isValidOfferSdp('hello')).toBe(false);
    });
  });

  describe('readStreamSignal', () => {
    it('reads what it wrote and ignores anything malformed', () => {
      expect(readStreamSignal(null)).toEqual({
        negotiation: 0,
        offer: null,
        answer: null,
        keepaliveAt: null,
        closeReason: null,
      });
      expect(
        readStreamSignal({
          negotiation: 2,
          offer: { sdp: 'o', negotiation: 2, attempt: 1 },
          answer: { sdp: 'a', negotiation: 1 },
          keepaliveAt: '2026-09-27T00:00:00.000Z',
          closeReason: 'revoked',
        }),
      ).toEqual({
        negotiation: 2,
        offer: { sdp: 'o', negotiation: 2, attempt: 1 },
        // An answer to an earlier negotiation answers nothing now.
        answer: null,
        keepaliveAt: '2026-09-27T00:00:00.000Z',
        closeReason: 'revoked',
      });
      expect(readStreamSignal({ negotiation: 'x', closeReason: 'nonsense' })).toMatchObject({
        negotiation: 0,
        closeReason: null,
      });
    });
  });

  describe('streamState', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const base = {
      status: MediaOperationStatus.Rendering,
      attempt: 1,
      claimExpiresAt: new Date('2026-09-27T12:01:00Z'),
      errorCode: null,
    };

    it('walks queued → negotiating → offered → answered', () => {
      const empty = readStreamSignal(null);
      expect(streamState({ ...base, status: MediaOperationStatus.Queued, attempt: 0 }, empty, now)).toBe('queued');
      expect(streamState(base, empty, now)).toBe('negotiating');
      const offered = readStreamSignal({ negotiation: 0, offer: { sdp: 'o', negotiation: 0, attempt: 1 } });
      expect(streamState(base, offered, now)).toBe('offered');
      const answered = readStreamSignal({
        negotiation: 0,
        offer: { sdp: 'o', negotiation: 0, attempt: 1 },
        answer: { sdp: 'a', negotiation: 0 },
      });
      expect(streamState(base, answered, now)).toBe('answered');
    });

    it('treats an offer from an earlier claim as no offer', () => {
      const offered = readStreamSignal({ negotiation: 0, offer: { sdp: 'o', negotiation: 0, attempt: 1 } });
      expect(streamState({ ...base, attempt: 2 }, offered, now)).toBe('negotiating');
    });

    it('is closed once the operation stops or a cancel was asked for', () => {
      const signal = readStreamSignal(null);
      for (const status of [
        MediaOperationStatus.Cancelling,
        MediaOperationStatus.Cancelled,
        MediaOperationStatus.Failed,
        MediaOperationStatus.Completed,
      ]) {
        expect(streamState({ ...base, status }, signal, now)).toBe('closed');
      }
    });
  });

  describe('streamWorkerLost', () => {
    const now = new Date('2026-09-27T12:00:00Z');

    it('is lost when the lease lapsed or recovery requeued a stream that had been claimed', () => {
      expect(
        streamWorkerLost(
          { status: MediaOperationStatus.Rendering, attempt: 1, claimExpiresAt: new Date('2026-09-27T11:59:00Z') },
          now,
        ),
      ).toBe(true);
      expect(streamWorkerLost({ status: MediaOperationStatus.Queued, attempt: 1, claimExpiresAt: null }, now)).toBe(
        true,
      );
    });

    it('is not lost while the lease holds or before the first claim', () => {
      expect(
        streamWorkerLost(
          { status: MediaOperationStatus.Rendering, attempt: 1, claimExpiresAt: new Date('2026-09-27T12:00:30Z') },
          now,
        ),
      ).toBe(false);
      expect(streamWorkerLost({ status: MediaOperationStatus.Queued, attempt: 0, claimExpiresAt: null }, now)).toBe(
        false,
      );
    });
  });

  describe('streamCloseReason', () => {
    const now = new Date('2026-09-27T12:00:00Z');
    const started = new Date('2026-09-27T11:59:00Z');

    it('closes a stream whose browser stopped keeping it alive', () => {
      const signal = readStreamSignal({ keepaliveAt: new Date(now.getTime() - STREAM_IDLE_MS - 1).toISOString() });
      expect(streamCloseReason({ createdAt: started, signal, now })).toBe('expired');
    });

    it('closes a stream that reached its bound', () => {
      const signal = readStreamSignal({ keepaliveAt: now.toISOString() });
      expect(streamCloseReason({ createdAt: new Date(now.getTime() - STREAM_MAX_DURATION_MS - 1), signal, now })).toBe(
        'expired',
      );
    });

    it('keeps a live stream open', () => {
      const signal = readStreamSignal({ keepaliveAt: now.toISOString() });
      expect(streamCloseReason({ createdAt: started, signal, now })).toBeNull();
    });
  });
});
