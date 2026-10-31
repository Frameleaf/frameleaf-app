import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackupTransferJournal } from 'src/utils/cloud-backup-transfer.js';
import { CloudBackupStoreRepository } from 'src/repositories/cloud-backup-store.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';

it.each(['length', 'chunked'] as const)(
  'downloads a complete %s response when the peer closes the connection under backpressure',
  async (framing) => {
    const bytes = Buffer.alloc(9 * 1024 * 1024, 0x61);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const server = createServer((request, response) => {
      response.writeHead(200, {
        ...(framing === 'length' || request.method === 'HEAD'
          ? { 'content-length': bytes.length }
          : { 'transfer-encoding': 'chunked' }),
        connection: 'close',
        etag: '"synthetic"',
      });
      response.end(bytes);
    });
    const directory = await mkdtemp(join(tmpdir(), 'backup-http-'));
    try {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback address');
      const store = new CloudBackupStoreRepository(LoggingRepository.create());
      const destination = join(directory, 'restored.bin');
      let delayed = false;
      const journal: BackupTransferJournal = {
        directory,
        current: null,
        async save(value) {
          journal.current = value;
          if (!delayed && value?.kind === 'download' && value.offset > 0) {
            // A slow durable checkpoint applies real response backpressure while the peer sends FIN.
            delayed = true;
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }
        },
      };
      const result = await store.download(
        {
          endpoint: `http://127.0.0.1:${address.port}`,
          region: 'test',
          bucket: 'synthetic',
          accessKeyId: 'synthetic',
          secretAccessKey: 'synthetic',
          transfer: journal,
        },
        `o/${sha256}`,
        Buffer.alloc(32, 1),
        destination,
        sha256,
      );
      expect(result).toEqual({ size: bytes.length, sha256 });
      expect((await readFile(destination)).equals(bytes)).toBe(true);
      expect(delayed).toBe(true);
      expect(journal.current).toBeNull();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
