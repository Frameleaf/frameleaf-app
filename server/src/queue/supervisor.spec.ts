import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { Worker } from 'node:worker_threads';
import type { WorkerStoppedProof } from 'src/queue/worker-stop-proof.js';
import { superviseQueueWorker } from 'src/queue/supervisor.js';
import { SupervisorStop } from 'src/utils/shutdown.js';

/** Real worker threads and child processes; fake clocks cannot prove event-loop isolation. */
describe('queue execution supervisor', () => {
  it('writes stop proof only after the real executor and registered child are gone, then waits for persistence', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    await once(child, 'spawn');
    const childClosed = once(child, 'close');
    const workerId = randomUUID();
    const worker = new Worker(
      `const {parentPort,MessageChannel,workerData}=require('node:worker_threads');
      const {port1,port2}=new MessageChannel();
      parentPort.postMessage({type:'queue-watchdog-port',workerId:workerData.workerId,port:port1},[port1]);
      parentPort.postMessage({type:'queue-child',pid:workerData.pid,active:true});
      parentPort.postMessage({type:'ready'}); setInterval(()=>{},1000);`,
      { eval: true, workerData: { workerId, pid: child.pid } },
    );
    const { promise: write, resolve: persisted } = Promise.withResolvers<void>();
    const { promise: writing, resolve: called } = Promise.withResolvers<void>();
    const recordStopped = vi.fn(async (proof: WorkerStoppedProof) => {
      expect(proof.workerId).toBe(workerId);
      expect(proof.stoppedAt).toEqual(expect.any(Number));
      expect(worker.threadId).toBe(-1);
      expect(() => process.kill(child.pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      called();
      await write;
    });
    const { stopped } = superviseQueueWorker(worker, undefined, undefined, { recordStopped });
    const exit = vi.fn();
    const shutdown = new SupervisorStop({ exit, deadlineMs: 9000 });
    shutdown.begin(() => [
      {
        stop: () => {},
        kill: () => {
          void worker.terminate();
        },
      },
    ]);
    void stopped.then(() => shutdown.workerExited(0));
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });
    try {
      await new Promise<void>((resolve) =>
        worker.on('message', (message) => {
          if (message.type === 'ready') resolve();
        }),
      );
      expect(recordStopped).not.toHaveBeenCalled();
      await worker.terminate();
      await childClosed;
      await writing;
      expect(settled).toBe(false);
      expect(exit).not.toHaveBeenCalled();
      persisted();
      await stopped;
      expect(recordStopped).toHaveBeenCalledTimes(1);
      expect(settled).toBe(true);
      expect(exit).toHaveBeenCalledWith(0);
    } finally {
      persisted();
      child.kill('SIGKILL');
      await worker.terminate();
    }
  }, 10_000);

  it('refuses proof when kill requests and a reported close cannot establish child absence', async () => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn().mockResolvedValue(0) });
    const recordStopped = vi.fn();
    const diagnostic = vi.fn();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    try {
      const { stopped } = superviseQueueWorker(worker as unknown as Worker, undefined, undefined, {
        recordStopped,
        diagnostic,
        stopWaitMs: 20,
        childScanMs: 5,
      });
      worker.emit('message', { type: 'queue-child', pid: 99_999_999, active: true });
      worker.emit('message', { type: 'queue-child', pid: 99_999_999, active: false });
      worker.emit('exit', 1);
      await stopped;
      expect(recordStopped).not.toHaveBeenCalled();
      expect(diagnostic).toHaveBeenCalledWith(expect.stringContaining('native children remain unconfirmed'));
    } finally {
      kill.mockRestore();
    }
  });

  it('terminates an executor stuck in synchronous JavaScript on an independent watchdog signal', async () => {
    const worker = new Worker(
      `const {parentPort,MessageChannel}=require('node:worker_threads');
      const {port1,port2}=new MessageChannel();
      parentPort.postMessage({type:'queue-watchdog-port',port:port1},[port1]);
      parentPort.postMessage({type:'fixture-port',port:port2},[port2]);
      while(true) { Math.sqrt(9); }`,
      { eval: true },
    );
    superviseQueueWorker(worker);
    const exit = once(worker, 'exit');
    worker.on('message', (message) => {
      if (message.type !== 'fixture-port') return;
      message.port.postMessage({ type: 'terminate' });
      message.port.close();
    });
    try {
      expect((await exit)[0]).toBe(1);
    } finally {
      await worker.terminate();
    }
  }, 10_000);

  it('kills the executor when the separate coordinator itself stops sending heartbeats', async () => {
    const worker = new Worker(
      `const {parentPort,MessageChannel}=require('node:worker_threads');
      const {port1,port2}=new MessageChannel();
      parentPort.postMessage({type:'queue-watchdog-port',port:port1},[port1]);
      port2.postMessage({type:'alive'}); while(true) {}`,
      { eval: true },
    );
    superviseQueueWorker(worker, 100, 20);
    try {
      expect((await once(worker, 'exit'))[0]).toBe(1);
    } finally {
      await worker.terminate();
    }
  }, 10_000);

  it('terminates the executor that reports an unusable database pool', async () => {
    const worker = new Worker(
      `const {parentPort}=require('node:worker_threads');
      parentPort.postMessage({type:'database-unusable'}); setInterval(()=>{},1000);`,
      { eval: true },
    );
    superviseQueueWorker(worker);
    try {
      expect((await once(worker, 'exit'))[0]).toBe(1);
    } finally {
      await worker.terminate();
    }
  }, 10_000);

  it.skipIf(spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status !== 0)(
    'kills a registered real FFmpeg process after it stops making progress',
    async () => {
      // Real-time synthetic input keeps the process running without reading any user media.
      const ffmpeg = spawn(
        'ffmpeg',
        ['-v', 'error', '-re', '-f', 'lavfi', '-i', 'color=size=16x16:rate=1', '-f', 'null', '-'],
        { stdio: 'ignore' },
      );
      const childExit = once(ffmpeg, 'exit');
      await once(ffmpeg, 'spawn');
      const worker = new Worker(
        `const {parentPort,workerData}=require('node:worker_threads');
        parentPort.postMessage({type:'queue-child',pid:workerData,active:true});
        parentPort.postMessage({type:'ready'}); parentPort.on('message',()=>parentPort.postMessage({type:'database-unusable'})); setInterval(()=>{},1000);`,
        { eval: true, workerData: ffmpeg.pid },
      );
      superviseQueueWorker(worker);
      const workerExit = once(worker, 'exit');
      try {
        await new Promise<void>((resolve) =>
          worker.on('message', (message) => {
            if (message.type === 'ready') resolve();
          }),
        );
        process.kill(ffmpeg.pid!, 'SIGSTOP'); // actual stalled child, not a mocked transcode promise
        worker.postMessage('fail-cleanup');
        expect((await childExit)[1]).toBe('SIGKILL');
        expect((await workerExit)[0]).toBe(1);
      } finally {
        ffmpeg.kill('SIGKILL');
        await worker.terminate();
      }
    },
    15_000,
  );
});
