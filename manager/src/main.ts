import 'reflect-metadata';
import {
  Body,
  Catch,
  Controller,
  Get,
  Module,
  Post,
  Req,
  Res,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import express, { type Request, type Response } from 'express';
import { chmod, mkdir, readFile, realpath, stat, statfs, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { Docker, command } from './docker.js';
import { Security } from './security.js';
import { Backups } from './backups.js';
import { Releases } from './releases.js';
import { Operations, ReviewInput } from './operations.js';
import { Refusal, publicSource, redact } from './contracts.js';
import { appdataDefaults } from './appdata.js';
import { PostgresStorage } from './postgres-storage.js';

const directory = process.env.MANAGER_DATA;
const origin = process.env.MANAGER_ORIGIN;
if (!directory || directory !== resolve(directory) || !origin)
  throw new Error('MANAGER_DATA and MANAGER_ORIGIN are required');
const store = new Store(directory);
const docker = new Docker();
const bootstrapFile = join(directory, 'claim-key');
const security = new Security(store, origin, bootstrapFile);
const seed = store.get<string>('release-seed') ?? randomBytes(32).toString('hex');
store.createOnce('release-seed', seed);
const releases = new Releases(join(directory, 'releases'), seed);
const backupRoot = process.env.MANAGER_BACKUP_ROOT;
if (!backupRoot || backupRoot !== resolve(backupRoot))
  throw new Error('MANAGER_BACKUP_ROOT must be an absolute mounted directory');
const backups = new Backups(join(backupRoot, 'frameleaf-database'), join(directory, 'recovery-key'));
const unraidConfig = '/run/frameleaf-host/docker.cfg';
async function databaseDefaults() {
  const config = await readFile(unraidConfig, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new Refusal('unraid_configuration_unavailable');
  });
  return appdataDefaults(process.env, config);
}
const defaults = await databaseDefaults();
const databaseStorage = new PostgresStorage(docker, directory, defaults.roots, defaults.platform === 'unraid');
const operations = new Operations(
  store,
  docker,
  releases,
  backups,
  (process.env.MANAGER_STORAGE_ROOTS ?? '').split(':').filter(Boolean),
  databaseStorage,
  process.env.MANAGER_UNRAID_AUTOSTART,
);
const RequestKey = z.string().uuid();
const Password = z.string().min(14).max(256);

@Catch()
class Errors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = error instanceof Refusal ? error.status : error instanceof ZodError ? 400 : 500;
    response.status(status).json({
      code:
        error instanceof Refusal
          ? error.code
          : error instanceof ZodError
            ? 'invalid_request'
            : 'manager_operation_failed',
    });
  }
}

@Controller('manager-api')
class Api {
  @Get('status') status() {
    return { claimed: security.claimed() };
  }

