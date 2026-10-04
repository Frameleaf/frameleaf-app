/* eslint-disable no-restricted-imports -- Shared by the compiled server and offline recovery tool. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import z from 'zod';
import { parseHelpLinks } from './app-releases.ts';
import { BUDDY_UUID } from './buddy-backup-crypto.ts';
import { createBuddyDirectory, writeBuddyFile } from './buddy-backup-vault.ts';
import { ENV_ALIASES, resolveEnvAliases } from './env-aliases.ts';
import { EnvSchema } from './environment-schema.ts';

// Private capture grants no activation authority, including for identity/link/security inputs.
// The authoritative schema owns the complete canonical registry; old aliases are not declarations.
const keys = Object.keys(EnvSchema.shape).filter((key) => !key.startsWith('IMMICH_'));
const keySchema = z.enum(keys);
const hasShutdownContext = (names: string[]) =>
  names.includes('FRAMELEAF_SHUTDOWN_GRACE_SECONDS') === names.includes('FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS');
export const BuddyBootDeclarationSchema = z.strictObject({
  version: z.literal(1),
  environmentKeys: z
    .array(keySchema)
    .max(keys.length)
    .refine((values) => new Set(values).size === values.length)
    .refine(hasShutdownContext, 'Declare both shutdown grace and deadline inputs together'),
});
export type BuddyBootDeclaration = z.infer<typeof BuddyBootDeclarationSchema>;
const valueSchema = z.union([z.string(), z.number().finite(), z.boolean(), z.array(z.string())]);
const configurationSchema = z.strictObject({
  version: z.literal(1),
  entries: z
    .array(
      z.union([
        z.strictObject({ key: keySchema, state: z.literal('unset') }),
        z.strictObject({ key: keySchema, state: z.literal('value'), value: valueSchema }),
      ]),
    )
    .max(keys.length)
    .refine((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length)
    .refine((entries) => hasShutdownContext(entries.map((entry) => entry.key)), 'Incomplete declared shutdown context'),
});
export type BuddyBootConfiguration = z.infer<typeof configurationSchema>;
const helpLinkKeys = {
  FRAMELEAF_DOCS_URL: 'documentationUrl',
  FRAMELEAF_SUPPORT_URL: 'supportUrl',
  FRAMELEAF_BUG_FEATURE_URL: 'bugFeatureUrl',
  FRAMELEAF_SOURCE_URL: 'sourceUrl',
} as const;

const effectiveBuddyBootValues = (raw: Record<string, string | undefined>): Record<string, unknown> => {
  const parsed = EnvSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid declared boot configuration values');
  try {
    // Same canonical precedence, normalization and invalid-legacy handling as ConfigRepository.getEnv.
    const helpLinks = parseHelpLinks(parsed.data);
    return {
      ...parsed.data,
      ...Object.fromEntries(Object.entries(helpLinkKeys).map(([key, name]) => [key, helpLinks[name]])),
    };
  } catch {
    // The underlying URL diagnostics may contain input values; never expose those through recovery.
    throw new Error('Invalid declared boot configuration values');
  }
};

/** Validate typed effective values through the same parser, including cross-field constraints. */
export const readBuddyBootConfiguration = (input: unknown): BuddyBootConfiguration => {
  const checked = configurationSchema.safeParse(input);
  if (!checked.success) throw new Error('Invalid declared boot configuration');
  const raw = Object.fromEntries(
    checked.data.entries.map((entry) => [
      entry.key,
      entry.state === 'unset'
        ? undefined
        : Array.isArray(entry.value)
          ? entry.value.join(',') || ' ' // Preserve explicit empty lists separately from normalized unset values.
          : String(entry.value),
    ]),
  );
  const effective = effectiveBuddyBootValues(raw);
  for (const entry of checked.data.entries) {
    if (entry.state === 'value' && JSON.stringify(effective[entry.key]) !== JSON.stringify(entry.value))
      throw new Error('Declared boot configuration value is not canonical');
  }
  return checked.data;
};

export const captureBuddyBootConfiguration = (declaration: unknown): BuddyBootConfiguration => {
  const checked = BuddyBootDeclarationSchema.safeParse(declaration);
  if (!checked.success) throw new Error('Invalid declared boot configuration');
  const selected: Record<string, string | undefined> = {};
  for (const key of checked.data.environmentKeys) {
    selected[key] = process.env[key];
    for (const alias of ENV_ALIASES) {
      if (alias.current === key) selected[alias.legacy] = process.env[alias.legacy];
    }
  }
  const { env } = resolveEnvAliases(selected);
  const effective = effectiveBuddyBootValues(env);
  return readBuddyBootConfiguration({
    version: 1,
    entries: checked.data.environmentKeys.map((key) =>
      (Object.hasOwn(helpLinkKeys, key) ? effective[key] : env[key]) === undefined || effective[key] === undefined
        ? { key, state: 'unset' }
        : { key, state: 'value', value: effective[key] },
    ),
  });
};

/** Private staging only. The snapshot grants no authority to activate or publish historical values. */
export const stageBuddyBootConfiguration = async (
  directory: string,
  snapshotId: string,
  input: unknown,
  authorize?: () => Promise<void>,
) => {
  if (!BUDDY_UUID.test(snapshotId)) throw new Error('Invalid boot configuration snapshot binding');
  const configuration = readBuddyBootConfiguration(input);
  await createBuddyDirectory(directory);
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || (metadata.mode & 0o777) !== 0o700)
    throw new Error('Boot configuration staging requires a private regular directory');
  await writeBuddyFile(
    join(directory, 'boot-configuration.json'),
    JSON.stringify({ ...configuration, snapshotId }),
    false,
    authorize,
  );
};
