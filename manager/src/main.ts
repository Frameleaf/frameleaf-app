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
import { fstatSync } from 'node:fs';
import { createNativeService } from './runtime/native-service.js';
import { chmod, mkdir, readFile, realpath, rm, stat, statfs } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { DesktopGrants } from './desktop-grants.js';
import { desktopApi } from './desktop-api.js';
import { Docker, command } from './docker.js';
import { Security, trustedProxyList } from './security.js';
import { Backups } from './backups.js';
import { Releases } from './releases.js';
import { CommonImportBootstrapCredentials } from './common-import-runtime.js';
import { Operations, PhotoAppPrepareInput, ReviewInput } from './operations.js';
import { folderImportKinds } from './photo-app-folder.js';
import { Refusal, containerId, publicSource, redact, releaseTag, secretEnvironmentValues } from './contracts.js';
import { appdataDefaults } from './appdata.js';
import { nativeListener } from './runtime/native-listener.js';
import { publishNativeClaimProof, requireNativeClaimProof } from './runtime/native-claim.js';
import { PostgresStorage } from './postgres-storage.js';
import { HostAutostart } from './unraid-autostart.js';
import { ServiceOverrides, detectAcceleration, hostInstallations, suggestedPort } from './compose.js';
import { sharePortWithRedirect } from './http-redirect.js';
import { log, print, renderBanner, requestLog } from './banner.js';

const directory = process.env.MANAGER_DATA;
const runtime = process.env.MANAGER_RUNTIME ?? 'docker';
let acceleration: ReturnType<typeof detectAcceleration> | undefined;
// Docker: optional; without it Manager answers on any IP, localhost, .local or single-label address.
const origin = process.env.MANAGER_ORIGIN || undefined;
if (!directory || directory !== resolve(directory) || (runtime === 'native' && !origin))
  throw new Error('MANAGER_DATA is required, and MANAGER_ORIGIN for the native runtime');
const nativeAddress = runtime === 'native' ? nativeListener(origin!) : null;
if (!['docker', 'native'].includes(runtime)) throw new Refusal('manager_runtime_invalid');
const store = new Store(directory);
if (runtime === 'docker' && store.get('native-installation')) throw new Refusal('manager_runtime_changed');
if (runtime === 'native') {
  const bootstrapPipe = fstatSync(0);
  // Node disables isFIFO() on Windows even when libuv reports the pipe mode.
  const privatePipe = process.platform === 'win32'
    ? (bootstrapPipe.mode & 0xf000) === 0x1000
    : bootstrapPipe.isFIFO() || bootstrapPipe.isSocket();
  if (!privatePipe) throw new Refusal('native_bootstrap_unavailable');
}
const backupRoot = process.env.MANAGER_BACKUP_ROOT ?? (runtime === 'native' ? join(directory, 'backups') : undefined);
if (!backupRoot || backupRoot !== resolve(backupRoot))
  throw new Error('MANAGER_BACKUP_ROOT must be an absolute mounted directory');
const native = runtime === 'native'
  ? await createNativeService(store, process.stdin, origin!, join(backupRoot, 'frameleaf-database'))
  : null;
