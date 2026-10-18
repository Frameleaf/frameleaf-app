import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { digest, Refusal, type Operation } from '../contracts.js';
import { Store } from '../store.js';

const localPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && resolve(value) === value);
const Installation = z
  .object({
    runtime: z.literal('native'),
    id: z.string().regex(/^[a-f0-9]{12}$/),
    controller: localPath,
    candidate: localPath,
    state: localPath,
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    certified: z.boolean(),
    databasePort: z.number().int().min(1).max(65535),
    apiPort: z.number().int().min(1).max(65535),
  })
  .strict()
  .refine((value) => value.databasePort !== value.apiPort);
export type NativeInstallation = z.infer<typeof Installation>;
const Running = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('running'),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{40}$/),
    certified: z.boolean(),
  })
  .strict();
const Stopped = z
  .object({ protocolVersion: z.literal(1), state: z.literal('stopped') })
  .strict();
const Failed = z
  .object({
    protocolVersion: z.literal(1),
    state: z.literal('failed'),
    code: z.string().min(1).max(128),
  })
  .strict();
const Quiescent = Running.omit({ state: true })
  .extend({
    state: z.literal('quiescent'),
    installationId: z.string().regex(/^[a-f0-9]{12}$/),
    profileIdentity: z.string().regex(/^[a-f0-9]{64}$/),
    generation: z.string().uuid(),
  })
  .strict();
type Ready = z.infer<typeof Running>;
type StopReceipt = z.infer<typeof Stopped> & {
  inspection?: z.infer<typeof Quiescent>;
};
export interface NativeRuntime {
  readonly identity: Readonly<{
    runtime: 'native';
    installationId: string;
    fingerprint: string;
  }>;
  start(): Promise<Ready>;
  stop(): Promise<StopReceipt>;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // Either side may fail before its caller starts waiting; the promise still retains that failure.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Owner = {
  child: ChildProcessWithoutNullStreams | null;
  ready: ReturnType<typeof deferred<Ready>>;
  closed: ReturnType<typeof deferred<StopReceipt>>;
  readySeen: boolean;
  stoppedSeen: boolean;
  stopping: boolean;
  finished: boolean;
  fault: Refusal | null;
  startupTimer?: ReturnType<typeof setTimeout>;
  stopTimer?: ReturnType<typeof setTimeout>;
};

