// Server Backup's place in Frameleaf Cloud: the link this Manager holds as a "backup machine", and what a
// run needs from it: short-lived storage credentials, the run lease, and the signed history of backups.
// Only this process talks to Cloud. The worker asks it for credentials and never sees the machine's key.
import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cloud, CloudError, createIdentity, type Grant, type Identity, type Lease } from './cloud-link.js';
import { Refusal } from './contracts.js';
import type { Store } from './store.js';

export type Operation = 'upload' | 'restore' | 'prune';
export type Credentials = Grant['capability']['credentials'];
export interface Place {
  endpoint: string;
  region: string;
  bucket: string;
  /** `r/v1/<vault>/`: everything of one repository sits under it. */
  prefix: string;
}
/** A stored backup, as the worker reports it once its last object is written. */
export interface Stored {
  key: string;
  versionId: string | null;
  ciphertextSha256: string;
  time: string;
}
type Entry = Parameters<Cloud['recordSnapshot']>[1];

/** What one run holds in Cloud. */
export interface Session {
  place: Place;
  /** A backup's place in the signed history: its snapshot is stored under this number. Null for a restore. */
  sequence: number | null;
  /** Asked before every request to storage. Asking for `prune` swaps the run lease from backup to prune. */
  credentials(operation: Operation, renew: boolean): Promise<Credentials>;
  /** Adds the finished backup to the signed history Cloud keeps. */
  record(stored: Stored): Promise<void>;
  /** Lets the lease go, and tells Cloud how the run went when given a report. */
  end(report?: { startedAt: number; state: 'done' | 'failed' | 'stopped'; bytes: number; files: number; snapshot: string | null; error: string | null }): Promise<void>;
}

interface Saved {
  account: { label: string; email: string; dataRegion: string } | null;
  /** Where the first backup makes its storage. Chosen once; storage does not move. */
  locationId: string | null;
  /** A backup that is stored but that Cloud has not confirmed adding to its history. Sent again before the next one starts. */
  unrecorded: Entry | null;
  /** The older machine whose backups this one has asked to take over. */
  takeover: { fromInstanceId: string } | null;
  /** The Cloud id under which the photo server has vouched for this Manager, once Cloud has taken that. */
  attached?: string | null;
}

const KEY = 'server-backup-cloud';

/** What a failure is called on Manager's screens and in a run's history: Cloud's own code, in Manager's spelling. */
export function reasonOf(error: unknown): string {
  if (error instanceof CloudError) {
    const detail = error.code === 'entitlement-missing' ? error.data?.missing : error.code === 'request-invalid' ? error.detail : null;
    const code = `${error.code}${typeof detail === 'string' ? `_${detail}` : ''}`.replaceAll('-', '_').toLowerCase();
    return /^[a-z0-9_]{1,60}$/.test(code) ? (code.startsWith('cloud_') ? code : `cloud_${code}`) : 'cloud_refused';
  }
  return (error as { code?: string })?.code ?? (error instanceof Error ? error.message : String(error));
}

export class CloudBackup {
  private linking: { name: string; deviceCode: string; userCode: string; approveAt: string; until: number; intervalSec: number; linkToken: string | null } | null = null;

  constructor(
    private store: Store,
    private cloud: Cloud,
    private machine: { version: string; platform: string },
    /** Asks the photo server on this machine to vouch for the Manager with this Cloud id. Null when it can't. */
    private vouch: (machineInstanceId: string) => Promise<{ statement: unknown; signature: string } | null> = async () => null,
  ) {}

  private saved(): Saved {
    return this.store.get<Saved>(KEY) ?? { account: null, locationId: null, unrecorded: null, takeover: null };
  }
  private save(change: Partial<Saved>) {
    this.store.set(KEY, { ...this.saved(), ...change });
  }