  @Post('claim') async claim(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    const value = z
      .object({ name: z.string().min(1).max(120), password: Password, proof: z.string().max(64) })
      .strict()
      .parse(input);
    await security.claim(value.name, value.password, value.proof);
    const session = await security.login(value.password);
    security.cookie(response, session.session);
    return { csrf: session.csrf };
  }
  @Post('login') async login(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    const { password } = z
      .object({ password: z.string().max(256) })
      .strict()
      .parse(input);
    const session = await security.login(password);
    security.cookie(response, session.session);
    return { csrf: session.csrf };
  }
  @Post('logout') logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    security.logout(request, response);
    return { signedOut: true };
  }
  @Post('administrator') async administrator(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    const value = z
      .object({
        name: z.string().trim().min(1).max(120),
        password: z.string().max(256),
        newPassword: Password.optional(),
      })
      .strict()
      .parse(input);
    const session = await security.updateAdministrator(value.name, value.password, value.newPassword);
    security.cookie(response, session.session);
    return { csrf: session.csrf };
  }
  @Get('dashboard') async dashboard(@Req() request: Request) {
    const installation = operations.installation();
    const containers = installation
      ? (await docker.inventory()).filter((c) => c.Config.Labels?.['app.frameleaf.manager'] === installation.id)
      : [];
    const host = await docker.compatibility().catch(() => null);
    return {
      csrf: security.session(request).csrf,
      installation,
      operations: operations.history(),
      profile: store.get('profile'),
      administrator: { name: store.get<{ name: string }>('administrator')?.name },
      managerOrigin: security.origin,
      backupRoot,
      host: {
        name: new URL(origin!).hostname,
        available: !!host,
        platform: host?.platform ?? 'Unavailable',
        version: host?.version ?? 'Unavailable',
        memory: host?.memory,
        processors: host?.processors,
      },
      summary: installation ? await operations.librarySummary().catch(() => null) : null,
      services: containers.map((c) => ({
        id: c.Id,
        service: c.Config.Labels['com.docker.compose.service'],
        running: c.State.Running,
        health: c.State.Health?.Status ?? 'unknown',
      })),
      storageRoots: (process.env.MANAGER_STORAGE_ROOTS ?? '').split(':').filter(Boolean),
      databaseStorage: await databaseDefaults(),
      onboardingFinished: !!store.get('onboarding-finished'),
      appUrl: installation ? new URL(`http://${new URL(origin!).hostname}:${installation.port}`).origin : null,
      librarySetup: installation
        ? await operations.libraryStatus().catch(() => ({ phase: 'unavailable', canFinish: false }))
        : null,
    };
  }
  @Get('sources') async sources() {
    const result = await operations.discover();
    return { sources: result.sources.map(publicSource), refused: result.refused };
  }
  @Post('source-review') sourceReview(@Body() input: unknown) {
    const { sourceId } = z.object({ sourceId: ReviewInput.shape.sourceId.unwrap() }).strict().parse(input);
    return operations.sourceReview(sourceId);
  }
  @Get('storage') async storage() {
    const roots = [
      ...new Set([
        ...(process.env.MANAGER_STORAGE_ROOTS ?? '').split(':').filter(Boolean),
        ...defaults.roots,
        backupRoot!,
      ]),
    ];
    return Promise.all(
      roots.map(async (path) => {
        try {
          if ((await realpath(path)) !== path) throw new Refusal('storage_path_changed');
          const space = await statfs(path);
          return {
            path,
            totalBytes: space.blocks * space.bsize,
            availableBytes: space.bavail * space.bsize,
            freeBytes: space.bfree * space.bsize,
          };
        } catch {
          return { path, totalBytes: null, availableBytes: null, freeBytes: null };
        }
      }),
    );
  }
  @Get('releases') available() {
    return releases.available();
  }
  @Post('review') review(@Body() input: unknown) {
    return operations.review(ReviewInput.parse(input));
  }
  @Post('install') install(@Body() input: unknown) {
    const value = z.object({ reviewId: z.string().uuid(), key: RequestKey }).strict().parse(input);
    const { id } = operations.start(value.reviewId, value.key);
    return { id };
  }
  @Post('control') control(@Body() input: unknown) {
    const value = z
      .object({ action: z.enum(['start', 'stop', 'restart', 'backup']), key: RequestKey })
      .strict()
      .parse(input);
    return { id: operations.control(value.action, value.key).id };
  }
  @Post('recover') async recover(@Body() input: unknown) {
    const value = z.object({ id: z.string().uuid() }).strict().parse(input);
    await operations.recover(value.id);
    return { sourceStopped: true };
  }
  @Post('resume') resume(@Body() input: unknown) {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    return { id: operations.resume(id).id };
  }
  @Post('review-update') reviewUpdate(@Body() input: unknown) {
    const { tag } = z.object({ tag: ReviewInput.shape.tag }).strict().parse(input);
    return operations.reviewUpdate(tag);
  }
  @Post('update') update(@Body() input: unknown) {
    const { id, key } = z.object({ id: z.string().uuid(), key: RequestKey }).strict().parse(input);
    return { id: operations.update(id, key).id };
  }
  @Post('unlock-backups') async unlockBackups(@Body() input: unknown) {
    if (store.history().some((operation) => operation.state !== 'complete')) throw new Refusal('operation_in_progress');
    const { key } = z
      .object({ key: z.string().max(128) })
      .strict()
      .parse(input);
    await backups.unlock(key);
    return { unlocked: true };
  }
  @Get('backups') async snapshots() {
    return (await backups.list()).map(({ id, time }) => ({ id, time }));
  }
  @Get('backup-status') backupStatus() {
    return backups.status();
  }
  @Post('backup-key') async backupKey(@Body() input: unknown, @Res() response: Response) {
    const { password } = z
      .object({ password: z.string().max(256) })
      .strict()
      .parse(input);
    await security.confirm(password);
    const key = await backups.recoveryKey().catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') throw new Refusal('recovery_key_unavailable');
      throw error;
    });
    response.setHeader('Content-Disposition', 'attachment; filename="frameleaf-manager-recovery-key.txt"');
    response.type('application/octet-stream').send(key);
  }
  @Post('review-restore') reviewRestore(@Body() input: unknown) {
    const { snapshot, databaseRoot } = z
      .object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), databaseRoot: ReviewInput.shape.databaseRoot })
      .strict()
      .parse(input);
    return operations.reviewRestore(snapshot, databaseRoot);
  }
  @Post('restore') restore(@Body() input: unknown) {
    const { id, key } = z.object({ id: z.string().uuid(), key: RequestKey }).strict().parse(input);
    return { id: operations.restore(id, key).id };
  }
  @Post('logs') async logs(@Body() input: unknown) {
    const { id } = z
      .object({ id: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .parse(input);
    const container = await docker.inspect(id),
      installation = operations.installation();
    if (!installation || container.Config.Labels?.['app.frameleaf.manager'] !== installation.id)
      throw new Refusal('not_a_managed_container', 403);
    // Exact environment values are removed in addition to generic token and credential patterns.
    return {
      logs: redact(await docker.logs(id), [
        ...container.Config.Env.map((e) => e.slice(e.indexOf('=') + 1)),
        store.get<string>('database-password') ?? '',
      ]),
    };
  }
  @Post('profile') profile(@Body() input: unknown) {
    const profile = z
      .object({
        firstName: z.string().min(1).max(80),
        lastName: z.string().max(80),
        email: z.email(),
        account: z.enum(['local', 'create', 'existing']),
      })
      .strict()
      .parse(input);
    store.set('profile', profile);
    return { saved: true, accountCreated: false };
  }
  @Post('finish-setup') async finishSetup(@Body() input: unknown) {
    z.object({}).strict().parse(input);
    const setup = (await operations.libraryStatus()) as { canFinish?: boolean };
    if (!setup?.canFinish) throw new Refusal('library_and_phone_setup_incomplete');
    store.set('onboarding-finished', Date.now());
    return { complete: true };
  }
  @Post('retry-setup') async retrySetup(@Body() input: unknown) {
    z.object({}).strict().parse(input);
    return operations.libraryStatus(true);
  }
  @Post('export') async configuration(@Body() input: unknown, @Res() response: Response) {
    const { password } = z
      .object({ password: z.string().max(256) })
      .strict()
      .parse(input);
    await security.confirm(password); // fresh credential proof, independent of the existing browser session
    response.setHeader('Content-Disposition', 'attachment; filename="frameleaf-manager-recovery.json"');
    response.type('application/octet-stream').send(
      JSON.stringify({
        schemaVersion: 1,
        installation: operations.installation(),
        compose: await readFile(join(operations.directory(), 'compose.json'), 'utf8'),
        application: store.get('application-config'),
        recoveryKey: await backups.recoveryKey().catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT') return null;
          throw error;
        }),
        mediaIncluded: false,
      }),
    );
  }
}
@Module({ controllers: [Api] })
class ManagerModule {}

