import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { Refusal, digest, type Installation, type Mount, type Operation } from './contracts.js';
import { command, environment, overlap, type Docker } from './docker.js';
import { atomicJson } from './files.js';
import type { Store } from './store.js';
import type { Fencing } from './fencing.js';
import { filesystemMounts, type PostgresStorage, type FilesystemMount } from './postgres-storage.js';

type Review = {
  available: boolean;
  id: string;
  expires: number;
  current: Installation;
  root: string;
  sourceIdentity: string;
  rootIdentity: string;
  files: number;
  bytes: number;
};
type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>;
export type ServerPauseStatus = {
  paused: boolean;
  operationId: string | null;
  drained: boolean;
  activeJobs: number;
  writesInFlight: number;
};
/**
 * The Frameleaf server's library move pause (FL-360): uploads, changes and every job queue pause,
 * durably across restarts, until resumed or until the pause's lease runs out.
 */
export interface ServerPause {
  pause(operationId: string): Promise<ServerPauseStatus>;
  /** Also renews the pause when `operationId` holds it. */
  status(operationId?: string): Promise<ServerPauseStatus>;
  resume(operationId: string): Promise<unknown>;
}
export type DrainTiming = { timeoutMs: number; intervalMs: number };
const DRAIN: DrainTiming = { timeoutMs: 30 * 60_000, intervalMs: 2000 };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The existing operation lock owns the copy, mapping commit and conservative write-start intent. */
export class LibraryMove {
  private stopping = new Set<string>();
  constructor(
    private store: Store,
    private docker: Docker,
    private fencing: Fencing,
    private storage: PostgresStorage,
    private directory: string,
    private backups: string,
    private execute: typeof command = command,
    private server?: ServerPause,
    private drain: DrainTiming = DRAIN,
  ) {}

