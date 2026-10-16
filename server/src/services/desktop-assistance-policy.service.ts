import { ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import z from 'zod';
import type { Transaction } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { SystemMetadataKey } from 'src/enum.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { lockEffectiveConfig } from 'src/utils/effective-config-lock.js';

const schema = z.strictObject({
  version: z.literal(1),
  accounts: z
    .record(z.uuid(), z.strictObject({ revisionId: z.uuid() }))
    .refine((accounts) => Object.keys(accounts).length <= 256),
});
export type DesktopAssistancePolicyRegistry = z.infer<typeof schema>;

@Injectable()
export class DesktopAssistancePolicyService {
  constructor(private metadata: SystemMetadataRepository) {}

  /** Consent outlives an individual helper's pause, logout or revocation. */
  async enable(ownerId: string) {
    z.uuid().parse(ownerId);
    return this.metadata.withConfigTransaction(async (metadata) => {
      const policy = await this.registry(metadata);
      if (policy.accounts[ownerId]) return policy.accounts[ownerId];

      if (Object.keys(policy.accounts).length >= 256) throw new ConflictException('desktop_pool_policy_capacity');
      const account = { revisionId: randomUUID() };
      policy.accounts[ownerId] = account;
      await metadata.set(SystemMetadataKey.FrameleafDesktopAssistance, policy);
      return account;
    });
  }

  async read(ownerId: string) {
    z.uuid().parse(ownerId);
    return (await this.registry(this.metadata)).accounts[ownerId];
  }

  snapshot() {
    return this.registry(this.metadata);
  }

  async assertCurrent(ownerId: string, revisionId: string, tx?: Transaction<DB>) {
    if (tx) await lockEffectiveConfig(tx, 'read');
    const policy = await this.registry(tx ? new SystemMetadataRepository(tx) : this.metadata);
    if (policy.accounts[ownerId]?.revisionId !== revisionId) throw new ConflictException('desktop_pool_policy_changed');
  }

  private async registry(metadata: SystemMetadataRepository): Promise<DesktopAssistancePolicyRegistry> {
    const value = await metadata.get(SystemMetadataKey.FrameleafDesktopAssistance);
    const result = schema.safeParse(value ?? { version: 1, accounts: {} });
    if (!result.success) throw new ConflictException('desktop_pool_policy_invalid');
    return result.data;
  }
}
