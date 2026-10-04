import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { Worker } from 'node:worker_threads';
import { superviseQueueWorker } from 'src/queue/supervisor.js';

/** Real worker threads and child processes; fake clocks cannot prove event-loop isolation. */
describe('queue execution supervisor', () => {
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
      if (message.type === 'fixture-port') {
        message.port.postMessage({ type: 'terminate' });
        message.port.close();
      }
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