  private current(): Installation {
    const installation = this.store.get<Installation>('installation');
    if (!installation) throw new Refusal('no_installation');
    if (installation.mounts.length !== 1 || installation.mounts[0].type !== 'bind' || installation.mounts[0].readOnly)
      throw new Refusal('unsupported_media_mappings');
    return installation;
  }
  private paths(current: Installation, root: string): void {
    if ([current.mounts[0].source, current.databaseRoot, this.directory, this.backups].some((p) => overlap(root, p)))
      throw new Refusal('media_move_overlap');
  }
  private async identity(path: string): Promise<string> {
    const data = await stat(path);
    if (!data.isDirectory() || (await realpath(path)) !== path) throw new Refusal('media_mount_changed');
    return digest({ dev: data.dev, ino: data.ino });
  }
  static backing(path: string, mounts: FilesystemMount[]): { device: string; path: string } {
    const mount = mounts
      .filter((m) => path === m.target || path.startsWith(m.target === '/' ? '/' : m.target + '/'))
      .sort((a, b) => b.target.length - a.target.length)[0];
    if (!mount) throw new Refusal('host_mount_information_required');
    return {
      device: mount.device,
      path: resolve(mount.root, relative(mount.target, path)),
    };
  }
  private async physicalPaths(current: Installation, root: string): Promise<void> {
    const mounts = filesystemMounts(await readFile('/run/frameleaf-host/mountinfo', 'utf8'));
    const location = (path: string) => LibraryMove.backing(path, mounts);
    const destination = location(root);
    const autostart = process.env.MANAGER_UNRAID_AUTOSTART
      ? await readFile(process.env.MANAGER_UNRAID_AUTOSTART, 'utf8')
      : '';
    const names = new Set(autostart.split('\n').map((line) => line.trim().split(/\s+/)[0]));
    const protectedPaths = [location(current.mounts[0].source), destination];
    for (const container of await this.docker.inventory()) {
      if (
        container.Config.Labels?.['app.frameleaf.manager'] === current.id ||
        (container.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
          environment(container).MANAGER_DATA === this.directory)
      )
        continue;
      const canStart =
        container.State.Running ||
        !['', 'no'].includes(container.HostConfig.RestartPolicy.Name) ||
        names.has(container.Name.replace(/^\//, ''));
      if (!canStart) continue;
      for (const mapping of container.Mounts.filter((m) => m.RW && ['bind', 'volume'].includes(m.Type))) {
        if (!mapping.Source.startsWith('/')) throw new Refusal('media_writer_mount_unverified');
        const source = location(mapping.Source);
        if (protectedPaths.some((target) => source.device === target.device && overlap(source.path, target.path)))
          throw new Refusal('other_media_writer_detected');
      }
    }

    if (
      [current.mounts[0].source, current.databaseRoot, this.directory, this.backups]
        .map(location)
        .some((source) => source.device === destination.device && overlap(source.path, destination.path))
    )
      throw new Refusal('media_move_overlap');
  }
  private state(id: string): string {
    return join(this.directory, 'media-moves', id);
  }
  private async cancelled(operation: Operation): Promise<boolean> {
    const marker = await stat(join(this.state(String(operation.input.reviewId)), 'cancel')).catch(
      (e: NodeJS.ErrnoException) => {
        if (e.code !== 'ENOENT') throw e;
        return null;
      },
    );
    return this.stopping.has(operation.id) || !!marker;
  }
  private async helper(
    action: 'measure' | 'freeze' | 'copy' | 'verify',
    review: Review,
    destination: string,
  ): Promise<{ files: number; bytes: number }> {
    const controllers = (await this.docker.inventory()).filter(
      (c) =>
        c.State.Running &&
        c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
        environment(c).MANAGER_DATA === this.directory,
    );
    if (controllers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(controllers[0].Image))
      throw new Refusal('manager_copy_image_unverified');
    const name = `frameleaf-media-${review.id}-${action}`;
    let prior: any = null;
    try {
      prior = JSON.parse(await this.execute('docker', ['inspect', name]))[0];
    } catch (error) {
      if (!(error instanceof Refusal) || error.code !== 'docker_operation_failed') throw error;
    }
    if (prior) {
      if (prior.Config?.Labels?.['app.frameleaf.move'] !== review.id || prior.Image !== controllers[0].Image)
        throw new Refusal('media_copy_container_changed');
      if (prior.State.Running) throw new Refusal('media_copy_still_running');
      await this.execute('docker', ['rm', prior.Id]);
    }
    await mkdir(this.state(review.id), { recursive: true, mode: 0o700 });
    let result: string;
    try {
      result = await this.execute(
        'docker',
        [
          'run',
          '--name',
          name,
          '--pull',
          'never',
          '--label',
          `app.frameleaf.move=${review.id}`,
          '--network',
          'none',
          '--read-only',
          '--memory',
          '512m',
          '--cpus',
          '2',
          '--pids-limit',
          '64',
          '--security-opt',
          'no-new-privileges',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--cap-add',
          'DAC_OVERRIDE',
          '--cap-add',
          'FOWNER',
          '--mount',
          `type=bind,source=${review.current.mounts[0].source},target=/source,readonly`,
          '--mount',
          `type=bind,source=${destination},target=/destination${action === 'copy' ? '' : ',readonly'}`,
          '--mount',
          `type=bind,source=${this.state(review.id)},target=/state`,
          '--entrypoint',
          'node',
          controllers[0].Image,
          '/app/manager/media-copy.cjs',
          action,
        ],
        { timeout: 86_400_000 },
      );
    } finally {
      const owned = JSON.parse(await this.execute('docker', ['inspect', name]))[0];
      if (owned.Config?.Labels?.['app.frameleaf.move'] !== review.id || owned.Image !== controllers[0].Image)
        throw new Refusal('media_copy_container_changed');
      if (!owned.State.Running) await this.execute('docker', ['rm', owned.Id]);
    }
    const values = JSON.parse(result);
    if (
      [
        'unsupported_media_entry',
        'media_source_changed',
        'media_copy_mismatch',
        'media_move_cancelled',
        'media_copy_failed',
      ].includes(values.error)
    )
      throw new Refusal(values.error);
    if (
      !Number.isSafeInteger(values.files) ||
      values.files < 0 ||
      !Number.isSafeInteger(values.bytes) ||
      values.bytes < 0
    )
      throw new Refusal('invalid_media_copy_receipt');
    return values;
  }
  async review(root: string): Promise<Review> {
    const current = this.current();
    this.paths(current, root);
    await this.storage.validate(root, 0);
    await this.storage.validate(current.mounts[0].source, 0, current.id);
    await this.physicalPaths(current, root);
    await this.fencing.assertMedia(current.mounts, current);
    const review: Review = {
      available: await this.pauseAvailable(),
      id: randomUUID(),
      expires: Date.now() + 900_000,
      current,
      root,
      sourceIdentity: await this.identity(current.mounts[0].source),
      rootIdentity: await this.identity(root),
      files: 0,
      bytes: 0,
    };
    const size = await this.helper('measure', review, root);
    await this.storage.validate(root, size.bytes);
    Object.assign(review, size);
    this.store.set(`media-move:${review.id}`, review);
    return review;
  }
  private requireQuiescence(): void {
    // The server must offer the FL-360 pause; without it nothing is stopped or moved.
    if (!this.server) throw new Refusal('media_quiescence_unavailable');
  }
  private async pauseAvailable(): Promise<boolean> {
    if (!this.server) return false;
    try {
      const status = await this.server.status();
      return !status.paused;
    } catch {
      return false;
    }
  }
  private async serverRunning(current: Installation): Promise<boolean> {
    return (await this.docker.inventory()).some(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === current.id &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server' &&
        c.State.Running,
    );
  }
  /**
   * Pause uploads, changes and job queues on the running server and wait until nothing is in flight.
   * A stack that is already stopped (a retried step) has nothing left to drain. Any failure lifts
   * the pause again before it is reported, so a refused move leaves the server working.
   */
  private async quiesce(operation: Operation, current: Installation): Promise<void> {
    if (!(await this.serverRunning(current))) return;
    if (!this.server) throw new Refusal('media_quiescence_unavailable');
    const deadline = Date.now() + this.drain.timeoutMs;
    try {
      let status = await this.server.pause(operation.id);
      while (!status.drained) {
        if (await this.cancelled(operation)) throw new Refusal('media_move_cancelled');
        if (Date.now() >= deadline) throw new Refusal('media_quiescence_timeout');
        await delay(this.drain.intervalMs);
        status = await this.server.status(operation.id);
        if (!status.paused || status.operationId !== operation.id) throw new Refusal('media_quiescence_lost');
      }
    } catch (error) {
      await this.resumeServer(operation, current);
      throw error instanceof Refusal ? error : new Refusal('media_quiescence_unavailable');
    }
  }
  /** Lift the pause once the server answers again; the server's own lease lifts it if this cannot. */
  private async resumeServer(operation: Operation, current: Installation): Promise<boolean> {
    if (!this.server) return false;
    const deadline = Date.now() + this.drain.timeoutMs;
    for (;;) {
      try {
        if (await this.serverRunning(current)) {
          await this.server.resume(operation.id);
          operation.receipts['move-server-resumed'] = true;
          this.store.save(operation);
          return true;
        }
      } catch {
        /* the server is still starting */
      }
      if (Date.now() >= deadline) return false;
      await delay(this.drain.intervalMs);
    }
  }
  start(id: string, key: string): { operation: Operation; created: boolean } {
    const prior = this.store.request('move-library', key, { reviewId: id });
    if (prior) return { operation: prior, created: false };
    const review = this.store.get<Review>(`media-move:${id}`);
    if (!review || review.expires < Date.now() || digest(review.current) !== digest(this.current()))
      throw new Refusal('review_expired');
    this.requireQuiescence();
    return this.store.start('move-library', key, { reviewId: id });
  }
  static configuration(compose: any, mount: Mount, destination: string): any {
    const updated = structuredClone(compose);
    const volumes = updated.services?.['frameleaf-server']?.volumes;
    const mapping = volumes?.filter(
      (m: any) =>
        m.type === 'bind' && m.source === mount.source && m.target === mount.target && m.read_only === mount.readOnly,
    );
    if (mapping?.length !== 1) throw new Refusal('media_mapping_changed');
    mapping[0].source = destination;
    return updated;
  }
  async run(
    operation: Operation,
    step: Step,
    checkpoint: () => Promise<string>,
    status: () => Promise<unknown>,
  ): Promise<void> {
    const review = this.store.get<Review>(`media-move:${operation.input.reviewId}`);
    if (!review) throw new Refusal('review_missing');
    if (operation.receipts['move-recovery-intent']) return this.recover(operation);
    if (await this.cancelled(operation)) throw new Refusal('media_move_cancelled');
    const current = review.current;
    this.paths(current, review.root);
    await this.physicalPaths(current, review.root);
    if (
      (await this.identity(current.mounts[0].source)) !== review.sourceIdentity ||
      (await this.identity(review.root)) !== review.rootIdentity
    )
      throw new Refusal('media_mount_changed');
    const destination = join(review.root, `frameleaf-${current.id}-media-${operation.id}`);
    await step('move-stop-writers', async () => {
      if (digest(this.current()) !== digest(current)) throw new Refusal('installation_changed');
      await this.storage.validate(review.root, review.bytes);
      await this.fencing.assertMedia(current.mounts, current);
      await this.quiesce(operation, current);
      const writers = (await this.docker.inventory()).filter(
        (c) => c.Config.Labels?.['app.frameleaf.manager'] === current.id,
      );
      operation.receipts['move-writer-policies'] ??= writers.map((c) => ({
        service: c.Config.Labels['com.docker.compose.service'],
        restart: c.HostConfig.RestartPolicy,
      }));
      this.store.save(operation);
      await this.fencing.stopInstallation(current);
      return true;
    });
    await step('move-checkpoint', async () => {
      await this.fencing.stopInstallation(current);
      await this.docker.compose(join(this.directory, 'stack'), current.project, 'up', ['database']);
      return checkpoint();
    });
    await step('move-fence-stack', async () => {
      await this.fencing.stopInstallation(current);
      return true;
    });
    if (!operation.receipts['move-writes-intent']) {
      await this.fencing.verifyInstallation(current);
      await this.fencing.assertMedia(current.mounts, current);
    }
    const frozen = await step('move-freeze', () => this.helper('freeze', review, review.root));
    await step('move-copy', async () => {
      await this.storage.validate(review.root, frozen.bytes);
      if (await this.cancelled(operation)) throw new Refusal('media_move_cancelled');
      const owned = operation.receipts['move-destination'] as { path: string; identity: string } | undefined;
      try {
        await mkdir(destination, { mode: 0o700 });
      } catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        if (!owned || owned.path !== destination || owned.identity !== (await this.identity(destination)))
          throw new Refusal('media_destination_unverified');
      }
      if ((await realpath(destination)) !== destination) throw new Refusal('media_mount_changed');
      operation.receipts['move-destination'] = {
        path: destination,
        identity: await this.identity(destination),
      };
      this.store.save(operation);
      return this.helper('copy', review, destination);
    });
    await step('move-verify', () => this.helper('verify', review, destination));
    const next = {
      ...current,
      mounts: [{ ...current.mounts[0], source: destination }],
    };
    await step('move-switch', async () => {
      if (await this.cancelled(operation)) throw new Refusal('media_move_cancelled');
      await this.helper('verify', review, destination);
      if (
        (await this.identity(current.mounts[0].source)) !== review.sourceIdentity ||
        (await this.identity(review.root)) !== review.rootIdentity
      )
        throw new Refusal('media_mount_changed');
      await this.fencing.verifyInstallation(current);
      await this.physicalPaths(current, review.root);

      await this.storage.validate(destination, 0, current.id);
      const existing = this.store.get<Installation>('installation');
      if (digest(existing) !== digest(current) && digest(existing) !== digest(next))
        throw new Refusal('installation_changed');
      const path = join(this.directory, 'stack', 'compose.json');
      const original = JSON.parse(
        await readFile(join(this.directory, 'checkpoints', operation.id, 'compose.json'), 'utf8'),
      );
      await atomicJson(path, LibraryMove.configuration(original, current.mounts[0], destination));
      this.store.set('installation', next);
      this.store.set(`retained-media:${operation.id}`, {
        source: current.mounts[0].source,
        destination,
        installation: current,
      });
      return next;
    });
    await step('move-start', async () => {
      if ((await this.cancelled(operation)) && !operation.receipts['move-writes-intent'])
        throw new Refusal('media_move_cancelled');
      await this.fencing.assertMedia([...current.mounts, ...next.mounts], next);
      await this.physicalPaths(current, review.root);
      if (await this.cancelled(operation)) throw new Refusal('media_move_cancelled');
      // Starting may have succeeded before a lost response. A rollback must never discard new writes.
      operation.receipts['move-writes-intent'] = true;
      this.store.save(operation);
      await this.docker.compose(join(this.directory, 'stack'), current.project, 'up');
      try {
        return await this.checkStarted(operation, current, review, destination, status);
      } finally {
        // Succeeded or not, the library now runs from the new folder: uploads and jobs resume.
        await this.resumeServer(operation, current);
      }
    });
  }
  private async checkStarted(
    operation: Operation,
    current: Installation,
    review: Review,
    destination: string,
    status: () => Promise<unknown>,
  ) {
    await this.restorePolicies(operation, current);
    const server = (await this.docker.inventory()).find(
      (c) =>
        c.Config.Labels?.['app.frameleaf.manager'] === current.id &&
        c.Config.Labels?.['com.docker.compose.service'] === 'frameleaf-server',
    );
    if (
      !server?.State.Running ||
      !server.Mounts.some(
        (m) => m.Type === 'bind' && m.Source === destination && m.Destination === current.mounts[0].target && m.RW,
      )
    )
      throw new Refusal('media_mapping_changed');
    if (server.State.Health?.Status !== 'healthy') throw new Refusal('media_move_health_unverified');
    const manifest = JSON.parse(await readFile(join(this.state(review.id), 'manifest.json'), 'utf8')) as {
      path: string;
      directory: boolean;
      sha256?: string;
    }[];
    const files = manifest.filter((entry) => !entry.directory);
    const chosen = [
      ...new Map(
        [
          files.find((entry) => /(^|\/)upload\//.test(entry.path)),
          files.find((entry) => /(^|\/)thumbs\//.test(entry.path)),
          ...files,
        ]
          .filter((entry): entry is (typeof files)[number] => !!entry)
          .map((entry) => [entry.path, entry]),
      ).values(),
    ].slice(0, 64);
    const script = `const fs=require('node:fs/promises'),{createHash}=require('node:crypto'),{join,resolve}=require('node:path');(async()=>{const root=process.argv[1];await fs.access(root);for(const e of JSON.parse(process.argv[2])){const p=join(root,e.path);if(!p.startsWith(root+'/')||await fs.realpath(p)!==p)throw Error();const h=createHash('sha256');const f=await fs.open(p,'r');try{if(!(await f.stat()).isFile())throw Error();for await(const b of f.createReadStream({autoClose:false}))h.update(b);}finally{await f.close();}if(h.digest('hex')!==e.sha256)throw Error();}process.stdout.write('true');})().catch(()=>process.exit(1));`;
    if ((await this.docker.node(server.Id, script, [current.mounts[0].target, JSON.stringify(chosen)])) !== 'true')
      throw new Refusal('media_move_access_unverified');
    const library = (await status()) as { verificationPassed?: boolean; phase?: string };
    if (!library.verificationPassed || library.phase === 'needs-attention')
      throw new Refusal('media_move_library_needs_attention');
    return { accessChecked: chosen.length, library };
  }
  async stop(operation: Operation): Promise<void> {
    if (operation.receipts['move-writes-intent']) throw new Refusal('media_move_reverse_required');
    this.stopping.add(operation.id);
    await mkdir(this.state(String(operation.input.reviewId)), {
      recursive: true,
      mode: 0o700,
    });
    await atomicJson(join(this.state(String(operation.input.reviewId)), 'cancel'), { stopped: true });
  }
  async recover(operation: Operation): Promise<void> {
    if (operation.receipts['move-writes-intent']) throw new Refusal('media_move_reverse_required');
    operation.receipts['move-recovery-intent'] = true;
    this.store.save(operation);
    const review = this.store.get<Review>(`media-move:${operation.input.reviewId}`);
    if (!review) throw new Refusal('review_missing');
    // Refuse recovery until the actual owned copier has exited; do not race it with restart.
    for (const c of await this.docker.inventory())
      if (c.Config.Labels?.['app.frameleaf.move'] === review.id && c.State.Running)
        throw new Refusal('media_copy_still_running');
    const original = JSON.parse(
      await readFile(join(this.directory, 'checkpoints', operation.id, 'compose.json'), 'utf8').catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT' || operation.completed.includes('move-checkpoint')) throw error;
          if (digest(this.current()) !== digest(review.current)) throw new Refusal('installation_changed');
          return readFile(join(this.directory, 'stack', 'compose.json'), 'utf8');
        },
      ),
    );
    if ((await this.identity(review.current.mounts[0].source)) !== review.sourceIdentity)
      throw new Refusal('media_mount_changed');
    if (!operation.receipts['move-recovery-writes-intent'] && operation.completed.includes('move-freeze'))
      await this.helper('freeze', review, review.root);
    await this.fencing.assertMedia(review.current.mounts, review.current);
    await atomicJson(join(this.directory, 'stack', 'compose.json'), original);
    this.store.set('installation', review.current);
    operation.receipts['move-recovery-writes-intent'] = true;
    this.store.save(operation);
    await this.docker.compose(join(this.directory, 'stack'), review.current.project, 'up');
    await this.restorePolicies(operation, review.current);
    await this.resumeServer(operation, review.current);
    operation.receipts['cancelled'] = 'media_move_cancelled_original_retained';
  }
  private async restorePolicies(operation: Operation, current: Installation): Promise<void> {
    const containers = await this.docker.inventory();
    for (const writer of (operation.receipts['move-writer-policies'] ?? []) as any[]) {
      const container = containers.find(
        (c) =>
          c.Config.Labels?.['app.frameleaf.manager'] === current.id &&
          c.Config.Labels?.['com.docker.compose.service'] === writer.service,
      );
      if (!container) throw new Refusal('managed_container_changed');
      const policy = writer.restart;
      await this.docker.restartPolicy(
        container.Id,
        policy.Name === 'on-failure' && policy.MaximumRetryCount
          ? `on-failure:${policy.MaximumRetryCount}`
          : policy.Name,
      );
    }
  }
}
