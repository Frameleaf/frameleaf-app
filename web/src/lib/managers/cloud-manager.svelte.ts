import {
  activateLicense,
  cancelCloudLink,
  checkInCloud,
  getCloudLink,
  getCloudStatus,
  getLicenseProducts,
  getLicenseStatus,
  installLicenseCertificate,
  refreshLicense,
  removeLicenseKey,
  removeLicensePlan,
  startCloudLink,
  unlinkCloud,
  updateCloudPermissions,
  updateCloudSignIn,
  type CloudPermissionsUpdateDto,
  type CloudStatusResponseDto,
  type LicenseProductsResponseDto,
  type LicenseStatusResponseDto,
} from '@immich/sdk';
import { eventManager } from '$lib/managers/event-manager.svelte';

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
  #error = $state<unknown>(null);
  #loading = $state(false);
  #listeners = 0;
  #poll?: ReturnType<typeof setTimeout>;

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

  get error() {
    return this.#error;
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
    try {
      const [status, license, products] = await Promise.all([
        getCloudStatus(),
        getLicenseStatus(),
        getLicenseProducts(),
      ]);
      this.#license = license;
      this.#products = products;
      this.#apply(status);
    } catch (error) {
      this.#error = error;
    } finally {
      this.#loading = false;
    }
  }

  startLink = () => this.#run(() => startCloudLink());
  cancelLink = () => this.#run(() => cancelCloudLink());
  unlink = () => this.#run(() => unlinkCloud());
  checkIn = () => this.#run(() => checkInCloud());
  setPermissions = (dto: CloudPermissionsUpdateDto) =>
    this.#run(() => updateCloudPermissions({ cloudPermissionsUpdateDto: dto }));
  /** FL-158: offer Sign in with Frameleaf on the login page at home too. */
  setShowOnLocalLogin = (showOnLocalLogin: boolean) =>
    this.#run(() => updateCloudSignIn({ cloudSignInUpdateDto: { showOnLocalLogin } }));
  setButtonText = (buttonText: string) => this.#run(() => updateCloudSignIn({ cloudSignInUpdateDto: { buttonText } }));

  activateLicense = (key: string) => this.#runLicense(() => activateLicense({ licenseActivateDto: { key } }));
  installLicenseFile = (certificate: string) =>
    this.#runLicense(() => installLicenseCertificate({ licenseCertificateDto: { certificate } }));
  removeLicenseKey = () => this.#runLicense(() => removeLicenseKey());
  removePlan = () => this.#runLicense(() => removeLicensePlan());
  refreshLicense = () => this.#runLicense(() => refreshLicense());

  async #runLicense(call: () => Promise<LicenseStatusResponseDto>) {
    const license = await call();
    this.#license = license;
    return license;
  }

  async #run(call: () => Promise<CloudStatusResponseDto>) {
    const status = await call();
    this.#apply(status);
    return status;
  }

  #apply(status: CloudStatusResponseDto) {
    this.#status = status;
    this.#error = null;
    this.#stopPolling();
    if (status.state === 'pending' && status.pending && this.#listeners > 0) {
      const seconds = Math.max(1, status.pending.intervalSeconds);
      this.#poll = setTimeout(() => void this.#pollOnce(), seconds * 1000);
    }
  }

  async #pollOnce() {
    try {
      this.#apply(await getCloudLink());
    } catch (error) {
      this.#error = error;
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
