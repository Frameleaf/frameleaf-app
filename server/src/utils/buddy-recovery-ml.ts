import { type Transaction, sql } from 'kysely';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  MlCloudModelChoiceRow,
  MlDestinationRow,
  MlWorkloadRouteRow,
} from 'src/repositories/ml-destination.repository.js';
import type { DB } from 'src/schema/index.js';
import type { RepoDeps } from 'src/utils/config.js';
import { MlDestinationHealth, MlDestinationKind, SystemMetadataKey } from 'src/enum.js';
import { writeBuddyFile } from 'src/utils/buddy-backup-vault.js';
import { readConfig } from 'src/utils/config.js';
import {
  type RecoveryMlBinding,
  type RecoveryMlConfig,
  recoveryAuthorityDigest,
  recoveryMlBindingSchema,
  recoveryMlConfigOf,
  recoveryMlEndpointIdentity,
  recoveryMlOverlaySchema,
  recoveryMlRefusal,
  recoveryMlRegistrySchema,
} from 'src/utils/recovery-ml-authority.js';

export type BuddyReplacementMl = {
  binding: RecoveryMlBinding;
  config: RecoveryMlConfig;
  epoch: number;
  destinations: MlDestinationRow[];
  routes: MlWorkloadRouteRow[];
  modelChoices: MlCloudModelChoiceRow[];
};

/** Read only an owned immutable private artifact; refusal never reflects file contents. */
async function readPrivateMlArtifact(filename: string): Promise<any> {
  try {
    const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const metadata = await file.stat();
      if (
        !metadata.isFile() ||
        (metadata.mode & 0o777) !== 0o600 ||
        metadata.uid !== process.getuid?.() ||
        metadata.size > 16 * 1024 * 1024
      )
        throw recoveryMlRefusal();
      // eslint-disable-next-line unicorn/consistent-json-file-read -- FileHandle.readFile takes encoding as its first argument.
      return JSON.parse(await file.readFile({ encoding: 'utf8' }));
    } finally {
      await file.close();
    }
  } catch {
    throw recoveryMlRefusal();
  }
}

export async function readReplacementMl(
  directory: string,
  recoveryId: string,
  plan: unknown,
): Promise<BuddyReplacementMl> {
  try {
    const value: BuddyReplacementMl = await readPrivateMlArtifact(join(directory, 'replacement-ml.json'));
    recoveryMlBindingSchema.parse(value.binding);
    recoveryMlOverlaySchema.shape.authority.parse(value.config);
    if (
      value.binding.recoveryId !== recoveryId ||
      value.binding.preparedPlanDigest !== recoveryAuthorityDigest(plan) ||
      !Number.isSafeInteger(value.epoch) ||
      value.epoch < 1 ||
      !Array.isArray(value.destinations) ||
      !Array.isArray(value.routes) ||
      !Array.isArray(value.modelChoices)
    )
      throw recoveryMlRefusal();
    return value;
  } catch {
    throw recoveryMlRefusal();
  }
}

/** C1 is held before reading destination/routes. The immutable private artifact owns retry identity. */
export async function captureReplacementMl(
  repos: RepoDeps,
  tx: Transaction<DB>,
  directory: string,
  recoveryId: string,
  plan: unknown,
  assert: () => Promise<void>,
): Promise<BuddyReplacementMl> {
  await assert();
  const identity = await repos.metadataRepo.get(SystemMetadataKey.FrameleafInstance);
  if (!identity?.kid || !identity.instanceId) throw recoveryMlRefusal();
  const config = await readConfig(repos);
  const epoch = await repos.metadataRepo.getEffectiveConfigEpoch();
  const input = await repos.metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
  const registry = input ? recoveryMlRegistrySchema.safeParse(input) : null;
  if (registry && !registry.success) throw recoveryMlRefusal();
  const rows = await tx.selectFrom('ml_destination').selectAll().orderBy('id').forShare().execute();
  const destinations = rows.filter((row) => !registry?.data?.quarantine[row.id]);
  const routes = await tx.selectFrom('ml_workload_route').selectAll().orderBy('workload').forShare().execute();
  const value: BuddyReplacementMl = {
    binding: {
      format: 1,
      recoveryId,
      preparedPlanDigest: recoveryAuthorityDigest(plan),
      replacementIdentity: recoveryAuthorityDigest({ instanceId: identity.instanceId, kid: identity.kid }),
    },
    config: recoveryMlConfigOf(config),
    epoch: epoch?.epoch ?? 1,
    destinations,
    routes: routes.filter((route) => destinations.some((row) => row.id === route.destinationId)),
    modelChoices: await tx.selectFrom('ml_cloud_model_choice').selectAll().orderBy('modelGroup').forShare().execute(),
  };
  await assert();
  try {
    await writeBuddyFile(join(directory, 'replacement-ml.json'), JSON.stringify(value), true, assert);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryMlRefusal();
    if (
      recoveryAuthorityDigest(await readReplacementMl(directory, recoveryId, plan)) !== recoveryAuthorityDigest(value)
    )
      throw recoveryMlRefusal();
  }
  await assert();
  return value;
}

