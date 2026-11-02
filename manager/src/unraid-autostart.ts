import { resolve } from 'node:path';
import { command, environment, type Docker } from './docker.js';
import { Refusal, containerId } from './contracts.js';

export interface AutostartFile {
  read(required?: boolean): Promise<string>;
  write(expected: string, modified: string): Promise<void>;
}

// Runs in the exact local Manager image with only the existing host file mounted.
export const autostartScript = String.raw`
const fs = require('node:fs/promises');
(async () => {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const request = JSON.parse(input), path = process.argv[1];
  const writing = typeof request.expected === 'string' && typeof request.modified === 'string';
  const file = await fs.open(path, writing ? 'r+' : 'r');
  try {
    if (!(await file.stat()).isFile()) throw new Error('unraid_autostart_unavailable');
    const text = await file.readFile('utf8');
    if (writing) {
      if (text !== request.expected) throw new Error('autostart_changed');
      await file.write(request.modified, 0, 'utf8');
      await file.truncate(Buffer.byteLength(request.modified));
      await file.sync();
      if (await fs.readFile(path, 'utf8') !== request.modified) throw new Error('autostart_write_failed');
    }
    process.stdout.write(JSON.stringify({ text: writing ? request.modified : text }));
  } finally {
    await file.close();
  }
})().catch(error => process.stdout.write(JSON.stringify({
  error: ['autostart_changed', 'autostart_write_failed'].includes(error.message)
    ? error.message : 'unraid_autostart_unavailable'
})));
`;

/** Docker resolves the host path; Manager needs neither a data-root mount nor a container recreation. */
export class HostAutostart implements AutostartFile {
  private pending: Promise<unknown> = Promise.resolve();
  constructor(private docker: Docker, private directory: string, private execute: typeof command = command) {}

  private access(request: { expected?: string; modified?: string }, required = true): Promise<string> {
    const result = this.pending.then(() => this.performAccess(request, required));
    this.pending = result.catch(() => {});
    return result;
  }
  private async performAccess(request: { expected?: string; modified?: string }, required: boolean): Promise<string> {
    const containers = await this.docker.inventory();
    const controllers = containers.filter((c) =>
      c.State.Running && c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
      environment(c).MANAGER_DATA === this.directory,
    );
    if (controllers.length !== 1 || !/^sha256:[a-f0-9]{64}$/.test(controllers[0].Image))
      throw new Refusal('unraid_autostart_unavailable');
    // A Manager restart or a failed cleanup must not leave an earlier helper able to write later.
    for (const helper of containers.filter((c) => c.Config.Labels?.['app.frameleaf.manager.autostart'] === this.directory))
      await this.execute('docker', ['rm', '--force', containerId.parse(helper.Id)]);
    const { dataRoot } = await this.docker.compatibility();
    if (!dataRoot.startsWith('/') || dataRoot === '/' || resolve(dataRoot) !== dataRoot || /[\x00-\x1f\x7f,]/.test(dataRoot))
      throw new Refusal('unraid_autostart_unavailable');
    const run = async (mount: string, script: string) => {
      const id = containerId.parse((await this.execute('docker', [
        'create', '--interactive', '--pull', 'never', '--network', 'none', '--read-only',
        '--label', `app.frameleaf.manager.autostart=${this.directory}`,
        '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--cap-add', 'DAC_OVERRIDE',
        '--pids-limit', '32', '--memory', '128m', '--mount', mount,
        '--entrypoint', 'node', controllers[0].Image, '-e', script, '/autostart',
      ])).trim());
      try {
        return await this.execute('docker', ['start', '--attach', '--interactive', id], { input: JSON.stringify(request) });
      } finally {
        await this.execute('docker', ['rm', '--force', id]);
      }
    };
    let result: { text?: string; error?: string };
    try {
      result = JSON.parse(await run(
        `type=bind,source=${dataRoot}/unraid-autostart,target=/autostart${request.expected === undefined ? ',readonly' : ''}`,
        autostartScript,
      ));
    } catch {
      if (!required && request.expected === undefined) {
        // A fresh host may have no list. Prove ENOENT without creating it; never hide access failures.
        const absent = await run(`type=bind,source=${dataRoot},target=/docker,readonly`, String.raw`
require('node:fs/promises').lstat('/docker/unraid-autostart')
  .then(() => process.stdout.write('present'))
  .catch(error => process.stdout.write(error.code === 'ENOENT' ? 'missing' : 'unavailable'));
`).catch(() => 'unavailable');
        if (absent === 'missing') return '';
      }
      throw new Refusal('unraid_autostart_unavailable');
    }
    if (result.error === 'autostart_changed' || result.error === 'autostart_write_failed') throw new Refusal(result.error);
    if (typeof result.text !== 'string' || result.error) throw new Refusal('unraid_autostart_unavailable');
    return result.text;
  }
  read(required = true): Promise<string> { return this.access({}, required); }
  async write(expected: string, modified: string): Promise<void> { await this.access({ expected, modified }); }
}
