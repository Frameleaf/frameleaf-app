import { execFile as execFileCallback } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const KIB = 1024n;

/** POSIX df counts 1024-byte units; Node statfs.bsize can be the optimal I/O size, not the count unit. */
export const getDiskUsageBigInt = async (folder: string) => {
  let stdout: string;
  try {
    ({ stdout } = await execFile('df', ['-Pk', resolve(folder)], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
    }));
  } catch (error) {
    throw new Error('Filesystem capacity probe failed', { cause: error });
  }
  const lines = stdout.trim().split('\n');
  // Names may contain spaces; refuse ambiguous rows instead of reading numbers out of a name.
  const rows =
    lines.length === 2
      ? lines[1].matchAll(/\S[ \t]+(\d+)[ \t]+(\d+)[ \t]+(-?\d+)[ \t]+\d+%[ \t]+(?=\/)/g).toArray()
      : [];
  const row = rows.length === 1 ? rows[0] : undefined;
  if (!row || !lines[0].includes('1024-blocks')) throw new Error('Invalid filesystem capacity response');
  const total = BigInt(row[1]);
  const used = BigInt(row[2]);
  const available = BigInt(row[3]);
  if (used > total || available > total - used) throw new Error('Invalid filesystem capacity response');
  return { total: total * KIB, free: (total - used) * KIB, available: (available < 0n ? 0n : available) * KIB };
};

/** Existing storage responses use numbers; refuse capacities that cannot be represented exactly. */
export const getDiskUsage = async (folder: string) => {
  const usage = await getDiskUsageBigInt(folder);
  const safeNumber = (bytes: bigint) => {
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('Filesystem capacity exceeds the supported numeric range');
    return Number(bytes);
  };
  return { total: safeNumber(usage.total), free: safeNumber(usage.free), available: safeNumber(usage.available) };
};