  /** This machine's id and key in Cloud. The key is the only way to its stored backups from here, so it is replaced whole or not at all. */
  private file() {
    return join(this.store.directory, 'server-backup-cloud.identity');
  }
  private async keep(identity: Identity) {
    const fresh = `${this.file()}.new`;
    await writeFile(fresh, JSON.stringify(identity), { mode: 0o600 });
    await chmod(fresh, 0o600);
    await rename(fresh, this.file());
  }
  private async identity(): Promise<Identity> {
    const text = await readFile(this.file(), 'utf8').catch(() => null);
    if (!text || !this.saved().account) throw new Refusal('server_backup_cloud_not_linked');
    return JSON.parse(text) as Identity;
  }

  get linked() {
    return this.saved().account !== null;
  }
  view() {
    const { account, locationId, takeover, unrecorded } = this.saved();
    return {
      state: account ? 'linked' : this.linking && this.linking.until > Date.now() ? 'linking' : 'unlinked',
      account,
      code: account || !this.linking || this.linking.until <= Date.now() ? null : { userCode: this.linking.userCode, approveAt: this.linking.approveAt, intervalSec: this.linking.intervalSec },
      locationId,
      takeover,
      unrecorded: unrecorded !== null,
    };
  }

  /** Starts linking: the owner approves the code on the account site. `name` is what the account site calls this server. */
  async startLink(name: string) {
    if (this.linked) throw new Refusal('server_backup_cloud_already_linked');
    // A new id and key each time. One that Cloud never accepted is worth nothing, and one an older Cloud
    // linked as a photo server must never be used again.
    const identity = createIdentity();
    await this.keep(identity);
    const started = await this.cloud.startLink(identity, { name, ...this.machine });
    this.linking = { name, intervalSec: started.intervalSec, deviceCode: started.deviceCode, userCode: started.userCode, approveAt: started.approveAt, until: Date.now() + started.expiresInSec * 1000, linkToken: null };
    return { userCode: started.userCode, approveAt: started.approveAt, expiresInSec: started.expiresInSec, intervalSec: started.intervalSec };
  }

  /** One look at whether the owner has approved. */
  async checkLink(): Promise<'waiting' | 'linked' | 'refused' | 'expired'> {
    const linking = this.linking;
    if (!linking) throw new Refusal('server_backup_cloud_not_linking');
    const forget = async () => {
      this.linking = null;
      await rm(this.file(), { force: true });
    };
    if (!linking.linkToken) {
      const polled = await this.cloud.pollLink(linking.deviceCode);
      if (polled.state === 'waiting' || polled.state === 'slower') return 'waiting';
      if (polled.state !== 'approved') {
        await forget();
        return polled.state;
      }
      linking.linkToken = polled.linkToken;
    }
    try {
      const text = await readFile(this.file(), 'utf8');
      const account = await this.cloud.register(JSON.parse(text) as Identity, linking.linkToken, { name: linking.name, ...this.machine });
      this.save({ account: { label: account.account, email: account.email, dataRegion: account.dataRegion } });
      this.linking = null;
      return 'linked';
    } catch (error) {
      // The approval is kept while Cloud can't be reached, so the owner need not approve twice.
      if (!(error instanceof CloudError && error.code === 'cloud_unreachable')) await forget();
      throw error;
    }
  }

  /** What this server's backups use of the plan's storage. */
  async usage() {
    return this.cloud.usage(await this.identity());
  }

  /** A deletion of this server's backups that is waiting or under way, or null. */
  async purge() {
    const latest = await this.cloud.purge(await this.identity());
    return latest && (latest.status === 'held' || latest.status === 'purging') ? latest : null;
  }
  async requestPurge() {
    return this.cloud.requestPurge(await this.identity());
  }
  async cancelPurge() {
    return this.cloud.cancelPurge(await this.identity());
  }

  /**
   * Disconnects this Manager from Frameleaf Cloud. Its identity is thrown away: it can't be used again.
   * What is stored stays in Cloud, read-only, for the hold Cloud keeps before deleting it; a Manager that
   * connects again can take those backups over with the recovery key.
   */
  async unlink() {
    const identity = await this.identity();
    await this.cloud.unlink(identity).catch((error) => {
      // Already gone from Cloud (unlinked on the account site, or taken over): nothing left to undo there.
      if (!(error instanceof CloudError) || (error.status !== 401 && error.status !== 404)) throw error;
    });
    await rm(this.file(), { force: true });
    this.linking = null;
    this.store.set(KEY, { account: null, locationId: null, unrecorded: null, takeover: null, attached: null } satisfies Saved);
  }