/** Preserve source dependency/identity history before replacement metadata or rows are installed. */
export async function preserveHistoricalMl(
  repos: RepoDeps,
  tx: Transaction<DB>,
  directory: string,
  authority: BuddyReplacementMl,
  assert: () => Promise<void>,
) {
  await assert();
  const epoch = await repos.metadataRepo.getEffectiveConfigEpoch();
  const registry = await repos.metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
  const filename = join(directory, 'historical-ml.json');
  if (
    epoch?.recoveryMl?.recoveryId === authority.binding.recoveryId &&
    registry?.recoveryId === authority.binding.recoveryId &&
    registry.preparedPlanDigest === authority.binding.preparedPlanDigest &&
    registry.replacementIdentity === authority.binding.replacementIdentity &&
    epoch.recoveryMl.preparedPlanDigest === authority.binding.preparedPlanDigest &&
    epoch.recoveryMl.replacementIdentity === authority.binding.replacementIdentity
  ) {
    const existing = await readPrivateMlArtifact(filename);
    if (recoveryAuthorityDigest(existing.binding) !== recoveryAuthorityDigest(authority.binding))
      throw recoveryMlRefusal();
    return;
  }
  const value = {
    binding: authority.binding,
    destinations: await tx.selectFrom('ml_destination').selectAll().orderBy('id').forUpdate().execute(),
    routes: await tx.selectFrom('ml_workload_route').selectAll().orderBy('workload').execute(),
    modelChoices: await tx.selectFrom('ml_cloud_model_choice').selectAll().orderBy('modelGroup').execute(),
    system: await repos.metadataRepo.get(SystemMetadataKey.SystemConfig),
    epoch,
    identity: await repos.metadataRepo.get(SystemMetadataKey.FrameleafInstance),
    cloudLink: await repos.metadataRepo.get(SystemMetadataKey.FrameleafCloudLink),
  };
  try {
    await writeBuddyFile(filename, JSON.stringify(value), true, assert);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryMlRefusal();
    if (recoveryAuthorityDigest(await readPrivateMlArtifact(filename)) !== recoveryAuthorityDigest(value))
      throw recoveryMlRefusal();
  }
}

