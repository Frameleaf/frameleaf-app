import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, posix } from 'node:path';
import { type ImportManifest } from 'src/library-import/manifest.js';
import { parseImportedOwnerIntent } from 'src/library-import/owner-reconciliation.js';
import { publishAdapterImportBundle } from 'src/library-import/photoprism-bundle.js';
import {
  type ObservedFile,
  type OpenedPreparationSource,
  type PreparationAdapter,
  type PreparationSourceInput,
  type SourceLogin,
  unrestrictedLogin,
} from 'src/library-import/preparation/types.js';
import { LibraryImportRefused } from 'src/library-import/state.js';

/** Recorded on every best-effort import so the review can suggest upgrading first. */
export const UNTESTED_VERSION_LOSS = 'SOURCE_VERSION_UNTESTED';
/** Destination media mount inside the preparation container. */
export const DESTINATION_ROOT = '/data';
const PLACEHOLDER_SHA256 = '0'.repeat(64);

export type PreparationOwnerChoice = {
  sourceId: string;
  destinationId: string;
  email: string;
  /** The administrator saw the source restrictions and accepts a restricted destination account. */
  acknowledgeRestrictions?: boolean;
};

const restrictionReasons = (login: SourceLogin) => {
  const reasons: string[] = [];
  if (!login.accountEnabled) reasons.push('account-disabled');
  if (!login.passwordLoginEnabled) reasons.push('password-login-disabled');
  if (login.secondFactorRequired) reasons.push('second-factor-required');
  if (login.externalIdentityRequired) reasons.push('external-identity-required');
  if (login.ownedLibraryAccess !== 'full') reasons.push('restricted-library-access');
  if (login.otherRestrictions !== 'none') reasons.push('other-source-restrictions');
  return reasons;
};

const sha256File = async (path: string) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes as Buffer);
  return hash.digest('hex');
};

/** Byte evidence read from the fenced originals mount. Hashing is skipped for the review-only pass. */
async function observe(source: OpenedPreparationSource, originalsRoot: string, hash: boolean) {
  const observed: ObservedFile[] = [];
  const missing: string[] = [];
  for (const file of await source.files()) {
    const path = join(originalsRoot, file.path);
    try {
      const info = await stat(path);
      if (!info.isFile()) throw new Error('not a file');
      observed.push({
        id: file.id,
        path: file.path,
        bytes: String(info.size),
        sha256: hash ? await sha256File(path) : PLACEHOLDER_SHA256,
        role: file.role,
        modifiedAt: info.mtime.toISOString(),
      });
    } catch {
      missing.push(file.id);
    }
  }
  return { observed, missing };
}

const lossCounts = (manifest: ImportManifest) => {
  const counts = new Map<string, number>();
  for (const loss of manifest.losses) counts.set(loss.code, (counts.get(loss.code) ?? 0) + 1);
  return [...counts].map(([code, count]) => ({ code, count })).sort((a, b) => a.code.localeCompare(b.code));
};

/** A best-effort source becomes a reviewed loss instead of a refusal. */
async function readManifest(source: OpenedPreparationSource, input: PreparationSourceInput, hash: boolean) {
  const { observed, missing } = await observe(source, input.originalsRoot, hash);
  // ponytail: refuse rather than skip; readers require evidence for every original they reference.
  if (missing.length > 0) throw new LibraryImportRefused('IMPORT_SOURCE_ORIGINALS_MISSING');
  const { manifest, archive } = await source.manifest(observed);
  manifest.source = input.source;
  if (!source.tested) manifest.losses.push({ code: UNTESTED_VERSION_LOSS, acknowledged: false });
  return { manifest, archive };
}

/** Review-only pass: what will come over, who owns it and what will not. Writes nothing. */
export async function inspectPreparationSource(adapter: PreparationAdapter, input: PreparationSourceInput) {
  const source = await adapter.open(input);
  try {
    const { manifest } = await readManifest(source, input, false);
    const owners = await source.owners();
    const assetsByOwner = Map.groupBy(manifest.assets, (asset) => asset.ownerId);
    const files = new Map(manifest.files.map((file) => [file.id, file]));
    let bytes = 0n;
    for (const file of files.values()) bytes += BigInt(file.bytes);
    return {
      format: 'frameleaf-library-import-inspection' as const,
      source: input.source,
      tested: source.tested,
      testedVersion: source.testedVersion,
      summary: {
        owners: manifest.users.length,
        assets: manifest.assets.length,
        albums: manifest.albums.length,
        files: manifest.files.length,
        bytes: String(bytes),
      },
      owners: manifest.users.map((user) => {
        const owner = owners.find((candidate) => candidate.sourceId === user.id);
        return {
          sourceId: user.id,
          name: owner?.name || user.name,
          email: owner?.email ?? null,
          assets: assetsByOwner.get(user.id)?.length ?? 0,
          restrictions: restrictionReasons(owner?.login ?? { ...unrestrictedLogin, otherRestrictions: 'present' }),
        };
      }),
      losses: lossCounts(manifest),
    };
  } finally {
    await source.close();
  }
}