  async locations() {
    return this.cloud.locations(await this.identity());
  }
  /** Where the first backup makes its storage. Only a place Cloud offers; with one on offer there is nothing to choose. */
  async setLocation(locationId?: string) {
    const offered = await this.locations();
    const chosen = locationId === undefined && offered.length === 1 ? offered[0] : offered.find((place) => place.locationId === locationId);
    if (!chosen) throw new Refusal('server_backup_cloud_no_location');
    this.save({ locationId: chosen.locationId });
  }

  /** The account's other backup machines whose backups this one may ask for. */
  async takeoverCandidates() {
    return this.cloud.takeoverCandidates(await this.identity());
  }
  async askTakeover(fromInstanceId: string) {
    const asked = await this.cloud.requestTakeover(await this.identity(), fromInstanceId);
    this.save({ takeover: { fromInstanceId } });
    return asked;
  }
  /**
   * One look at whether the owner has approved the takeover. Once they have, this installation is the older
   * machine in Cloud: its id, this key. The older machine's backups open with its recovery key, not ours.
   */
  async checkTakeover() {
    const { takeover } = this.saved();
    if (!takeover) throw new Refusal('server_backup_cloud_no_takeover');
    const identity = await this.identity();
    const answer = await this.cloud.takeover(identity, takeover.fromInstanceId);
    if (answer.status === 'approved') {
      await this.keep({ ...identity, instanceId: answer.instanceId ?? takeover.fromInstanceId });
      this.save({ takeover: null, unrecorded: null });
    } else if (answer.status !== 'pending') this.save({ takeover: null });
    return answer;
  }

  /**
   * Shares the photo server's licence and plan: its signed word that this Manager manages it goes to Cloud
   * once per Cloud id (a takeover changes the id, and Cloud then wants it again). Without a photo server
   * that can vouch, this Manager stands on its own and Cloud says what it lacks.
   */
  private async attach(identity: Identity) {
    if (this.saved().attached === identity.instanceId) return;
    const vouched = await this.vouch(identity.instanceId);
    if (!vouched) return;
    await this.cloud.attach(identity, vouched);
    this.save({ attached: identity.instanceId });
  }

  /** Sends a record Cloud has not confirmed. Sending the same one twice is answered with the first. */
  private async flush(identity: Identity) {
    const entry = this.saved().unrecorded;
    if (!entry) return;
    try {
      await this.cloud.recordSnapshot(identity, entry);
    } catch (error) {
      // ponytail: a record Cloud will never take (its history moved on) is dropped; the backup itself stays
      // stored and restorable, it is only missing from the signed history. Re-sign it in place if that ever matters.
      if (!(error instanceof CloudError) || (error.status !== 409 && error.status !== 422)) throw error;
    }
    this.save({ unrecorded: null });
  }

