import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { PassThrough } from 'node:stream';
import {
  FrameReader,
  RELAY_BACKOFF_MAX_MS,
  TunnelRefusedError,
  backoffDelayMs,
  challengeNonce,
  decodeFrame,
  encodeFrame,
  expectFrame,
  proofMessage,
  refreshDelayMs,
  relayCandidatesResponseSchema,
  relayClientIp,
  relaySelectResponseSchema,
  relayTokenProblem,
  relayTokenResponseSchema,
  relayVisitorNameAllowed,
} from 'src/utils/frameleaf-relay.js';
import { cloudContractFixture } from 'test/fixtures/frameleaf-cloud-contracts.js';

const INSTANCE_ID = '0192f1a4-7c3e-7b21-9d4e-2a6f8c0b1e53';
const enrollment = { label: 'u225vlzhsdlhwh4l', domain: 'frameleaf.net' };
const X = 'hMtoh1AefyJyZkWYlBO5ccMRq0sgegtqMTjp47mbnTY';

const jwt = (claims: Record<string, unknown>) =>
  `${Buffer.from('{"alg":"EdDSA"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.c2ln`;

const tokenAnswer = (claims: Record<string, unknown> = {}, relay: Record<string, unknown> = {}) => {
  const fixture = cloudContractFixture('remote/relay-token-response.json');
  return relayTokenResponseSchema.parse({
    ...fixture,
    token: jwt({ ...cloudContractFixture('remote/relay-token-claims.json'), ...claims }),
    relay: { ...fixture.relay, ...relay },
  });
};

