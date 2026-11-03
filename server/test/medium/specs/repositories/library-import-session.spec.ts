import { Kysely, sql } from 'kysely';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { Socket, connect, createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecureContext, createServer, getCACertificates, setDefaultCACertificates } from 'node:tls';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { type ImportDatabase } from 'src/immich-import/types.js';
import { LIBRARY_IMPORT_LOCK } from 'src/library-import/lock.js';
import { withLibraryImportReadback } from 'src/library-import/verification.js';
import { type DB } from 'src/schema/index.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let connection: ReturnType<typeof connectImportDatabase>;
beforeAll(async () => {
  db = await getKyselyDB();
  const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  url.pathname = '/' + name;
  connection = connectImportDatabase(url.href, false);
});
afterAll(async () => {
  await connection?.close();
  await db?.destroy();
});
const backend = async (session: ImportDatabase) => (await session.query('SELECT pg_backend_pid() AS pid'))[0].pid;

it('pins an independent session across read-only verification and a later write transaction', async () => {
  const root = await backend(connection.db);
  await connection.db.withSession!(async (session) => {
    const id = await backend(session);
    expect(id).not.toBe(root);
    expect(await withLibraryImportReadback(session, backend)).toBe(id);
    expect(await session.transaction(backend)).toBe(id);
    expect(await backend(session)).toBe(id);
    await expect(session.transaction(async (tx) => tx.transaction(async () => {}))).rejects.toThrow(
      'IMPORT_NESTED_TRANSACTION_UNSUPPORTED',
    );
  });
  expect(await backend(connection.db)).toBe(root);
});

it.each([false, true])('releases session locks after callback failure=%s', async (fail) => {
  const run = connection.db.withSession!(async (session) => {
    await session.query('SELECT pg_advisory_lock($1::bigint)', [LIBRARY_IMPORT_LOCK]);
    const [locked] = (
      await sql<{
        locked: boolean;
      }>`SELECT pg_try_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint) AS locked`.execute(db)
    ).rows;
    expect(locked.locked).toBe(false);
    await withLibraryImportReadback(session, async () => {});
    if (fail) throw new Error('synthetic callback failure');
  });
  if (fail) await expect(run).rejects.toThrow('synthetic callback failure');
  else await run;
  const [unlocked] = (
    await sql<{
      unlocked: boolean;
    }>`SELECT pg_try_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint) AS unlocked`.execute(db)
  ).rows;
  expect(unlocked.unlocked).toBe(true);
});

it.each([false, true])('bounds multi-host reservation with all hosts unavailable=%s', async (allUnavailable) => {
  const listener = createTcpServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('Expected a synthetic TCP port');
  const closed = once(listener, 'close');
  listener.close();
  await closed;
  const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
  const [{ name }] = await connection.db.query('SELECT current_database() AS name');
  url.pathname = '/' + String(name);
  const unavailable = '127.0.0.1:' + address.port;
  const client = connectImportDatabase(
    url.href.replace(url.host, () => unavailable + ',' + (allUnavailable ? unavailable : url.host)),
    false,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('synthetic reservation watchdog')), 2000);
  });
  const callback = vi.fn(async (session: ImportDatabase) => {
    const pid = await backend(session);
    expect(await backend(session)).toBe(pid);
    return pid;
  });
  try {
    const result = Promise.race([client.db.withSession!(callback), watchdog]);
    if (allUnavailable) {
      await expect(result).rejects.not.toThrow('synthetic reservation watchdog');
      expect(callback).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual(expect.any(Number));
      expect(callback).toHaveBeenCalledTimes(1);
    }
  } finally {
    clearTimeout(timer);
    await client.close();
  }
});

it('refuses to reconnect a lost reserved session and leaves the root connection usable', async () => {
  await expect(
    connection.db.withSession!(async (session) => {
      const pid = await backend(session);
      await sql`SELECT pg_terminate_backend(${pid}::int,5000)`.execute(db);
      await expect(backend(session)).rejects.toThrow();
      await expect(backend(session)).rejects.toThrow();
    }),
  ).rejects.toThrow('IMPORT_SESSION_CLEANUP_FAILED');
  expect(await backend(connection.db)).toEqual(expect.any(Number));
});

it('expires every escaped scoped database capability when its callback returns', async () => {
  let escaped: ImportDatabase | undefined;
  await connection.db.withSession!((session) => {
    escaped = session;
    return Promise.resolve();
  });
  await expect(backend(escaped!)).rejects.toThrow('IMPORT_SESSION_CLOSED');
  await expect(escaped!.transaction(async () => {})).rejects.toThrow('IMPORT_SESSION_CLOSED');
  const schema = await escaped!.readSchema!()
    .then(() => 'unexpected success')
    .catch((error: Error) => error.message);
  expect(schema).toBe('IMPORT_SESSION_CLOSED');
});

it('preserves the callback failure when its reserved connection also fails cleanup', async () => {
  await expect(
    connection.db.withSession!(async (session) => {
      const pid = await backend(session);
      await sql`SELECT pg_terminate_backend(${pid}::int,5000)`.execute(db);
      throw new Error('synthetic primary failure');
    }),
  ).rejects.toThrow('synthetic primary failure');
  expect(await backend(connection.db)).toEqual(expect.any(Number));
});

