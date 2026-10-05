import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Refusal } from './contracts.js';

export async function fileHash(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
}
export async function publishFile(temporary: string, destination: string): Promise<void> {
  const handle = await open(temporary, 'r+');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, destination);
  const directory = await open(dirname(destination), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
export async function atomicJson(destination: string, data: unknown): Promise<void> {
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });
  await writeFile(temporary, JSON.stringify(data, null, 2), { mode: 0o600, flag: 'wx' });
  await publishFile(temporary, destination);
}
export async function copyVerified(source: string, destination: string, expected: string): Promise<void> {
  try {
    if ((await fileHash(destination)) === expected) return;
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }
  const temporary = `${destination}.partial`;
  await rm(temporary, { force: true });
  await pipeline(createReadStream(source), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
  if ((await fileHash(temporary)) !== expected) {
    await rm(temporary);
    throw new Refusal('checkpoint_dump_changed');
  }
  await publishFile(temporary, destination);
}