  /**
   * What one run needs. A backup holds Cloud's run lease for as long as it goes and renews it every minute;
   * `onLost` is called when Cloud says the lease is gone, and the run must then stop writing at once.
   * A restore needs no lease.
   */
  async begin(kind: 'backup' | 'restore', vaultId: string, onLost: () => void = () => undefined): Promise<Session> {
    const identity = await this.identity();
    let lease: Lease | null = null;
    let beat: NodeJS.Timeout | null = null;
    const drop = async () => {
      if (beat) clearInterval(beat);
      beat = null;
      const held = lease;
      lease = null;
      if (held) await this.cloud.releaseLease(identity, held.leaseId).catch(() => undefined);
    };
    const hold = async (operation: Lease['operation']): Promise<Lease> => {
      if (lease?.operation === operation) return lease;
      await drop();
      const taken = await this.cloud.acquireLease(identity, operation);
      lease = taken;
      beat = setInterval(() => {
        // Only Cloud saying so ends the run. A dropped connection is tried again at the next beat; if it
        // lasts past the lease's life, Cloud says the lease is lost.
        this.cloud.heartbeat(identity, taken.leaseId).catch((error) => {
          if (error instanceof CloudError && error.code === 'lease-lost' && lease === taken) onLost();
        });
      }, taken.heartbeatAfterSec * 1000);
      beat.unref();
      return taken;
    };
    const grant = async (operation: Operation): Promise<Grant> => {
      const under = operation === 'restore' ? {} : { leaseId: (await hold(operation === 'prune' ? 'prune' : 'backup')).leaseId };
      try {
        return await this.cloud.rotate(identity, { operation, ...under });
      } catch (error) {
        // Cloud no longer counts the photo server's licence for us: it is asked to vouch again next time.
        if (error instanceof CloudError && error.code === 'entitlement-missing') this.save({ attached: null });
        // No storage yet: this is the first backup, and its storage is made where the owner chose.
        if (!(error instanceof CloudError) || error.status !== 404) throw error;
        const { locationId } = this.saved();
        if (!locationId) throw new Refusal('server_backup_cloud_no_location');
        return this.cloud.grant(identity, { locationId, operation, ...under });
      }
    };
    const held = new Map<Operation, { credentials: Credentials; until: number }>();
    const take = async (operation: Operation) => {
      const fresh = await grant(operation);
      held.set(operation, { credentials: fresh.capability.credentials, until: Date.now() + fresh.capability.refreshAfterSec * 1000 });
      return fresh;
    };

    try {
      // Before the first credentials are asked for, so a licence shared by the photo server counts at once.
      // A photo server that can't vouch right now doesn't stop a Manager that has what it needs anyway.
      if (kind === 'backup') await this.attach(identity).catch(() => undefined);
      const first = await take(kind === 'backup' ? 'upload' : 'restore');
      let sequence: number | null = null;
      let previousDigest: string | null = null;
      if (kind === 'backup') {
        await this.flush(identity);
        const head = await this.cloud.snapshotHead(identity, vaultId);
        sequence = (head?.sequence ?? 0) + 1;
        previousDigest = head?.digest ?? null;
      }
      const prefix = `r/v1/${vaultId}/`;
      return {
        place: { endpoint: first.endpoint, region: first.region, bucket: first.bucket, prefix },
        sequence,
        credentials: async (operation, renew) => {
          const have = held.get(operation);
          return have && !renew && have.until > Date.now() ? have.credentials : (await take(operation)).capability.credentials;
        },
        record: async (stored) => {
          // Cloud's storage keeps versions; a backup with no version to point at can't be vouched for.
          if (sequence === null || stored.versionId === null) throw new Error('cloud_record_impossible');
          const entry: Entry = { snapshotId: randomUUID(), vaultId, sequence, previousDigest, objectKey: prefix + stored.key, versionId: stored.versionId, ciphertextSha256: stored.ciphertextSha256, keyVersion: 1, createdAt: stored.time };
          // Saved before it is sent: if the answer is lost, the same record goes again and Cloud answers with the first.
          this.save({ unrecorded: entry });
          await this.cloud.recordSnapshot(identity, entry);
          this.save({ unrecorded: null });
        },
        end: async (report) => {
          await drop();
          if (!report) return;
          const errorCode = report.error === null ? null : /^[a-z0-9_-]{1,64}$/.test(report.error) ? report.error : 'failed';
          await this.cloud
            .reportRun(identity, {
              runId: randomUUID(),
              status: report.state === 'done' ? 'succeeded' : report.state === 'stopped' ? 'cancelled' : 'failed',
              startedAt: new Date(report.startedAt).toISOString(),
              finishedAt: new Date().toISOString(),
              bytesUploaded: report.bytes,
              // Cloud counts stored objects; a repository run counts the files it covered instead.
              objectsUploaded: report.files,
              objectsSkipped: 0,
              manifestKey: report.snapshot === null ? null : prefix + report.snapshot,
              errorCode,
            })
            .catch(() => undefined);
        },
      };
    } catch (error) {
      await drop();
      throw error;
    }
  }
}
