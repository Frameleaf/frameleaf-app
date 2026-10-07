/* eslint-disable no-restricted-imports -- Pre-application startup must use only pure relative imports. */
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import z from 'zod';
import { parseHelpLinks } from './app-releases.ts';
import { BUDDY_UUID } from './buddy-backup-crypto.ts';
import { buddyRecoveryTarget, readBuddyRecovery } from './buddy-backup-recovery.ts';
import { writeBuddyFile } from './buddy-backup-vault.ts';
import { BuddyBootDeclarationSchema, readBuddyBootConfiguration } from './buddy-boot-configuration.ts';
import { ENV_ALIASES, resolveEnvAliases } from './env-aliases.ts';
import { EnvSchema } from './environment-schema.ts';
import { parseWorkerSelection } from './environment-values.ts';

// Capture alone never authorizes identity/security, deployment profiles,
// feature enabling or dependency credentials.
const applicationKeys = new Set([
  'FRAMELEAF_PORT',
  'FRAMELEAF_HOST',
  'FRAMELEAF_LOG_LEVEL',
  'FRAMELEAF_LOG_FORMAT',
  'FRAMELEAF_SHUTDOWN_GRACE_SECONDS',
  'FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS',
  'FRAMELEAF_DOCS_URL',
  'FRAMELEAF_SUPPORT_URL',
  'FRAMELEAF_BUG_FEATURE_URL',
  'FRAMELEAF_SOURCE_URL',
  'NO_COLOR',
]);
const workerKeys = ['FRAMELEAF_WORKERS_INCLUDE', 'FRAMELEAF_WORKERS_EXCLUDE'];
const mediaKey = 'FRAMELEAF_MEDIA_LOCATION';
const mountSchema = z.strictObject({
  roots: z
    .array(
      z.strictObject({
        path: z
          .string()
          .refine((path) => isAbsolute(path) && resolve(path) === path && path !== '/' && !path.includes('\0')),
        device: z.string().regex(/^(0|[1-9]\d*)$/),
        inode: z.string().regex(/^[1-9]\d*$/),
      }),
    )
    .min(1)
    .refine((roots) => new Set(roots.map((root) => root.path)).size === roots.length),
});
const bindingSchema = z
  .strictObject({
    version: z.literal(1),
    state: z.enum(['request', 'ready']),
    recoveryId: z.string().regex(BUDDY_UUID),
    snapshotId: z.string().regex(BUDDY_UUID),
    vaultId: z.string().regex(BUDDY_UUID),
    replacementIdentity: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    scope: z.enum(['server', 'settings']),
    mode: z.enum(['keep', 'replace']),
    environmentKeys: BuddyBootDeclarationSchema.shape.environmentKeys,
    workerService: z.literal('supervisor').optional(),
    mountService: mountSchema.optional(),
    recoveryDirectory: z.string(),
    artifactDigest: z.string().regex(/^[\da-f]{64}$/),
    preparedDigest: z.string().regex(/^[\da-f]{64}$/),
  })
  .refine(
    (binding) =>
      binding.environmentKeys.every(
        (key) =>
          applicationKeys.has(key) ||
          (binding.workerService && workerKeys.includes(key)) ||
          (binding.mountService && key === mediaKey),
      ) &&
      (!binding.workerService ||
        (binding.scope === 'server' && workerKeys.every((key) => binding.environmentKeys.includes(key)))) &&
      (!binding.mountService || (binding.scope === 'server' && binding.environmentKeys.includes(mediaKey))),
  );
type BootBinding = z.infer<typeof bindingSchema>;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const refusal = () => new Error('Invalid replacement-local Buddy boot authority');

