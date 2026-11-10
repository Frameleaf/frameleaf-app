import {
  activateLicense,
  cancelCloudLink,
  continueCloudLink,
  checkInCloud,
  getCloudLink,
  getCloudStatus,
  getCloudBackupLicenceCoverage,
  getLicenseProducts,
  getLicenseStatus,
  installLicenseCertificate,
  linkCloudWithAccount,
  refreshLicense,
  removeLicenseKey,
  removeLicensePlan,
  startCloudLink,
  unlinkCloud,
  updateCloudPermissions,
  updateCloudRemoteAccess,
  updateCloudSignIn,
  verifyCloudAccountLink,
  type CloudAccountLinkDto,
  type CloudAccountLinkResponseDto,
  type CloudPermissionsUpdateDto,
  type CloudRemoteAccessUpdateDto,
  type CloudStatusResponseDto,
  type CloudBackupLicenceCoverageResponseDto,
  type LicenseProductsResponseDto,
  type LicenseStatusResponseDto,
} from '@frameleaf/sdk';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';

/** The longest wait between checks of a pending code after failures. */
export const MAX_POLL_BACKOFF_SECONDS = 60;

/**
 * The Frameleaf Cloud link as administrators see it (FL-155). Admin-only: pages that are not an
 * administrator's never call `listen`. The status reloads when the server says the link changed
 * (`on_frameleaf_cloud`), after a settings save, and, while a code waits for approval, on the
 * interval the cloud set; the server itself decides when to ask the cloud.
 */
export class CloudManager {
  #status = $state<CloudStatusResponseDto | null>(null);
  #license = $state<LicenseStatusResponseDto | null>(null);
  #products = $state<LicenseProductsResponseDto | null>(null);
  #backupCoverage = $state<CloudBackupLicenceCoverageResponseDto | null>(null);
  #coverageCurrent: () => boolean = () => false;
  #coverageGeneration = 0;
  #licenseAction = 0;
  #licenseRevision = 0;
  #licensePending = false;
  #error = $state<unknown>(null);
  #loading = $state(false);
  #listeners = 0;
  #poll?: ReturnType<typeof setTimeout>;
  #pollFailures = 0;
  /** Bumped by every request that can change the link; an older answer is dropped when it lands. */
  #generation = 0;
  #pollError = $state<unknown>(null);

  get status() {
    return this.#status;
  }

  /** FL-156: the licence certificates this server holds. */
  get license() {
    return this.#license;
  }

  /** FL-157: bundled prices and the deployment's store. */
  get products() {
    return this.#products;
  }

  get backupCoverage() {
    const coverage = this.#backupCoverage;
    return this.#coverageCurrent() ? coverage : null;
  }

  get error() {
    return this.#error;
  }

  /** The last failed check for an approved code; polling keeps retrying with backoff meanwhile. */
  get pollError() {
    return this.#pollError;
  }

  get loading() {
    return this.#loading;
  }

  constructor() {
    eventManager.on({
      FrameleafCloudUpdate: ({ topic }) => {
        if ((topic === 'link' || topic === 'license') && this.#listeners > 0) {
          void this.refresh();
        }
      },
      SystemConfigUpdate: () => {
        if (this.#listeners > 0) {
          void this.refresh();
        }
      },
    });
  }

  /** Start keeping the status current; call the returned function to stop. */
  listen() {
    this.#listeners++;
    void this.refresh();
    return () => {
      this.#listeners = Math.max(0, this.#listeners - 1);
      if (this.#listeners === 0) {
        this.#stopPolling();
      }
    };
  }

  async refresh() {
    this.#loading = true;
    const generation = ++this.#generation;
    const coverageGeneration = ++this.#coverageGeneration;
    const licenseRevision = this.#licenseRevision;
    const isCurrent = authManager.captureSession({ reactive: true });
    const isLinkCurrent = this.#captureLink();
    // each loads on its own, so a licence or price failure never hides a status that loaded
    this.#backupCoverage = null;
    const [status, license, products, backupCoverage] = await Promise.allSettled([
      getCloudStatus(),
      getLicenseStatus(),
      getLicenseProducts(),
      getCloudBackupLicenceCoverage(),
    ]);
    if (generation !== this.#generation || !isCurrent()) {
      // a Cancel, Unlink or other change started meanwhile; its answer is the current one
      this.#loading = false;
      return;
    }
    if (license.status === 'fulfilled' && licenseRevision === this.#licenseRevision) {
      this.#license = license.value;
    }
    if (products.status === 'fulfilled') {
      this.#products = products.value;
    }
    if (coverageGeneration === this.#coverageGeneration) {
      this.#coverageCurrent = isCurrent;
      this.#backupCoverage = isCurrent() && backupCoverage.status === 'fulfilled' ? backupCoverage.value : null;
    }
    if (status.status === 'fulfilled') {
      this.#apply(status.value);
      if (!isLinkCurrent() && licenseRevision !== this.#licenseRevision && !this.#licensePending) {
        // This read crossed a finished action and discovered a different link. Reconcile that link
        // without applying the superseded licence/coverage snapshot or restarting link polling.
        void this.#refreshLicenseForLink(this.#licenseAction, this.#licenseRevision, isCurrent);
        this.#backupCoverage = null;
        void this.#refreshBackupCoverage(++this.#coverageGeneration, isCurrent);
      }
    } else {
      this.#error = status.reason;
    }
    this.#loading = false;
  }

