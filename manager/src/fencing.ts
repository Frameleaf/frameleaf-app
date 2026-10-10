import { open, readFile } from 'node:fs/promises';
import { Docker, environment, sharesMedia, type Container } from './docker.js';
import { Discovery } from './discovery.js';
import { Refusal, type Source, type Installation, type Mount } from './contracts.js';
import { Store } from './store.js';

export function removeAutostart(text: string, names: string[]): string {
  // Unraid's rc.docker reads one exact container name and optional delay on each line.
  return text
    .split('\n')
    .filter((line) => !names.includes(line.trim().split(/\s+/)[0]))
    .join('\n');
}
export class Fencing {
  constructor(
    private docker: Docker,
    private store: Store,
    private autostartFile?: string,
  ) {}
  async stopInstallation(installation: Installation): Promise<void> {
    await this.assertMedia(installation.mounts, installation);
    const owned = (await this.docker.inventory()).filter(
      (c) => c.Config.Labels?.['app.frameleaf.manager'] === installation.id,
    );
    this.store.createOnce(
      `installation-fence:${installation.id}`,
      owned.map((c) => ({ id: c.Id, restart: c.HostConfig.RestartPolicy })),
    );
    if (this.autostartFile) await this.removeNames(owned.map((c) => c.Name.replace(/^\//, '')));
    for (const container of owned) {
      await this.docker.restartPolicy(container.Id, 'no');
      await this.docker.stop(container.Id);
    }
    await this.verifyInstallation(installation);
  }
  async verifyInstallation(installation: Installation): Promise<void> {
    const owned = (await this.docker.inventory()).filter(
      (c) => c.Config.Labels?.['app.frameleaf.manager'] === installation.id,
    );
    if (owned.some((c) => c.State.Running || c.HostConfig.RestartPolicy.Name !== 'no'))
      throw new Refusal('previous_installation_not_fenced');
    if (this.autostartFile) {
      const text = await readFile(this.autostartFile, 'utf8');
      if (
        removeAutostart(
          text,
          owned.map((c) => c.Name.replace(/^\//, '')),
        ) !== text
      )
        throw new Refusal('previous_autostart_enabled');
    }
  }
  private async removeNames(names: string[]): Promise<void> {
    const text = await readFile(this.autostartFile!, 'utf8'),
      modified = removeAutostart(text, names);
    const file = await open(this.autostartFile!, 'r+');
    try {
      if ((await file.readFile('utf8')) !== text) throw new Refusal('autostart_changed');
      await file.write(modified, 0, 'utf8');
      await file.truncate(Buffer.byteLength(modified));
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await readFile(this.autostartFile!, 'utf8')) !== modified) throw new Refusal('autostart_write_failed');
  }
  async assertMedia(media: Mount[], installation?: Installation, workers: string[] = []): Promise<void> {
    const all = await this.docker.inventory();
    const autostart = this.autostartFile ? await readFile(this.autostartFile, 'utf8') : '';
    const names = new Set(autostart.split('\n').map((line) => line.trim().split(/\s+/)[0]));
    const unexpected = all.filter((c) => {
      const controller =
        c.Config.Labels?.['app.frameleaf.manager.role'] === 'controller' &&
        environment(c).MANAGER_DATA === this.store.directory;
      const owned = !!installation && c.Config.Labels?.['app.frameleaf.manager'] === installation.id;
      const canStart =
        c.State.Running ||
        !['', 'no'].includes(c.HostConfig.RestartPolicy.Name) ||
        names.has(c.Name.replace(/^\//, ''));
      return canStart && sharesMedia(c, media, all) && !workers.includes(c.Id) && !controller && !owned;
    });
    if (unexpected.length) throw new Refusal('other_media_writer_detected');
  }
  async stop(source: Source): Promise<void> {
    // The durable intent permits only our own restart-policy changes on a retry. All other
    // configuration and container identities must still match the reviewed source.
    const intent = this.store.get<string>(`fence:${source.id}`);
    if (intent && intent !== source.fingerprint) throw new Refusal('source_changed_review_again');
    await new Discovery(this.docker).revalidate(source, !!intent);
    await this.assertMedia(source.mounts, undefined, source.workers);
    this.store.createOnce(`fence:${source.id}`, source.fingerprint);
    const all = await this.docker.inventory();
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      const text = await readFile(this.autostartFile, 'utf8');
      const names = source.workers
        .map((id) => all.find((c) => c.Id === id)?.Name.replace(/^\//, ''))
        .filter((s): s is string => !!s);
      this.store.createOnce(`autostart:${source.id}`, { text, names });
      // A mounted file must be updated in place; rename would replace the container's mount, not the host file.
      await this.removeNames(names);
    }
    for (const id of source.workers) {
      await this.docker.restartPolicy(id, 'no');
      await this.docker.stop(id);
    }
    await this.verify(source);
  }
  async verify(source: Source, installation?: Installation): Promise<void> {
    await new Discovery(this.docker).revalidate(source, true);
    await this.assertMedia(source.mounts, installation, source.workers);
    const all = await this.docker.inventory();
    for (const id of source.workers) {
      const c = all.find((c) => c.Id === id);
      if (!c || c.State.Running || c.HostConfig.RestartPolicy.Name !== 'no') throw new Refusal('source_not_fenced');
    }
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      const text = await readFile(this.autostartFile, 'utf8');
      const names = source.workers.map((id) => all.find((c) => c.Id === id)!.Name.replace(/^\//, ''));
      if (removeAutostart(text, names) !== text) throw new Refusal('source_autostart_enabled');
    }
  }
  async recover(source: Source, installation: Installation | null): Promise<void> {
    if (installation?.mayHaveWrittenMedia) throw new Refusal('media_recovery_required_no_automatic_source_restart');
    // Complete a partial fence before restoring the original restart policies.
    await this.stop(source);
    await this.verify(source, installation ?? undefined);
    for (const id of source.workers) {
      const policy = source.restart[id];
      await this.docker.restartPolicy(
        id,
        policy.Name === 'on-failure' && policy.MaximumRetryCount
          ? `on-failure:${policy.MaximumRetryCount}`
          : policy.Name,
      );
    }
    // Preserve the remaining Unraid list and leave the recovered source stopped for an explicit host start.
  }
}