describe('relay tunnel protocol', () => {
  describe('control frames', () => {
    it('encodes a 4-byte big-endian length and JSON', () => {
      const frame = encodeFrame({ type: 'AUTH', token: 't' });
      expect(frame.readUInt32BE(0)).toBe(frame.length - 4);
      expect(JSON.parse(frame.subarray(4).toString())).toEqual({ type: 'AUTH', token: 't' });
    });

    it('waits for a whole frame and keeps the bytes after it', () => {
      const bytes = Buffer.concat([encodeFrame({ type: 'READY' }), Buffer.from('PRI * HTTP/2.0')]);
      expect(decodeFrame(bytes.subarray(0, 6))).toBeNull();
      const decoded = decodeFrame(bytes)!;
      expect(decoded.frame).toEqual({ type: 'READY' });
      expect(decoded.rest.toString()).toBe('PRI * HTTP/2.0');
    });

    it('refuses frames over 64 KiB, before reading them', () => {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(64 * 1024 + 1);
      expect(() => decodeFrame(header)).toThrow(RangeError);
      expect(() => encodeFrame({ type: 'AUTH', token: 'x'.repeat(70_000) })).toThrow(RangeError);
    });

    it('refuses a frame without a type', () => {
      const body = Buffer.from('[1]');
      const header = Buffer.alloc(4);
      header.writeUInt32BE(body.length);
      expect(() => decodeFrame(Buffer.concat([header, body]))).toThrow(TypeError);
    });

    it('reads frames split across chunks and hands back what follows', async () => {
      const stream = new PassThrough();
      const reader = new FrameReader(stream);
      const bytes = Buffer.concat([encodeFrame({ type: 'CHALLENGE', nonce: 'n' }), encodeFrame({ type: 'READY' })]);
      stream.write(bytes.subarray(0, 3));
      const first = reader.next();
      stream.write(bytes.subarray(3, 20));
      stream.write(Buffer.concat([bytes.subarray(20), Buffer.from('h2')]));
      await expect(first).resolves.toEqual({ type: 'CHALLENGE', nonce: 'n' });
      await expect(reader.next()).resolves.toEqual({ type: 'READY' });
      expect(reader.detach().toString()).toBe('h2');
    });

    it('fails a pending read when the stream ends', async () => {
      const stream = new PassThrough();
      const reader = new FrameReader(stream);
      const pending = reader.next();
      stream.end();
      await expect(pending).rejects.toThrow('ended');
    });

    it('gives up on a frame that does not come in time, and reads the next one after', async () => {
      const stream = new PassThrough();
      const reader = new FrameReader(stream);
      await expect(reader.next(20)).rejects.toThrow('in time');
      stream.write(encodeFrame({ type: 'READY' }));
      await expect(reader.next(1000)).resolves.toEqual({ type: 'READY' });
    });

    it('keeps nothing once it failed: a flood is dropped and reported once', async () => {
      const stream = new PassThrough();
      const onFail = vi.fn();
      const reader = new FrameReader(stream, onFail);
      stream.write(Buffer.alloc(70 * 1024));
      stream.write(Buffer.alloc(70 * 1024));
      await new Promise((resolve) => setImmediate(resolve));
      expect(onFail).toHaveBeenCalledTimes(1);
      expect(onFail.mock.calls[0][0]).toBeInstanceOf(RangeError);
      await expect(reader.next()).rejects.toThrow('unread control bytes');
      expect(reader.detach()).toHaveLength(0);
    });

    it('turns ERROR into a refusal with its code', () => {
      expect(() => expectFrame({ type: 'ERROR', code: 'revoked' }, 'READY')).toThrow(TunnelRefusedError);
      try {
        expectFrame({ type: 'ERROR', code: 'bad_proof' }, 'CHALLENGE');
      } catch (error) {
        expect((error as TunnelRefusedError).code).toBe('bad_proof');
      }
      expect(() => expectFrame({ type: 'READY' }, 'CHALLENGE')).toThrow('READY where CHALLENGE');
    });
  });

  describe('handshake', () => {
    it('accepts only a 32-byte nonce', () => {
      const nonce = Buffer.alloc(32, 7);
      expect(challengeNonce({ type: 'CHALLENGE', nonce: nonce.toString('base64url') })).toEqual(nonce);
      expect(() => challengeNonce({ type: 'CHALLENGE', nonce: Buffer.alloc(16).toString('base64url') })).toThrow();
      expect(() => challengeNonce({ type: 'CHALLENGE', nonce: 'not base64!' })).toThrow();
      expect(() => challengeNonce({ type: 'CHALLENGE' })).toThrow();
    });

    it('signs "fl-relay-v1" ‖ nonce ‖ relayId, so a proof is good for one relay only', () => {
      const { privateKey, publicKey } = generateKeyPairSync('ed25519');
      const nonce = Buffer.alloc(32, 1);
      const message = proofMessage(nonce, 'eu1');
      expect(message).toEqual(Buffer.concat([Buffer.from('fl-relay-v1'), nonce, Buffer.from('eu1')]));
      const signature = sign(null, message, privateKey);
      expect(signature).toHaveLength(64);
      expect(verify(null, proofMessage(nonce, 'eu1'), publicKey, signature)).toBe(true);
      expect(verify(null, proofMessage(nonce, 'us1'), publicKey, signature)).toBe(false);
    });
  });

  describe('backoff', () => {
    it('is full jitter from 1 second, doubling, up to 5 minutes', () => {
      expect(backoffDelayMs(0, () => 0.999)).toBe(999);
      expect(backoffDelayMs(3, () => 0.5)).toBe(4000);
      expect(backoffDelayMs(30, () => 0.999999)).toBeLessThan(RELAY_BACKOFF_MAX_MS);
      expect(backoffDelayMs(30, () => 0.999999)).toBeGreaterThan(RELAY_BACKOFF_MAX_MS - 1000);
      expect(backoffDelayMs(5, () => 0)).toBe(0);
    });
  });

  describe('control plane answers', () => {
    it('reads the cloud’s golden fixtures', () => {
      expect(relayTokenResponseSchema.parse(cloudContractFixture('remote/relay-token-response.json')).relay.sni).toBe(
        'tun.eu1.relays.frameleaf.cloud',
      );
      expect(
        relayCandidatesResponseSchema.parse(cloudContractFixture('remote/relay-candidates.json')).candidates,
      ).toHaveLength(2);
      expect(relaySelectResponseSchema.parse(cloudContractFixture('remote/relay-select-response.json')).relay.id).toBe(
        'eu1',
      );
    });

    it('refuses a token answer for another ALPN or port', () => {
      const fixture = cloudContractFixture('remote/relay-token-response.json');
      expect(() => relayTokenResponseSchema.parse({ ...fixture, relay: { ...fixture.relay, alpn: 'h2' } })).toThrow();
      expect(() => relayTokenResponseSchema.parse({ ...fixture, relay: { ...fixture.relay, port: 8443 } })).toThrow();
    });

    const expected = { instanceId: INSTANCE_ID, enrollment, publicKeyX: X, now: 1_790_000_000_000 };

    it('uses a token for this server, its relay and its key', () => {
      expect(relayTokenProblem(tokenAnswer(), expected)).toBeNull();
    });

    it.each([
      [{ relay: 'us1' }, {}, 'another relay'],
      [{}, { sni: 'tun.evil.example' }, 'another tunnel host'],
      [{ sub: '0192f1a4-0000-7b21-9d4e-2a6f8c0b1e53' }, {}, 'another server'],
      [{ sni: 'aaaaaaaaaaaaaaaa.frameleaf.net' }, {}, 'another server'],
      [{ cnf: { jwk: { kty: 'OKP', crv: 'Ed25519', x: 'A'.repeat(43) } } }, {}, 'another key'],
      [{ exp: 1_789_999_999 }, {}, 'expired'],
    ])('refuses a token with %j %j (%s)', (claims, relay, problem) => {
      expect(relayTokenProblem(tokenAnswer(claims, relay), expected)).toContain(problem);
    });

    it('refuses a token it cannot read', () => {
      expect(relayTokenProblem({ ...tokenAnswer(), token: 'x.y.z' }, expected)).toContain('cannot be read');
    });

    it('refreshes at refreshAfterSec, never later than half the remaining life', () => {
      const answer = tokenAnswer({ iat: 1_790_000_000, exp: 1_790_014_400 });
      expect(refreshDelayMs(answer, 1_790_000_000_000)).toBe(7200 * 1000);
      expect(refreshDelayMs(answer, 1_790_012_400_000)).toBe(1000 * 1000);
    });
  });

  describe('visitors', () => {
    it.each([
      ['u225vlzhsdlhwh4l.frameleaf.net', true],
      ['r.u225vlzhsdlhwh4l.frameleaf.net', true],
      ['R.U225VLZHSDLHWH4L.FRAMELEAF.NET.', true],
      ['192-168-1-10.u225vlzhsdlhwh4l.frameleaf.net', true],
      ['photos.example.com', true],
      ['a.b.u225vlzhsdlhwh4l.frameleaf.net', false],
      ['r.aaaaaaaaaaaaaaaa.frameleaf.net', false],
      ['evilu225vlzhsdlhwh4l.frameleaf.net', false],
      ['example.com', false],
      ['', false],
      [null, false],
    ])('serves %s through the relay: %s', (name, allowed) => {
      expect(relayVisitorNameAllowed(name, enrollment, 'photos.example.com')).toBe(allowed);
    });

    it('serves no custom hostname unless one is verified', () => {
      expect(relayVisitorNameAllowed('photos.example.com', enrollment, null)).toBe(false);
    });

    it('takes the client address only when it is one', () => {
      expect(relayClientIp('203.0.113.9')).toBe('203.0.113.9');
      expect(relayClientIp(' 2001:db8::1 ')).toBe('2001:db8::1');
      expect(relayClientIp('203.0.113.9, 10.0.0.1')).toBeNull();
      expect(relayClientIp(['1.2.3.4'])).toBeNull();
      expect(relayClientIp(undefined)).toBeNull();
    });

    it.each([
      '192.168.1.20',
      '10.0.0.1',
      '127.0.0.1',
      '::1',
      'fd00::1',
      '169.254.1.1',
      'fe80::1',
      '::ffff:192.168.1.2',
    ])('never takes a home or loopback address from the relay: %s', (address) => {
      expect(relayClientIp(address)).toBeNull();
    });

    it('takes a public address', () => {
      expect(relayClientIp('2001:db8::5')).toBe('2001:db8::5');
    });
  });
});