  startLink = () => this.#run(() => startCloudLink());
  cancelLink = () => this.#run(() => cancelCloudLink());
  /** FC-18: link again in the account's region with the approval the cloud kept after `region-mismatch`. */
  continueLink = () => this.#run(() => continueCloudLink());
  unlink = () => this.#run(() => unlinkCloud());
  /** FL-708: first-run setup links with a Frameleaf account's email and password; no approval code. */
  linkWithAccount = (dto: CloudAccountLinkDto) =>
    this.#runAccountLink(() => linkCloudWithAccount({ cloudAccountLinkDto: dto }));
  /** FL-708: the emailed or authenticator code a link with an account asked for. */
  verifyAccountLink = (challengeId: string, code: string) =>
    this.#runAccountLink(() => verifyCloudAccountLink({ cloudAccountLinkVerifyDto: { challengeId, code } }));
  checkIn = () => this.#run(() => checkInCloud());
  setPermissions = (dto: CloudPermissionsUpdateDto) =>
    this.#run(() => updateCloudPermissions({ cloudPermissionsUpdateDto: dto }));
  /** FL-158: offer Sign in with Frameleaf on the login page at home too. */
  setShowOnLocalLogin = (showOnLocalLogin: boolean) =>
    this.#run(() => updateCloudSignIn({ cloudSignInUpdateDto: { showOnLocalLogin } }));
  setButtonText = (buttonText: string) => this.#run(() => updateCloudSignIn({ cloudSignInUpdateDto: { buttonText } }));
  /** FL-235: the storage quota (GiB) new invited accounts start with; null is unlimited. */
  setInvitedStorageQuota = (invitedStorageQuota: number | null) =>
    this.#run(() => updateCloudSignIn({ cloudSignInUpdateDto: { invitedStorageQuota } }));
  /** FL-161: whether originals may go through the relay, and whether passwords work away from home. */
  setRemoteAccess = (dto: CloudRemoteAccessUpdateDto) =>
    this.#run(() => updateCloudRemoteAccess({ cloudRemoteAccessUpdateDto: dto }));

  activateLicense = (key: string) => this.#runLicense(() => activateLicense({ licenseActivateDto: { key } }));
  installLicenseFile = (certificate: string) =>
    this.#runLicense(() => installLicenseCertificate({ licenseCertificateDto: { certificate } }));
  removeLicenseKey = () => this.#runLicense(() => removeLicenseKey());
  removePlan = () => this.#runLicense(() => removeLicensePlan());
  refreshLicense = () => this.#runLicense(() => refreshLicense());

