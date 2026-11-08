import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createInterface } from 'node:readline';
import { access, open, readFile, rename, rm } from 'node:fs/promises';
import { z } from 'zod';
import { isAbsolute, join, resolve } from 'node:path';
import { Refusal, containerId, imageDigest, redact, type Database, type Mount } from './contracts.js';
import { publishFile } from './files.js';
import { containerView, dockerArguments, toHost } from './host-paths.js';
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
const sourceText = z.string().min(1).max(1024);
/** The review-only pass of `prepare-library-import` (action `inspect`); nothing is written. */
export const importInspection = z.strictObject({
  format: z.literal('frameleaf-library-import-inspection'),
  source: importSourceSchema,
  tested: z.boolean(),
  testedVersion: z.string().max(1024),
  summary: z.strictObject({
    owners: count,
    assets: count,
    albums: count,
    files: count,
    bytes: z.string().regex(/^(0|[1-9]\d{0,30})$/u),
  }),
  owners: z
    .array(
      z.strictObject({
        sourceId: sourceText,
        name: z.string().max(1024),
        email: z.string().max(320).nullable(),
        assets: count,
        restrictions: z.array(z.string().min(1).max(200)).max(100),
      }),
    )
    .max(10_000),
  losses: z.array(z.strictObject({ code: sourceText, count })).max(1000),
});
export type ImportInspection = z.infer<typeof importInspection>;
/** The read-only account the preparation uses on the disposable copy; the copy's superuser only loads the dump. */
export const SOURCE_RESTORE_READER = 'frameleaf_reader';
/** The disposable copy of a source app's MySQL/PostgreSQL database, one per capture operation. */
export const sourceRestoreName = (operationId: string) => `frameleaf-import-source-${operationId}`;
const restoreName = /^frameleaf-import-source-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export type SourceDatabaseLogin = {
  engine: 'mysql' | 'postgres';
  container: string;
  name: string;
  user: string;
  password: string;
};
export type SourceRestore = {
  engine: 'mysql' | 'postgres';
  /** The container name, `frameleaf-import-source-<operationId>`. */
  name: string;
  /** The source database container's image ID; the copy runs the same engine build. */
  image: string;
  database: string;
  password: string;
};
// The password reaches docker through its environment, never argv; the extra name lets failure logs mask it.
const loginEnv = (variable: string, password: string) => ({ [variable]: password, FRAMELEAF_SOURCE_PASSWORD: password });

