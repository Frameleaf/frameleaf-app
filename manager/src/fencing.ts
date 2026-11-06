import { open, readFile } from 'node:fs/promises';
import { Docker, environment, sharesMedia, type Container } from './docker.js';
import { databaseCandidates, Discovery } from './discovery.js';
import { Refusal, type Source, type SourceFence, type Installation, type Mount } from './contracts.js';
import { Store } from './store.js';
import { verifyFolderFence } from './photo-app-folder.js';
import type { AutostartFile } from './unraid-autostart.js';

// Unraid's rc.docker reads one exact container name and optional delay on each line.
const autostartName = (line: string) => line.trim().split(/\s+/)[0];
export function removeAutostart(text: string, names: string[]): string {
  return text
    .split('\n')
    .filter((line) => !names.includes(autostartName(line)))
    .join('\n');
}
/** Puts recorded lines back at the top (dependencies start first), skipping names already listed. */
export function restoreAutostart(text: string, lines: string[]): string {
  const present = new Set(text.split('\n').map(autostartName));
  const missing = lines.filter((line) => !present.has(autostartName(line)));
  return missing.length ? [...missing, text].join('\n') : text;
}
const restartFlag = (policy: { Name: string; MaximumRetryCount: number }) =>
  policy.Name === 'on-failure' && policy.MaximumRetryCount ? `on-failure:${policy.MaximumRetryCount}` : policy.Name;
/**
 * FL-476: a source database or Redis container retired after a verified import, journalled before any change so
 * source recovery can put back its restart policy, Unraid autostart line and running state.
 */