  async #runLicense(call: () => Promise<LicenseStatusResponseDto>) {
    const action = ++this.#licenseAction;
    this.#licensePending = true;
    // Generic reads must not overwrite an action with a snapshot from before/during that action.
    ++this.#licenseRevision;
    ++this.#coverageGeneration;
    const isCurrent = authManager.captureSession({ reactive: true });
    const isLinkCurrent = this.#captureLink();
    this.#backupCoverage = null;
    try {
      const license = await call();
      if (action === this.#licenseAction && isCurrent() && isLinkCurrent()) {
        this.#license = license;
      }
      return license;
    } finally {
      if (action === this.#licenseAction) {
        this.#licensePending = false;
      }
      if (action === this.#licenseAction && isCurrent()) {
        const revision = ++this.#licenseRevision;
        if (!isLinkCurrent()) {
          void this.#refreshLicenseForLink(action, revision, isCurrent);
        }
        this.#backupCoverage = null;
        // A licence action finishes independently of Cloud; failed actions also recheck current cover.
        void this.#refreshBackupCoverage(++this.#coverageGeneration, isCurrent);
      }
    }
  }

  async #refreshLicenseForLink(action: number, revision: number, isCurrent: () => boolean) {
    const isLinkCurrent = this.#captureLink();
    try {
      const license = await getLicenseStatus();
      if (action === this.#licenseAction && revision === this.#licenseRevision && isCurrent() && isLinkCurrent()) {
        this.#license = license;
      }
    } catch {
      // One best-effort read; a Cloud outage must not hold the completed action or restart it.
    }
  }

  #captureLink() {
    const { state, cloudHost, instanceId, linkedAt, cloneSuspected } = this.#status ?? {};
    const accountId = this.#status?.account?.id;
    return () =>
      this.#status?.state === state &&
      this.#status?.cloudHost === cloudHost &&
      this.#status?.instanceId === instanceId &&
      this.#status?.account?.id === accountId &&
      this.#status?.linkedAt === linkedAt &&
      this.#status?.cloneSuspected === cloneSuspected;
  }

  async #refreshBackupCoverage(generation: number, isCurrent: () => boolean) {
    if (generation !== this.#coverageGeneration || !isCurrent() || this.#status?.state !== 'linked') {
      return;
    }
    const isLinkCurrent = this.#captureLink();
    try {
      const coverage = await getCloudBackupLicenceCoverage();
      if (generation === this.#coverageGeneration && isCurrent() && isLinkCurrent()) {
        this.#coverageCurrent = isCurrent;
        this.#backupCoverage = coverage;
      }
    } catch {
      if (generation === this.#coverageGeneration && isCurrent() && isLinkCurrent()) {
        this.#backupCoverage = null;
      }
    }
  }

  async #runAccountLink(call: () => Promise<CloudAccountLinkResponseDto>) {
    let answer: CloudAccountLinkResponseDto | undefined;
    await this.#run(async () => {
      answer = await call();
      return answer.status;
    });
    return answer!;
  }

  async #run(call: () => Promise<CloudStatusResponseDto>) {
    const generation = ++this.#generation;
    ++this.#coverageGeneration;
    const isCurrent = authManager.captureSession({ reactive: true });
    this.#backupCoverage = null;
    this.#stopPolling();
    let applied = false;
    try {
      const status = await call();
      if (generation === this.#generation && isCurrent()) {
        this.#apply(status);
        applied = true;
      }
      return status;
    } finally {
      // a failed action (for example "Get a new code" or Cancel) leaves a pending code waiting:
      // keep checking it, or the page would sit on "Waiting" for good
      const pending = this.#status?.state === 'pending' ? this.#status.pending : null;
      if (generation === this.#generation && isCurrent()) {
        if (!applied && pending) {
          this.#schedulePoll(Math.max(1, pending.intervalSeconds));
        }
        this.#backupCoverage = null;
        void this.#refreshBackupCoverage(++this.#coverageGeneration, isCurrent);
      }
    }
  }

  #apply(status: CloudStatusResponseDto) {
    if (status.state !== 'linked') {
      this.#backupCoverage = null;
    }
    this.#status = status;
    this.#error = null;
    this.#pollError = null;
    this.#pollFailures = 0;
    this.#stopPolling();
    if (status.state === 'pending' && status.pending) {
      this.#schedulePoll(Math.max(1, status.pending.intervalSeconds));
    }
  }

  #schedulePoll(seconds: number) {
    this.#stopPolling();
    if (this.#listeners > 0) {
      this.#poll = setTimeout(() => void this.#pollOnce(), seconds * 1000);
    }
  }

  /**
   * One check of a pending code. A failure never stops polling while the code is pending: it is
   * shown, and the next check waits twice as long each time (at most a minute), so an approval
   * made meanwhile is still picked up.
   */
  async #pollOnce() {
    const generation = this.#generation;
    try {
      const status = await getCloudLink();
      if (generation === this.#generation) {
        this.#apply(status);
      }
    } catch (error) {
      if (generation !== this.#generation) {
        return;
      }
      this.#pollError = error;
      const pending = this.#status?.state === 'pending' ? this.#status.pending : null;
      if (pending) {
        this.#pollFailures++;
        const base = Math.max(1, pending.intervalSeconds);
        this.#schedulePoll(Math.min(base * 2 ** this.#pollFailures, MAX_POLL_BACKOFF_SECONDS));
      }
    }
  }

  #stopPolling() {
    if (!this.#poll) {
      return;
    }
    clearTimeout(this.#poll);
    this.#poll = undefined;
  }
}

export const cloudManager = new CloudManager();