/** Full preparation: hash originals, review placements and publish the sealed bundle. */
export async function preparePreparationSource(
  adapter: PreparationAdapter,
  input: PreparationSourceInput & {
    operationId: string;
    destinationId: string;
    stagingRoot: string;
    /** The destination media mount, `/data` inside the preparation container. */
    destinationRoot: string;
    approvedLossCodes: ReadonlySet<string>;
    owners: PreparationOwnerChoice[];
    verifySource: () => Promise<void>;
  },
) {
  await input.verifySource();
  const source = await adapter.open(input);
  try {
    const { manifest, archive } = await readManifest(source, input, true);
    const choices = new Map(input.owners.map((owner) => [owner.sourceId, owner]));
    if (choices.size !== input.owners.length || manifest.users.some((user) => !choices.has(user.id)))
      throw new LibraryImportRefused('IMPORT_OWNER_MAPPING_INCOMPLETE');
    const sourceOwners = new Map((await source.owners()).map((owner) => [owner.sourceId, owner]));
    const revision = input.source.revision;
    const owners = [];
    for (const user of manifest.users) {
      const choice = choices.get(user.id)!;
      const sourceOwner = sourceOwners.get(user.id);
      // An owner the adapter cannot describe is imported as restricted, never as an open account.
      const login: SourceLogin = sourceOwner?.login ?? { ...unrestrictedLogin, otherRestrictions: 'present' };
      const reasons = restrictionReasons(login);
      if (reasons.length > 0 && !choice.acknowledgeRestrictions)
        throw new LibraryImportRefused('IMPORT_OWNER_RESTRICTIONS_NOT_ACKNOWLEDGED');
      const credential = sourceOwner
        ? await sourceOwner.password({
            operationId: input.operationId,
            sourceUserId: user.id,
            destinationUserId: choice.destinationId,
          })
        : undefined;
      const disposition =
        reasons.length > 0
          ? { kind: 'restricted', reasons, acknowledged: true, credential: credential ? 'preserve' : 'unavailable' }
          : credential
            ? { kind: 'preserve' }
            : { kind: 'claim', reason: 'no-local-verifier', claimPermitted: true };
      const intent = parseImportedOwnerIntent({
        sourceUserId: user.id,
        email: choice.email,
        login: { ...login, revision, snapshotSha256: revision },
        disposition,
      });
      owners.push({ intent, credential });
    }
    const files = new Map(manifest.files.map((file) => [file.id, file]));
    const placed = new Set<string>();
    const placements = [];
    for (const asset of manifest.assets) {
      const owner = choices.get(asset.ownerId)!.destinationId;
      for (const fileId of asset.fileIds) {
        const file = files.get(fileId)!;
        // Flat per owner: the read-only preparation can't create folders, so the Manager creates only
        // `library/<owner>` before preparing. The hash prefix keeps same-named files from different folders apart.
        const name = createHash('sha256').update(file.id).digest('hex').slice(0, 16) + '-' + posix.basename(file.path);
        const destinationPath = posix.join('library', owner, name);
        if (placed.has(destinationPath)) continue;
        placed.add(destinationPath);
        placements.push({
          id: `${asset.id}:${file.id}`,
          sourceAssetId: asset.id,
          sourceFileId: file.id,
          mode: 'copy',
          sourceRoot: 'source',
          sourcePath: file.path,
          destinationRoot: 'destination',
          destinationPath,
          expectedBytes: file.bytes,
          expectedSha256: file.sha256,
        });
      }
    }
    const roots = [];
    for (const [id, path] of [
      ['source', input.originalsRoot],
      ['destination', input.destinationRoot],
    ]) {
      const info = await stat(path, { bigint: true });
      roots.push({ id, path, device: String(info.dev), inode: String(info.ino) });
    }
    const bundle = await publishAdapterImportBundle({
      manifest,
      archive: archive as Parameters<typeof publishAdapterImportBundle>[0]['archive'],
      approvedLossCodes: input.approvedLossCodes,
      roots,
      placements,
      ownerMappings: input.owners.map(({ sourceId, destinationId }) => ({ sourceId, destinationId })),
      owners,
      stagingRoot: input.stagingRoot,
      operationId: input.operationId,
      destinationId: input.destinationId,
      verifySource: input.verifySource,
    });
    return bundle;
  } finally {
    await source.close();
  }
}