async function main() {
  process.umask(0o077);
  await mkdir(directory!, { recursive: true, mode: 0o700 });
  try {
    await stat(bootstrapFile);
  } catch {
    await writeFile(bootstrapFile, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  }
  const cert = join(directory!, 'tls.crt'),
    key = join(directory!, 'tls.key');
  try {
    await stat(cert);
    await stat(key);
  } catch {
    const host = new URL(origin!).hostname.replace(/^\[|\]$/g, '');
    if (!/^[A-Za-z0-9.:-]+$/.test(host)) throw new Error('Invalid HTTPS hostname');
    await command('openssl', [
      'req',
      '-x509',
      '-newkey',
      'rsa:3072',
      '-nodes',
      '-days',
      '365',
      '-keyout',
      key,
      '-out',
      cert,
      '-subj',
      `/CN=${host}`,
      '-addext',
      `subjectAltName=${isIP(host) ? 'IP' : 'DNS'}:${host}`,
    ]);
    await chmod(key, 0o600);
  }
  store.interrupt();
  const app = await NestFactory.create(ManagerModule, {
    logger: false,
    bodyParser: false,
    httpsOptions: { cert: await readFile(cert), key: await readFile(key) },
  });
  app.use(security.guard);
  app.use(express.json({ limit: '32kb' }));
  app.useGlobalFilters(new Errors());
  app.use(
    express.static(fileURLToPath(new URL('../ui/dist', import.meta.url)), { index: 'index.html', dotfiles: 'deny' }),
  );
  app.enableShutdownHooks();
  await app.listen(9443, '0.0.0.0');
}
main().catch(() => {
  process.stderr.write('Frameleaf Manager could not start; check its mounted configuration.\n');
  process.exitCode = 1;
});
