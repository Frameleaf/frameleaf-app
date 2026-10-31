import { exec, spawn, type ChildProcess } from 'node:child_process';
import { setTimeout } from 'node:timers';

const READY_MESSAGE = 'Frameleaf Microservices is running';

const composeDown = () =>
  new Promise<void>((resolve, reject) =>
    exec('docker compose down', { timeout: 120_000 }, (error) => (error ? reject(error) : resolve())),
  );

const stopChild = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    // If compose up ignores SIGTERM, escalate to SIGKILL and stop waiting so teardown still runs.
    const escalate = setTimeout(() => child.kill('SIGKILL'), 10_000);
    const giveUp = setTimeout(() => resolve(), 15_000);
    child.once('close', () => {
      clearTimeout(escalate);
      clearTimeout(giveUp);
      resolve();
    });
    child.kill();
  });

const setup = async () => {
  const command = 'compose up --build --renew-anon-volumes --force-recreate --remove-orphans';
  const child = spawn('docker', command.split(' '), { stdio: 'pipe' });

  let timeout: NodeJS.Timeout | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Error('Timeout starting e2e environment')), 60_000);

    // The readiness line can be split across stdout chunks, so keep a short tail of the previous one.
    let tail = '';
    child.stdout.on('data', (data) => {
      const input = data.toString();
      console.log(input);
      const text = tail + input;
      if (text.includes(READY_MESSAGE)) {
        resolve();
      }
      tail = text.slice(-READY_MESSAGE.length);
    });

    child.on('error', reject);
    child.on('exit', (code, signal) =>
      reject(new Error(`docker compose up exited before the e2e environment was ready (${signal ?? code})`)),
    );
  });

  child.stderr.on('data', (data) => console.log(data.toString()));

  try {
    await ready;
  } catch (error) {
    // Let compose up finish before tearing down, and keep the startup error as the one reported.
    await stopChild(child);
    try {
      await composeDown();
    } catch (cleanupError) {
      console.error('docker compose down failed', cleanupError);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  return composeDown;
};

export default setup;
