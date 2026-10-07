import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { open, rename, rm } from 'node:fs/promises';
import { Refusal, containerId, imageDigest, type Database, type Mount } from './contracts.js';
import { publishFile } from './files.js';

export type Container = {
  Id: string;
  Name: string;
  Image: string;
  State: { Running: boolean; Health?: { Status: string } };
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
  input?: string;
  inputFile?: string;
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
  // An incomplete transfer is never a receipt; the operation lock makes its retry exclusive.
  if (options.outputFile) await rm(`${options.outputFile}.partial`, { force: true });
  const child = spawn(binary, args, {
    shell: false,
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_CONFIG: process.env.DOCKER_CONFIG, ...options.env },
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), options.timeout ?? 120_000);
  let result = Buffer.alloc(0),
    tooLarge = false;
  // Never retain stderr: Docker, pg_dump and restic failures can contain database credentials.
  child.stderr.resume();
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(new Refusal(`${binary}_unavailable`, 503)));
    child.once('close', (code) => {
      clearTimeout(timer);
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
  if (options.inputFile) transfers.push(pipeline(createReadStream(options.inputFile), child.stdin));
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
    if (options.outputFile) await rm(`${options.outputFile}.partial`, { force: true });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export const environment = (c: Container) =>
  Object.fromEntries(
    (c.Config.Env ?? []).map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
  );
export const mounts = (c: Container): Mount[] =>
  c.Mounts.filter((m) => m.Type === 'bind' || m.Type === 'volume').map((m) => ({
    type: m.Type as 'bind' | 'volume',
    source: m.Type === 'volume' ? m.Name! : m.Source,
    target: m.Destination,
    readOnly: !m.RW,
  }));
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
  async compatibility(): Promise<{ platform: string; version: string; compose: string; dataRoot: string }> {
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
    return { platform: `linux/${architecture}`, version: info.ServerVersion, compose, dataRoot: info.DockerRootDir };
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
        `PGPASSWORD=${db.password}`,
        db.container,
        'psql',
        '-X',
        '--no-password',
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--set',
        'ON_ERROR_STOP=1',
        '-At',
      ],
      { input: sql },
    );
  }
  async dump(db: Database, destination: string): Promise<void> {
    containerId.parse(db.container);
    await this.execute(
      'docker',
      [
        'exec',
        '--env',
        `PGPASSWORD=${db.password}`,
        db.container,
        'pg_dump',
        '--no-password',
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ],
      { outputFile: destination, timeout: 7_200_000 },
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
        `PGPASSWORD=${db.password}`,
        db.container,
        'pg_restore',
        '--no-password',
        '--username',
        db.user,
        '--dbname',
        db.name,
        '--exit-on-error',
        '--single-transaction',
        '--no-owner',
        '--no-acl',
      ],
      { inputFile: file, timeout: 7_200_000 },
    );
  }
  async verifyDump(db: Database, file: string): Promise<void> {
    containerId.parse(db.container);
    await this.execute('docker', ['exec', '-i', db.container, 'pg_restore', '--list'], { inputFile: file });
  }
  async restartPolicy(id: string, policy: string): Promise<void> {
    containerId.parse(id);
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
      services.some((s) => !['database', 'redis', 'frameleaf-server', 'immich-machine-learning'].includes(s))
    )
      throw new Refusal('invalid_managed_project');
    await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        'compose.json',
        action,
        ...(action === 'up' ? ['--detach', '--wait', '--wait-timeout', '900', '--pull', 'never'] : []),
        ...services,
      ],
      { cwd: directory, timeout: 1_200_000 },
    );
  }
  /** Fixed offline command only; container identity survives a Manager restart. */
  async importCommand(
    directory: string,
    project: string,
    operationId: string,
    action: 'status' | 'preflight' | 'run' | 'resume' | 'verify',
  ): Promise<Record<string, any>> {
    if (
      !/^frameleaf-[a-f0-9]{12}$/.test(project) ||
      !/^[a-f0-9-]{36}$/.test(operationId) ||
      !['status', 'preflight', 'run', 'resume', 'verify'].includes(action)
    )
      throw new Refusal('invalid_import_command');
    const name = `${project}-import-${operationId}`;
    const existing = (await this.inventory()).find((c) => c.Name === `/${name}`);
    if (existing) {
      if (existing.Config.Labels['app.frameleaf.manager.import'] !== operationId)
        throw new Refusal('import_container_identity_changed');
      if (existing.State.Running) throw new Refusal('import_still_running_retry_when_stopped');
      await this.execute('docker', ['rm', existing.Id]);
    }
    const output = await this.execute(
      'docker',
      [
        'compose',
        '--project-name',
        project,
        '--file',
        'import-compose.json',
        'run',
        '--name',
        name,
        '--no-deps',
        '-T',
        '--entrypoint',
        'node',
        'frameleaf-server',
        'dist/main.js',
        'frameleaf-admin',
        'import-immich',
        action,
        '--config',
        '/run/frameleaf/import.json',
      ],
      { cwd: directory, timeout: 86_400_000 },
    );
    const line = output
      .trim()
      .split('\n')
      .findLast((line) => line.startsWith('{'));
    if (!line) throw new Refusal('invalid_import_response');
    return JSON.parse(line);
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
        'node',
        'frameleaf-server',
        'dist/main.js',
        'frameleaf-admin',
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
