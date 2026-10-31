import { spawn } from 'node:child_process';

type CommandResponse = { stdout: string; stderr: string; exitCode: number | null };

export const executeCommand = (command: string, args: string[], options?: { cwd?: string }) => {
  const { promise, resolve, reject } = Promise.withResolvers<CommandResponse>();
  const child = spawn(command, args, { stdio: 'pipe', cwd: options?.cwd });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (data) => (stdout += data.toString()));
  child.stderr.on('data', (data) => (stderr += data.toString()));
  child.once('error', reject);
  child.once('close', (exitCode) => {
    resolve({
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode,
    });
  });

  return { promise, child };
};