export type Container = {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean; StartedAt?: string; Health?: { Status: string; Log?: { ExitCode: number }[] } };
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
  /** Keep stderr in the result too (`docker logs` replays a container's stderr on its own stderr). */
  mergeStderr?: boolean;
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
  if (binary === 'docker') args = await dockerArguments(args, options.cwd);
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
  else {
    const keep = (chunk: Buffer) => {
      if (result.length + chunk.length > 8 * 1024 * 1024) {
        tooLarge = true;
        child.kill('SIGKILL');
      } else result = Buffer.concat([result, chunk]);
    };
    if (!options.mergeStderr) child.stdout.on('data', keep);
    else
      // Whole lines only, per stream: a stderr chunk never lands inside a stdout line that spans two chunks.
      for (const stream of [child.stdout, child.stderr] as const) {
        let pending = Buffer.alloc(0);
        stream.on('data', (chunk: Buffer | string) => {
          const all = Buffer.concat([pending, Buffer.from(chunk)]);
          const end = all.length > 1024 * 1024 ? all.length : all.lastIndexOf(10) + 1;
          pending = all.subarray(end);
          if (end) keep(all.subarray(0, end));
        });
        stream.once('end', () => pending.length && keep(Buffer.concat([pending, Buffer.from('\n')])));
      }
  }
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
        // Host paths: another container may bind a parent folder that Manager has no container path for.
        return !!left && !!right && overlap(toHost(left), toHost(right));
      }),
  );
}
export class Docker {
  constructor(private execute: typeof command = command) {}
  async inventory(): Promise<Container[]> {
    const ids = (await this.execute('docker', ['ps', '-aq', '--no-trunc'])).trim().split('\n').filter(Boolean);
    if (!ids.length) return [];
    ids.forEach((id) => containerId.parse(id));
    return (JSON.parse(await this.execute('docker', ['inspect', ...ids])) as Container[]).map(containerView);
  }
  async inspect(id: string): Promise<Container> {
    containerId.parse(id);
    return containerView(JSON.parse(await this.execute('docker', ['inspect', id]))[0] as Container);
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
  async sql(db: Database, sql: string, timeout?: number): Promise<string> {
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
      { input: sql, timeout, env: { PGPASSWORD: db.password } },
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
    restore?: string,
  ) {
    const output = await this.runImportPreparation(directory, image, authority, media, restore);
    const { operationId, destinationId, source } = authority;
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
  /** The same offline runner for the review-only `inspect` request: owners, counts and losses, nothing written. */
  async inspectImportSource(
    directory: string,
    image: string,
    authority: ImportPreparationAuthority,
    media: { source: string; target: string }[],
    restore?: string,
  ): Promise<ImportInspection> {
    const output = await this.runImportPreparation(directory, image, authority, media, restore);
    try {
      const result = importInspection.parse(JSON.parse(output.trim().split('\n').at(-1)!));
      if (JSON.stringify(result.source) !== JSON.stringify(importSourceSchema.parse(authority.source)))
        throw new Error('Inspection source changed');
      return result;
    } catch {
      throw new Refusal('invalid_import_response');
    }
  }
  /**
   * Runs the staged `prepare.json` (inspect or prepare) offline. With `restore`, the container shares only that
   * disposable database copy's network namespace (itself `--network none`), so 127.0.0.1 reaches the copy and
   * nothing else.
   */
  private async runImportPreparation(
    directory: string,
    image: string,
    authority: ImportPreparationAuthority,
    media: { source: string; target: string }[],
    restore?: string,
  ): Promise<string> {
    const { operationId, destinationId, source, preparationSha256 } = authority;
    if (
      !imageDigest.safeParse(image).success || !z.uuid().safeParse(operationId).success ||
      !z.uuid().safeParse(destinationId).success || !importHash.safeParse(preparationSha256).success ||
      !importSourceSchema.safeParse(source).success || typeof authority.verify !== 'function' ||
      (restore !== undefined && (restore !== sourceRestoreName(operationId) || !restoreName.test(restore)))
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
      'run', '--rm', '--interactive', '--network', restore ? `container:${restore}` : 'none', '--log-driver', 'none', '--pull', 'never',
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
    return output;
  }
  /** The first of these client programs the container has (MariaDB 11 images dropped the `mysql*` names). */
  private async databaseProgram(container: string, programs: string[]): Promise<string> {
    for (const program of programs) {
      try {
        await this.execute('docker', ['exec', container, program, '--version']);
        return program;
      } catch {
        /* try the next name */
      }
    }
    throw new Refusal('database_image_unsupported');
  }
  /**
   * Dump a stopped source app's database with the database container's own client into a private file.
   * MySQL/MariaDB: one consistent transaction with routines and triggers; PostgreSQL: pg_dump custom format.
   */
  async dumpSourceDatabase(login: SourceDatabaseLogin, destination: string): Promise<void> {
    containerId.parse(login.container);
    if (!/^[A-Za-z0-9_$-]{1,64}$/u.test(login.name) || !/^[A-Za-z0-9_.@-]{1,64}$/u.test(login.user) || !isAbsolute(destination))
      throw new Refusal('invalid_source_database');
    try {
      if (login.engine === 'mysql') {
        const program = await this.databaseProgram(login.container, ['mariadb-dump', 'mysqldump']);
        await this.execute('docker', [
          'exec', '--env', 'MYSQL_PWD', login.container, program,
          '--user', login.user, '--single-transaction', '--routines', '--triggers', '--events', '--no-tablespaces',
          '--hex-blob', '--default-character-set=utf8mb4', '--databases', login.name,
        ], { outputFile: destination, timeout: 7_200_000, env: loginEnv('MYSQL_PWD', login.password) });
      } else
        await this.execute('docker', [
          'exec', '--env', 'PGPASSWORD', login.container, 'pg_dump', '--no-password',
          '--username', login.user, '--dbname', login.name, '--format=custom', '--no-owner', '--no-acl',
        ], { outputFile: destination, timeout: 7_200_000, env: loginEnv('PGPASSWORD', login.password) });
    } catch (error) {
      if (error instanceof Refusal && error.code === 'database_image_unsupported') throw error;
      throw new Refusal('source_database_dump_failed');
    }
  }
  /**
   * Start the disposable copy from the source database's own image with no network at all and a fresh root
   * password. Only `docker exec` and a preparation container sharing its namespace can reach it.
   */
  async startSourceRestore(restore: SourceRestore, operationId: string): Promise<string> {
    if (
      restore.name !== sourceRestoreName(operationId) || !restoreName.test(restore.name) ||
      !/^sha256:[a-f0-9]{64}$/u.test(restore.image) || !/^[A-Za-z0-9_$-]{1,64}$/u.test(restore.database) ||
      !/^[a-f0-9]{64}$/u.test(restore.password)
    ) throw new Refusal('invalid_source_database');
    const environment = restore.engine === 'mysql'
      ? ['--env', 'MARIADB_ROOT_PASSWORD', '--env', 'MYSQL_ROOT_PASSWORD']
      : ['--env', 'POSTGRES_PASSWORD', '--env', 'POSTGRES_USER=postgres', '--env', `POSTGRES_DB=${restore.database}`];
    const id = (await this.execute('docker', [
      'run', '--detach', '--name', restore.name, '--network', 'none', '--restart', 'no', '--pull', 'never',
      '--log-driver', 'none', '--label', `app.frameleaf.manager.import-source=${operationId}`,
      ...environment, restore.image,
    ], {
      env: restore.engine === 'mysql'
        ? { MARIADB_ROOT_PASSWORD: restore.password, MYSQL_ROOT_PASSWORD: restore.password, FRAMELEAF_SOURCE_PASSWORD: restore.password }
        : loginEnv('POSTGRES_PASSWORD', restore.password),
    })).trim();
    return containerId.parse(id);
  }
  /** True once the copy accepts TCP on 127.0.0.1; image entrypoints first run a socket-only setup server. */
  async sourceRestoreReady(restore: SourceRestore): Promise<boolean> {
    if (!restoreName.test(restore.name)) throw new Refusal('invalid_source_database');
    try {
      if (restore.engine === 'mysql') {
        const program = await this.databaseProgram(restore.name, ['mariadb', 'mysql']);
        await this.execute('docker', [
          'exec', '--env', 'MYSQL_PWD', restore.name, program, '--protocol=tcp', '--host=127.0.0.1', '--user=root',
          '--execute=SELECT 1',
        ], { env: loginEnv('MYSQL_PWD', restore.password), timeout: 30_000 });
      } else
        await this.execute('docker', [
          'exec', restore.name, 'pg_isready', '--host=127.0.0.1', '--username=postgres', `--dbname=${restore.database}`,
        ], { timeout: 30_000 });
      return true;
    } catch {
      return false;
    }
  }
  /** Load the dump into the copy over its loopback, as the copy's own superuser. */
  async restoreSourceDatabase(restore: SourceRestore, file: string): Promise<void> {
    if (!restoreName.test(restore.name) || !isAbsolute(file)) throw new Refusal('invalid_source_database');
    try {
      if (restore.engine === 'mysql') {
        const program = await this.databaseProgram(restore.name, ['mariadb', 'mysql']);
        // Events restored from the dump must never run against the copy: it has to stay what was hashed.
        await this.stopSourceRestoreEvents(restore, program);
        await this.execute('docker', [
          'exec', '--interactive', '--env', 'MYSQL_PWD', restore.name, program, '--protocol=tcp', '--host=127.0.0.1',
          '--user=root', '--default-character-set=utf8mb4',
        ], { inputFile: file, timeout: 7_200_000, env: loginEnv('MYSQL_PWD', restore.password) });
      } else
        await this.execute('docker', [
          'exec', '--interactive', '--env', 'PGPASSWORD', restore.name, 'pg_restore', '--no-password', '--host=127.0.0.1',
          '--username=postgres', `--dbname=${restore.database}`, '--exit-on-error', '--single-transaction', '--no-owner', '--no-acl',
        ], { inputFile: file, timeout: 7_200_000, env: loginEnv('PGPASSWORD', restore.password) });
    } catch {
      throw new Refusal('source_database_restore_failed');
    }
  }
  /** Turn the copy's event scheduler off (an image may already start it DISABLED) and confirm it stays off. */
  private async stopSourceRestoreEvents(restore: SourceRestore, program: string): Promise<void> {
    const run = (statement: string) =>
      this.execute('docker', [
        'exec', '--interactive', '--env', 'MYSQL_PWD', restore.name, program, '--protocol=tcp', '--host=127.0.0.1',
        '--user=root', '--batch', '--skip-column-names',
      ], { input: statement + '\n', env: loginEnv('MYSQL_PWD', restore.password), timeout: 60_000 });
    await run('SET GLOBAL event_scheduler=OFF;').catch(() => undefined);
    const state = (await run('SELECT @@global.event_scheduler;')).trim().toUpperCase();
    if (state !== 'OFF' && state !== 'DISABLED') throw new Refusal('source_database_restore_failed');
  }
  /**
   * Lock the loaded copy for the offline readers: a global read-only server (MySQL also super_read_only) and a
   * reader with no role and only catalogue-reading grants (MySQL: SELECT, RELOAD, LOCK TABLES, TRIGGER, EVENT,
   * SHOW VIEW and, where the engine has it, SHOW CREATE ROUTINE / SHOW_ROUTINE; PostgreSQL: SELECT on public).
   */
  async secureSourceRestore(restore: SourceRestore, readerPassword: string): Promise<void> {
    if (!restoreName.test(restore.name) || !/^[a-f0-9]{64}$/u.test(readerPassword) || !/^[A-Za-z0-9_$-]{1,64}$/u.test(restore.database))
      throw new Refusal('invalid_source_database');
    const reader = SOURCE_RESTORE_READER;
    try {
      if (restore.engine === 'mysql') {
        const program = await this.databaseProgram(restore.name, ['mariadb', 'mysql']);
        // The SQL (with the reader's password) goes through stdin, never argv.
        const sql = (statements: string) =>
          this.execute('docker', [
            'exec', '--interactive', '--env', 'MYSQL_PWD', restore.name, program, '--protocol=tcp', '--host=127.0.0.1', '--user=root',
          ], { input: statements, env: loginEnv('MYSQL_PWD', restore.password), timeout: 60_000 });
        const optional = (statement: string) => sql(statement).then(() => true, () => false);
        await sql(
          `CREATE USER '${reader}'@'%' IDENTIFIED BY '${readerPassword}';\n` +
            `GRANT SELECT, RELOAD, LOCK TABLES, TRIGGER, EVENT, SHOW VIEW ON *.* TO '${reader}'@'%';\n`,
        );
        // MariaDB 11.3+ names it SHOW CREATE ROUTINE, MySQL 8.0.20+ SHOW_ROUTINE; older engines have neither.
        if (!(await optional(`GRANT SHOW CREATE ROUTINE ON *.* TO '${reader}'@'%';`)))
          await optional(`GRANT SHOW_ROUTINE ON *.* TO '${reader}'@'%';`);
        await this.stopSourceRestoreEvents(restore, program);
        await sql('SET GLOBAL read_only=1;');
        // MySQL only; MariaDB has no super_read_only.
        await optional('SET GLOBAL super_read_only=1;');
      } else {
        const database = `"${restore.database}"`;
        await this.execute('docker', [
          'exec', '--interactive', '--env', 'PGPASSWORD', restore.name, 'psql', '--no-password', '--host=127.0.0.1',
          '--username=postgres', `--dbname=${restore.database}`, '--set=ON_ERROR_STOP=1', '--quiet',
        ], {
          input: [
            `CREATE ROLE ${reader} LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD '${readerPassword}';`,
            `REVOKE CREATE ON SCHEMA public FROM PUBLIC;`,
            `GRANT CONNECT ON DATABASE ${database} TO ${reader};`,
            `GRANT USAGE ON SCHEMA public TO ${reader};`,
            `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${reader};`,
            `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${reader};`,
            `ALTER ROLE ${reader} SET default_transaction_read_only = on;`,
            `ALTER DATABASE ${database} SET default_transaction_read_only = on;`,
          ].join('\n') + '\n',
          env: loginEnv('PGPASSWORD', restore.password),
          timeout: 60_000,
        });
      }
    } catch {
      throw new Refusal('source_database_restore_failed');
    }
  }
  /** Remove the copy and its anonymous data volume; a copy that was never created is already gone. */
  async removeSourceRestore(name: string): Promise<void> {
    if (!restoreName.test(name)) throw new Refusal('invalid_source_database');
    const existing = (await this.inventory()).find((c) => c.Name === `/${name}`);
    if (!existing) return;
    if (existing.Config.Labels?.['app.frameleaf.manager.import-source'] !== name.slice('frameleaf-import-source-'.length))
      throw new Refusal('import_container_identity_changed');
    await this.execute('docker', ['rm', '--force', '--volumes', existing.Id]);
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
  /** stdout and stderr together, in time order (Docker timestamps every line; they are stripped again). */
  async logs(id: string, { tail = 200, since = '1h' } = {}): Promise<string> {
    containerId.parse(id);
    const text = await this.execute('docker', ['logs', '--timestamps', '--tail', String(tail), '--since', since, id], {
      mergeStderr: true,
    });
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, line]) => line)
      .join('\n');
  }
}
