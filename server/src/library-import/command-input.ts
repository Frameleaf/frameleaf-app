import { createHash } from 'node:crypto';
import { type BigIntStats, constants } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Refusal } from '#library-import-transfer/contracts';
import { openImportRoot } from '#library-import-transfer/import-copy';
import { sourceKinds } from 'src/library-import/manifest.js';

const actions = ['preflight', 'run', 'status', 'resume', 'verify', 'rollback', 'abandon'] as const;
const path = z
  .string()
  .min(2)
  .max(4096)
  .refine(
    (value) =>
      value.startsWith('/') &&
      resolve(value) === value &&
      !value.endsWith('/') &&
      !value.includes('\\') &&
      [...value].every((character) => character >= ' '),
  );
export { path as privateImportPathSchema };
const argumentsSchema = z
  .strictObject({
    action: z.enum(actions),
    source: z.enum(sourceKinds),
    configPath: path,
    activate: z.literal(true).optional(),
  })
  .refine((value) => !value.activate || value.action === 'verify');
const configSchema = z.strictObject({
  format: z.literal('frameleaf-library-import-command'),
  version: z.literal(1),
  operationId: z.uuid().transform((value) => value.toLowerCase()),
  destinationId: z.uuid().transform((value) => value.toLowerCase()),
  bundleDirectory: path,
  stateDirectory: path,
  bootstrapAdmin: z
    .strictObject({
      userId: z.uuid().transform((value) => value.toLowerCase()),
      path,
    })
    .optional(),
});
export type LibraryImportCommandConfig = z.infer<typeof configSchema>;

export function parseLibraryImportArguments(args: string[]) {
  try {
    const { values, positionals, tokens } = parseArgs({
      args,
      allowPositionals: true,
      strict: true,
      tokens: true,
      options: { source: { type: 'string' }, config: { type: 'string' }, activate: { type: 'boolean' } },
    });
    if (
      positionals.length !== 1 ||
      ['source', 'config'].some(
        (name) => tokens.filter((token) => token.kind === 'option' && token.name === name).length !== 1,
      ) ||
      tokens.filter((token) => token.kind === 'option' && token.name === 'activate').length > 1
    )
      throw new Error('Invalid import command arguments');
    return argumentsSchema.parse({
      action: positionals[0],
      source: values.source,
      configPath: values.config,
      ...(values.activate && { activate: true }),
    });
  } catch {
    throw new Refusal('import_command_arguments_invalid');
  }
}

const same = (before: BigIntStats, after: BigIntStats) =>
  before.dev === after.dev &&
  before.ino === after.ino &&
  before.size === after.size &&
  before.mtimeNs === after.mtimeNs &&
  before.ctimeNs === after.ctimeNs &&
  before.nlink === after.nlink;

/** Private bundle metadata only. Originals are resolved separately through the reviewed transfer plan. */
export async function openPrivateImportFile(filename: string): Promise<FileHandle> {
  if (!path.safeParse(filename).success) throw new Refusal('import_private_input_unavailable');
  const root = await openImportRoot(dirname(filename));
  let file: FileHandle | undefined;
  try {
    const directory = await root.stat({ bigint: true });
    if ((directory.mode & 0o777n) !== 0o700n || directory.uid !== BigInt(process.geteuid?.() ?? -1))
      throw new Refusal('import_private_input_unavailable');
    file = await open(
      `/proc/self/fd/${root.fd}/${basename(filename)}`,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const info = await file.stat({ bigint: true });
    if (!info.isFile() || info.nlink !== 1n || (info.mode & 0o777n) !== 0o600n || info.uid !== directory.uid)
      throw new Refusal('import_private_input_unavailable');
    await root.close();
    return file;
  } catch {
    await Promise.allSettled([root.close(), file?.close()]);
    throw new Refusal('import_private_input_unavailable');
  }
}

export async function readPrivateImportJSON(filename: string, limit: number) {
  let file: FileHandle | undefined;
  try {
    file = await openPrivateImportFile(filename);
    const before = await file.stat({ bigint: true });
    if (before.size > BigInt(limit)) throw new Error('Private import input exceeds its limit');
    const bytes = await file.readFile();
    if (bytes.length > limit || !same(before, await file.stat({ bigint: true })))
      throw new Error('Private import input changed');
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') };
  } catch {
    throw new Refusal('import_private_input_unavailable');
  } finally {
    await file?.close();
  }
}

export async function loadLibraryImportConfig(configPath: string): Promise<LibraryImportCommandConfig> {
  const { value } = await readPrivateImportJSON(configPath, 65_536);
  const parsed = configSchema.safeParse(value);
  if (
    !parsed.success ||
    parsed.data.bundleDirectory === parsed.data.stateDirectory ||
    (parsed.data.bootstrapAdmin?.path &&
      (basename(parsed.data.bootstrapAdmin.path) !== 'bootstrap-admin.json' ||
        dirname(parsed.data.bootstrapAdmin.path) !== dirname(configPath)))
  )
    throw new Refusal('import_command_configuration_invalid');
  return parsed.data;
}