const docker = new Docker();
// Proxies named in MANAGER_TRUSTED_PROXIES may forward the client address; a loopback-only publish (launch.sh
// default) means a connection from the bridge gateway can only be this host. Otherwise a gateway-sourced
// claim is refused (review L1): Docker's userland proxy and NAS portal proxies hide the real client.
const bindAddress = process.env.MANAGER_BIND_ADDRESS?.replace(/^::ffff:(?=\d+\.)/, '') ?? '';
const security = new Security(store, origin, process.env.MANAGER_FRAME_ORIGIN, {
  trustedProxies: trustedProxyList(process.env.MANAGER_TRUSTED_PROXIES),
  loopbackPublished: runtime === 'docker' && (bindAddress === '::1' || /^127\./.test(bindAddress)),
});
const nativeClaimProof = native && !security.claimed() ? randomBytes(32) : null;
const seed = store.get<string>('release-seed') ?? randomBytes(32).toString('hex');
store.createOnce('release-seed', seed);
const releases = new Releases(join(directory, 'releases'), seed);
const backups = native?.backups ?? new Backups(join(backupRoot, 'frameleaf-database'), native?.backupPassword ?? join(directory, 'recovery-key'), native?.backupCommand ?? command);
const unraidConfig = '/run/frameleaf-host/docker.cfg';
async function databaseDefaults() {
  const config = await readFile(unraidConfig, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new Refusal('unraid_configuration_unavailable');
  });
  return appdataDefaults(process.env, config);
}
const defaults = native ? { roots: [], platform: 'native' as const } : await databaseDefaults();
// Preserve existing explicit mounts; Unraid otherwise discovers the file through the host engine.
const mountedAutostart = '/run/frameleaf-host/unraid-autostart';
const autostart = process.env.MANAGER_UNRAID_AUTOSTART || mountedAutostart;
const autostartStat = native ? null : await stat(autostart).catch(() => null);
// Docker creates a directory when the host file is missing; that is not Unraid's autostart list.
if (autostartStat?.isDirectory()) console.error(`manager: ${autostart} is a directory, not Unraid's unraid-autostart file`);
if (autostartStat?.isFile()) process.env.MANAGER_UNRAID_AUTOSTART = autostart;
else delete process.env.MANAGER_UNRAID_AUTOSTART;
const databaseStorage = new PostgresStorage(docker, directory, defaults.roots, defaults.platform === 'unraid');
const operations = new Operations(
  store,
  docker,
  releases,
  backups,
  (process.env.MANAGER_STORAGE_ROOTS ?? '').split(':').filter(Boolean),
  databaseStorage,
  process.env.MANAGER_UNRAID_AUTOSTART ?? (defaults.platform === 'unraid' ? new HostAutostart(docker, directory) : undefined),
);
const lifecycle = native ?? operations;
/** The port the administrator reached Manager on: never offered to, or accepted for, the Frameleaf stack. */
const managerPort = (request: Request) => Number(new URL(security.requestOrigin(request)).port || 443);
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
      ...(error instanceof Refusal && error.detail ? { detail: error.detail } : {}),
    });
  }
}

@Controller('manager-api')
class Api {
  @Get('status') status() {
    const claimed = security.claimed();
    return { claimed, claimProofRequired: !!native && !claimed };
  }