/** The descriptor comes from reviewed installed resources, never a photo-server response or webview. */
export class NativeHost implements NativeRuntime {
  readonly installation: Readonly<NativeInstallation>;
  readonly identity: NativeRuntime['identity'];
  private owner: Owner | null = null;
  private inspecting: Promise<StopReceipt> | null = null;
  private observed:
    { state: 'stopped' } | { state: 'unknown'; code: string } | null = null;
  constructor(
    installation: NativeInstallation,
    private password: () => Promise<string>,
    private authorizeController: () => Promise<void> = async () => {},
  ) {
    const parsed = Installation.safeParse(installation);
    if (!parsed.success) throw new Refusal('native_installation_invalid');
    this.installation = Object.freeze(parsed.data);
    this.identity = Object.freeze({
      runtime: 'native',
      installationId: parsed.data.id,
      fingerprint: digest(parsed.data),
    });
  }
  start(): Promise<Ready> {
    if (this.inspecting)
      return Promise.reject(new Refusal('native_runtime_busy'));
    if (this.owner && !this.owner.finished) {
      if (this.owner.stopping)
        return Promise.reject(new Refusal('native_runtime_busy'));
      return this.owner.ready.promise;
    }
    const owner: Owner = {
      child: null,
      ready: deferred<Ready>(),
      closed: deferred<StopReceipt>(),
      readySeen: false,
      stoppedSeen: false,
      stopping: false,
      finished: false,
      fault: null,
    };
    this.observed = null;
    this.owner = owner;
    void this.launch(owner).catch(() => {
      owner.fault ??= new Refusal('native_controller_unavailable');
      if (owner.child) this.stopOwner(owner);
      else this.finish(owner);
    });
    return owner.ready.promise;
  }
  stop(): Promise<StopReceipt> {
    if (!this.owner || this.owner.finished) return this.inspect();
    if (!this.owner.finished) this.stopOwner(this.owner);
    return this.owner.closed.promise;
  }
  status(): {
    state: 'unknown' | 'starting' | 'running' | 'stopping' | 'stopped';
    code?: string;
  } {
    const owner = this.owner;
    if (this.inspecting)
      return { state: 'unknown', code: 'native_state_inspecting' };
    if ((!owner || owner.finished) && this.observed) return this.observed;
    if (!owner) return { state: 'unknown', code: 'native_owner_not_attached' };
    if (owner.fault) return { state: 'unknown', code: owner.fault.code };
    if (owner.finished) return { state: 'stopped' };
    return {
      state: owner.stopping
        ? 'stopping'
        : owner.readySeen
          ? 'running'
          : 'starting',
    };
  }
  private inspect(): Promise<StopReceipt> {
    if (this.inspecting) return this.inspecting;
    this.observed = null;
    const work = this.probe()
      .then((receipt) => {
        this.observed = { state: 'stopped' };
        return receipt;
      })
      .catch((error: unknown) => {
        const failure =
          error instanceof Refusal
            ? error
            : new Refusal('native_host_inspection_failed');
        this.observed = { state: 'unknown', code: failure.code };
        throw failure;
      })
      .finally(() => {
        this.inspecting = null;
      });
    this.inspecting = work;
    void work.catch(() => {});
    return work;
  }
  private async probe(): Promise<StopReceipt> {
    await this.authorizeController();
    const { id, candidate, state, manifestSha256 } = this.installation;
    const wire =
      JSON.stringify({
        protocolVersion: 1,
        installationId: id,
        candidate,
        state,
        manifestSha256,
      }) + '\n';
    if (Buffer.byteLength(wire) > 16 * 1024)
      return Promise.reject(new Refusal('native_installation_invalid'));
    return new Promise((resolve, reject) => {
      const env =
        process.platform === 'win32' && process.env.SystemRoot
          ? { SystemRoot: process.env.SystemRoot }
          : {};
      const child = spawn(this.installation.controller, ['--inspect-owner'], {
        env,
        stdio: 'pipe',
        windowsHide: true,
      });
      let output = Buffer.alloc(0);
      let fault: Refusal | null = null;
      const fail = (code: string) => {
        fault ??= new Refusal(code);
        child.kill();
      };
      const timer = setTimeout(
        () => fail('native_inspection_timeout'),
        120_000,
      );
      timer.unref();
      child.stderr.resume();
      child.once('error', () => fail('native_controller_unavailable'));
      child.stdin.on('error', () => fail('native_host_pipe_failed'));
      child.stdout.on('error', () => fail('native_host_pipe_failed'));
      child.stderr.on('error', () => fail('native_host_pipe_failed'));
      child.stdout.on('data', (chunk: Buffer) => {
        if (fault) return;
        if (output.length + chunk.length > 16 * 1024)
          return fail('native_host_protocol_invalid');
        output = Buffer.concat([output, chunk]);
      });
      child.once('close', (code, signal) => {
        clearTimeout(timer);
        if (fault) return reject(fault);
        let value: unknown;
        try {
          value = JSON.parse(output.toString('utf8'));
        } catch {
          return reject(new Refusal('native_host_inspection_failed'));
        }
        const failed = Failed.safeParse(value);
        if (failed.success) {
          const allowed = [
            'host_recovery_requires_manager',
            'host_profile_identity_changed',
            'host_controller_binding_changed',
            'host_controller_already_owned',
            'host_process_state_requires_review',
            'host_controller_state_unavailable',
          ];
          return reject(
            new Refusal(
              allowed.includes(failed.data.code)
                ? failed.data.code
                : 'native_host_inspection_failed',
            ),
          );
        }
        const result = Quiescent.safeParse(value);
        if (code !== 0 || signal || !result.success)
          return reject(new Refusal('native_host_inspection_failed'));
        const expected = this.installation;
        if (
          result.data.installationId !== id ||
          result.data.manifestSha256 !== manifestSha256 ||
          result.data.sourceRevision !== expected.sourceRevision ||
          result.data.certified !== expected.certified
        )
          return reject(new Refusal('native_host_identity_changed'));
        resolve({
          protocolVersion: 1,
          state: 'stopped',
          inspection: result.data,
        });
      });
      child.stdin.end(wire);
    });
  }
  private stopOwner(owner: Owner): void {
    if (owner.stopping || owner.finished) return;
    owner.stopping = true;
    owner.ready.reject(owner.fault ?? new Refusal('native_start_cancelled'));
    if (!owner.child) return;
    owner.child.stdin.end('stop\n');
    owner.stopTimer = setTimeout(() => {
      owner.fault ??= new Refusal('native_shutdown_unconfirmed');
      owner.child?.kill(); // Only a live owned ChildProcess; never a PID from storage.
    }, 170_000);
    owner.stopTimer.unref();
  }
  private finish(owner: Owner): void {
    clearTimeout(owner.startupTimer);
    clearTimeout(owner.stopTimer);
    owner.finished = true;
    if (!owner.readySeen) owner.fault ??= new Refusal('native_start_cancelled');
    if (owner.fault) {
      owner.ready.reject(owner.fault);
      owner.closed.reject(owner.fault);
    } else {
      owner.ready.reject(new Refusal('native_start_cancelled'));
      owner.closed.resolve({ protocolVersion: 1, state: 'stopped' });
    }
  }
  private async launch(owner: Owner): Promise<void> {
    try {
      await this.authorizeController();
    } catch {
      owner.fault = new Refusal('native_controller_changed');
      throw owner.fault;
    }
    if (owner.stopping) {
      owner.fault ??= new Refusal('native_start_cancelled');
      throw owner.fault;
    }
    let password: string;
    try {
      password = await this.password();
    } catch {
      owner.fault = new Refusal('native_credentials_unavailable');
      throw owner.fault;
    }
    if (owner.stopping) {
      owner.fault ??= new Refusal('native_start_cancelled');
      throw owner.fault;
    }
    if (
      typeof password !== 'string' ||
      password.length < 24 ||
      Buffer.byteLength(password) > 512 ||
      /[\r\n\0]/.test(password)
    ) {
      owner.fault = new Refusal('native_credentials_unavailable');
      throw owner.fault;
    }
    const { id, candidate, state, manifestSha256, databasePort, apiPort } =
      this.installation;
    const wire =
      JSON.stringify({
        protocolVersion: 1,
        installationId: id,
        candidate,
        state,
        manifestSha256,
        databasePort,
        apiPort,
        password,
      }) + '\n';
    if (Buffer.byteLength(wire) > 16 * 1024)
      throw new Refusal('native_installation_invalid');
    const env =
      process.platform === 'win32' && process.env.SystemRoot
        ? { SystemRoot: process.env.SystemRoot }
        : {};
    const child = spawn(this.installation.controller, ['--owner-pipe'], {
      env,
      stdio: 'pipe',
      windowsHide: true,
    });
    owner.child = child;
    child.stderr.resume(); // Never surface child stderr, arguments or credential-bearing config.
    let pending = Buffer.alloc(0);
    const fail = (code: string) => {
      owner.fault ??= new Refusal(code);
      this.stopOwner(owner);
    };
    owner.startupTimer = setTimeout(
      () => fail('native_startup_timeout'),
      300_000,
    );
    owner.startupTimer.unref();
    child.once('error', () => fail('native_controller_unavailable'));
    child.stdin.on('error', () => fail('native_host_pipe_failed'));
    child.stdout.on('error', () => fail('native_host_pipe_failed'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (owner.fault) return;
      pending = Buffer.concat([pending, chunk]);
      if (pending.length > 16 * 1024)
        return fail('native_host_protocol_invalid');
      let newline: number;
      while ((newline = pending.indexOf(10)) !== -1) {
        let value: unknown;
        try {
          value = JSON.parse(pending.subarray(0, newline).toString('utf8'));
        } catch {
          return fail('native_host_protocol_invalid');
        }
        pending = pending.subarray(newline + 1);
        const running = Running.safeParse(value);
        if (running.success && !owner.readySeen && !owner.stoppedSeen) {
          const expected = this.installation;
          if (
            running.data.manifestSha256 !== expected.manifestSha256 ||
            running.data.sourceRevision !== expected.sourceRevision ||
            running.data.certified !== expected.certified
          )
            return fail('native_host_identity_changed');
          owner.readySeen = true;
          clearTimeout(owner.startupTimer);
          if (!owner.stopping) owner.ready.resolve(running.data);
        } else if (
          Stopped.safeParse(value).success &&
          owner.stopping &&
          !owner.stoppedSeen
        ) {
          owner.stoppedSeen = true;
        } else if (Failed.safeParse(value).success) {
          return fail('native_host_failed');
        } else return fail('native_host_protocol_invalid');
      }
    });
    child.once('close', (code, signal) => {
      if (
        code !== 0 ||
        signal ||
        pending.length ||
        !owner.stoppedSeen ||
        !owner.stopping
      )
        owner.fault ??= new Refusal('native_shutdown_unconfirmed');
      this.finish(owner);
    });
    child.stdin.write(wire);
  }
}

