import { timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { chmod } from 'node:fs/promises';
import { BlockList, Socket, connect, createServer, isIP } from 'node:net';

const ports = new Set([80, 443, 8080, 8443]);
const blocked = new BlockList();
for (const [address, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
] as const) {
  blocked.addSubnet(address, bits, 'ipv4');
}
for (const [address, bits] of [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
] as const) {
  blocked.addSubnet(address, bits, 'ipv6');
}
const globalIpv6 = (() => {
  const list = new BlockList();
  list.addSubnet('2000::', 3, 'ipv6');
  return list;
})();

export function isPublicMediaAddress(address: string): boolean {
  switch (isIP(address)) {
    case 4: {
      return !blocked.check(address, 'ipv4');
    }
    case 6: {
      return !address.includes('%') && globalIpv6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
    }
    default: {
      return false;
    }
  }
}

type BrokerFailure = 'invalid_url' | 'blocked_target' | 'too_large';
export class MediaBrokerError extends Error {
  constructor(public readonly code: BrokerFailure) {
    super(code);
  }
}

export function validateMediaUrl(value: string): URL {
  const url = URL.parse(value);
  if (
    !url ||
    !/^https?:\/\//i.test(value) ||
    url.username ||
    url.password ||
    value.length > 16_384 ||
    // eslint-disable-next-line no-control-regex -- Reject characters that the URL parser would silently normalize.
    /[\u{0}-\u{20}\u{7F}\\]/u.test(value)
  ) {
    throw new MediaBrokerError('invalid_url');
  }
  const host = url.hostname.replaceAll(/^\[|\]$/g, '');
  if ((url.port && !ports.has(Number(url.port))) || (isIP(host) && !isPublicMediaAddress(host))) {
    throw new MediaBrokerError('blocked_target');
  }
  return url;
}

function readBytes(socket: Socket, length: number): Promise<Buffer> {
  if (length === 0) {
    return Promise.resolve(Buffer.alloc(0));
  }
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      socket.off('readable', onReadable).off('end', fail).off('close', fail).off('error', fail);
    };
    const fail = () => {
      cleanup();
      reject(new Error('SOCKS connection closed'));
    };
    const onReadable = () => {
      const data = socket.read(length) as Buffer | null;
      if (data) {
        cleanup();
        resolve(data);
      }
    };
    if (socket.destroyed || socket.readableEnded) {
      fail();
      return;
    }
    socket.on('readable', onReadable).once('end', fail).once('close', fail).once('error', fail);
    onReadable();
  });
}

async function socksTarget(client: Socket, token: Buffer) {
  const greeting = await readBytes(client, 2);
  const methods = await readBytes(client, greeting[1]);
  if (greeting[0] !== 5 || !methods.includes(2)) {
    client.end(Buffer.from([5, 255]));
    return;
  }
  client.write(Buffer.from([5, 2]));

  const auth = await readBytes(client, 2);
  const username = await readBytes(client, auth[1]);
  const [length] = await readBytes(client, 1);
  const password = await readBytes(client, length);
  if (
    auth[0] !== 1 ||
    !username.equals(Buffer.from('job')) ||
    password.length !== token.length ||
    !timingSafeEqual(password, token)
  ) {
    client.end(Buffer.from([1, 1]));
    return;
  }
  client.write(Buffer.from([1, 0]));

  const header = await readBytes(client, 4);
  const reply = (status: number) => Buffer.from([5, status, 0, 1, 0, 0, 0, 0, 0, 0]);
  if (header[0] !== 5 || header[1] !== 1 || header[2] !== 0) {
    client.end(reply(7));
    return;
  }
  let host: string;
  switch (header[3]) {
    case 1: {
      host = [...(await readBytes(client, 4))].join('.');
      break;
    }
    case 3: {
      const [length] = await readBytes(client, 1);
      host = (await readBytes(client, length)).toString('latin1');
      break;
    }
    case 4: {
      const address = await readBytes(client, 16);
      host = Array.from({ length: 8 }, (_, i) => address.readUInt16BE(i * 2).toString(16)).join(':');
      break;
    }
    default: {
      client.end(reply(8));
      return;
    }
  }
  return { host, port: (await readBytes(client, 2)).readUInt16BE(), reply };
}

export async function startMediaDownloadBroker(path: string, token: string, maxBytes = Infinity) {
  const credential = Buffer.from(token);
  const sockets = new Set<Socket>();
  let closed = false;
  let received = 0;
  let failure: BrokerFailure | undefined;

  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.setTimeout(30_000, () => socket.destroy());
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
  };
  const server = createServer({ allowHalfOpen: true }, (client) => {
    if (closed || failure === 'too_large' || sockets.size >= 64) {
      client.destroy();
      return;
    }
    track(client);
    void (async () => {
      const target = await socksTarget(client, credential);
      if (!target) {
        return;
      }
      const { host, port, reply } = target;
      if (
        !ports.has(port) ||
        (!isIP(host) && !/^(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.?$/i.test(host))
      ) {
        failure ??= 'blocked_target';
        client.end(reply(2));
        return;
      }

      const literalFamily = isIP(host);
      const addresses = literalFamily
        ? [{ address: host, family: literalFamily }]
        : await lookup(host, { all: true }).catch(() => []);
      if (closed || client.destroyed) {
        return;
      }
      if (addresses.length === 0) {
        client.end(reply(4));
        return;
      }
      if (addresses.some(({ address }) => !isPublicMediaAddress(address))) {
        failure ??= 'blocked_target';
        client.end(reply(2));
        return;
      }

      // Pin the socket to the checked address. Prefer IPv4 when the container has no IPv6 route.
      const { address, family } = addresses.find(({ family }) => family === 4) ?? addresses[0];
      const upstream = connect({ host: address, port, family });
      track(upstream);
      client.once('close', () => upstream.destroy());
      upstream.once('close', (hadError) => {
        if (hadError || !upstream.readableEnded) {
          client.destroy();
        }
      });
      upstream.once('connect', () => {
        client.write(reply(0));
        client.pipe(upstream);
        upstream.on('data', (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            failure = 'too_large';
            for (const socket of sockets) {
              socket.destroy();
            }
          } else if (!client.write(chunk)) {
            upstream.pause();
            client.once('drain', () => upstream.resume());
          }
        });
        upstream.once('end', () => client.end());
      });
    })().catch(() => client.destroy());
  });
  const close = async () => {
    closed = true;
    credential.fill(0);
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(path, () => {
        server.off('error', reject);
        resolve();
      });
    });
    await chmod(path, 0o666);
  } catch (error) {
    await close();
    throw error;
  }
  return {
    close,
    get failure() {
      return failure;
    },
  };
}
