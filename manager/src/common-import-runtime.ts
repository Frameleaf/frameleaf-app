import { lstat, mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { DATABASE_PASSWORD_FILE } from './compose.js';
import { imageDigest, Refusal } from './contracts.js';
import { atomicJson, atomicSecret } from './files.js';

const bootstrapName = 'bootstrap-admin.json';
const configTarget = '/run/frameleaf/import-private';
const bundleTarget = '/run/frameleaf/import-bundle';
const stateTarget = '/run/frameleaf/import-state';
export const COMMON_IMPORT_CONFIG = `${configTarget}/command.json`;

async function privateDirectory(path: string, create = false) {
  if (create) {
    await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
  }
  const info = await lstat(path);
  if (!info.isDirectory() || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== 0o700)
    throw new Refusal('import_runtime_directory_unsafe');
}

/** Called under the Manager operation lock with an operation-private root. */
export async function prepareCommonImportRuntime(
  root: string,
  operationId: string,
  destinationId: string,
  bundleName = 'bundle',
  bootstrapAdminId?: string,
) {
  if (
    ![operationId, destinationId, ...(bootstrapAdminId === undefined ? [] : [bootstrapAdminId])].every(
      (id) => z.uuid().safeParse(id).success,
    )
  )
    throw new Refusal('invalid_import_authority');
  const prefix = `bundle-${operationId}-`;
  if (
    bundleName !== 'bundle' &&
    (!bundleName.startsWith(prefix) || !/^[a-zA-Z0-9]{6}$/u.test(bundleName.slice(prefix.length)))
  )
    throw new Refusal('import_runtime_bundle_invalid');
  await privateDirectory(root);
  const config = join(root, 'config');
  const bundle = join(root, bundleName);
  const state = join(root, 'state');
  await privateDirectory(bundle);
  await privateDirectory(config, true);
  await privateDirectory(state, true);
  const filename = join(config, 'command.json');
  const expected = {
    format: 'frameleaf-library-import-command',
    version: 1,
    operationId,
    destinationId,
    bundleDirectory: bundleTarget,
    stateDirectory: stateTarget,
    ...(bootstrapAdminId && { bootstrapAdmin: { userId: bootstrapAdminId, path: `${configTarget}/${bootstrapName}` } }),
  };
  const existing = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (existing) {
    if (
      !existing.isFile() ||
      existing.nlink !== 1 ||
      existing.uid !== process.geteuid?.() ||
      (existing.mode & 0o777) !== 0o600 ||
      existing.size > 65_536 ||
      (await readFile(filename, 'utf8')) !== JSON.stringify(expected, null, 2)
    )
      throw new Refusal('import_runtime_configuration_changed');
  } else await atomicJson(filename, expected);
  const directory = await open(root, 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
  return [
    { source: config, target: configTarget, read_only: true },
    { source: bundle, target: bundleTarget, read_only: true },
    { source: state, target: stateTarget, read_only: false },
  ].map((mount) => ({
    ...mount,
    source: mount.source.replaceAll('$', () => '$$'),
    type: 'bind' as const,
    bind: { create_host_path: false },
  }));
}

export async function writeCommonImportCompose(
  directory: string,
  project: string,
  operationId: string,
  destinationId: string,
  media: { source: string; target: string; readOnly: boolean }[],
  bundleName?: string,
  bootstrapAdminId?: string,
) {
  const mounts = z
    .array(
      z.strictObject({
        source: z.string().refine((value) => value !== '/' && resolve(value) === value && !value.includes('\0')),
        target: z.string().regex(/^\/(?:data|import-media\/[a-z0-9][a-z0-9_-]*)$/u),
        readOnly: z.boolean(),
      }),
    )
    .safeParse(media);
  if (
    !mounts.success ||
    !mounts.data.some((mount) => mount.target === '/data' && !mount.readOnly) ||
    new Set(mounts.data.map((mount) => mount.target)).size !== mounts.data.length ||
    mounts.data.some(
      ({ source }) => source === directory || source.startsWith(directory + '/') || directory.startsWith(source + '/'),
    )
  )
    throw new Refusal('import_runtime_media_invalid');

  const stack = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8'));
  const image = imageDigest.safeParse(stack.services?.['frameleaf-server']?.image);
  if (stack.name !== project || !image.success) throw new Refusal('invalid_import_authority');

  const root = join(directory, `import-runtime-${operationId}`);
  const volumes = await prepareCommonImportRuntime(root, operationId, destinationId, bundleName, bootstrapAdminId);
  const passwordPath = join(directory, DATABASE_PASSWORD_FILE);
  const info = await lstat(passwordPath);
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size === 0 ||
    info.size > 4096
  )
    throw new Refusal('import_runtime_database_secret_unavailable');
  const url = new URL('postgresql://frameleaf@database:5432/frameleaf');
  url.password = await readFile(passwordPath, 'utf8');
  await atomicSecret(join(root, 'config', 'database-url'), url.toString());

  const compose = join(root, 'compose.json');
  await atomicJson(compose, {
    services: {
      'frameleaf-server': {
        image: image.data,
        restart: 'no',
        environment: {
          DB_URL_FILE: `${configTarget}/database-url`,
          FRAMELEAF_MEDIA_LOCATION: '/data',
          FRAMELEAF_MANAGER_INSTALLATION: project.slice('frameleaf-'.length),
          FRAMELEAF_IMPORT_MANAGER_OPERATION_ID: operationId,
        },
        labels: {
          'app.frameleaf.manager': project.slice('frameleaf-'.length),
          'app.frameleaf.manager.import': operationId,
        },
        logging: { driver: 'none' },
        volumes: [
          ...volumes,
          ...mounts.data.map((mount) => ({
            type: 'bind',
            source: mount.source.replaceAll('$', () => '$$'),
            target: mount.target,
            read_only: mount.readOnly,
            bind: { create_host_path: false },
          })),
        ],
      },
    },
    networks: { default: { external: true, name: `${project}_default` } },
  });
  return compose;
}

/** The caller has saved the preflight receipt or completed rollback. */
export async function removeCommonImportBootstrap(directory: string, operationId: string) {
  if (!z.uuid().safeParse(operationId).success) throw new Refusal('invalid_import_authority');
  const root = join(directory, `import-runtime-${operationId}`);
  const config = join(root, 'config');
  try {
    await privateDirectory(root);
    await privateDirectory(config);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await rm(join(config, bootstrapName), { force: true });
  const handle = await open(config, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const CommonImportBootstrapCredentials = z.strictObject({
  email: z
    .email()
    .max(254)
    .transform((value) => value.toLowerCase()),
  name: z.string().trim().min(1).max(200),
  password: z
    .string()
    .min(8)
    .refine((value) => Buffer.byteLength(value) <= 72 && !value.includes('\0')),
});

/** Stage reviewed credentials under the operation lock. Only identifiers go in the Manager journal. */
export async function stageCommonImportBootstrap(
  directory: string,
  identity: { operationId: string; destinationId: string; userId: string },
  input: unknown,
) {
  const { operationId, destinationId, userId } = identity;
  const credentials = CommonImportBootstrapCredentials.safeParse(input);
  if (!credentials.success || ![operationId, destinationId, userId].every((id) => z.uuid().safeParse(id).success))
    throw new Refusal('import_runtime_bootstrap_invalid');
  const root = join(directory, `import-runtime-${operationId}`);
  const config = join(root, 'config');
  await privateDirectory(root);
  await privateDirectory(config);
  const path = join(config, bootstrapName);
  const value = { operationId, destinationId, userId, ...credentials.data };
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (!info) {
    await atomicJson(path, value);
    return;
  }
  if (
    !info.isFile() ||
    info.nlink !== 1 ||
    info.uid !== process.geteuid?.() ||
    (info.mode & 0o777) !== 0o600 ||
    info.size > 8192 ||
    (await readFile(path, 'utf8')) !== JSON.stringify(value, null, 2)
  )
    throw new Refusal('import_runtime_bootstrap_changed');
}
