import { randomUUID } from 'node:crypto';
import { parseDirectAppend, validateDirectOffer } from 'src/utils/asset-upload-direct.js';

describe('direct upload protocol', () => {
  const append = { version: 1, type: 'append', requestId: randomUUID(), offset: 0, length: 4, complete: false };
  it('accepts bounded append and native empty completion', () => {
    expect(parseDirectAppend(JSON.stringify(append), 4)).toEqual(append);
    expect(parseDirectAppend(JSON.stringify({ ...append, length: 0, complete: true }), 4).length).toBe(0);
  });
  it.each([
    { version: 2 },
    { type: 'get' },
    { requestId: 'not-a-uuid' },
    { offset: -1 },
    { offset: Number.MAX_SAFE_INTEGER + 1 },
    { length: 5 },
    { length: 0 },
    { complete: 'true' },
    { url: 'https://example.com' },
  ])('rejects malformed or unsupported controls: %j', (change) => {
    expect(() => parseDirectAppend(JSON.stringify({ ...append, ...change }), 4)).toThrow();
  });
  it('rejects oversized controls before parsing', () => {
    expect(() => parseDirectAppend(' '.repeat(1025), 4)).toThrow();
  });
  const sdp = [
    'v=0',
    'o=- 1 1 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    'm=application 9 UDP/DTLS/SCTP webrtc-datachannel',
    'c=IN IP4 0.0.0.0',
    'a=ice-ufrag:test',
    'a=ice-pwd:abcdefghijklmnopqrstuv',
    `a=fingerprint:sha-256 ${Array.from({ length: 32 }, () => 'AA').join(':')}`,
    'a=setup:actpass',
    'a=sctp-port:5000',
    'a=end-of-candidates',
    '',
  ].join('\r\n');
  it('accepts a complete data-only offer', () => expect(() => validateDirectOffer({ version: 1, sdp })).not.toThrow());
  it.each([
    { version: 2, sdp },
    { version: 1, sdp, extra: true },
    { version: 1, sdp: `${sdp}m=audio 9 UDP/TLS/RTP/SAVPF 111\r\n` },
    { version: 1, sdp: `${sdp}a=candidate:1 1 udp 1 192.0.2.1 5000 typ relay\r\n` },
    { version: 1, sdp: sdp.replace('a=end-of-candidates\r\n', '') },
    { version: 1, sdp: `${sdp}${'x'.repeat(65_536)}` },
  ])('rejects unsafe offers without echoing SDP', (offer) => {
    expect(() => validateDirectOffer(offer)).toThrow('Invalid direct upload offer');
  });
});