/** Native lifecycle uses Manager's journal/lock; backup, update and restore remain their existing authorities. */
export class NativeOperations {
  private executing = new Map<string, Promise<void>>();
  constructor(
    readonly store: Store,
    private runtime: NativeRuntime,
  ) {}
  control(kind: 'start' | 'stop' | 'restart', key: string): Operation {
    if (!['start', 'stop', 'restart'].includes(kind))
      throw new Refusal('invalid_control_operation');
    const { operation, created } = this.store.start(kind, key, {
      ...this.runtime.identity,
    });
    if (created) this.launch(operation);
    return operation;
  }
  resume(id: string): Operation {
    const operation = this.store.history().find((value) => value.id === id);
    if (
      !operation ||
      this.executing.has(id) ||
      !['failed', 'interrupted'].includes(operation.state) ||
      !['start', 'stop', 'restart'].includes(operation.kind) ||
      JSON.stringify(operation.input) !== JSON.stringify(this.runtime.identity)
    )
      throw new Refusal('operation_not_recoverable');
    operation.state = 'running';
    operation.error = null;
    this.store.save(operation);
    this.launch(operation);
    return operation;
  }
  async wait(id: string): Promise<Operation> {
    try {
      await this.executing.get(id);
      const operation = this.store.history().find((value) => value.id === id);
      if (!operation) throw new Refusal('operation_not_found');
      return operation;
    } catch (error) {
      if (error instanceof Refusal) throw error;
      throw new Refusal('operation_journal_unavailable');
    }
  }
  private launch(operation: Operation): void {
    const work = this.run(operation)
      .then(() => {
        operation.state = 'complete';
        this.store.save(operation);
      })
      .catch((error: unknown) => {
        operation.state = 'failed';
        operation.error =
          error instanceof Refusal ? error.code : 'operation_failed';
        this.store.save(operation);
      })
      .finally(() => this.executing.delete(operation.id));
    this.executing.set(operation.id, work);
    // A failed journal write retains its database lock; detached API calls must not crash Manager.
    void work.catch(() => {});
  }
  private async step(
    operation: Operation,
    name: string,
    work: () => Promise<unknown>,
  ): Promise<void> {
    operation.step = name;
    this.store.save(operation);
    operation.receipts[name] = await work();
    if (!operation.completed.includes(name)) operation.completed.push(name);
    this.store.save(operation);
  }
  private async run(operation: Operation): Promise<void> {
    if (
      operation.kind === 'restart' &&
      !operation.completed.includes('stop-native-host')
    )
      await this.step(operation, 'stop-native-host', () => this.runtime.stop());
    // A historical start/stop receipt cannot establish current owned process state after recovery.
    if (operation.kind === 'stop')
      await this.step(operation, 'stop-native-host', () => this.runtime.stop());
    else
      await this.step(operation, 'start-native-host', () =>
        this.runtime.start(),
      );
  }
}
