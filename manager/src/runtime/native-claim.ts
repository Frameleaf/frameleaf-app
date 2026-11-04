import { randomUUID, timingSafeEqual } from 'node:crypto';
import { open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Refusal } from '../contracts.js';

export async function publishNativeClaimProof(directory: string, proof: Buffer): Promise<void> {
  const temporary = join(directory, `.claim-key-${randomUUID()}`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    try {
      await file.writeFile(proof.toString('hex'));
    } finally {
      await file.close();
    }
    await rename(temporary, join(directory, 'claim-key'));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function requireNativeClaimProof(expected: Buffer | null, supplied: unknown): void {
  if (
    !expected ||
    typeof supplied !== 'string' ||
    !/^[a-f0-9]{64}$/.test(supplied) ||
    !timingSafeEqual(expected, Buffer.from(supplied, 'hex'))
  ) {
    throw new Refusal('invalid_claim_proof', 401);
  }
}