/** Called before any imported row is mutated; committed retries retain the original source preimage. */
export async function admitReplacementMl(
  repos: RepoDeps,
  tx: Transaction<DB>,
  directory: string,
  authority: BuddyReplacementMl,
  assert: () => Promise<void>,
) {
  await assert();
  const identity = await repos.metadataRepo.get(SystemMetadataKey.FrameleafInstance);
  if (
    !identity ||
    authority.binding.replacementIdentity !==
      recoveryAuthorityDigest({ instanceId: identity.instanceId, kid: identity.kid })
  )
    throw recoveryMlRefusal();
  const currentRegistry = await repos.metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
  const currentEpoch = await repos.metadataRepo.getEffectiveConfigEpoch();
  if (
    currentRegistry?.recoveryId === authority.binding.recoveryId &&
    currentRegistry.preparedPlanDigest === authority.binding.preparedPlanDigest &&
    currentRegistry.replacementIdentity === authority.binding.replacementIdentity &&
    currentEpoch?.recoveryMl?.recoveryId === authority.binding.recoveryId &&
    currentEpoch.recoveryMl.preparedPlanDigest === authority.binding.preparedPlanDigest &&
    currentEpoch.recoveryMl.replacementIdentity === authority.binding.replacementIdentity
  ) {
    const historical = await readPrivateMlArtifact(join(directory, 'historical-ml.json'));
    if (recoveryAuthorityDigest(historical.binding) !== recoveryAuthorityDigest(authority.binding))
      throw recoveryMlRefusal();
    return;
  }
  const destinations = await tx.selectFrom('ml_destination').selectAll().orderBy('id').forUpdate().execute();
  const preimage = await readPrivateMlArtifact(join(directory, 'historical-ml.json'));
  if (recoveryAuthorityDigest(preimage.binding) !== recoveryAuthorityDigest(authority.binding))
    throw recoveryMlRefusal();
  const quarantine = Object.fromEntries(destinations.map((row) => [row.id, recoveryMlEndpointIdentity(row)]));
  for (const row of authority.destinations) {
    const existing = destinations.find((source) => source.id === row.id);
    // Never rewrite an accounting UUID to describe a different endpoint or credential.
    if (existing && recoveryMlEndpointIdentity(existing) !== recoveryMlEndpointIdentity(row)) throw recoveryMlRefusal();
    if (
      existing &&
      row.kind === MlDestinationKind.FrameleafCloud &&
      (!preimage.identity ||
        recoveryAuthorityDigest({ instanceId: preimage.identity.instanceId, kid: preimage.identity.kid }) !==
          authority.binding.replacementIdentity)
    )
      throw recoveryMlRefusal();
    const user = row.consentAcknowledgedBy
      ? await tx.selectFrom('user').select('id').where('id', '=', row.consentAcknowledgedBy).executeTakeFirst()
      : null;
    if (existing) {
      await tx
        .updateTable('ml_destination')
        .set({
          enabled: row.enabled && (row.kind !== MlDestinationKind.FrameleafCloud || !!user),
          workloads: sql`${JSON.stringify(row.workloads)}::text::jsonb`,
          budgetLimitUsd: row.budgetLimitUsd,
          maxRuntimeMinutes: row.maxRuntimeMinutes,
          maxUploadBytes: row.maxUploadBytes,
          sharesLibraryHardware: row.sharesLibraryHardware,
          lastProbeAt: null,
          lastProbeHealth: MlDestinationHealth.Unknown,
          lastProbeSummary: null,
          lastProbeWorkloads: null,
          lastProbeHardware: null,
          lastProbeCloud: null,
          lastProbeLatencyMs: null,
          // Source consent cannot substitute for the captured replacement consent owner.
          consentAcknowledgedAt: user ? row.consentAcknowledgedAt : null,
          consentAcknowledgedBy: user?.id ?? null,
          consentVersion: user ? row.consentVersion : null,
        })
        .where('id', '=', row.id)
        .execute();
    } else {
      const { consentAcknowledgedBy: _owner, ...captured } = row;
      await tx
        .insertInto('ml_destination')
        .values({
          ...captured,
          workloads: sql`${JSON.stringify(row.workloads)}::text::jsonb`,
          lastProbeWorkloads: null,
          lastProbeHardware: null,
          lastProbeCloud: null,
          lastProbeAt: null,
          lastProbeLatencyMs: null,
          lastProbeHealth: MlDestinationHealth.Unknown,
          lastProbeSummary: null,
          consentAcknowledgedBy: user?.id ?? null,
          consentAcknowledgedAt: user ? row.consentAcknowledgedAt : null,
          consentVersion: user ? row.consentVersion : null,
          enabled: row.enabled && (row.kind !== MlDestinationKind.FrameleafCloud || !!user),
        } as never)
        .execute();
    }
    delete quarantine[row.id];
  }
  for (const row of destinations)
    if (quarantine[row.id])
      await tx.updateTable('ml_destination').set({ enabled: false }).where('id', '=', row.id).execute();
  for (const route of authority.routes) {
    if (authority.destinations.every((row) => row.id !== route.destinationId)) throw recoveryMlRefusal();
    await tx
      .insertInto('ml_workload_route')
      .values(route)
      .onConflict((oc) =>
        oc
          .column('workload')
          .doUpdateSet({ destinationId: route.destinationId, modelId: route.modelId, updatedAt: route.updatedAt }),
      )
      .execute();
  }
  await tx.deleteFrom('ml_cloud_model_choice').execute();
  for (const choice of authority.modelChoices) await tx.insertInto('ml_cloud_model_choice').values(choice).execute();
  await repos.metadataRepo.set(SystemMetadataKey.FrameleafRecoveryMlAuthority, { ...authority.binding, quarantine });
  await assert();
}

/** Completed publication may be retried only against its durable current authority, never an imported epoch. */
export async function verifyCommittedReplacementMl(repos: RepoDeps, authority: BuddyReplacementMl) {
  await repos.metadataRepo.withConfigTransaction(async (metadataRepo) => {
    const epoch = await metadataRepo.getEffectiveConfigEpoch();
    const registry = await metadataRepo.get(SystemMetadataKey.FrameleafRecoveryMlAuthority);
    const identity = await metadataRepo.get(SystemMetadataKey.FrameleafInstance);
    if (
      !epoch?.recoveryMlBinding ||
      !registry ||
      !identity ||
      recoveryAuthorityDigest(epoch.recoveryMlBinding) !== recoveryAuthorityDigest(authority.binding) ||
      recoveryAuthorityDigest({
        format: registry.format,
        recoveryId: registry.recoveryId,
        preparedPlanDigest: registry.preparedPlanDigest,
        replacementIdentity: registry.replacementIdentity,
      }) !== recoveryAuthorityDigest(authority.binding) ||
      authority.binding.replacementIdentity !==
        recoveryAuthorityDigest({ instanceId: identity.instanceId, kid: identity.kid })
    )
      throw recoveryMlRefusal();
    await readConfig({ ...repos, metadataRepo });
  });
}
