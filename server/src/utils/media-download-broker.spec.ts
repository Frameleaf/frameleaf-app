import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { Socket, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPublicMediaAddress, startMediaDownloadBroker, validateMediaUrl } from 'src/utils/media-download-broker.js';

describe('media download broker', () => {
  it.each([
    '0.0.0.0',
    '127.0.0.1',
    '10.2.3.4',
    '100.64.0.1',
    '169.254.169.254',
    '172.18.0.1',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.2',
    '203.0.113.2',
    '224.0.0.1',
    '::',
    '::1',
    '::ffff:7f00:1',
    '64:ff9b::7f00:1',
    'fc00::1',
    'fe80::1',
    'ff00::1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicMediaAddress(address)).toBe(false);
  });

  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('allows public address %s', (address) => {
    expect(isPublicMediaAddress(address)).toBe(true);
  });

  it.each(['file:///etc/hosts', 'https://a:b@example.org', 'https://example.org:22', 'http://127.1'])(
    'rejects %s before launching an extractor',
    (url) => {
      expect(() => validateMediaUrl(url)).toThrow();
    },
  );

  it('requires the job token and rejects private SOCKS CONNECT requests', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'media-test-'));
    const path = join(directory, 'proxy.sock');
    const token = randomBytes(24).toString('hex');
    const broker = await startMediaDownloadBroker(path, token);
    const exchange = async (password: string, lastPacket?: Buffer) => {
      const socket = connect(path);
      const request = async (client: Socket, bytes: Buffer) => {
        const response = new Promise<Buffer>((resolve, reject) => {
          client.once('data', resolve);
          client.once('error', reject);
        });
        client.write(bytes);
        return response;
      };
      try {
        expect(await request(socket, Buffer.from([5, 2, 0, 2]))).toEqual(Buffer.from([5, 2]));
        const auth = await request(
          socket,
          Buffer.concat([
            Buffer.from([1, 3]),
            Buffer.from('job'),
            Buffer.from([password.length]),
            Buffer.from(password),
          ]),
        );
        return lastPacket ? await request(socket, lastPacket) : auth;
      } finally {
        socket.destroy();
      }
    };
    try {
      expect(await exchange('wrong')).toEqual(Buffer.from([1, 1]));
      const header = Buffer.from([5, 1, 0, 1, 127, 0, 0, 1, 0, 80]);
      expect((await exchange(token, header)).subarray(0, 2)).toEqual(Buffer.from([5, 2]));
      header[1] = 3;
      expect((await exchange(token, header)).subarray(0, 2)).toEqual(Buffer.from([5, 7]));
    } finally {
      await broker.close();
      await rm(directory, { recursive: true, force: true });
    }
  });
});