/** Bound, private, owned file reads; never follow a historical path or disclose parser errors. */
const readPrivateBootFile = async (path: string, limit = 1024 * 1024): Promise<Buffer> => {
  if (!isAbsolute(path) || resolve(path) !== path || path.includes('\0')) throw refusal();
  for (let ancestor = dirname(path); ; ancestor = dirname(ancestor)) {
    const metadata = await lstat(ancestor);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw refusal();
    if (ancestor === dirname(path) && ((metadata.mode & 0o777) !== 0o700 || metadata.uid !== process.getuid?.()))
      throw refusal();
    if (dirname(ancestor) === ancestor) break;
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    if (
      !before.isFile() ||
      (before.mode & 0o777n) !== 0o600n ||
      before.uid !== BigInt(process.getuid?.() ?? -1) ||
      before.size > BigInt(limit)
    )
      throw refusal();
    const bytes = await file.readFile();
    const after = await file.stat({ bigint: true });
    if (
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw refusal();
    return bytes;
  } finally {
    await file.close();
  }
};

const readBootBinding = async (path: string, bytes?: Buffer): Promise<BootBinding> => {
  const result = bindingSchema.safeParse(JSON.parse((bytes ?? (await readPrivateBootFile(path))).toString()));
  if (!result.success) throw refusal();
  const binding = result.data;
  if (
    basename(binding.recoveryDirectory) !== binding.recoveryId ||
    basename(dirname(binding.recoveryDirectory)) !== 'recovery'
  )
    throw refusal();
  return binding;
};

const replacementBootIdentity = async (bindingFile: string, env: NodeJS.ProcessEnv) => {
  const { env: local } = resolveEnvAliases(env);
  const directories = local.FRAMELEAF_IDENTITY_DIR
    ? [local.FRAMELEAF_IDENTITY_DIR]
    : (local.FRAMELEAF_MEDIA_LOCATION ? [local.FRAMELEAF_MEDIA_LOCATION] : ['/data', '/usr/src/app/upload']).map(
        (root) => join(root, 'frameleaf', 'identity'),
      );
  const directory = dirname(bindingFile);
  if (!directories.includes(directory)) throw refusal();
  const privateKey = createPrivateKey(await readPrivateBootFile(join(directory, 'instance-key.pem'), 16_384));
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (jwk.kty !== 'OKP' || jwk.crv !== 'Ed25519') throw refusal();
  const identity = createHash('sha256')
    .update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x }))
    .digest('base64url');
  let marker: { action?: { buddyRecoveryId?: string } } | null = null;
  for (const candidate of directories) {
    try {
      const value = JSON.parse(
        (await readPrivateBootFile(join(candidate, 'buddy', 'recovery-active.json'), 8192)).toString(),
      );
      if (
        value.isMaintenanceMode !== true ||
        typeof value.secret !== 'string' ||
        !BUDDY_UUID.test(value.action?.buddyRecoveryId)
      )
        throw refusal();
      if (marker || candidate !== directory) throw refusal();
      marker = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return { identity, marker };
};

const bindingEvidence = async (binding: BootBinding, requireComplete: boolean) => {
  const prepared = await readPrivateBootFile(join(binding.recoveryDirectory, 'prepared.json'), 1024 ** 3);
  const artifact = await readPrivateBootFile(join(binding.recoveryDirectory, 'boot-configuration.json'));
  if (hash(prepared) !== binding.preparedDigest || hash(artifact) !== binding.artifactDigest) throw refusal();
  const plan = await readBuddyRecovery(dirname(dirname(binding.recoveryDirectory)), binding.recoveryId);
  // readBuddyRecovery must refer to the same private bytes, even across a raced replacement.
  if (JSON.stringify(plan) !== JSON.stringify(JSON.parse(prepared.toString()))) throw refusal();
  if (
    plan.scope !== binding.scope ||
    plan.mode !== binding.mode ||
    plan.manifest.snapshotId !== binding.snapshotId ||
    plan.manifest.vaultId !== binding.vaultId
  )
    throw refusal();
  if (binding.scope === 'server' && !plan.manifest.library.database) throw refusal();
  const staged = JSON.parse(artifact.toString());
  if (staged.snapshotId !== binding.snapshotId) throw refusal();
  const { snapshotId: _snapshotId, ...input } = staged;
  const configuration = readBuddyBootConfiguration(input);
  if (JSON.stringify(configuration) !== JSON.stringify(readBuddyBootConfiguration(plan.manifest.bootConfiguration)))
    throw refusal();
  if (binding.environmentKeys.some((key) => configuration.entries.every((entry) => entry.key !== key))) throw refusal();
  if (binding.mountService) {
    const roots = new Set(plan.manifest.storageRoots);
    if (
      !roots.has(plan.manifest.storageRoot) ||
      roots.size !== binding.mountService.roots.length ||
      binding.mountService.roots.some((root) => !roots.has(root.path))
    )
      throw refusal();
  }
  if (requireComplete) {
    const journal = JSON.parse(
      (await readPrivateBootFile(join(binding.recoveryDirectory, 'publication.json'))).toString(),
    );
    if (!z.strictObject({ version: z.literal(2), state: z.literal('complete') }).safeParse(journal).success)
      throw refusal();
  }
  return { configuration, storageRoot: plan.manifest.storageRoot };
};

/** Admit the exact original directories, never a missing mount's fallback directory or a relocated identity. */
const validateMountProfile = async (
  binding: BootBinding,
  path: string,
  env: NodeJS.ProcessEnv,
  storageRoot: string,
  maintenance = false,
) => {
  if (!binding.mountService) return;
  // ponytail: require an explicit media root; default-path discovery needs a separately verified adapter.
  if (resolveEnvAliases(env).env.FRAMELEAF_MEDIA_LOCATION !== storageRoot) throw refusal();
  const roots = binding.mountService.roots.map((root) => root.path);
  for (const root of binding.mountService.roots) {
    await buddyRecoveryTarget(root.path, roots, []);
    const metadata = await lstat(root.path, { bigint: true });
    if (!metadata.isDirectory() || String(metadata.dev) !== root.device || String(metadata.ino) !== root.inode)
      throw refusal();
  }
  const local = await replacementBootIdentity(path, env);
  if (
    local.identity !== binding.replacementIdentity ||
    (maintenance && !local.marker) ||
    (local.marker && local.marker.action?.buddyRecoveryId !== binding.recoveryId)
  )
    throw refusal();
};

/** Validate the entire prospective environment before changing a single selected input. */
const bootEnvironmentOverlay = (
  binding: BootBinding,
  configuration: ReturnType<typeof readBuddyBootConfiguration>,
  env: NodeJS.ProcessEnv,
) => {
  const prospective = { ...env };
  const current = resolveEnvAliases(env).env;
  const parsed = EnvSchema.safeParse(current);
  if (!parsed.success) throw refusal();
  const helpLinks = parseHelpLinks(parsed.data);
  const helpValues: Record<string, string | undefined> = {
    FRAMELEAF_DOCS_URL: helpLinks.documentationUrl,
    FRAMELEAF_SUPPORT_URL: helpLinks.supportUrl,
    FRAMELEAF_BUG_FEATURE_URL: helpLinks.bugFeatureUrl,
    FRAMELEAF_SOURCE_URL: helpLinks.sourceUrl,
  };
  // Keep treats the include/exclude pair as one local deployment profile.
  const keepWorkers = binding.mode === 'keep' && workerKeys.some((key) => current[key] !== undefined);
  for (const key of binding.environmentKeys) {
    if (keepWorkers && workerKeys.includes(key)) continue;
    const aliases = ENV_ALIASES.filter((alias) => alias.current === key).map((alias) => alias.legacy);
    const existing = (Object.hasOwn(helpValues, key) ? helpValues[key] : current[key]) !== undefined;
    if (binding.mode === 'keep' && existing) continue;
    const entry = configuration.entries.find((entry) => entry.key === key)!;
    for (const name of [key, ...aliases]) delete prospective[name];
    if (entry.state === 'value')
      prospective[key] = Array.isArray(entry.value) ? entry.value.join(',') : String(entry.value);
  }
  const checked = EnvSchema.safeParse(resolveEnvAliases(prospective).env);
  if (!checked.success) throw refusal();
  parseHelpLinks(checked.data);
  if (binding.workerService) parseWorkerSelection(checked.data);
  return prospective;
};

export const loadBuddyBootBinding = async () => {
  const path = process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE;
  if (path === undefined) return;
  try {
    const original = await readPrivateBootFile(path);
    const binding = await readBootBinding(path, original);
    const local = await replacementBootIdentity(path, process.env);
    if (
      local.identity !== binding.replacementIdentity ||
      (local.marker && local.marker.action?.buddyRecoveryId !== binding.recoveryId)
    )
      throw refusal();
    const { configuration, storageRoot } = await bindingEvidence(binding, binding.state === 'ready');
    if (local.marker) return; // Resume maintenance on replacement inputs, never historical inputs.
    if (binding.state !== 'ready') throw refusal();
    const prospective = bootEnvironmentOverlay(binding, configuration, process.env);
    await validateMountProfile(binding, path, prospective, storageRoot);
    const current = await replacementBootIdentity(path, process.env);
    if (current.identity !== binding.replacementIdentity || !(await readPrivateBootFile(path)).equals(original))
      throw refusal();
    if (current.marker) {
      if (current.marker.action?.buddyRecoveryId !== binding.recoveryId) throw refusal();
      return;
    }
    // All IO and validation have finished. Apply only selected canonical/alias names.
    // Actual database *_FILE sources remain untouched without a matching service adapter.
    for (const key of binding.environmentKeys) {
      const aliases = ENV_ALIASES.filter((alias) => alias.current === key).map((alias) => alias.legacy);
      for (const name of [key, ...aliases]) {
        if (prospective[name] === undefined) delete process.env[name];
        else process.env[name] = prospective[name];
      }
    }
  } catch {
    throw refusal();
  }
};

/** Finalize an explicit local request only after verified fenced publication completed. */
export const finalizeBuddyBootBinding = async (root: string, id: string, assert: () => Promise<void>) => {
  const path = process.env.FRAMELEAF_BUDDY_BOOT_BINDING_FILE;
  if (path === undefined) return;
  try {
    await assert();
    const original = await readPrivateBootFile(path);
    const binding = await readBootBinding(path, original);
    if (binding.recoveryId !== id || binding.recoveryDirectory !== join(root, 'recovery', id)) throw refusal();
    const local = await replacementBootIdentity(path, process.env);
    if (local.identity !== binding.replacementIdentity || local.marker?.action?.buddyRecoveryId !== id) throw refusal();
    const { configuration, storageRoot } = await bindingEvidence(binding, true);
    const prospective =
      binding.workerService || binding.mountService
        ? bootEnvironmentOverlay(binding, configuration, process.env)
        : process.env;
    await assert();
    if (!(await readPrivateBootFile(path)).equals(original)) throw refusal();
    await validateMountProfile(binding, path, prospective, storageRoot, true);
    if (binding.state === 'ready') return; // Complete retry verifies the same grant idempotently.
    await writeBuddyFile(path, JSON.stringify({ ...binding, state: 'ready' }), false, async () => {
      await assert();
      if (!(await readPrivateBootFile(path)).equals(original)) throw refusal();
      await validateMountProfile(binding, path, prospective, storageRoot, true);
    });
    await assert();
  } catch {
    throw refusal();
  }
};