  @Post('claim') async claim(@Body() input: unknown, @Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const claim = z.object({ name: z.string().min(1).max(120), password: Password }).strict();
    const value = (native ? claim.extend({ proof: z.string().max(64).optional() }) : claim).parse(input);
    if (native && !security.claimed()) requireNativeClaimProof(nativeClaimProof, 'proof' in value ? value.proof : undefined);
    await security.claim(value.name, value.password, security.clientAddress(request));
    if (native) {
      nativeClaimProof?.fill(0);
      await rm(join(store.directory, 'claim-key'), { force: true });
    }
    const session = await security.login(value.password);
    security.issueSession(response, session.session);
    return { csrf: session.csrf };
  }
  @Post('login') async login(@Body() input: unknown, @Res({ passthrough: true }) response: Response) {
    const { password } = z
      .object({ password: z.string().max(256) })
      .strict()
      .parse(input);
    const session = await security.login(password);
    security.issueSession(response, session.session);
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
    security.issueSession(response, session.session);
    return { csrf: session.csrf };
  }
  @Get('dashboard') async dashboard(@Req() request: Request) {
    const installation = operations.installation();
    // Without an installation the switcher is optional; with one, an unreachable Docker still fails as before.
    const inventory = await docker.inventory().catch((error) => {
      if (installation) throw error;
      return [];
    });
    const containers = installation
      ? inventory.filter((c) => c.Config.Labels?.['app.frameleaf.manager'] === installation.id)
      : [];
    const host = await docker.compatibility().catch(() => null);
    return {
      csrf: security.session(request).csrf,
      installation,
      operations: operations.history(),
      autoUpdate: store.get<boolean>('auto-update') !== false,
      /** Why the last automatic update check could not start an update, until a later check does. */
      autoUpdateFailure: store.get<{ code: string; at: string }>('auto-update-failure'),
      profile: store.get('profile'),
      administrator: { name: store.get<{ name: string }>('administrator')?.name },
      managerOrigin: security.requestOrigin(request),
      backupRoot,
      host: {
        name: new URL(security.requestOrigin(request)).hostname,
        available: !!host,
        platform: host?.platform ?? 'Unavailable',
        version: host?.version ?? 'Unavailable',
        memory: host?.memory,
        processors: host?.processors,
        // ponytail: probed once per Manager start; a new GPU or driver shows after Manager restarts.
        acceleration: runtime === 'docker' ? await (acceleration ??= detectAcceleration()) : 'cpu',
      },
      summary: installation ? await operations.librarySummary().catch(() => null) : null,
      services: containers.map((c) => ({
        id: c.Id,
        service: c.Config.Labels['com.docker.compose.service'],
        running: c.State.Running,
        health: c.State.Health?.Status ?? 'unknown',
      })),
      storageRoots: (process.env.MANAGER_STORAGE_ROOTS ?? '').split(':').filter(Boolean),
      retainedMedia: store
        .history()
        .filter((o) => o.kind === 'move-library')
        .map((o) => store.get(`retained-media:${o.id}`))
        .filter(Boolean),
      databaseStorage: await databaseDefaults(),
      onboardingFinished: !!store.get('onboarding-finished'),
      installations: hostInstallations(inventory, installation?.id, security.requestOrigin(request)),
      suggestedPort: suggestedPort(inventory, [Number(new URL(security.requestOrigin(request)).port || 443)]),
      appUrl: installation ? new URL(`http://${new URL(security.requestOrigin(request)).hostname}:${installation.port}`).origin : null,
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
  @Post('source-settings') sourceSettings(@Body() input: unknown) {
    const { sourceId, settings } = z
      .object({
        sourceId: ReviewInput.shape.sourceId.unwrap(),
        settings: z.record(z.string(), z.unknown()).nullable().optional(),
      })
      .strict()
      .parse(input);
    return settings === undefined
      ? operations.sourceSettings(sourceId)
      : operations.saveSourceSettings(sourceId, settings);
  }
  /** FL-1149 (Beta): other photo apps on this host, importable or with a reason code. */
  @Get('photo-app-sources') photoAppSources() {
    return operations.photoAppSources();
  }
  /** Stops the app (its database keeps running), captures it, and leaves the operation awaiting review. */
  @Post('photo-app-capture') async photoAppCapture(@Body() input: unknown) {
    const { container, key } = z.object({ container: containerId, key: RequestKey }).strict().parse(input);
    return { id: (await operations.startCommonCapture(container, key)).id };
  }
  /**
   * An export folder the owner made themselves (Ente Photos): nothing is stopped. The same review, preparation and
   * cancel routes follow; cancelling only discards what Manager read.
   */
  @Post('photo-app-folder') async photoAppFolder(@Body() input: unknown) {
    const { kind, path, key } = z
      .object({ kind: z.enum(folderImportKinds), path: z.string().min(1).max(4096), key: RequestKey })
      .strict()
      .parse(input);
    return { id: (await operations.startFolderImport(kind, path, key)).id };
  }
  @Post('photo-app-inspect') photoAppInspect(@Body() input: unknown) {
    const { operationId, tag } = z.object({ operationId: z.uuid(), tag: releaseTag.optional() }).strict().parse(input);
    return operations.inspectPhotoApp(operationId, tag);
  }
  @Post('photo-app-prepare') photoAppPrepare(@Body() input: unknown, @Req() request: Request) {
    return operations.preparePhotoApp(PhotoAppPrepareInput.parse(input), managerPort(request));
  }
  @Post('photo-app-cancel') async photoAppCancel(@Body() input: unknown) {
    const { operationId } = z.object({ operationId: z.uuid() }).strict().parse(input);
    await operations.cancelPhotoApp(operationId);
    return { cancelled: true };
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
  @Post('review') review(@Body() input: unknown, @Req() request: Request) {
    return operations.review(ReviewInput.parse(input), managerPort(request));
  }
  @Post('install') install(@Body() input: unknown, @Req() request: Request) {
    const value = z.object({
      reviewId: z.string().uuid(), key: RequestKey, bootstrap: CommonImportBootstrapCredentials.optional(),
      approvalToken: z.uuid().optional(),
    }).strict().parse(input);
    if (value.bootstrap) security.requireImportBootstrapTransport(request);
    const { id } = operations.start(value.reviewId, value.key, value.bootstrap, value.approvalToken);
    return { id };
  }
  @Post('control') control(@Body() input: unknown) {
    const value = z
      .object({ action: z.enum(['start', 'stop', 'restart', 'backup']), key: RequestKey })
      .strict()
      .parse(input);
    return { id: operations.control(value.action, value.key).id };
  }
  @Get('container-settings') containerSettings() {
    return operations.containerSettings();
  }
  @Post('container-settings') saveContainerSettings(@Body() input: unknown) {
    const { services, key } = z.object({ services: ServiceOverrides, key: RequestKey }).strict().parse(input);
    return { id: operations.reconfigure(services, key).id };
  }
  @Post('recover') async recover(@Body() input: unknown) {
    const value = z.object({ id: z.string().uuid() }).strict().parse(input);
    await operations.recover(value.id);
    return { sourceStopped: true };
  }
  @Post('resume') resume(@Body() input: unknown, @Req() request: Request) {
    const { id, bootstrap } = z.object({ id: z.string().uuid(), bootstrap: CommonImportBootstrapCredentials.optional() }).strict().parse(input);
    if (bootstrap) security.requireImportBootstrapTransport(request);
    return { id: operations.resume(id, bootstrap).id };
  }
  @Post('review-update') reviewUpdate(@Body() input: unknown) {
    const { tag } = z.object({ tag: ReviewInput.shape.tag }).strict().parse(input);
    return operations.reviewUpdate(tag);
  }
  @Post('update') update(@Body() input: unknown) {
    const { id, key } = z.object({ id: z.string().uuid(), key: RequestKey }).strict().parse(input);
    return { id: operations.update(id, key).id };
  }
  @Post('auto-update') autoUpdate(@Body() input: unknown) {
    const { enabled } = z.object({ enabled: z.boolean() }).strict().parse(input);
    store.set('auto-update', enabled);
    return { enabled };
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
  @Post('review-restore') reviewRestore(@Body() input: unknown, @Req() request: Request) {
    const { snapshot, databaseRoot } = z
      .object({ snapshot: z.string().regex(/^[a-f0-9]{64}$/), databaseRoot: ReviewInput.shape.databaseRoot })
      .strict()
      .parse(input);
    return operations.reviewRestore(snapshot, databaseRoot, managerPort(request));
  }
  @Post('review-move') reviewMove(@Body() input: unknown) {
    const { root } = z
      .object({ root: z.string().min(1).max(4096) })
      .strict()
      .parse(input);
    return operations.reviewMove(root);
  }
  @Post('move-library') moveLibrary(@Body() input: unknown) {
    const { id, key } = z.object({ id: z.string().uuid(), key: RequestKey }).strict().parse(input);
    return { id: operations.move(id, key).id };
  }
  @Post('stop-move') async stopMove(@Body() input: unknown) {
    const { id } = z.object({ id: z.string().uuid() }).strict().parse(input);
    await operations.stopMove(id);
    return { requested: true };
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
    // Exact values of secret-named environment variables are removed in addition to generic token and
    // credential patterns. Other values (NODE_ENV=production, NVIDIA_DRIVER_CAPABILITIES=all) are not secrets.
    return {
      logs: redact(await docker.logs(id), [
        ...secretEnvironmentValues(container.Config.Env),
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
  /** Finish onboarding without waiting for library preparation or a phone: the server just runs. */
  @Post('skip-setup') async skipSetup(@Body() input: unknown) {
    z.object({}).strict().parse(input);
    let dismissed = true;
    try {
      await operations.dismissLibrarySetup();
    } catch (error) {
      // A server from before setup could be dismissed: Manager still stops asking; the server carries on as it was,
      // and the owner is told so.
      if (!(error instanceof Refusal && error.code === 'server_refused_404')) throw error;
      dismissed = false;
    }
    store.set('onboarding-finished', Date.now());
    return { complete: true, dismissed };
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
        // The stack reads the password from a mounted file, so the compose text no longer carries it.
        databasePassword: store.get('database-password'),
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
  const version = await readFile(new URL('../package.json', import.meta.url), 'utf8')
    .then((text) => `v${JSON.parse(text).version}`)
    .catch(() => 'unknown version');
  print(renderBanner('Frameleaf Manager', version));
  log(`starting ${version} on ${defaults.platform} (${runtime}); state ${directory}, backups ${backupRoot}`);
  await mkdir(directory!, { recursive: true, mode: 0o700 });
  const cert = join(directory!, 'tls.crt'),
    key = join(directory!, 'tls.key');
  const http = !native && security.origin?.startsWith('http://');
  if (!native && !http) {
    try {
      await stat(cert);
      await stat(key);
    } catch {
      const host = origin ? new URL(origin).hostname.replace(/^\[|\]$/g, '') : 'localhost';
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
  }
  const httpsOptions = native
    ? native.httpsOptions()
    : http ? undefined : { cert: await readFile(cert), key: await readFile(key) };
  store.interrupt();
  // Dumps, recovery records and restore reviews left by settled operations, and old release bundles.
  if (!native) await operations.prune();
  const app = await NestFactory.create(ManagerModule, {
    logger: false,
    bodyParser: false,
    httpsOptions,
  });
  app.use(requestLog());
  app.use(desktopApi(store, security, new DesktopGrants(store, security), lifecycle, native ?? undefined));
  app.use(security.guard);
  if (native) {
    // Native management uses the desktop UI; Docker recovery/import routes cannot operate on native state.
    const credentials = new Set(['/manager-api/status', '/manager-api/claim', '/manager-api/login', '/manager-api/logout', '/manager-api/administrator']);
    app.use((request: Request, response: Response, next: express.NextFunction) => {
      if (credentials.has(request.path)) return next();
      response.status(409).json({ code: 'native_action_unavailable' });
    });
  }
  app.use(express.json({ limit: '32kb' }));
  app.useGlobalFilters(new Errors());
  let ui = fileURLToPath(new URL('../ui/dist', import.meta.url));
  if (process.env.MANAGER_UI_DIRECTORY) {
    // The platform package supplies original UI assets through a read-only mount.
    // Restrict the override to this one path; never expose arbitrary host/state folders.
    if (process.env.MANAGER_UI_DIRECTORY !== '/run/frameleaf-ui' ||
        await realpath('/run/frameleaf-ui') !== '/run/frameleaf-ui' ||
        await realpath('/run/frameleaf-ui/index.html') !== '/run/frameleaf-ui/index.html')
      throw new Error('Invalid mounted Manager UI directory');
    ui = '/run/frameleaf-ui';
    app.use(async (request: Request, response: Response, next: express.NextFunction) => {
      if (request.path.startsWith('/manager-api/')) return next();
      try {
        const file = resolve(ui, '.' + decodeURIComponent(request.path === '/' ? '/index.html' : request.path));
        if (!file.startsWith(ui + '/') || await realpath(file) !== file || !(await stat(file)).isFile())
          return response.sendStatus(404);
        next();
      } catch { response.sendStatus(404); }
    });
  }
  app.use(express.static(ui, { index: 'index.html', dotfiles: 'deny' }));
  app.enableShutdownHooks();
  if (native) {
    await app.listen(nativeAddress!.port, nativeAddress!.host);
    try {
      // A process that cannot acquire the listener must not replace the running Manager's proof.
      if (nativeClaimProof) await publishNativeClaimProof(store.directory, nativeClaimProof);
    } catch (error) {
      await app.close();
      throw error;
    }
  } else if (http) await app.listen(9443, '0.0.0.0');
  else {
    // Docker: browsers send a typed "IP:port" as http://, so redirect it instead of an empty reply.
    await app.init();
    await new Promise<void>((done) => sharePortWithRedirect(app.getHttpServer()).listen(9443, '0.0.0.0', done));
  }
  log(`ready, listening on port ${native ? nativeAddress!.port : 9443} (${http ? 'http' : 'https'})`);
  if (native) process.stdout.write(JSON.stringify(native.ready(origin!)) + '\n');
  // ponytail: fixed 6-hour check; add quiet-hours scheduling if owners ask for updates at a set time.
  else setInterval(() => operations.autoUpdate().catch((error) => console.error(`manager: automatic update skipped: ${error?.code ?? error}`)), 6 * 3_600_000).unref();
}
main().catch(() => {
  process.stderr.write('Frameleaf Manager could not start; check its mounted configuration.\n');
  process.exitCode = 1;
});