it.each(['cleanup', 'callback', 'transaction'])(
  'hard-closes stalled %s rollback and releases the session lock within its deadline',
  async (mode) => {
    const port = Number(new URL(process.env.IMMICH_TEST_POSTGRES_URL!).port);
    const stalled = new Set<Socket>();
    const originalWrite = Socket.prototype._write;
    const write = vi.spyOn(Socket.prototype, '_write').mockImplementation(function (
      this: Socket,
      chunk: unknown,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      if (this.remotePort === port && Buffer.isBuffer(chunk) && chunk.includes(Buffer.from('ROLLBACK'))) {
        stalled.add(this);
        // A pending write prevents a graceful socket end from releasing the PostgreSQL session.
        return;
      }
      originalWrite.call(this, chunk, encoding, callback);
    });
    const rescue = setTimeout(() => {
      for (const socket of stalled) socket.destroy();
    }, 11_000);
    try {
      const start = performance.now();
      await expect(
        connection.db.withSession!(async (session) => {
          await session.query('SELECT pg_advisory_lock($1::bigint)', [LIBRARY_IMPORT_LOCK]);
          if (mode === 'transaction')
            await session.transaction(() => Promise.reject(new Error('synthetic stalled callback failure')));
          else if (mode === 'callback') throw new Error('synthetic stalled callback failure');
        }),
      ).rejects.toThrow(mode === 'cleanup' ? 'IMPORT_SESSION_CLEANUP_FAILED' : 'synthetic stalled callback failure');
      expect(stalled.size).toBe(1);
      expect(performance.now() - start).toBeLessThan(10_000);
      await db.transaction().execute(async (tx) => {
        await sql`SET LOCAL statement_timeout='1s'`.execute(tx);
        await sql`SELECT pg_advisory_xact_lock(${LIBRARY_IMPORT_LOCK}::bigint)`.execute(tx);
      });
      expect(await backend(connection.db)).toEqual(expect.any(Number));
    } finally {
      clearTimeout(rescue);
      write.mockRestore();
      for (const socket of stalled) socket.destroy();
    }
  },
  15_000,
);

it('preserves TLS SNI and rejects a trusted certificate for another hostname', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'frameleaf-session-tls-'));
  const authorities = getCACertificates('default');
  const peers = new Set<Socket>();
  const names: string[] = [];
  const certificate = (name: string) => {
    const key = join(directory, name + '.key');
    const cert = join(directory, name + '.crt');
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-keyout',
        key,
        '-out',
        cert,
        '-days',
        '1',
        '-subj',
        '/CN=' + name,
        '-addext',
        'subjectAltName=DNS:' + name,
      ],
      { stdio: 'ignore' },
    );
    return { key: readFileSync(key), cert: readFileSync(cert) };
  };
  let proxy: ReturnType<typeof createServer> | undefined;
  let client: ReturnType<typeof connectImportDatabase> | undefined;
  try {
    const good = certificate('localhost');
    const wrong = certificate('another.example.test');
    setDefaultCACertificates([...authorities, good.cert.toString(), wrong.cert.toString()]);
    let context = createSecureContext(good);
    proxy = createServer(
      {
        ...good,
        ALPNProtocols: ['postgresql'],
        SNICallback: (name, callback) => {
          names.push(name);
          callback(null, context);
        },
      },
      (socket) => {
        const upstream = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
        const peer = connect(Number(upstream.port), upstream.hostname);
        peers.add(socket);
        peers.add(peer);
        socket.on('error', () => peer.destroy());
        peer.on('error', () => socket.destroy());
        socket.on('close', () => peer.destroy());
        peer.on('close', () => socket.destroy());
        socket.pipe(peer).pipe(socket);
      },
    );
    proxy.on('tlsClientError', () => {});
    await new Promise<void>((resolve) => proxy!.listen(0, '127.0.0.1', resolve));
    const address = proxy.address();
    if (!address || typeof address === 'string') throw new Error('Missing synthetic TLS proxy address');
    const url = new URL(process.env.IMMICH_TEST_POSTGRES_URL!);
    const [{ name }] = (await sql<{ name: string }>`SELECT current_database() AS name`.execute(db)).rows;
    url.hostname = 'localhost';
    url.port = String(address.port);
    url.pathname = '/' + name;
    url.searchParams.set('sslmode', 'verify-full');
    url.searchParams.set('sslnegotiation', 'direct');
    client = connectImportDatabase(url.href, false);
    await client.db.withSession!(async (session) => {
      expect(await backend(session)).toEqual(expect.any(Number));
    });
    expect(names).toEqual(['localhost']);
    context = createSecureContext(wrong);
    await expect(client.db.withSession!(backend)).rejects.toThrow(/Hostname\/IP does not match/);
    expect(names).toEqual(['localhost', 'localhost']);
  } finally {
    await client?.close();
    for (const socket of peers) socket.destroy();
    if (proxy) await new Promise<void>((resolve) => proxy!.close(() => resolve()));
    setDefaultCACertificates(authorities);
    rmSync(directory, { recursive: true, force: true });
  }
});
