import { randomUUID } from 'node:crypto';
import type { ConfigRepository } from 'src/repositories/config.repository.js';
import type { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { SystemMetadataKey } from 'src/enum.js';
import { readCloudLink } from 'src/utils/frameleaf-cloud-gateway.js';

type IdentityDeps = { configRepository: ConfigRepository; systemMetadataRepository: SystemMetadataRepository };

/**
 * FL-229 (NAPI-005): this server's stable, local-only id - created once, on the first call that
 * needs it (a ping, or the first LAN advertisement), and kept for the server's life. Used only
 * while unlinked; a linked server's identity is the Frameleaf Cloud instance id instead.
 */
export const stableServerId = async (deps: Pick<IdentityDeps, 'systemMetadataRepository'>): Promise<string> => {
  const stored = await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafServerId);
  if (stored?.id) {
    return stored.id;
  }
  const record = { id: randomUUID(), createdAt: new Date().toISOString() };
  // Concurrent first pings must return the winning persisted identity, never their own losing UUID.
  await deps.systemMetadataRepository.set(SystemMetadataKey.FrameleafServerId, record, false);
  return (await deps.systemMetadataRepository.get(SystemMetadataKey.FrameleafServerId))!.id;
};

/**
 * FL-229: this server's identity on any unauthenticated route (ping, DNS-SD TXT records) - the
 * Frameleaf Cloud instance id while linked, else the stable local id.
 */
export const serverIdentity = async (deps: IdentityDeps): Promise<{ id: string; linked: boolean }> => {
  const { link, linked } = await readCloudLink(deps);
  const usable = linked && !!link?.instanceId;
  return { id: usable ? (link!.instanceId as string) : await stableServerId(deps), linked: usable };
};
