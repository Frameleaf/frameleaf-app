import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { type BigIntStats, constants, fstatSync } from 'node:fs';
import { type FileHandle, open, readFile } from 'node:fs/promises';
import { Refusal } from '#library-import-transfer/contracts';
import { openImportRoot } from '#library-import-transfer/import-copy';

const authority = 'FRAMELEAF_IMPORT_EXECUTION_LOCK_FD';
const refuse = (): never => {
  throw new Refusal('import_execution_lock_unavailable');
};
const privateFile = (value: BigIntStats) =>
  value.isFile() &&
  value.nlink === 1n &&
  (value.mode & 0o777n) === 0o600n &&
  value.uid === BigInt(process.geteuid?.() ?? -1);

async function lockFile(directory: string, create: boolean): Promise<FileHandle> {
  const root = await openImportRoot(directory);
  try {
    const info = await root.stat({ bigint: true });
    if ((info.mode & 0o777n) !== 0o700n || info.uid !== BigInt(process.geteuid?.() ?? -1)) return refuse();
    const file = await open(
      `/proc/self/fd/${root.fd}/execution.lock`,
      constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK | (create ? constants.O_CREAT : 0),
      0o600,
    );
    try {
      if (!privateFile(await file.stat({ bigint: true }))) return refuse();
      await file.sync();
      await root.sync();
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  } finally {
    await root.close();
  }
}

/** The same executing Node process retains this descriptor until death; no lease can be stolen mid-move. */
export async function assertImportExecutionLock(directory: string) {
  try {
    if (process.platform !== 'linux' || process.env[authority] !== '3') return refuse();
    const inherited = fstatSync(3, { bigint: true });
    if (!privateFile(inherited)) return refuse();
    const file = await lockFile(directory, false);
    try {
      const current = await file.stat({ bigint: true });
      if (current.dev !== inherited.dev || current.ino !== inherited.ino) return refuse();
    } finally {
      await file.close();
    }
    const info = await readFile('/proc/self/fdinfo/3', 'utf8');
    if (!new RegExp(String.raw`^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+${process.pid}\s`, 'm').test(info))
      return refuse();
    return { device: String(inherited.dev), inode: String(inherited.ino) };
  } catch {
    return refuse();
  }
}

/** Run before application bootstrap. The parent performs no database or media effects. */
export async function enterImportExecutionLock(directory: string): Promise<boolean> {
  try {
    if (process.platform !== 'linux') return refuse();
    if (process.env[authority] !== undefined) {
      await assertImportExecutionLock(directory);
      return true;
    }
    const file = await lockFile(directory, true);
    try {
      const child = spawn(
        '/usr/local/bin/frameleaf-import-rename',
        ['--exec-locked', process.execPath, ...process.execArgv, ...process.argv.slice(1)],
        { env: { ...process.env, [authority]: '3' }, stdio: ['inherit', 'inherit', 'inherit', file.fd] },
      );
      // Close our copy immediately; only the executing child retains the shared description.
      const [[code, signal]] = await Promise.all([once(child, 'exit'), file.close()]);
      process.exitCode = typeof code === 'number' ? code : signal === 'SIGINT' ? 130 : 1;
      return false;
    } catch (error) {
      if (file.fd !== -1) await file.close();
      throw error;
    }
  } catch {
    return refuse();
  }
}
