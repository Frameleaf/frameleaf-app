import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { superviseMediaProcess } from 'src/queue/process-lifetime.js';

describe('native process lifetime', () => {
  it('kills an unresponsive process and waits for actual close after cancellation', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.on("SIGTERM",()=>{}); process.stdout.write("ready"); setInterval(()=>{},1000)',
    ]);
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const abort = new AbortController();
    const lifetime = superviseMediaProcess(child, { signal: abort.signal, deadlineMs: 3000, graceMs: 50 });
    try {
      abort.abort(new Error('cancelled by test'));
      lifetime.release(); // A late successful result cannot revoke cancellation escalation.
      expect((await closed)[1]).toBe('SIGKILL');
      expect(lifetime.error()?.message).toBe('cancelled by test');
    } finally {
      child.kill('SIGKILL');
    }
  });

  it('allows measured progress beyond the initial deadline and then stops idle work', async () => {
    const child = spawn(process.execPath, [
      '-e',
      'process.stdout.write("ready"); const pulse=setInterval(()=>process.stdout.write("packet"),25); setTimeout(()=>clearInterval(pulse),500); setInterval(()=>{},1000)',
    ]);
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const lifetime = superviseMediaProcess(child, { deadlineMs: 150, idleMs: 300, graceMs: 50 });
    child.stdout.on('data', (chunk: Buffer) => lifetime.progress(chunk.byteLength));
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(child.exitCode).toBeNull();
      expect(lifetime.error()).toBeUndefined();
      await closed;
      expect(lifetime.error()?.message).toBe('Media process stopped making progress');
    } finally {
      child.kill('SIGKILL');
    }
  });
});

describe('reusable process task lifetime', () => {
  it('releases only task timers/listeners and leaves a pooled process alive for its next task', async () => {
    const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(()=>{},1000)']);
    const closed = once(child, 'close');
    await once(child.stdout, 'data');
    const abort = new AbortController();
    const lifetime = superviseMediaProcess(child, { signal: abort.signal, deadlineMs: 20, trackChild: false });
    try {
      lifetime.release();
      abort.abort(new Error('previous task cancelled'));
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(child.exitCode).toBeNull();
      expect(child.signalCode).toBeNull();
      expect(lifetime.error()).toBeUndefined();
      const replacement = superviseMediaProcess(child, { deadlineMs: 20, graceMs: 10, trackChild: false });
      await closed;
      expect(replacement.error()?.message).toBe('Media process execution deadline exceeded');
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  });
});
