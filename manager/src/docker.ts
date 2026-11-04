import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { Refusal, containerId, imageDigest, redact, type Database, type Mount } from './contracts.js';
import { publishFile } from './files.js';
import { completeCommonImport } from './common-import-lifecycle.js';
import { COMMON_IMPORT_CONFIG, IMPORT_PREPARATION_TARGET, writeCommonImportCompose } from './common-import-runtime.js';
import { DOCKERMAN_TEMPLATES, saveDockermanTemplates } from './dockerman.js';
import { configureUnraidCompose } from './compose.js';
import { importHash, importSourceKinds, importSourceSchema, type ImportPlan } from './import-plan.js';
import {
  parseImportSourceAuthority,
  replyImportPreparationAuthority,
  replyImportSourceAuthority,
  type ImportPreparationAuthority,
  type ImportSourceAuthority,
} from './import-source-authority.js';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const preparationReceipt = z.strictObject({
  bundleName: z.string(),
  binding: z.strictObject({ operationId: z.uuid(), source: importSourceSchema, manifestSha256: importHash, planSha256: importHash }),
  destinationId: z.uuid(),
  requiredMediaBytes: count,
  summary: z.strictObject({ owners: count, assets: count, files: count, albums: count, preservationDifferences: count }),
});

export type Container = {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean; StartedAt?: string; Health?: { Status: string } };
  Config: {
    Image: string;
    Env: string[];
    Labels: Record<string, string>;
    Entrypoint: string[] | null;
    Cmd: string[] | null;
  };
  HostConfig: {
    RestartPolicy: { Name: string; MaximumRetryCount: number };
    NetworkMode: string;
    PortBindings: Record<string, { HostIp: string; HostPort: string }[] | null>;
  };
  Mounts: { Type: string; Source: string; Name?: string; Destination: string; RW: boolean; Propagation?: string }[];
  NetworkSettings: { Networks: Record<string, { IPAddress: string; Aliases?: string[]; DNSNames?: string[] }> };
};
export type CommandOptions = {
  /** Fixed packaged executable selected by a trusted adapter, never an HTTP request. */
  executable?: string;
  input?: string;
  /** Offline importer challenges; stdin remains open until the child finishes.
   * Known source-authority refusal codes/statuses are public; private details are discarded.
   */
  reply?: (line: string) => Promise<string | undefined>;
  inputFile?: string;
  /** The reader may stop once it has what it needs (pg_restore --list reads only the table of contents). */
  inputMayCloseEarly?: boolean;
  outputFile?: string;
  timeout?: number;
  cwd?: string;
  env?: Record<string, string>;
};
/** Only typed adapters call this executor. It is never exposed as an HTTP command runner. */
export async function command(
  binary: 'docker' | 'restic' | 'openssl' | 'cosign',
  args: string[],
  options: CommandOptions = {},
): Promise<string> {
  if (options.executable !== undefined &&
    (!options.executable || options.executable.includes('\0') ||
      !isAbsolute(options.executable) || resolve(options.executable) !== options.executable))
    throw new Refusal('command_executable_invalid');
  if (options.reply !== undefined &&
    (typeof options.reply !== 'function' || options.input !== undefined ||
      options.inputFile !== undefined || options.outputFile !== undefined))
    throw new Refusal('command_dialogue_invalid');
  // An incomplete transfer is never a receipt; the operation lock makes its retry exclusive.
  if (options.outputFile) await rm(`${options.outputFile}.partial`, { force: true });
  const child = spawn(options.executable ?? binary, args, {
    shell: false,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, ...options.env },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000);
  let result = Buffer.alloc(0),
    tooLarge = false,
    exit = 'not started',
    stderr = '';
  // stderr can contain credentials: keep only a short tail in memory, redacted before it is logged.
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => (stderr = (stderr + chunk).slice(-STDERR_TAIL)));
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Refusal(`${binary}_unavailable`, 503)));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      exit = signal ? `signal ${signal}` : tooLarge ? 'output too large' : `exit ${code}`;
      code === 0 && !tooLarge ? resolve() : reject(new Refusal(`${binary}_operation_failed`, 503));
    });
  });
  const transfers: Promise<unknown>[] = [];
  if (options.outputFile)
    transfers.push(
      pipeline(child.stdout, createWriteStream(`${options.outputFile}.partial`, { flags: 'wx', mode: 0o600 })),
    );
  else
    child.stdout.on('data', (chunk: Buffer) => {
      if (result.length + chunk.length > 8 * 1024 * 1024) {
        tooLarge = true;
        child.kill('SIGKILL');
      } else result = Buffer.concat([result, chunk]);
    });
  if (options.reply) {
    const reply = options.reply;
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    child.stdin.on('error', () => {});
    transfers.push((async () => {
      try {
        for await (const line of lines) {
          const response = await Promise.race([
            Promise.resolve().then(() => reply(line)),
            exited.then(() => { throw new Error('Child exited during source check'); }),
          ]);
          if (response !== undefined) {
            if (typeof response !== 'string' || Buffer.byteLength(response) > 65536)
              throw new Error('Invalid offline response');
            await new Promise<void>((resolve, reject) =>
              child.stdin.write(response, (error) => error ? reject(error) : resolve()));
          }
        }
      } catch (error) {
        // Relay only known public authority classifications, never private callback details.
        if (error instanceof Refusal && [
          'import_source_authority_required',
          'import_source_authority_invalid',
          'import_source_authority_refused',
        ].includes(error.code) && Number.isInteger(error.status) && error.status >= 400 && error.status < 600)
          throw new Refusal(error.code, error.status);
        throw new Refusal('command_reply_failed');
      } finally {
        lines.close();
        child.stdin.end();
      }
    })());
  } else if (options.inputFile)
    transfers.push(
      pipeline(createReadStream(options.inputFile), child.stdin).catch((error: NodeJS.ErrnoException) => {
        // The exit code still decides success; only the reader hanging up early is tolerated.
        if (!(options.inputMayCloseEarly && ['EPIPE', 'ERR_STREAM_PREMATURE_CLOSE'].includes(error.code ?? ''))) throw error;
      }),
    );
  else {
    child.stdin.on('error', () => {});
    child.stdin.end(options.input);
  }
  try {
    await Promise.all([exited, ...transfers]);
    if (options.outputFile) {
      await publishFile(`${options.outputFile}.partial`, options.outputFile);
    }
    return result.toString('utf8');
  } catch (error) {
    child.kill('SIGKILL');
    await Promise.allSettled([exited, ...transfers]);
    logFailure(binary, args, exit, stderr, error, options.env);
    if (options.outputFile) await rm(`${options.outputFile}.partial`, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const STDERR_TAIL = 2048;
// The server image's admin CLI wrapper (server/bin/frameleaf-admin → start.sh → node <server>/dist/main.js).
// test/server-image-layout.test.ts ties this to server/Dockerfile's final stage.
export const SERVER_ADMIN = '/usr/src/app/server/bin/frameleaf-admin';
const SECRET_ARGUMENT = /^([A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN|KEY)[A-Z0-9_]*)=(.*)$/is;
/** One redacted line for the container log: what ran, how it ended and the end of stderr. */
function logFailure(
  binary: string,
  args: string[],
  exit: string,
  stderr: string,
  error: unknown,
  env: Record<string, string> = {},
): void {
  // Secrets passed through the environment (PGPASSWORD) are masked like secret arguments.
  const secrets = [
    ...args.map((arg) => SECRET_ARGUMENT.exec(arg)?.[2] ?? ''),
    ...Object.entries(env).map(([name, value]) => SECRET_ARGUMENT.exec(`${name}=${value}`)?.[2] ?? ''),
  ].filter(Boolean);
  const shown = args
    .map((arg) => arg.replace(SECRET_ARGUMENT, '$1=[redacted]'))
    .map((arg) => (arg.length > 120 ? `${arg.slice(0, 117)}...` : arg))
    .join(' ');
  const reason = error instanceof Refusal ? error.code : ((error as NodeJS.ErrnoException)?.code ?? String(error));
  const tail = redact(stderr, secrets).trim().replaceAll(/\s+/g, ' ');
  console.error(redact(`manager: command failed (${reason}, ${exit}): ${binary} ${shown}${tail ? ` | stderr: ${tail}` : ''}`, secrets));
}

export const environment = (c: Container) =>
  Object.fromEntries(
    (c.Config.Env ?? []).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
// Docker lists mounts in no fixed order; reviews and fingerprints need a stable one.
export const mounts = (c: Container): Mount[] =>
  c.Mounts.filter((m) => m.Type === 'bind' || m.Type === 'volume')
    .map((m) => ({
      type: m.Type as 'bind' | 'volume',
      source: m.Type === 'volume' ? m.Name! : m.Source,
      target: m.Destination,
      readOnly: !m.RW,
    }))
    .sort((a, b) => a.target.localeCompare(b.target) || a.source.localeCompare(b.source));
export const overlap = (a: string, b: string): boolean =>
  a === b || a.startsWith(`${b.replace(/\/$/, '')}/`) || b.startsWith(`${a.replace(/\/$/, '')}/`);
export function sharesMedia(c: Container, media: Mount[], all: Container[] = []): boolean {
  const backing = (mount: Mount) =>
    mount.type === 'bind'
      ? mount.source
      : all.flatMap((item) => item.Mounts).find((item) => item.Type === 'volume' && item.Name === mount.source)?.Source;
  return mounts(c).some(
    (a) =>
      !a.readOnly &&
      media.some((b) => {
        if (b.readOnly) return false;
        if (a.type === 'volume' && b.type === 'volume' && a.source === b.source) return true;
        const left = backing(a),
          right = backing(b);
        return !!left && !!right && overlap(left, right);
      }),
  );
}
export class Docker {
  constructor(private execute: typeof command = command) {}
  async inventory(): Promise<Container[]> {
    const ids = (await this.execute('docker', ['ps', '-aq', '--no-trunc'])).trim().split('\n').filter(Boolean);
    if (!ids.length) return [];
    ids.forEach((id) => containerId.parse(id));
    return JSON.parse(await this.execute('docker', ['inspect', ...ids]));
  }
  async inspect(id: string): Promise<Container> {
    containerId.parse(id);
    return JSON.parse(await this.execute('docker', ['inspect', id]))[0];
  }
  async compatibility(): Promise<{
    platform: string;
    version: string;
    compose: string;
    dataRoot: string;
    memory: number | null;
    processors: number | null;
  }> {
    const info = JSON.parse(await this.execute('docker', ['info', '--format', '{{json .}}']));
    if (info.OSType !== 'linux' || info.Swarm?.LocalNodeState === 'active')
      throw new Refusal('unsupported_docker_host');
    const architecture = { x86_64: 'amd64', aarch64: 'arm64', amd64: 'amd64', arm64: 'arm64' }[
      String(info.Architecture)
    ];
    if (!architecture || Number(String(info.ServerVersion).split('.')[0]) < 24)
      throw new Refusal('unsupported_docker_version_or_architecture');
    const compose = (await this.execute('docker', ['compose', 'version', '--short'])).trim();
    if (!/^v?[2-9]\./.test(compose)) throw new Refusal('compose_v2_required');
    if (typeof info.DockerRootDir !== 'string' || !info.DockerRootDir.startsWith('/'))
      throw new Refusal('docker_storage_unavailable');
    return {
      platform: `linux/${architecture}`,
      version: info.ServerVersion,
      compose,
      dataRoot: info.DockerRootDir,
      memory: Number.isFinite(info.MemTotal) ? info.MemTotal : null,
      processors: Number.isFinite(info.NCPU) ? info.NCPU : null,
    };
  }
  async readFile(id: string, path: string): Promise<string> {
    containerId.parse(id);
    if (!path.startsWith('/') || path.includes('\0') || path.includes('\n'))
      throw new Refusal('invalid_configuration_path');
    return this.execute('docker', ['exec', id, 'cat', '--', path]);
  }
  async node(id: string, script: string, args: string[] = []): Promise<string> {
    containerId.parse(id);
    return this.execute('docker', ['exec', id, 'node', '-e', script, '--', ...args]);
  }
  async sql(db: Database, sql: string): Promise<string> {
    containerId.parse(db.container);
    return this.execute(
      'docker',
      [
        'exec',
        '-i',
        '--env',
        'PGPASSWORD',
        db.container,
        'psql',
        '-X',
        '--no-password',
        '--port',
        String(db.port ?? 5432),
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--set',
        'ON_ERROR_STOP=1',
        '-At',
      ],
      // The password reaches docker through its environment, never its argv.
      { input: sql, env: { PGPASSWORD: db.password } },
    );
  }
  async dump(db: Database, destination: string): Promise<void> {
    containerId.parse(db.container);
    await this.execute(
      'docker',
      [
        'exec',
        '--env',
        'PGPASSWORD',
        db.container,
        'pg_dump',
        '--no-password',
        '--port',
        String(db.port ?? 5432),
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ],
      { outputFile: destination, timeout: 7_200_000, env: { PGPASSWORD: db.password } },
    );
  }
  async restore(db: Database, file: string): Promise<void> {
    containerId.parse(db.container);
    // Only a newly allocated target database. No --clean against a source and no physical directory reuse.
    await this.execute(
      'docker',
      [
        'exec',
        '-i',
        '--env',
        'PGPASSWORD',
        db.container,
        'pg_restore',
        '--no-password',
        '--port',
        String(db.port ?? 5432),
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
      ],
      { inputFile: file, timeout: 7_200_000, env: { PGPASSWORD: db.password } },
    );
  }
  async verifyDump(db: Database, file: string): Promise<void> {
    containerId.parse(db.container);
    // pg_restore --list exits after the table of contents; the rest of the stream is never read.
    await this.execute('docker', ['exec', '-i', db.container, 'pg_restore', '--list'], {
      inputFile: file,
      inputMayCloseEarly: true,
    });
  }
  async restartPolicy(id: string, policy: string): Promise<void> {
    containerId.parse(id);
    // Docker reports an unset policy as "", which means the same as "no" but is not a valid --restart value.
    if (policy === '') policy = 'no';
    if (!/^(?:no|always|unless-stopped|on-failure(?::\d+)?)$/.test(policy)) throw new Refusal('invalid_restart_policy');
    await this.execute('docker', ['update', '--restart', policy, id]);
  }
  async stop(id: string): Promise<void> {
    containerId.parse(id);
    await this.execute('docker', ['stop', '--time', '60', id]);
  }
  async start(id: string): Promise<void> {
    containerId.parse(id);
    await this.execute('docker', ['start', id]);
  }
  async pull(image: string, platform: string): Promise<void> {
    imageDigest.parse(image);
    if (!['linux/amd64', 'linux/arm64'].includes(platform)) throw new Refusal('unsupported_architecture');
    await this.execute('docker', ['pull', '--platform', platform, image], { timeout: 3_600_000 });
  }
  async compose(
    directory: string,
    project: string,
    action: 'up' | 'stop' | 'restart',
    services: string[] = [],
  ): Promise<void> {
    if (
      !/^frameleaf-[a-f0-9]{12}$/.test(project) ||
      services.some(
        (s) => !['database', 'redis', 'frameleaf-server', 'frameleaf-machine-learning', 'immich-machine-learning'].includes(s),
      )
    )
      throw new Refusal('invalid_managed_project');
    const unraid = action === 'up' && process.env.MANAGER_PLATFORM === 'unraid';
    // DockerMan templates are optional: catalog templates published before the mapping existed still start.
    const dockerman = unraid && (await access(DOCKERMAN_TEMPLATES).then(() => true, () => false));
    if (action === 'up') {
      if (unraid) await configureUnraidCompose(directory);
      await this.pullMissing(directory, services);
    }
    await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        'compose.json',
        action,
        ...(action === 'up' ? ['--detach', '--wait', '--wait-timeout', '900', '--pull', 'never', '--remove-orphans'] : []),
        ...services,
      ],
      { cwd: directory, timeout: 1_200_000 },
    );
    if (dockerman) {
      const ids = (await this.execute('docker', ['ps', '--all', '--quiet', '--no-trunc',
        '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.oneoff=False']))
        .trim().split(/\s+/).filter(Boolean);
      ids.forEach((id) => containerId.parse(id));
      if (!ids.length) throw new Refusal('dockerman_containers_missing');
      await saveDockermanTemplates(JSON.parse(await this.execute('docker', ['inspect', ...ids])), project);
    }
  }
  /**
   * Pulls the digest-pinned images compose.json runs that this host lacks. `up --pull never` never fetches,
   * and a resumed setup skips its finished download step, so an image missing then stays missing.
   */
  private async pullMissing(directory: string, services: string[]): Promise<void> {
    const compose = JSON.parse(await readFile(join(directory, 'compose.json'), 'utf8')) as {
      services: Record<string, { image: string }>;
    };
    const wanted = Object.entries(compose.services)
      .filter(([name]) => !services.length || services.includes(name))
      .map(([, service]) => imageDigest.parse(service.image));
    const present = new Set(
      (await this.execute('docker', ['image', 'ls', '--digests', '--format', '{{.Repository}}@{{.Digest}}'])).split('\n'),
    );
    // `image ls` prints no tag beside the digest, so `name:tag@sha256:…` is looked up as `name@sha256:…`.
    for (const image of new Set(wanted))
      if (!present.has(image.replace(/:[^/@]+(?=@)/, ''))) await this.execute('docker', ['pull', image], { timeout: 3_600_000 });
  }
  /**
   * FL-414: which of these media folders the Frameleaf server cannot write to, checked by the server
   * image itself with the live Compose mounts and user, so a host path, a named volume and an NFS mount
   * answer alike. An empty list means every one is writable. Nothing is written.
   */
  async unwritableMedia(directory: string, project: string, targets: string[]): Promise<string[]> {
    if (
      !/^frameleaf-[a-f0-9]{12}$/.test(project) ||
      targets.some((target) => !target.startsWith('/') || /[\n\0]/.test(target))
    )
      throw new Refusal('invalid_media_check');
    if (targets.length === 0) return [];
    const output = await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        'compose.json',
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '--entrypoint',
        'sh',
        'frameleaf-server',
        '-c',
        'for folder do [ -d "$folder" ] && [ -w "$folder" ] || printf "%s\\n" "$folder"; done',
        'sh',
        ...targets,
      ],
      { cwd: directory, timeout: 300_000 },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => targets.includes(line));
  }
  /** Prepare an operation-private bundle with source and destination originals mounted read-only. */
  async prepareImportBundle(
    directory: string,
    image: string,
    authority: ImportPreparationAuthority,
    media: { source: string; target: string }[],
  ) {
    const { operationId, destinationId, source, preparationSha256 } = authority;
    if (
      !imageDigest.safeParse(image).success || !z.uuid().safeParse(operationId).success ||
      !z.uuid().safeParse(destinationId).success || !importHash.safeParse(preparationSha256).success ||
      !importSourceSchema.safeParse(source).success || typeof authority.verify !== 'function'
    ) throw new Refusal('invalid_import_authority');
    const root = join(directory, `import-runtime-${operationId}`);
    const safePath = (value: string) => value !== '/' && resolve(value) === value && !/[\x00-\x1f,]/u.test(value);
    if (
      !safePath(root) || new Set(media.map(({ target }) => target)).size !== media.length ||
      media.some(({ source, target }) =>
        !safePath(source) || !/^\/(?:data|import-media\/[a-z0-9][a-z0-9_-]*)$/u.test(target) ||
        root === source || root.startsWith(source + '/') || source.startsWith(root + '/'),
      )
    ) throw new Refusal('import_runtime_media_invalid');
    await authority.verify();
    const output = await this.execute('docker', [
      'run', '--rm', '--interactive', '--network', 'none', '--log-driver', 'none', '--pull', 'never',
      '--name', `frameleaf-import-prepare-${operationId}`,
      '--mount', `type=bind,src=${root},dst=${IMPORT_PREPARATION_TARGET}`,
      ...media.flatMap(({ source, target }) => ['--mount', `type=bind,src=${source},dst=${target},readonly`]),
      '--entrypoint', SERVER_ADMIN, image, 'prepare-library-import', '--config', `${IMPORT_PREPARATION_TARGET}/prepare.json`,
    ], {
      cwd: directory,
      timeout: 86_400_000,
      reply: (line) => replyImportPreparationAuthority(line, authority),
    });
    await authority.verify();
    try {
      const result = preparationReceipt.parse(JSON.parse(output.trim().split('\n').at(-1)!));
      const prefix = `bundle-${operationId}-`;
      if (
        result.binding.operationId !== operationId || result.destinationId !== destinationId ||
        JSON.stringify(result.binding.source) !== JSON.stringify(importSourceSchema.parse(source)) ||
        !result.bundleName.startsWith(prefix) || !/^[a-zA-Z0-9]{6}$/u.test(result.bundleName.slice(prefix.length))
      ) throw new Error('Preparation binding changed');
      return result;
    } catch {
      throw new Refusal('invalid_import_response');
    }
  }
  /** Fixed offline command only; container identity survives a Manager restart. */
  async importCommand(
    directory: string,
    project: string,
    operationId: string,
    action: 'status' | 'preflight' | 'run' | 'resume' | 'verify' | 'rollback' | 'abandon',
    common?: {
      source: ImportPlan['source']['kind'];
      destinationId: string;
      bundleName?: string;
      bootstrapAdminId?: string;
      media: { source: string; target: string; readOnly: boolean }[];
      activate?: boolean;
      authority?: ImportSourceAuthority;
    },
  ): Promise<Record<string, any>> {
    if (
      !/^frameleaf-[a-f0-9]{12}$/.test(project) ||
      !/^[a-f0-9-]{36}$/.test(operationId) ||
      !(
        common
          ? ['status', 'preflight', 'run', 'resume', 'verify', 'rollback', 'abandon']
          : ['status', 'preflight', 'run', 'resume', 'verify']
      ).includes(action) ||
      (common !== undefined &&
        (!common ||
          !importSourceKinds.includes(common.source) ||
          !isAbsolute(directory) ||
          !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(common.destinationId) ||
          (common.activate !== undefined && typeof common.activate !== 'boolean') ||
          (common.activate === true && action !== 'verify')))
    )
      throw new Refusal('invalid_import_command');
    const authority = common?.authority === undefined ? undefined : parseImportSourceAuthority(common.authority);
    if (common && action !== 'status' && !authority) throw new Refusal('import_source_authority_required');
    if (authority && (authority.installation !== project.slice('frameleaf-'.length) ||
      authority.binding.operationId !== operationId || authority.binding.source.kind !== common?.source ||
      authority.destinationId !== common?.destinationId))
      throw new Refusal('import_source_authority_invalid');
    const name = `${project}-import-${operationId}`;
    const existing = (await this.inventory()).find((c) => c.Name === `/${name}`);
    if (existing) {
      if (existing.Config.Labels['app.frameleaf.manager.import'] !== operationId)
        throw new Refusal('import_container_identity_changed');
      if (existing.State.Running) throw new Refusal('import_still_running_retry_when_stopped');
      await this.execute('docker', ['rm', existing.Id]);
    }
    const compose = common
      ? await writeCommonImportCompose(directory, project, operationId, common.destinationId, common.media, common.bundleName, common.bootstrapAdminId)
      : 'import-compose.json';
    const output = await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        compose,
        'run',
        '--name',
        name,
        '--no-deps',
        '-T',
        ...(common ? ['--interactive'] : []),
        '--entrypoint',
        SERVER_ADMIN,
        'frameleaf-server',
        common ? 'import-library' : 'import-immich',
        action,
        ...(common ? ['--source', common.source] : []),
        '--config',
        common ? COMMON_IMPORT_CONFIG : '/run/frameleaf/import.json',
        ...(common?.activate ? ['--activate'] : []),
      ],
      {
        cwd: directory,
        timeout: 86_400_000,
        ...(common ? { reply: (line: string) => replyImportSourceAuthority(line, action, authority) } : {}),
      },
    );
    const line = output
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{'));
    if (!line) throw new Refusal('invalid_import_response');
    return JSON.parse(line);
  }
  /** The operation owns the durable preflight receipt and supplies its live source-fence check. */
  async completeReviewedImport(
    directory: string,
    project: string,
    sourceAuthority: ImportSourceAuthority,
    media: { source: string; target: string; readOnly: boolean }[],
    preflight: (run: () => Promise<Record<string, any>>) => Promise<void>,
    beforeActivation?: () => Promise<void>,
    bundleName?: string,
    bootstrapAdminId?: string,
  ): Promise<void> {
    const authority = parseImportSourceAuthority(sourceAuthority);
    const { installation, destinationId, binding: { operationId, source } } = authority;
    if (project !== `frameleaf-${installation}`) throw new Refusal('import_source_authority_invalid');
    await authority.verify();
    const launch = async (action: 'preflight' | 'status' | 'run' | 'resume' | 'verify', activate?: true) => {
      if (activate) await beforeActivation?.();
      return this.importCommand(directory, project, operationId, action, {
        source: source.kind,
        destinationId,
        bundleName,
        bootstrapAdminId,
        media,
        activate,
        authority,
      });
    };
    await preflight(() => launch('preflight'));
    await completeCommonImport(operationId, source, launch);
    await authority.verify();
  }
  async restoreCommand(directory: string, project: string, operationId: string): Promise<void> {
    if (!/^frameleaf-[a-f0-9]{12}$/.test(project) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId))
      throw new Refusal('invalid_restore_command');
    const name = `${project}-restore-${operationId}`;
    const containers = await this.inventory();
    if (
      containers.some(
        (c) =>
          c.State.Running &&
          c.Config.Labels['app.frameleaf.manager'] === project.slice(10) &&
          c.Config.Labels['com.docker.compose.service'] !== 'database',
      )
    )
      throw new Refusal('restore_workers_must_be_stopped');
    const existing = containers.find((c) => c.Name === `/${name}`);
    if (existing) {
      if (
        existing.Config.Labels['app.frameleaf.manager.restore'] !== operationId ||
        existing.Config.Labels['app.frameleaf.manager'] !== project.slice(10) ||
        existing.Config.Labels['com.docker.compose.service'] !== 'frameleaf-server'
      )
        throw new Refusal('restore_container_identity_changed');
      if (existing.State.Running) throw new Refusal('restore_still_running_retry_when_stopped');
      await this.execute('docker', ['rm', existing.Id]);
    }
    await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        'compose.json',
        'run',
        '--rm',
        '--name',
        name,
        '--label',
        `app.frameleaf.manager.restore=${operationId}`,
        '--no-deps',
        '--pull',
        'never',
        '-T',
        '--env',
        `FRAMELEAF_MANAGER_RESTORE_OPERATION_ID=${operationId}`,
        '--entrypoint',
        SERVER_ADMIN,
        'frameleaf-server',
        'restore-state',
      ],
      { cwd: directory, timeout: 7_200_000 },
    );
  }
  async logs(id: string): Promise<string> {
    containerId.parse(id);
    return this.execute('docker', ['logs', '--tail', '200', '--since', '1h', id]);
  }
}