export type RetiredService = {
  id: string;
  name: string;
  role: 'database' | 'redis';
  restart: { Name: string; MaximumRetryCount: number };
  running: boolean;
  autostart: string | null;
};
const retiredKey = (source: Pick<Source, 'id'>) => `source-services:${source.id}`;
/** Redis as the source server reaches it (REDIS_URL, else REDIS_HOSTNAME, else Immich's default `redis`). */
function redisHost(env: Record<string, string>): string | null {
  if (env.REDIS_URL) {
    try {
      return new URL(env.REDIS_URL).hostname || null;
    } catch {
      return null;
    }
  }
  return env.REDIS_HOSTNAME || 'redis';
}
// A whole share or pool (/mnt, /mnt/user, /mnt/cache): a file manager's browsing access, not an app's library.
const shareRoot = (source: string) => /^\/mnt(?:\/[^/]+)?\/?$/.test(source);
export class Fencing {
  constructor(
    private docker: Docker,
    private store: Store,
    private autostartFile?: string | AutostartFile,
  ) {}
  async stopInstallation(installation: Installation): Promise<void> {
    await this.reconcileAutostart();
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
      const text = await this.readAutostart();
      if (
        removeAutostart(
          text,
          owned.map((c) => c.Name.replace(/^\//, '')),
        ) !== text
      )
        throw new Refusal('previous_autostart_enabled');
    }
  }
  async readAutostart(required = false): Promise<string> {
    if (!this.autostartFile) return '';
    return typeof this.autostartFile === 'string'
      ? readFile(this.autostartFile, 'utf8') : this.autostartFile.read(required);
  }
  private async removeNames(names: string[]): Promise<void> {
    await this.rewriteAutostart((text) => removeAutostart(text, names));
  }
  private async rewriteAutostart(change: (text: string) => string): Promise<void> {
    await this.reconcileAutostart();
    const text = await this.readAutostart(),
      modified = change(text);
    if (modified === text) return;
    this.store.set('autostart-write', { text, modified });
    try {
      await this.writeAutostart(text, modified);
    } catch (error) {
      // A refused comparison made no write; allow a later retry against the new host list.
      if (error instanceof Refusal && error.code === 'autostart_changed') this.store.set('autostart-write', null);
      throw error;
    }
    this.store.set('autostart-write', null);
  }
  private async writeAutostart(text: string, modified: string): Promise<void> {
    if (typeof this.autostartFile !== 'string') {
      await this.autostartFile!.write(text, modified);
      if ((await this.readAutostart(true)) !== modified) throw new Refusal('autostart_write_failed');
      return;
    }
    const file = await open(this.autostartFile, 'r+');
    try {
      if ((await file.readFile('utf8')) !== text) throw new Refusal('autostart_changed');
      await file.write(modified, 0, 'utf8');
      await file.truncate(Buffer.byteLength(modified));
      await file.sync();
    } finally {
      await file.close();
    }
    if ((await this.readAutostart()) !== modified) throw new Refusal('autostart_write_failed');
  }
  private async reconcileAutostart(): Promise<void> {
    const pending = this.store.get<{ text: string; modified: string }>('autostart-write');
    if (!pending) return;
    const current = await this.readAutostart(true);
    if (current !== pending.modified) {
      const before = Buffer.from(pending.text), after = Buffer.from(pending.modified), actual = Buffer.from(current);
      let prefix = 0;
      while (prefix < Math.min(actual.length, after.length) && actual[prefix] === after[prefix]) prefix++;
      // Interrupted in-place writes are a new prefix followed by the old tail, until truncate completes.
      if (current !== pending.text && !actual.equals(Buffer.concat([after.subarray(0, prefix), before.subarray(prefix)])))
        throw new Refusal(
          'autostart_changed',
          409,
          'The Unraid autostart list changed after an interrupted write. Follow “Recover an interrupted Unraid autostart update” in the Manager guide to save the current list, retrieve the recorded versions, and retry safely. Do not delete the pending journal or re-enable fenced services.',
        );
      await this.writeAutostart(current, pending.modified);
    }
    this.store.set('autostart-write', null);
  }
  async assertMedia(media: Mount[], installation?: Installation, workers: string[] = []): Promise<void> {
    const all = await this.docker.inventory();
    const autostart = this.autostartFile ? await this.readAutostart() : '';
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
      const writer = { ...c, Mounts: c.Mounts.filter((m) => m.Type !== 'bind' || !shareRoot(m.Source)) };
      return canStart && sharesMedia(writer, media, all) && !workers.includes(c.Id) && !controller && !owned;
    });
    if (unexpected.length)
      throw new Refusal(
        'other_media_writer_detected',
        409,
        `Stop these containers and turn off their autostart, then try again: ${unexpected.map((c) => c.Name.replace(/^\//, '')).join(', ')}.`,
      );
  }
  async stop(source: Source | SourceFence): Promise<void> {
    // An export folder has nothing to stop: it only has to still hold what was reviewed.
    if ('folder' in source && source.folder) return verifyFolderFence(source.folder);
    // The durable intent permits only our own restart-policy changes on a retry. All other
    // configuration and container identities must still match the reviewed source.
    const intent = this.store.get<string>(`fence:${source.id}`);
    if (intent && intent !== source.fingerprint) throw new Refusal('source_changed_review_again');
    await new Discovery(this.docker).revalidate(this.pinned(source), !!intent);
    await this.reconcileAutostart();
    await this.assertMedia(source.mounts, undefined, source.workers);
    this.store.createOnce(`fence:${source.id}`, source.fingerprint);
    const all = await this.docker.inventory();
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      const text = await this.readAutostart(true);
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
  /** The reviewed source, also accepting the retired database's own restart-policy change (FL-476). */
  private pinned(source: Source | SourceFence): Source | SourceFence {
    const retired = this.retiredServices(source) ?? [];
    return { ...source, restart: { ...Object.fromEntries(retired.map((s) => [s.id, s.restart])), ...source.restart } };
  }
  retiredServices(source: Pick<Source, 'id'>): RetiredService[] | null {
    return this.store.get<RetiredService[]>(retiredKey(source)) ?? null;
  }
  /**
   * FL-476: once the import is verified the source's database and Redis serve nothing, so they stop too, lose their
   * restart policy and leave Unraid autostart. Recovery restores them from the journal entry written first. Redis
   * that cannot be identified unambiguously on the server's network is left as it is.
   */
  async retireSourceServices(source: Source): Promise<RetiredService[]> {
    await this.verify(source);
    if (!this.retiredServices(source)) {
      const all = await this.docker.inventory();
      const app = all.find((c) => c.Id === source.app);
      const database = all.find((c) => c.Id === source.database.container);
      if (!app || !database) throw new Refusal('source_changed_review_again');
      const host = redisHost(environment(app));
      const redis = host
        ? databaseCandidates(app, all, host).filter(
            (c) =>
              c.Id !== database.Id &&
              !source.workers.includes(c.Id) &&
              !c.Config.Labels?.['app.frameleaf.manager'] &&
              !c.Config.Labels?.['app.frameleaf.manager.role'],
          )
        : [];
      const lines =
        source.platform === 'unraid' && this.autostartFile
          ? (await this.readAutostart(true)).split('\n')
          : [];
      const record = (c: Container, role: RetiredService['role']): RetiredService => {
        const name = c.Name.replace(/^\//, '');
        return {
          id: c.Id,
          name,
          role,
          restart: c.HostConfig.RestartPolicy,
          running: c.State.Running,
          autostart: lines.find((line) => autostartName(line) === name)?.trim() ?? null,
        };
      };
      // Kept in autostart order so recovery writes the lines back in the order Unraid had them.
      const position = (s: RetiredService) => (s.autostart ? lines.map((l) => l.trim()).indexOf(s.autostart) : lines.length);
      this.store.createOnce(
        retiredKey(source),
        [record(database, 'database'), ...(redis.length === 1 ? [record(redis[0], 'redis')] : [])].sort(
          (a, b) => position(a) - position(b),
        ),
      );
    }
    const retired = this.retiredServices(source)!;
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      await this.removeNames(retired.map((s) => s.name));
    }
    for (const service of retired) {
      await this.docker.restartPolicy(service.id, 'no');
      await this.docker.stop(service.id);
    }
    await this.verify(source);
    return retired;
  }
  /** Puts retired source services back as they were before the import; a no-op when none were retired. */
  async restoreSourceServices(source: Pick<Source, 'id' | 'platform'>): Promise<void> {
    const retired = this.retiredServices(source);
    if (!retired) return;
    if (source.platform === 'unraid' && this.autostartFile)
      await this.rewriteAutostart((text) =>
        restoreAutostart(text, retired.flatMap((s) => (s.autostart ? [s.autostart] : []))),
      );
    const all = await this.docker.inventory();
    for (const service of retired) {
      if (!all.some((c) => c.Id === service.id)) throw new Refusal('source_changed_review_again');
      await this.docker.restartPolicy(service.id, restartFlag(service.restart));
      if (service.running) await this.docker.start(service.id);
    }
  }
  async verify(source: Source | SourceFence, installation?: Installation): Promise<void> {
    if ('folder' in source && source.folder) return verifyFolderFence(source.folder);
    await new Discovery(this.docker).revalidate(this.pinned(source), true);
    await this.assertMedia(source.mounts, installation, source.workers);
    const all = await this.docker.inventory();
    for (const id of source.workers) {
      const c = all.find((c) => c.Id === id);
      if (!c || c.State.Running || c.HostConfig.RestartPolicy.Name !== 'no') throw new Refusal('source_not_fenced');
    }
    if (source.platform === 'unraid') {
      if (!this.autostartFile) throw new Refusal('unraid_autostart_file_required');
      const text = await this.readAutostart(true);
      const names = source.workers.map((id) => all.find((c) => c.Id === id)!.Name.replace(/^\//, ''));
      if (removeAutostart(text, names) !== text) throw new Refusal('source_autostart_enabled');
    }
  }
  async recover(source: Source | SourceFence, installation: Installation | null): Promise<void> {
    if (installation?.mayHaveWrittenMedia) throw new Refusal('media_recovery_required_no_automatic_source_restart');
    // Nothing was stopped for an export folder, so there is nothing to put back.
    if ('folder' in source && source.folder) return;
    // Repair a journalled partial write before retrying the fence or restoring any service.
    await this.reconcileAutostart();
    await this.stop(source);
    await this.verify(source, installation ?? undefined);
    for (const id of source.workers) await this.docker.restartPolicy(id, restartFlag(source.restart[id]));
    // FL-476: the database and Redis go back exactly as they were (policy, autostart line, running).
    await this.restoreSourceServices(source);
    // Preserve the remaining Unraid list and leave the recovered source application stopped for an explicit host start.
  }
}
