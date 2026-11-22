import { createECDH, generateKeyPairSync, randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { UnifiedPushRepository } from 'src/repositories/unified-push.repository.js';
import { type UnifiedPushPlaintext, unifiedPushPlaintextOf } from 'src/utils/frameleaf-push.js';
import { openPushEnvelope, sealPushEnvelope } from 'src/utils/push-crypto.js';
import { decryptWebPush } from 'src/utils/web-push.js';

/**
 * FL-926: UnifiedPush delivery against a real distributor (ntfy). The message must reach ntfy as an
 * opaque Web Push body that a subscriber (the phone) decrypts back to the frameleaf-push-v1 envelope.
 *
 * ntfy listens on the container's bridge address, a private one, so the administrator setting that
 * allows push servers on this network is on; this server's own loopback stays refused either way.
 */
let ntfy: StartedTestContainer;
let base: string;

type NtfyMessage = { event: string; topic: string; message: string; encoding?: string };

const newDevice = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const envelope = generateKeyPairSync('x25519');
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
    envelopeKey: { privateKey: envelope.privateKey, publicKey: envelope.publicKey.export({ format: 'jwk' }).x! },
  };
};

/** A UnifiedPush topic as ntfy hands them out: `up` and 12 characters. */
const newTopic = () => `up${randomBytes(9).toString('base64url').replaceAll(/[-_]/g, 'x').slice(0, 12)}`;

const poll = async (topic: string): Promise<NtfyMessage[]> => {
  const response = await fetch(`${base}/${topic}/json?poll=1`);
  const text = await response.text();
  return text
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as NtfyMessage)
    .filter(({ event }) => event === 'message');
};

beforeAll(async () => {
  ntfy = await new GenericContainer('binwiederhier/ntfy:latest')
    .withCommand(['serve'])
    .withExposedPorts(80)
    .withWaitStrategy(Wait.forHttp('/v1/health', 80))
    .start();
  // Docker Desktop does not route to the bridge: use the published port on this machine's private address
  const lan = Object.values(networkInterfaces())
    .flat()
    .find(
      (nic) => nic?.family === 'IPv4' && !nic.internal && /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(nic.address),
    );
  if (process.platform === 'linux') {
    base = `http://${ntfy.getIpAddress(ntfy.getNetworkNames()[0])}:80`;
  } else if (lan) {
    base = `http://${lan.address}:${ntfy.getMappedPort(80)}`;
  } else {
    throw new Error('This suite needs a private IPv4 address on this machine to reach the published ntfy port');
  }
}, 180_000);

afterAll(async () => {
  await ntfy?.stop({ remove: true, removeVolumes: true });
});

describe('UnifiedPush to ntfy (FL-926)', () => {
  const sut = new UnifiedPushRepository();

  it('delivers a Web Push encrypted message that the subscriber opens to the frameleaf-push-v1 payload', async () => {
    const device = newDevice();
    const topic = newTopic();
    const payload = { v: 1, title: 'Trip', body: 'New items in Trip' };
    const plaintext = unifiedPushPlaintextOf({
      type: 'alert',
      payload: sealPushEnvelope(device.envelopeKey.publicKey, Buffer.from(JSON.stringify(payload))),
    });

    const result = await sut.send(
      { endpoint: `${base}/${topic}?up=1`, p256dh: device.p256dh, auth: device.auth },
      { plaintext, ttlSec: 3600, urgency: 'high', topic: 'album-update-1' },
      { allowLocalTargets: true },
    );
    expect(result).toEqual({ status: 'sent' });

    const messages = await poll(topic);
    expect(messages).toHaveLength(1);
    // ntfy holds only the opaque body (base64 of the binary message); nothing readable reaches it
    expect(messages[0].encoding).toBe('base64');
    expect(messages[0].message).not.toContain('Trip');
    const body = Buffer.from(messages[0].message, 'base64');
    const opened = JSON.parse(decryptWebPush(body, device).toString('utf8')) as UnifiedPushPlaintext;
    expect(opened).toEqual({ e: expect.any(String), t: 'alert' });
    const decrypted = openPushEnvelope(device.envelopeKey.privateKey, device.envelopeKey.publicKey, opened.e);
    expect(JSON.parse(decrypted.toString('utf8'))).toEqual(payload);
  });

  it('refuses the private ntfy address unless local push servers are allowed, and never sends', async () => {
    const device = newDevice();
    const topic = newTopic();
    const result = await sut.send(
      { endpoint: `${base}/${topic}?up=1`, p256dh: device.p256dh, auth: device.auth },
      { plaintext: Buffer.from('{}'), ttlSec: 60, urgency: 'normal' },
      { allowLocalTargets: false },
    );
    expect(result).toMatchObject({ status: 'refused' });
    await expect(poll(topic)).resolves.toEqual([]);
  });

  it('refuses this server itself, even with local push servers allowed', async () => {
    const device = newDevice();
    const port = ntfy.getMappedPort(80);
    const result = await sut.send(
      { endpoint: `http://127.0.0.1:${port}/${newTopic()}?up=1`, p256dh: device.p256dh, auth: device.auth },
      { plaintext: Buffer.from('{}'), ttlSec: 60, urgency: 'normal' },
      { allowLocalTargets: true },
    );
    expect(result).toMatchObject({ status: 'refused' });
  });
});
