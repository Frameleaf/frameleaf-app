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
/** FL-1505: recorded for each photo that was merged into an identical one. Reported, never asked about. */
export const IDENTICAL_MERGED_LOSS = 'SOURCE_IDENTICAL_ORIGINALS_MERGED';
/** Destination media mount inside the preparation container. */
export const DESTINATION_ROOT = '/data';
/** The review-only pass reads no bytes: every observed file carries this hash instead. */
export const PLACEHOLDER_SHA256 = '0'.repeat(64);

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

/**
 * FL-1505 (owner 2026-11-12, "merge and report"): Frameleaf keeps one photo per owner for the same bytes, and
 * the plan refuses two. A library that holds a photo twice (the same file in two folders) is merged here, after
 * hashing: the copy kept is the Locked one if any, then the one with the most files, then the first; it joins
 * every album either copy was in; each merged copy is a loss in the import's record (its own description, tags
 * and favourite do not come across). The review pass reads no bytes, so it cannot ask first.
 * ponytail: a copy in a stack or a Live Photo pair is left alone, and the plan still refuses that library;
 * merging those needs the pair rules too.
 */
export function mergeIdenticalOriginals(manifest: ImportManifest): number {
  type Asset = ImportManifest['assets'][number];
  // one array type for every manifest version; edited in place
  const assets: Asset[] = manifest.assets;
  const files = new Map(manifest.files.map((file) => [file.id, file]));
  const paired = new Set<string>();
  if ('stacks' in manifest) for (const stack of manifest.stacks) for (const id of stack.assetIds) paired.add(id);
  if ('livePhotos' in manifest)
    for (const pair of manifest.livePhotos) paired.add(pair.photoAssetId).add(pair.videoAssetId);
  const primarySha = (asset: Asset) =>
    files.get(
      'primaryFileId' in asset ? asset.primaryFileId : asset.fileIds.find((id) => files.get(id)!.role === 'original')!,
    )!.sha256;
  const isLocked = (asset: Asset) => asset.visibility === 'locked' || asset.locked === true;
  const groups = Map.groupBy(
    assets.filter((asset) => !paired.has(asset.id)),
    (asset) => JSON.stringify([asset.ownerId, primarySha(asset)]),
  );
  const mergedInto = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const [kept] = group.toSorted(
      (a, b) => Number(isLocked(b)) - Number(isLocked(a)) || b.fileIds.length - a.fileIds.length,
    );
    for (const asset of group) if (asset !== kept) mergedInto.set(asset.id, kept.id);
  }
  if (mergedInto.size === 0) return 0;
  const dropped = new Set<string>();
  for (let index = assets.length - 1; index >= 0; index--) {
    if (!mergedInto.has(assets[index].id)) continue;
    for (const id of assets[index].fileIds) dropped.add(id);
    assets.splice(index, 1);
  }
  // a file the kept copies still use stays
  for (const asset of assets) for (const id of asset.fileIds) dropped.delete(id);
  for (let index = manifest.files.length - 1; index >= 0; index--)
    if (dropped.has(manifest.files[index].id)) manifest.files.splice(index, 1);
  for (const album of manifest.albums)
    album.assetIds = [...new Set(album.assetIds.map((id) => mergedInto.get(id) ?? id))];
  for (const id of mergedInto.keys())
    manifest.losses.push({ code: IDENTICAL_MERGED_LOSS, entityId: id, acknowledged: false });
  return mergedInto.size;
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
    const merged = mergeIdenticalOriginals(manifest);
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
      // the merge is reported, not asked about: the review could not have shown it
      approvedLossCodes:
        merged > 0 ? new Set([...input.approvedLossCodes, IDENTICAL_MERGED_LOSS]) : input.approvedLossCodes,
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
