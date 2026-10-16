import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import z from 'zod';
import type { DesktopModelProfile } from 'src/utils/desktop-model-catalogue.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const relative = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (value) =>
      !/[\\:]/.test(value) &&
      !/\p{Control}/u.test(value) &&
      value
        .split('/')
        .every(
          (part) =>
            !!part &&
            part !== '.' &&
            part !== '..' &&
            !/[. ]$/.test(part) &&
            !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(part.split('.', 1)[0]),
        ),
  );
const manifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  protocolVersion: z.literal(1),
  epoch: safeInteger.positive(),
  platform: z.enum(['macos', 'windows', 'linux']),
  architecture: z.enum(['aarch64', 'x86_64']),
  provider: z.string().min(1).max(64),
  sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
  python: relative,
  files: z.record(relative, z.strictObject({ sha256: digest, bytes: safeInteger.max(16 * 1024 ** 3) })),
});
const policySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    minimumRuntimeEpoch: safeInteger.positive(),
    keys: z
      .array(z.strictObject({ id: z.string().regex(/^[a-z0-9-]{1,64}$/), publicKeyHex: digest }))
      .min(1)
      .max(16),
  })
  .refine(
    (value) =>
      new Set(value.keys.map((key) => key.id)).size === value.keys.length &&
      new Set(value.keys.map((key) => key.publicKeyHex)).size === value.keys.length,
  );
const profilesSchema = z.strictObject({
  schemaVersion: z.literal(1),
  profiles: z.record(
    z.string(),
    z.strictObject({
      python: z.string(),
      uv: z.string(),
      extra: z.string(),
      provider: z.string(),
      targets: z.array(z.string()),
    }),
  ),
});
const base64 = (maxBytes: number) =>
  z
    .string()
    .min(1)
    .max(4 * Math.ceil(maxBytes / 3))
    .transform((value, context) => {
      const bytes = Buffer.from(value, 'base64');
      if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString('base64') !== value) {
        context.addIssue({ code: 'custom', message: 'desktop_runtime_base64_invalid' });
        return z.NEVER;
      }
      return bytes;
    });
const envelopeSchema = z.strictObject({
  manifestGzipBase64: base64(2 * 1024 * 1024),
  signatureBase64: base64(64).refine((value) => value.length === 64),
});
const resource = (name: string): unknown =>
  JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/desktop', name), 'utf8'));

/** Establishes factory release identity only; does not prove local execution or authorize a model grant. */
export const verifyDesktopRuntimeAttestation = (input: unknown, profile: DesktopModelProfile) => {
  const envelope = envelopeSchema.parse(input);
  const raw = gunzipSync(envelope.manifestGzipBase64, { maxOutputLength: 8 * 1024 * 1024 });
  const policy = policySchema.parse(resource('release-trust.json'));
  const valid = policy.keys.some((authority) => {
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(authority.publicKeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, raw, key, envelope.signatureBase64);
  });
  if (!valid) throw new Error('desktop_runtime_signature_invalid');
  const manifest = manifestSchema.parse(JSON.parse(raw.toString('utf8')));
  const profiles = profilesSchema.parse(resource('runtime-profiles.json'));
  const names = Object.keys(manifest.files);
  if (
    manifest.epoch < policy.minimumRuntimeEpoch ||
    manifest.sourceRevision !== profile.runtimeSourceRevision ||
    manifest.provider !== profile.spec.provider ||
    Object.values(profiles.profiles).every(
      (approved) =>
        !(
          approved.provider === manifest.provider &&
          approved.targets.includes(`${manifest.platform}-${manifest.architecture}`)
        ),
    ) ||
    !Object.hasOwn(manifest.files, manifest.python) ||
    names.length === 0 ||
    names.length > 100_000 ||
    new Set(names.map((name) => name.toLowerCase())).size !== names.length ||
    Object.values(manifest.files).reduce((sum, file) => sum + file.bytes, 0) > 32 * 1024 ** 3
  )
    throw new Error('desktop_runtime_incompatible');
  return {
    manifestSha256: createHash('sha256').update(raw).digest('hex'),
    sourceRevision: manifest.sourceRevision,
    provider: manifest.provider,
    epoch: manifest.epoch,
    platform: manifest.platform,
    architecture: manifest.architecture,
  };
};

export const desktopRuntimeMinimumEpoch = () => policySchema.parse(resource('release-trust.json')).minimumRuntimeEpoch;
