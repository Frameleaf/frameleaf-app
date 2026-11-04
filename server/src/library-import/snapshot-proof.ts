import { createHash } from 'node:crypto';
import { type BigIntStats } from 'node:fs';
import { openPrivateImportFile } from 'src/library-import/command-input.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

/** Verify the approved bytes once, then check the same file identity at each authority boundary. */
export function importSnapshotVerifier(snapshotPath: string, revision: string, authorize: () => Promise<void>) {
  const identity = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
  let sealed: string | undefined;
  return async () => {
    await authorize();
    const file = await openPrivateImportFile(snapshotPath);
    try {
      const before = identity(await file.stat({ bigint: true }));
      if (sealed === undefined) {
        const hash = createHash('sha256');
        for await (const bytes of file.createReadStream({ autoClose: false })) hash.update(bytes);
        if (hash.digest('hex') !== revision || identity(await file.stat({ bigint: true })) !== before)
          throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
        sealed = before;
      } else if (sealed !== before) {
        throw new LibraryImportRefused('IMPORT_SOURCE_SNAPSHOT_CHANGED');
      }
    } finally {
      await file.close();
    }
  };
}
